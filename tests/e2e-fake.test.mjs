// T02 WU6: fake end-to-end — real PiRpcAdapter against the scripted fake
// pi child, real Store, real SessionHost. No network, no real Pi, no
// secrets. Exercises the full decision lifecycle over real pipes.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { Store } from '../src/store.mjs';
import { PiRpcAdapter } from '../src/pi-adapter.mjs';
import { SessionHost } from '../src/session-host.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-pi-rpc.mjs', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const T0 = 1_700_000_000_000;

function writeScenario(dir, name, scenario) {
  const path = join(dir, `${name}.scenario.json`);
  writeFileSync(path, JSON.stringify(scenario), 'utf8');
  return path;
}

function makeRealAdapter(dir, scenarioPath) {
  return new PiRpcAdapter({
    argv: [process.execPath, FIXTURE, '--mode', 'rpc', '--scenario', scenarioPath],
    cwd: dir,
    requestTimeoutMs: 5000,
  });
}

function setup() {
  const dir = mkdtempSync(join(TEST_RUNS, 'e2e-'));
  const store = new Store(join(dir, 'main.sqlite'), {
    now: () => T0,
    isProcessAlive: (pid) => pid === 999,
  });
  const host = new SessionHost({
    store,
    ownerId: 'e2e-host',
    pid: 999,
    adapterFactory: ({ sessionId }) => makeRealAdapter(dir, scenarios[sessionId]),
    requestTtlMs: 600_000,
    now: () => T0,
  });
  const scenarios = {};
  const outbox = [];
  host.onOutbox((message) => outbox.push(message));
  return { dir, store, host, scenarios, outbox };
}

describe('e2e fake: full decision lifecycle over real pipes', () => {
  let env;
  beforeEach(() => {
    env = setup();
  });
  afterEach(async () => {
    await env.host.dispose();
  });

  test('prompt response for a command resolves only after the awaited dialog (no deadlock)', async () => {
    const { dir, store } = env;
    // Real RPC contract: an awaited extension command does not resolve its
    // prompt response until the command dialog is answered.
    const scenarioPath = writeScenario(dir, 's1', {
      session: { sessionId: 'pi-e2e-hold', sessionFile: 'f' },
      prompts: [{
        respondAfterUi: true,
        response: { success: true },
        then: [{
          kind: 'ui',
          request: { method: 'select', title: 'Pick', options: ['Option A', 'Option B'] },
          awaitResponse: true,
        }],
      }],
    });
    const adapter = makeRealAdapter(dir, scenarioPath);
    try {
      await adapter.start();
      let commandResolved = false;
      const commandPromise = adapter
        .send({ type: 'prompt', message: '/bridge-demo abc123' })
        .then(() => { commandResolved = true; });

      // The dialog must arrive while the command is still pending.
      const seen = [];
      adapter.onUiRequest((request) => seen.push(request));
      let dialog = null;
      for (let i = 0; i < 100 && !dialog; i++) {
        dialog = seen.find((r) => r.method === 'select') ?? null;
        if (!dialog) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(dialog, 'awaited dialog arrived while command pending');
      assert.equal(commandResolved, false, 'prompt response withheld until dialog answered');

      adapter.respondUi(dialog.id, { value: 'Option A' });
      await Promise.race([commandPromise, new Promise((resolve) => setTimeout(resolve, 3000))]);
      assert.equal(commandResolved, true, 'command resolves after the dialog is answered');
    } finally {
      await adapter.dispose();
    }
  });

  test('demo lifecycle over real pipes: nonce-bound decision completes exactly once', async () => {
    const { store, host, scenarios, outbox, dir } = env;
    scenarios.s1 = writeScenario(dir, 's1', {
      session: { sessionId: 'pi-e2e-1', sessionFile: join(dir, 's1.jsonl') },
      prompts: [{
        respondAfterUi: true,
        response: { success: true },
        then: [{
          kind: 'ui',
          request: { method: 'select', title: 'Pick option', options: ['Option A', 'Option B'] },
          awaitResponse: true,
          afterResponse: [
            // Strict JSON with the host-generated nonce ($NONCE echoed).
            { kind: 'ui', request: { method: 'notify', message: '{"nonce":"$NONCE","choice":"$CHOICE"}', notifyType: 'info' } },
            { kind: 'event', event: { type: 'agent_settled' } },
          ],
        }],
      }],
    });

    await host.startSession('s1');
    // H3: the demo is a locally initiated lifecycle, never raw chat.
    assert.equal(host.startDemo('s1').ok, true);

    // Dialog arrives asynchronously; wait for persistence.
    for (let i = 0; i < 100 && store.listRecoverableRequests().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pending = store.listRecoverableRequests();
    assert.equal(pending.length, 1, 'dialog persisted before transport');
    assert.equal(pending[0].action.uiId, 'ui-1');
    assert.equal(pending[0].action.method, 'select');
    assert.ok(outbox.length >= 1, 'approval went to outbox');

    // Human decision arrives through the durable IPC queue (at-most-once).
    const requestId = pending[0].requestId;
    store.enqueueAction({ actionId: 'stable-decision-1', type: 'decision', payload: { requestId, decision: { value: 'Option B' } } });
    store.enqueueAction({ actionId: 'stable-decision-1', type: 'decision', payload: { requestId, decision: { value: 'Option A' } } });
    host.tick();

    // Response routed to the child; child runs afterResponse: nonce-bound
    // notify + agent_settled. Completion requires the nonce match.
    for (let i = 0; i < 100 && store.getRequest(requestId).state === 'resuming'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const final = store.getRequest(requestId);
    assert.equal(final.state, 'completed', `expected completed, got ${final.state}`);
    assert.deepEqual(final.result, { applied: true, demo: true, choice: 'Option B' });
    assert.equal(final.decision?.value, 'Option B');
  });

  test('malformed child output is bounded and non-fatal; session keeps working', async () => {
    const { store, host, scenarios, dir } = env;
    scenarios.s1 = writeScenario(dir, 's1', {
      session: { sessionId: 'pi-e2e-2', sessionFile: 'f' },
      prompts: [{
        response: { success: true },
        then: [
          { kind: 'raw', text: 'this is {not json at all\n' },
          { kind: 'event', event: { type: 'agent_settled' } },
        ],
      }],
    });
    await host.startSession('s1');
    await host.sendUserPrompt('s1', 'hello');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(host.isSessionRunning('s1'), true, 'host and child survive malformed stdout');
  });

  test('two sessions with real children can hold simultaneous pending dialogs', async () => {
    const { store, host, scenarios, dir } = env;
    const dialog = {
      kind: 'ui',
      request: { method: 'select', title: 'Pick', options: ['A', 'B'] },
      awaitResponse: true,
      afterResponse: [{ kind: 'event', event: { type: 'agent_settled' } }],
    };
    scenarios.s1 = writeScenario(dir, 's1', {
      session: { sessionId: 'pi-e2e-s1', sessionFile: 'f1' },
      prompts: [{ response: { success: true }, then: [dialog] }],
    });
    scenarios.s2 = writeScenario(dir, 's2', {
      session: { sessionId: 'pi-e2e-s2', sessionFile: 'f2' },
      prompts: [{ response: { success: true }, then: [dialog] }],
    });

    await host.startSession('s1');
    await host.startSession('s2');
    await host.sendUserPrompt('s1', 'go');
    await host.sendUserPrompt('s2', 'go');

    for (let i = 0; i < 100 && store.listRecoverableRequests().length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pending = store.listRecoverableRequests();
    assert.equal(pending.length, 2);
    assert.deepEqual(
      pending.map((r) => r.sessionId).sort(),
      ['s1', 's2'],
    );

    // Decide both in reverse order; each CAS is independent.
    const bySession = Object.fromEntries(pending.map((r) => [r.sessionId, r.requestId]));
    assert.equal(host.submitDecision({ requestId: bySession.s2, decision: { value: 'B' } }).ok, true);
    assert.equal(host.submitDecision({ requestId: bySession.s1, decision: { value: 'A' } }).ok, true);
    assert.equal(store.getRequest(bySession.s1).state, 'resuming');
    assert.equal(store.getRequest(bySession.s2).state, 'resuming');
  });
});

describe('e2e fake: two callback tokens for one request (verifier)', () => {
  let env;
  beforeEach(() => {
    env = setup();
  });
  afterEach(async () => {
    await env.host.dispose();
  });

  test('two distinct tokens -> two actions, at most one host response write and one result', async () => {
    const { store, host, scenarios, dir } = env;
    const responseLog = join(dir, 'ui-responses.log');
    scenarios.s1 = writeScenario(dir, 's1', {
      session: { sessionId: 'pi-e2e-2tok', sessionFile: join(dir, 's2tok.jsonl') },
      responseLog,
      prompts: [{
        respondAfterUi: true,
        response: { success: true },
        then: [{
          kind: 'ui',
          request: { method: 'select', title: 'Pick option', options: ['Option A', 'Option B'] },
          awaitResponse: true,
          afterResponse: [
            { kind: 'ui', request: { method: 'notify', message: '{"nonce":"$NONCE","choice":"$CHOICE"}', notifyType: 'info' } },
            { kind: 'event', event: { type: 'agent_settled' } },
          ],
        }],
      }],
    });

    await host.startSession('s1');
    // The demo is a locally initiated lifecycle, never raw chat: the
    // nonce-bound notify is what completes the request (H3).
    assert.equal(host.startDemo('s1').ok, true);
    for (let i = 0; i < 100 && store.listRecoverableRequests().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const requestId = store.listRecoverableRequests()[0].requestId;

    // Mirror of the worker: two distinct one-use tokens -> two distinct
    // action ids, both enqueued before the host consumes them.
    const tokenA = store.createCallbackToken({ requestId, kind: 'decision', decision: { value: 'Option A' } }).token;
    const tokenB = store.createCallbackToken({ requestId, kind: 'decision', decision: { value: 'Option B' } }).token;
    assert.notEqual(tokenA, tokenB, 'tokens are distinct');
    const first = store.enqueueAction({ actionId: `cb:${tokenA}`, type: 'decision', payload: { requestId, decision: { value: 'Option A' } } });
    const second = store.enqueueAction({ actionId: `cb:${tokenB}`, type: 'decision', payload: { requestId, decision: { value: 'Option B' } } });
    assert.equal(first, true);
    assert.equal(second, true, 'two distinct tokens enqueue two actions');

    host.tick();
    for (let i = 0; i < 100 && store.getRequest(requestId).state === 'resuming'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const final = store.getRequest(requestId);
    assert.equal(final.state, 'completed', `expected completed, got ${final.state}`);
    const winner = final.decision?.value;
    assert.ok(winner === 'Option A' || winner === 'Option B', 'exactly one of the two actions CAS-wins');
    assert.equal(final.result.choice, winner, 'result echoes the ACTUAL winning decision ($CHOICE, never canned)');

    // Give the child a moment to log the response write(s).
    for (let i = 0; i < 50 && !existsSync(responseLog); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const writes = existsSync(responseLog)
      ? readFileSync(responseLog, 'utf8').split('\n').filter((l) => l.length > 0)
      : [];
    assert.equal(writes.length, 1, 'exactly ONE extension_ui_response write for one request');
  });
});
