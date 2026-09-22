// T03 WU4: process-boundary e2e — real SessionHost + real PiRpcAdapter
// against the scripted fake pi child in the PARENT, and the real worker
// (real TelegramApi with a local fake fetch) in a SPAWNED child process.
// Proves: the durable queue carries decisions across processes, a worker
// restart neither loses the pending question nor touches the Pi child,
// and only opaque tokens cross the process boundary.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../src/store.mjs';
import { PiRpcAdapter } from '../src/pi-adapter.mjs';
import { SessionHost } from '../src/session-host.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-pi-rpc.mjs', import.meta.url));
const WORKER_CHILD = fileURLToPath(new URL('./fixtures/worker-child.mjs', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const T0 = 1_700_000_000_000;
const USER_ID = '777000';
const CHAT_ID = '-100123';

function spawnWorkerChild(dir, name) {
  const controlPath = join(dir, 'worker-control.json');
  const logPath = join(dir, `worker-${name}.log`);
  const configPath = join(dir, 'worker-config.json');
  writeFileSync(configPath, JSON.stringify({
    telegram: { allowedUserId: USER_ID, allowedChatId: CHAT_ID },
    bridge: { maxMessageChars: 3800, rateLimit: { max: 1000, windowMs: 60000 } },
  }), 'utf8');
  const child = spawn(process.execPath, [
    WORKER_CHILD,
    '--db', join(dir, 'main.sqlite'),
    '--control', controlPath,
    '--log', logPath,
    '--config', configPath,
    '--now-base', String(T0),
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return { child, controlPath, logPath, stderr: () => stderr };
}

function readLog(path) {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function waitFor(predicate, { timeoutMs = 15000, stepMs = 40 } = {}) {
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  })();
}

function exitOf(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(true);
    else child.once('exit', () => resolve(true));
  });
}

describe('e2e process boundary: worker child + host + fake pi', () => {
  test('decision flows through the durable queue across processes; restart keeps pi alive', async () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-e2e-'));
    const store = new Store(join(dir, 'main.sqlite'), {
      now: () => T0,
      // Host lease bookkeeping only; the worker child uses real liveness.
      isProcessAlive: (pid) => pid === 999,
    });
    const scenarioPath = join(dir, 's1.scenario.json');
    writeFileSync(scenarioPath, JSON.stringify({
      session: { sessionId: 'pi-e2e-1', sessionFile: join(dir, 's1.jsonl') },
      prompts: [
        {
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
        },
        { response: { success: true } },
      ],
    }), 'utf8');
    const host = new SessionHost({
      store,
      ownerId: 'e2e-host',
      pid: 999,
      adapterFactory: () => new PiRpcAdapter({
        argv: [process.execPath, FIXTURE, '--mode', 'rpc', '--scenario', scenarioPath],
        cwd: dir,
        requestTimeoutMs: 8000,
      }),
      requestTtlMs: 600_000,
      now: () => T0,
    });
    writeFileSync(join(dir, 'worker-control.json'), JSON.stringify({
      cycles: 60, gapMs: 25, webhook: '', updates: [],
    }), 'utf8');

    try {
      await host.startSession('s1');
      assert.equal(host.startDemo('s1').ok, true);

      // Dialog persisted and the approval_request queued for transport.
      const pending = await waitFor(() => {
        const requests = store.listRecoverableRequests();
        return requests.length === 1 ? requests[0] : null;
      });
      assert.ok(pending, 'dialog arrived before transport');
      const requestId = pending.requestId;

      // Spawn worker child 1; it must drain context + keyboard.
      const first = spawnWorkerChild(dir, 'first');
      const drained = await waitFor(() => store.listPendingOutbox().length === 0);
      assert.ok(drained, 'worker child drained the approval (context + keyboard)');

      // Context chunks were sent before the keyboard, in one child process.
      const firstLog = readLog(first.logPath);
      const sends = firstLog.filter((e) => e.api === 'sendMessage');
      assert.ok(sends.length >= 2, 'context and keyboard both sent');
      const keyboardIndex = sends.findIndex((e) => e.hasButtons);
      assert.ok(keyboardIndex > 0, 'keyboard sent after context chunks');
      for (let i = 0; i < keyboardIndex; i++) {
        assert.equal(sends[i].hasMarkup, false, 'no buttons before context');
      }
      const child1Pid = firstLog.find((e) => e.event === 'started')?.pid;
      assert.ok(Number.isInteger(child1Pid), 'worker child logged its pid');

      // Read the delivered keyboard: callback_data are opaque tokens only.
      const raw = new DatabaseSync(join(dir, 'main.sqlite'));
      const row = raw.prepare("SELECT payload_json FROM outbox WHERE kind = 'tg_keyboard'").get();
      raw.close();
      const markup = JSON.parse(row.payload_json).replyMarkup;
      const buttons = markup.inline_keyboard.flat();
      const optionButton = buttons.find((b) => b.text === 'Option A');
      assert.ok(optionButton, 'exact option label preserved');
      assert.match(optionButton.callback_data, /^[0-9a-f]{32}$/);
      assert.doesNotMatch(optionButton.callback_data, /Option|s1|777000|-100123/);

      // Restart: kill child 1 HARD (no dispose); the host and fake pi stay.
      first.child.kill('SIGKILL');
      await exitOf(first.child);
      assert.equal(store.getRequest(requestId).state, 'waiting_decision', 'question survived the crash');
      assert.equal(host.isSessionRunning('s1'), true, 'host session unaffected by worker death');

      // Child 2 (same db, real pid-liveness takeover) must re-drain nothing
      // (already delivered) and then deliver the human decision.
      const second = spawnWorkerChild(dir, 'second');
      const started = await waitFor(() => readLog(second.logPath).some((e) => e.event === 'started'));
      assert.ok(started, 'worker child 2 started');

      // The human presses Option A: an authorized callback update arrives.
      const control = JSON.parse(readFileSync(second.controlPath, 'utf8'));
      control.updates = [{
        update_id: 100,
        callback_query: {
          id: 'cq-100',
          from: { id: Number(USER_ID), is_bot: false },
          chat_instance: 'ci',
          message: { message_id: 500, chat: { id: Number(CHAT_ID), type: 'private' } },
          data: optionButton.callback_data,
        },
      }];
      writeFileSync(second.controlPath, JSON.stringify(control), 'utf8');

      // The action crosses the process boundary; the host consumes it.
      let final = null;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        host.tick();
        const state = store.getRequest(requestId).state;
        if (state === 'completed' || state === 'failed') { final = store.getRequest(requestId); break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(final, 'decision applied within the timeout');
      assert.equal(final.state, 'completed');
      // The fake pi child echoes the ACTUAL responded value via $CHOICE —
      // the notify JSON is built from the ui_response, not canned.
      assert.equal(final.decision?.value, 'Option A', 'token binding survived the process boundary');
      assert.equal(final.result.choice, final.decision.value, 'result echoes the actual decision');
      assert.deepEqual(final.result, { applied: true, demo: true, choice: 'Option A' });

      // The pi child is still attached: a fresh prompt resolves normally
      // AFTER the worker restart (worker dispose never closed pi stdin).
      const promptResult = await Promise.race([
        host.sendUserPrompt('s1', 'ping after restart'),
        new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      assert.ok(promptResult, 'pi child survived the worker restart (prompt resolved)');

      // Clean shutdown of child 2.
      const control2 = JSON.parse(readFileSync(second.controlPath, 'utf8'));
      control2.updates = [];
      writeFileSync(second.controlPath, JSON.stringify(control2), 'utf8');
      second.child.kill('SIGTERM');
      await exitOf(second.child);
      const secondLog = readLog(second.logPath);
      assert.equal(secondLog.some((e) => e.event === 'error'), false, 'worker child 2 exited cleanly');
    } finally {
      await host.dispose();
      store.close();
    }
  });
});
