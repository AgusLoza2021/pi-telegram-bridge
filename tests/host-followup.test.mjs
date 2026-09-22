// T04: host-side followup consumer. Default DENIED: without the explicit
// host flag no followup action is ever executed (T03 behavior preserved).
// When enabled on the host (same flag the worker validates), a typed
// {sessionId, text} action becomes one bounded user prompt:
//   - slash command lines are refused in ANY line (B3 parity);
//   - a session with an active pending dialog is never interleaved
//     (no ambiguous closed-dialog input);
//   - oversized text is refused;
//   - unknown/not-running sessions are refused (blocked, never crashed);
//   - an uncertain model acceptance (send rejection) is terminal: the
//     action is never retried or replayed;
//   - started/completed/failed/blocked notifications carry fixed factual
//     summaries only.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store.mjs';
import { SessionHost } from '../src/session-host.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const T0 = 1_700_000_000_000;

class FakeAdapter {
  constructor(label) {
    this.label = label;
    this.started = false;
    this.sent = [];
    this.uiResponses = [];
    this.eventHandlers = [];
    this.uiHandlers = [];
    this.sendImpl = null; // tests can override to simulate rejection
  }
  async start() {
    this.started = true;
    return { sessionId: `pi-${this.label}`, sessionFile: `fake-${this.label}.jsonl`, pid: 42000 };
  }
  onEvent(handler) { this.eventHandlers.push(handler); }
  onUiRequest(handler) { this.uiHandlers.push(handler); }
  send(command) {
    this.sent.push(command);
    if (this.sendImpl) return this.sendImpl(command);
    return Promise.resolve({ success: true, command: command.type });
  }
  respondUi(id, response) { this.uiResponses.push({ id, response }); }
  isRunning() { return this.started; }
  async dispose() { this.started = false; }
  emitEvent(event) { for (const h of this.eventHandlers) h(event); }
  emitUi(request) { for (const h of this.uiHandlers) h(request); }
}

function setup({ followupsEnabled = false } = {}) {
  const dir = mkdtempSync(join(TEST_RUNS, 'followup-'));
  const store = new Store(join(dir, 'main.sqlite'), {
    now: () => T0,
    isProcessAlive: (pid) => pid === 999,
  });
  const adapters = new Map();
  const host = new SessionHost({
    store,
    ownerId: 'host-under-test',
    pid: 999,
    adapterFactory: ({ sessionId }) => {
      const adapter = new FakeAdapter(sessionId);
      adapters.set(sessionId, adapter);
      return adapter;
    },
    requestTtlMs: 60_000,
    decisionApplyTimeoutMs: 30_000,
    followupsEnabled,
    now: () => T0,
  });
  return { store, host, adapters, dir };
}

/** Claim+run one action through the host tick, bypassing queue ordering noise. */
function enqueue(store, { actionId, type, payload }) {
  store.enqueueAction({ actionId, type, payload });
}

/** The followup send continuation is async; drain microtasks after ticks. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

async function startedHost({ followupsEnabled, sessionId = 'main' } = {}) {
  const ctx = setup({ followupsEnabled });
  await ctx.host.startSession(sessionId);
  await drain();
  ctx.host.tick(T0); // drain start noise
  return ctx;
}

describe('followup consumer: default DENIED', () => {
  test('without the host flag the action terminally fails and no prompt is sent', async () => {
    const { store, host, adapters } = await startedHost({ followupsEnabled: false });
    enqueue(store, { actionId: 'f1', type: 'followup', payload: { sessionId: 'main', text: 'hello' } });
    host.tick(T0);
    assert.equal(adapters.get('main').sent.length, 0);
  });
});

describe('followup consumer: enabled host', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await startedHost({ followupsEnabled: true });
  });
  afterEach(async () => {
    await ctx.host.dispose();
  });

  test('valid typed payload sends exactly one bounded prompt and completes the action', async () => {
    const { store, host, adapters } = ctx;
    enqueue(store, { actionId: 'f1', type: 'followup', payload: { sessionId: 'main', text: 'check the greenhouse' } });
    host.tick(T0);
    await drain();
    const prompts = adapters.get('main').sent.filter((c) => c.type === 'prompt');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].message, 'check the greenhouse');
    host.tick(T0);
    await drain(); // second tick: no replay
    assert.equal(adapters.get('main').sent.filter((c) => c.type === 'prompt').length, 1);
  });

  test('slash command text in any line is refused with a blocked notification', async () => {
    const { store, host, adapters } = ctx;
    enqueue(store, { actionId: 'f2', type: 'followup', payload: { sessionId: 'main', text: 'please\n/run away' } });
    host.tick(T0);
    assert.equal(adapters.get('main').sent.filter((c) => c.type === 'prompt').length, 0);
    const notifications = store.listPendingOutbox().filter((r) => r.kind === 'notification');
    assert.equal(notifications.length, 1);
    assert.ok(notifications[0].payload.message.startsWith('Followup refused'));
  });

  test('oversized text is refused without sending', async () => {
    const { store, host, adapters } = ctx;
    enqueue(store, { actionId: 'f3', type: 'followup', payload: { sessionId: 'main', text: 'x'.repeat(4097) } });
    host.tick(T0);
    assert.equal(adapters.get('main').sent.length, 0);
  });

  test('a session with an active pending dialog refuses the followup (no ambiguous input)', async () => {
    const { store, host, adapters } = ctx;
    adapters.get('main').emitEvent({ type: 'tool_execution_start', toolName: 'bridge_decision', toolCallId: 't1' });
    adapters.get('main').emitUi({ id: 'ui-1', method: 'select', title: 'Pick', options: ['A', 'B'] });
    host.tick(T0); // persist dialog as waiting_decision
    enqueue(store, { actionId: 'f4', type: 'followup', payload: { sessionId: 'main', text: 'hello' } });
    host.tick(T0);
    assert.equal(adapters.get('main').sent.filter((c) => c.type === 'prompt').length, 0);
    assert.ok(store.listPendingOutbox().some((r) => r.kind === 'notification' && r.payload.message.startsWith('Followup refused')));
  });

  test('unknown session is refused without crashing the tick', async () => {
    const { store, host } = ctx;
    enqueue(store, { actionId: 'f5', type: 'followup', payload: { sessionId: 'ghost', text: 'hello' } });
    host.tick(T0);
    assert.ok(store.listPendingOutbox().some((r) => r.kind === 'notification'));
  });

  test('malformed payload is terminally failed (never retried)', async () => {
    const { store, host, adapters } = ctx;
    enqueue(store, { actionId: 'f6', type: 'followup', payload: { wrong: true } });
    host.tick(T0);
    assert.equal(adapters.get('main').sent.length, 0);
    host.tick(T0);
    assert.equal(adapters.get('main').sent.length, 0);
  });

  test('uncertain model acceptance (send rejection) is terminal: one notification, never a replay', async () => {
    const { store, host, adapters } = ctx;
    adapters.get('main').sendImpl = () => Promise.reject(Object.assign(new Error('x'), { code: 'timeout' }));
    enqueue(store, { actionId: 'f7', type: 'followup', payload: { sessionId: 'main', text: 'hello' } });
    host.tick(T0);
    await drain();
    const notifications = store.listPendingOutbox().filter((r) => r.kind === 'notification');
    assert.equal(notifications.length, 1);
    assert.ok(notifications[0].payload.message.startsWith('Followup failed'));
    const promptsSoFar = adapters.get('main').sent.filter((c) => c.type === 'prompt').length;
    adapters.get('main').sendImpl = null;
    host.tick(T0);
    await drain();
    assert.equal(adapters.get('main').sent.filter((c) => c.type === 'prompt').length, promptsSoFar,
      'an uncertain acceptance must never be retried');
  });

  test('agent settle after an accepted followup emits a completed notification once', async () => {
    const { store, host, adapters } = ctx;
    enqueue(store, { actionId: 'f8', type: 'followup', payload: { sessionId: 'main', text: 'hello' } });
    host.tick(T0);
    await drain(); // acceptance continuation must run before the settle
    adapters.get('main').emitEvent({ type: 'agent_settled' });
    host.tick(T0);
    await drain();
    const messages = store.listPendingOutbox().filter((r) => r.kind === 'notification').map((r) => r.payload.message);
    assert.ok(messages.some((m) => m.startsWith('Followup accepted')));
    assert.ok(messages.some((m) => m.startsWith('Followup completed')));
    adapters.get('main').emitEvent({ type: 'agent_settled' });
    host.tick(T0);
    const after = store.listPendingOutbox().filter((r) => r.kind === 'notification').length;
    assert.equal(after, messages.length, 'settle notification must be single-shot');
  });

  test('dispose of a session with an in-flight followup emits a failed notification', async () => {
    const { store, host } = ctx;
    enqueue(store, { actionId: 'f9', type: 'followup', payload: { sessionId: 'main', text: 'hello' } });
    host.tick(T0);
    await drain();
    await host.dispose();
    const messages = store.listPendingOutbox().filter((r) => r.kind === 'notification').map((r) => r.payload.message);
    assert.ok(messages.some((m) => m.startsWith('Followup failed')));
  });
});

describe('followup consumer: refusals are always visible (bounded fixed-code notifications)', () => {
  test('a followup on a default-denied host emits a followups_disabled notification, never a silent consume', async () => {
    const { store, host, adapters } = await startedHost({ followupsEnabled: false });
    enqueue(store, { actionId: 'f10', type: 'followup', payload: { sessionId: 'main', text: 'hello' } });
    host.tick(T0);
    await drain();
    const messages = store.listPendingOutbox().filter((r) => r.kind === 'notification').map((r) => r.payload.message);
    assert.ok(messages.some((m) => m.includes('followups_disabled')),
      'default-denied followup must emit one bounded fixed-code notification');
    assert.equal(adapters.get('main').sent.length, 0, 'no prompt may be sent');
    await host.dispose();
  });

  test('a malformed followup action (non-object payload) emits a malformed_followup notification', async () => {
    const { store, host } = await startedHost({ followupsEnabled: true });
    enqueue(store, { actionId: 'f11', type: 'followup', payload: 'not-an-object' });
    host.tick(T0);
    await drain();
    const messages = store.listPendingOutbox().filter((r) => r.kind === 'notification').map((r) => r.payload.message);
    assert.ok(messages.some((m) => m.includes('malformed_followup')));
    await host.dispose();
  });
});
