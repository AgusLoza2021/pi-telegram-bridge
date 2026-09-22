// T02 WU5: SessionHost — lease/generation ownership, dialog persistence,
// decision CAS, applied-signal semantics ("sending response != applied"),
// expiry/cancel with real dialog cleanup, at-most-once action queue.
// Uses a scripted FakeAdapter; the real child-process adapter is covered
// by the E2E suite.

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
    this.disposed = false;
  }
  async start() {
    this.started = true;
    return { sessionId: `pi-${this.label}`, sessionFile: `fake-${this.label}.jsonl`, pid: 42000 };
  }
  onEvent(handler) { this.eventHandlers.push(handler); }
  onUiRequest(handler) { this.uiHandlers.push(handler); }
  send(command) {
    this.sent.push(command);
    return Promise.resolve({ success: true, command: command.type });
  }
  respondUi(id, response) { this.uiResponses.push({ id, response }); }
  isRunning() { return this.started; }
  async dispose() { this.started = false; this.disposed = true; }
  // test helpers
  emitUi(request) { for (const h of this.uiHandlers) h(request); }
  emitEvent(event) { for (const h of this.eventHandlers) h(event); }
}

function setup() {
  const dir = mkdtempSync(join(TEST_RUNS, 'host-'));
  // Hermetic liveness probe: only pid 999 counts as alive.
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
    now: () => T0,
  });
  return { store, host, adapters, dir };
}

describe('session-host: startup ownership', () => {
  let store, host, adapters;
  beforeEach(() => {
    ({ store, host, adapters } = setup());
  });
  afterEach(() => host.dispose());

  test('refuses to start when the host lease is busy (fail closed)', async () => {
    store.acquireHostLease({ ownerId: 'someone-else', pid: 999 });
    await assert.rejects(() => host.startSession('s1'), /lease/i);
  });

  test('start persists exact Pi session identity and bumps host generation', async () => {
    const info = await host.startSession('s1');
    assert.equal(info.hostGeneration, 1);
    const sessions = store.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, 's1');
    assert.equal(sessions[0].piSessionId, 'pi-s1');
    assert.equal(info.sessionFile, 'fake-s1.jsonl');
    assert.equal(info.pid, 42000);
  });

  test('takeover bumps host generation so stale decisions fail', async () => {
    await host.startSession('s1');
    const gen1 = store.getHostGeneration();
    await host.dispose();

    const host2 = new SessionHost({
      store,
      ownerId: 'host-2',
      pid: 1, // probe says dead -> verifiable takeover
      adapterFactory: () => new FakeAdapter('s1b'),
      now: () => T0,
    });
    const info = await host2.startSession('s1');
    assert.equal(info.hostGeneration, gen1 + 1);
    await host2.dispose();
  });
});

describe('session-host: dialog persistence and approval flow', () => {
  let store, host, adapters;
  beforeEach(() => {
    ({ store, host, adapters } = setup());
  });
  afterEach(() => host.dispose());

  test('ui select dialog is persisted BEFORE anything is sent to chat', async () => {
    await host.startSession('s1');
    const outbox = [];
    host.onOutbox((message) => outbox.push(message));

    adapters.get('s1').emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Approve write?', options: ['Yes', 'No'] });

    const recoverable = store.listRecoverableRequests();
    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0].state, 'waiting_decision');
    assert.equal(recoverable[0].action.uiId, 'ui-1', 'durable mapping requestId <-> pi dialog id');
    assert.equal(recoverable[0].action.method, 'select');
    assert.deepEqual(recoverable[0].action.options, ['Yes', 'No']);
    assert.equal(outbox.length, 1, 'approval request goes to outbox');
  });

  test('decision CAS: respondUi sent exactly once, state becomes resuming', async () => {
    await host.startSession('s1');
    adapters.get('s1').emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['A', 'B'] });
    const requestId = store.listRecoverableRequests()[0].requestId;

    const result = host.submitDecision({ requestId, decision: { value: 'B' } });
    assert.equal(result.ok, true);
    assert.equal(store.getRequest(requestId).state, 'resuming');

    // A second submission (duplicate telegram button, crash replay, etc.)
    // is rejected by CAS and never reaches pi again.
    const second = host.submitDecision({ requestId, decision: { value: 'A' } });
    assert.equal(second.ok, false);
    const sentResponses = adapters.get('s1').uiResponses.filter((r) => r.id === 'ui-1');
    assert.equal(sentResponses.length, 1);
    assert.deepEqual(sentResponses[0].response, { value: 'B' });
  });

  test('sending response != applied: real tool_execution_end for the correlated toolCallId completes', async () => {
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    // B4: bridge_decision is a real awaited question tool; pi emits
    // tool_execution_start BEFORE the dialog and end AFTER it, correlated
    // by toolCallId (never a model-provided requestId).
    adapter.emitEvent({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'bridge_decision',
      args: { question: 'Proceed?', choices: ['A', 'B'] },
    });
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Proceed?', options: ['A', 'B'] });
    const requestId = store.listRecoverableRequests()[0].requestId;
    host.submitDecision({ requestId, decision: { value: 'B' } });

    // agent_settled WITHOUT the applied tool end must NOT count as success.
    adapter.emitEvent({ type: 'agent_settled' });
    assert.equal(store.getRequest(requestId).state, 'failed');

    // The abandoned question tool still ends (pi always ends its tools).
    adapter.emitEvent({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'bridge_decision',
      result: { content: [{ type: 'text', text: 'no answer' }], details: {} },
      isError: true,
    });

    // Now the healthy path: a fresh start/dialog/decision/end cycle.
    adapter.emitEvent({ type: 'tool_execution_start', toolCallId: 'call_2', toolName: 'bridge_decision', args: {} });
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-2', method: 'select', title: 'Pick', options: ['A', 'B'] });
    const requestId2 = store.listRecoverableRequests().find((r) => r.action.uiId === 'ui-2').requestId;
    host.submitDecision({ requestId: requestId2, decision: { value: 'A' } });
    adapter.emitEvent({
      type: 'tool_execution_end',
      toolCallId: 'call_2',
      toolName: 'bridge_decision',
      result: { content: [{ type: 'text', text: 'user answered: A' }], details: { choice: 'A' } },
      isError: false,
    });
    assert.equal(store.getRequest(requestId2).state, 'completed');
  });

  test('tool_execution_end with isError fails the request (real shape, no invented success)', async () => {
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    adapter.emitEvent({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bridge_decision', args: {} });
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['A'] });
    const requestId = store.listRecoverableRequests()[0].requestId;
    host.submitDecision({ requestId, decision: { value: 'A' } });
    adapter.emitEvent({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'bridge_decision',
      result: { content: [{ type: 'text', text: 'dialog cancelled' }], details: {} },
      isError: true,
    });
    assert.equal(store.getRequest(requestId).state, 'failed');
  });

  test('agent_settled never fails unanswered or unrelated dialogs', async () => {
    await host.startSession('s1');
    await host.startSession('s2');
    const adapter = adapters.get('s1');
    // Unanswered question (human has not decided yet).
    adapter.emitEvent({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bridge_decision', args: {} });
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['A'] });
    const unanswered = store.listRecoverableRequests()[0].requestId;
    // Unrelated gate dialog in ANOTHER session.
    adapters.get('s2').emitUi({ type: 'extension_ui_request', id: 'ui-2', method: 'confirm', title: 'Write file?' });
    const gate = store.listRecoverableRequests().find((r) => r.action.uiId === 'ui-2').requestId;

    adapter.emitEvent({ type: 'agent_settled' });

    assert.equal(store.getRequest(unanswered).state, 'waiting_decision', 'unanswered dialog survives settle');
    assert.equal(store.getRequest(gate).state, 'waiting_decision', 'unrelated dialog survives settle');
    assert.equal(adapter.uiResponses.length, 0, 'nothing cancelled by settle');
  });

  test('a second dialog while one is pending is cancelled fail-closed (single active request)', async () => {
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    adapter.emitEvent({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bridge_decision', args: {} });
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'One', options: ['A'] });
    adapter.emitEvent({ type: 'tool_execution_start', toolCallId: 'call_2', toolName: 'bridge_decision', args: {} });
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-2', method: 'select', title: 'Two', options: ['B'] });

    // First dialog persists and stays blocked; the second is cancelled.
    assert.equal(store.listRecoverableRequests().length, 1);
    assert.equal(adapter.uiResponses.length, 1);
    assert.deepEqual(adapter.uiResponses[0], { id: 'ui-2', response: { cancelled: true } });

    // Expiry is the fail-closed exit for the remaining dialog.
    host.tick(T0 + 61_000);
    assert.equal(adapter.uiResponses.filter((r) => r.response.cancelled === true).length, 2);
  });

  test('gated write/edit execution is verified observationally via real end events', async () => {
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    const hostEvents = [];
    host.onHostEvent((event) => hostEvents.push(event));
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'write src/x.ts' });
    const requestId = store.listRecoverableRequests()[0].requestId;
    host.submitDecision({ requestId, decision: { confirmed: true } });

    adapter.emitEvent({
      type: 'tool_execution_end',
      toolCallId: 'call_w1',
      toolName: 'write',
      result: { content: [{ type: 'text', text: 'ok' }], details: {} },
      isError: false,
    });
    const observed = hostEvents.find((e) => e.kind === 'gated_tool_executed');
    assert.ok(observed, 'gated tool end observed');
    assert.equal(observed.toolName, 'write');
    assert.equal(observed.toolCallId, 'call_w1');
    assert.equal(observed.isError, false);
    assert.equal(store.getRequest(requestId).state, 'completed', 'gate request closes with its observed tool end');
  });

  test('a denied gate decision completes the request as denied, immediately', async () => {
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'write src/x.ts' });
    const requestId = store.listRecoverableRequests()[0].requestId;
    const result = host.submitDecision({ requestId, decision: { cancelled: true } });
    assert.equal(result.ok, true);
    assert.deepEqual(adapter.uiResponses.find((r) => r.id === 'ui-1').response, { cancelled: true });
    assert.equal(store.getRequest(requestId).state, 'completed');
    assert.equal(store.getRequest(requestId).result?.denied, true);
  });

  test('sensitive dialog content is never transported; dialog is cancelled', async () => {
    await host.startSession('s1');
    const outbox = [];
    host.onOutbox((message) => outbox.push(message));
    const hostEvents = [];
    host.onHostEvent((event) => hostEvents.push(event));

    adapters.get('s1').emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Use token 123456:AAHfiqksKZ8WmoZ_M1b3tGvBbCST12e3456?', options: ['Yes'] });

    assert.equal(outbox.length, 0, 'sensitive approval text is blocked from chat');
    const responses = adapters.get('s1').uiResponses.filter((r) => r.id === 'ui-1');
    assert.deepEqual(responses[0].response, { cancelled: true });
    assert.ok(hostEvents.some((e) => e.kind === 'ui_blocked_sensitive'));
    assert.equal(store.listRecoverableRequests().length, 0, 'nothing persisted for a blocked dialog');
  });
});

describe('session-host: expiry, cancel, action queue', () => {
  let store, host, adapters;
  beforeEach(() => {
    ({ store, host, adapters } = setup());
  });
  afterEach(() => host.dispose());

  test('expiry cancels the real pending pi dialog and expires the request', async () => {
    await host.startSession('s1');
    adapters.get('s1').emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Write file?' });
    const requestId = store.listRecoverableRequests()[0].requestId;

    host.tick(T0 + 61_000); // past ttl 60s

    assert.equal(store.getRequest(requestId).state, 'expired');
    const cancelled = adapters.get('s1').uiResponses.filter((r) => r.id === 'ui-1');
    assert.deepEqual(cancelled[0].response, { cancelled: true }, 'actual pi dialog is cancelled');
  });

  test('cancel action: dialog cancelled, run aborted, queue drained', async () => {
    await host.startSession('s1');
    adapters.get('s1').emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['A'] });
    const requestId = store.listRecoverableRequests()[0].requestId;

    store.enqueueAction({ actionId: 'act-1', type: 'cancel', payload: { requestId } });
    host.tick(T0);

    assert.equal(store.getRequest(requestId).state, 'cancelled');
    assert.ok(
      adapters.get('s1').uiResponses.some((r) => r.id === 'ui-1' && r.response.cancelled === true),
      'pending dialog cancelled',
    );
    assert.ok(
      adapters.get('s1').sent.some((c) => c.type === 'abort'),
      'run aborted',
    );
    // Action consumed exactly once: draining again finds nothing.
    const claim = store.claimNextAction({ ownerId: 'other-host', now: T0 });
    assert.equal(claim.ok, false);
  });

  test('at-most-once: duplicate decision actionId executes once', async () => {
    await host.startSession('s1');
    adapters.get('s1').emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['A', 'B'] });
    const requestId = store.listRecoverableRequests()[0].requestId;

    const payload = { requestId, decision: { value: 'A' } };
    store.enqueueAction({ actionId: 'stable-id-1', type: 'decision', payload });
    store.enqueueAction({ actionId: 'stable-id-1', type: 'decision', payload }); // transport retry

    host.tick(T0);
    const responses = adapters.get('s1').uiResponses.filter((r) => r.id === 'ui-1');
    assert.equal(responses.length, 1, 'decided exactly once');
  });

  test('two simultaneous pending requests across two sessions are handled independently', async () => {
    await host.startSession('s1');
    await host.startSession('s2');
    adapters.get('s1').emitUi({ type: 'extension_ui_request', id: 'ui-a', method: 'select', title: 'One', options: ['A'] });
    adapters.get('s2').emitUi({ type: 'extension_ui_request', id: 'ui-b', method: 'select', title: 'Two', options: ['B'] });

    const pending = store.listRecoverableRequests();
    assert.equal(pending.length, 2);
    const r1 = pending.find((r) => r.action.uiId === 'ui-a');
    const r2 = pending.find((r) => r.action.uiId === 'ui-b');
    host.submitDecision({ requestId: r1.requestId, decision: { value: 'A' } });
    assert.equal(store.getRequest(r1.requestId).state, 'resuming');
    assert.equal(store.getRequest(r2.requestId).state, 'waiting_decision', 'other session untouched');

    const s1Responses = adapters.get('s1').uiResponses;
    const s2Responses = adapters.get('s2').uiResponses;
    assert.equal(s1Responses.length, 1);
    assert.equal(s2Responses.length, 0);
  });
});

describe('session-host: corrections B2/H2/B3/H3', () => {
  let store, host, adapters;
  beforeEach(() => {
    ({ store, host, adapters } = setup());
  });
  afterEach(() => host.dispose());

  test('B2: notify is fire-and-forget and never creates a phantom request; a later select is untouched', async () => {
    await host.startSession('s1');
    const outbox = [];
    host.onOutbox((message) => outbox.push(message));
    const adapter = adapters.get('s1');

    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-n', method: 'notify', message: 'some progress' });
    assert.equal(store.listRecoverableRequests().length, 0, 'notify never creates a request');
    assert.equal(outbox.filter((m) => m.kind === 'notification').length, 1, 'notify goes to outbox as notification');

    // Regression: a real select right after must NOT be cancelled.
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['A'] });
    assert.equal(store.listRecoverableRequests().length, 1);
    assert.equal(adapter.uiResponses.length, 0, 'select dialog still pending, untouched');
    assert.equal(store.listRecoverableRequests()[0].state, 'waiting_decision');
  });

  test('H2: decisions are validated against the immutable dialog action BEFORE the CAS', async () => {
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    adapter.emitEvent({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bridge_decision', args: {} });
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['A', 'B'] });
    const requestId = store.listRecoverableRequests()[0].requestId;

    // Value not among the options: rejected, nothing sent, request intact.
    const badValue = host.submitDecision({ requestId, decision: { value: 'Z' } });
    assert.equal(badValue.ok, false);
    assert.equal(badValue.reason, 'bad_decision');
    assert.equal(store.getRequest(requestId).state, 'waiting_decision', 'request not consumed');
    assert.equal(store.getRequest(requestId).decision, null, 'nothing recorded');
    assert.equal(adapter.uiResponses.length, 0, 'nothing sent to pi');

    // Extra keys are rejected too (strict decision shapes).
    const extraKeys = host.submitDecision({ requestId, decision: { value: 'A', confirmAll: true } });
    assert.equal(extraKeys.ok, false);
    assert.equal(adapter.uiResponses.length, 0);

    // cancelled must be exactly {cancelled: true}.
    assert.equal(host.submitDecision({ requestId, decision: { cancelled: 1 } }).ok, false);
    assert.equal(host.submitDecision({ requestId, decision: { cancelled: true, value: 'A' } }).ok, false);

    // The valid decision still goes through afterwards.
    const good = host.submitDecision({ requestId, decision: { value: 'A' } });
    assert.equal(good.ok, true);
    assert.equal(adapter.uiResponses.filter((r) => r.id === 'ui-1').length, 1);
  });

  test('H2: confirm decisions must be boolean; input values bounded strings', async () => {
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Write file?' });
    const confirmId = store.listRecoverableRequests()[0].requestId;
    assert.equal(host.submitDecision({ requestId: confirmId, decision: { confirmed: 'yes' } }).ok, false);
    assert.equal(store.getRequest(confirmId).state, 'waiting_decision', 'bad shape consumes nothing');
    // The valid confirm then goes through; the gated tool end closes it.
    assert.equal(host.submitDecision({ requestId: confirmId, decision: { confirmed: true } }).ok, true);
    adapter.emitEvent({ type: 'tool_execution_end', toolCallId: 'call_w1', toolName: 'write', result: { content: [], details: {} }, isError: false });
    assert.equal(store.getRequest(confirmId).state, 'completed');

    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-2', method: 'input', title: 'Name?' });
    const inputId = store.listRecoverableRequests().find((r) => r.action.uiId === 'ui-2').requestId;
    assert.equal(host.submitDecision({ requestId: inputId, decision: { value: 'x'.repeat(5000) } }).ok, false, 'oversized input rejected');
    assert.equal(store.getRequest(inputId).state, 'waiting_decision');
    const good = host.submitDecision({ requestId: inputId, decision: { value: 'ok-name' } });
    assert.equal(good.ok, true);
  });

  test('B3: sendUserPrompt rejects command-shaped chat input in any line', async () => {
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    assert.equal(host.sendPrompt, undefined, 'raw sendPrompt is gone');

    for (const text of ['/help', '  /settings', 'first line\n/compact', '\t/model']) {
      const result = await host.sendUserPrompt('s1', text);
      assert.equal(result.ok, false, JSON.stringify(text));
      assert.equal(result.reason, 'command_rejected');
    }
    assert.equal(adapter.sent.filter((c) => c.type === 'prompt').length, 0, 'nothing forwarded');

    const ok = await host.sendUserPrompt('s1', 'run the tests please\nthen report');
    assert.equal(ok.ok, true);
    assert.equal(adapter.sent.filter((c) => c.type === 'prompt').length, 1);
  });

  test('H3: demo lifecycle uses a host-generated nonce; strict JSON notify completes only on nonce match', async () => {
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    const hostEvents = [];
    host.onHostEvent((event) => hostEvents.push(event));

    const started = host.startDemo('s1');
    assert.equal(started.ok, true);
    const demoPrompt = adapter.sent.find((c) => c.type === 'prompt');
    assert.match(demoPrompt.message, /^\/bridge-demo [0-9a-f]+$/, 'fixed command + host-generated nonce only');

    // The demo select dialog arrives (command flow, no tool start).
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Bridge demo', options: ['Option A', 'Option B'] });
    const requestId = store.listRecoverableRequests()[0].requestId;
    host.submitDecision({ requestId, decision: { value: 'Option B' } });

    // Wrong nonce never completes anything.
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-n', method: 'notify', message: JSON.stringify({ nonce: 'deadbeef', choice: 'Option B' }) });
    assert.equal(store.getRequest(requestId).state, 'resuming', 'mismatched nonce cannot complete');
    assert.ok(hostEvents.some((e) => e.kind === 'demo_rejected'), 'rejection observed');

    // The matching nonce does.
    const nonce = demoPrompt.message.split(' ')[1];
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-n2', method: 'notify', message: JSON.stringify({ nonce, choice: 'Option B' }) });
    assert.equal(store.getRequest(requestId).state, 'completed');
    assert.deepEqual(store.getRequest(requestId).result, { applied: true, demo: true, choice: 'Option B' });

    // Nonce is single-use: a second notify with the same nonce is ignored.
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-n3', method: 'notify', message: JSON.stringify({ nonce, choice: 'Option A' }) });
    assert.equal(store.getRequest(requestId).state, 'completed', 'second notify does not resurrect anything');
    assert.equal(store.listRecoverableRequests().length, 0);
  });

  test('H3: demo notify must be a strict JSON object, not arbitrary text', async () => {
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    host.startDemo('s1');
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Bridge demo', options: ['A'] });
    const requestId = store.listRecoverableRequests()[0].requestId;
    host.submitDecision({ requestId, decision: { value: 'A' } });

    for (const message of ['bridge-demo applied: A', JSON.stringify({ choice: 'A' }), 'not json', JSON.stringify({ nonce: 42, choice: 'A' })]) {
      adapter.emitUi({ type: 'extension_ui_request', id: `ui-x-${Math.random()}`, method: 'notify', message });
    }
    assert.equal(store.getRequest(requestId).state, 'resuming', 'arbitrary text never completes');
  });

  test('H3: an unfinished demo request fails closed on the decision apply timeout', async () => {
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    host.startDemo('s1');
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Bridge demo', options: ['A'] });
    const requestId = store.listRecoverableRequests()[0].requestId;
    host.submitDecision({ requestId, decision: { value: 'A' } });

    host.tick(T0 + 31_000); // decisionApplyTimeoutMs = 30s
    assert.equal(store.getRequest(requestId).state, 'failed');
    assert.equal(store.getRequest(requestId).result, 'decision_not_applied');
  });

  test('malformed actions become terminal failed, never retried', async () => {
    await host.startSession('s1');
    store.enqueueAction({ actionId: 'bad-1', type: 'nonsense_type', payload: {} });
    host.tick(T0);
    // Terminal: a second drain (same owner) finds nothing claimable.
    const claim = store.claimNextAction({ ownerId: 'host-under-test', now: T0 + 1 });
    assert.equal(claim.ok, false, 'malformed action not re-claimed');
  });

  test('decision apply timeout fails a responded tool question whose end never arrived', async () => {
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    adapter.emitEvent({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bridge_decision', args: {} });
    adapter.emitUi({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['A'] });
    const requestId = store.listRecoverableRequests()[0].requestId;
    host.submitDecision({ requestId, decision: { value: 'A' } });

    host.tick(T0 + 31_000);
    assert.equal(store.getRequest(requestId).state, 'failed');
    assert.equal(store.getRequest(requestId).result, 'decision_not_applied');
  });
});

describe('session-host: unrenderable select options are rejected before createRequest (M1-4)', () => {
  let store, host, adapters;
  beforeEach(() => {
    ({ store, host, adapters } = setup());
  });
  afterEach(() => host.dispose());

  const CASES = [
    ['zero options', []],
    ['nine options', Array.from({ length: 9 }, (_, i) => `opt-${i}`)],
    ['non-string option', ['Option A', 42]],
  ];

  for (const [label, options] of CASES) {
    test(`${label}: real pi dialog cancelled, nothing renderable persists, safe notify`, async () => {
      await host.startSession('s1');
      const adapter = adapters.get('s1');
      const events = [];
      host.onHostEvent((event) => events.push(event));

      adapter.emitUi({ id: 'ui-bad', method: 'select', title: 'Bad', options });

      assert.deepEqual(adapter.uiResponses, [{ id: 'ui-bad', response: { cancelled: true } }], 'the actual pi dialog is cancelled');
      assert.equal(store.listRecoverableRequests().length, 0, 'no request persisted for unrenderable options');
      assert.equal(store.listPendingOutbox().some((r) => r.kind === 'approval_request'), false, 'no approval row enqueued');
      const notification = store.listPendingOutbox().find((r) => r.kind === 'notification');
      assert.ok(notification, 'a safe fixed notification was enqueued');
      const message = typeof notification.payload.message === 'string' ? notification.payload.message : '';
      assert.ok(/option/i.test(message), 'notification mentions the fixed reason');
      for (const option of options) {
        if (typeof option === 'string') {
          assert.ok(!message.includes(option), 'option values never leak into the notify');
        }
      }
      assert.ok(events.some((e) => e.kind === 'dialog_rejected' && e.reason === 'unrenderable_options'), 'host event with the fixed reason');
    });
  }
});

// T04r: startup failure cleanup + demo/tool lifecycle ambiguity refusal.
describe('session-host: startup failure cleanup (no orphan Pi)', () => {
  test('startSession disposes the freshly spawned adapter when adapter.start() fails', async () => {
    const ctx = setup();
    const { host, adapters } = ctx;
    const factoryAdapter = new FakeAdapter('bad');
    factoryAdapter.startImpl = () => Promise.reject(new Error('spawn ok but probe failed'));
    factoryAdapter.start = function () { return this.startImpl(); };
    const disposed = [];
    factoryAdapter.dispose = async () => { disposed.push(true); };
    const failing = new SessionHost({
      store: ctx.store,
      ownerId: 'cleanup-test',
      pid: 999,
      adapterFactory: () => factoryAdapter,
      now: () => T0,
    });
    await assert.rejects(() => failing.startSession('s-bad'));
    assert.equal(disposed.length, 1, 'the new adapter must be disposed before the error escapes');
    await failing.dispose();
    await host.dispose();
  });

  test('startSession disposes the freshly spawned adapter when session registration fails', async () => {
    const ctx = setup();
    const { host, store, adapters } = ctx;
    const disposed = [];
    const failing = new SessionHost({
      store,
      ownerId: 'cleanup-test-2',
      pid: 999,
      adapterFactory: () => {
        const a = new FakeAdapter('regfail');
        a.dispose = async () => { disposed.push(true); };
        return a;
      },
      now: () => T0,
    });
    store.createSession = () => { throw new Error('db write failed'); };
    await assert.rejects(() => failing.startSession('s-regfail'));
    assert.equal(disposed.length, 1, 'registration failure must dispose the new adapter');
    await failing.dispose();
    await host.dispose();
  });
});

describe('session-host: demo vs real tool lifecycle ambiguity refusal', () => {
  test('a dialog arriving while BOTH a demo and a real tool are open is refused, never classified as demo', async () => {
    const { store, host, adapters } = setup();
    const hostEvents = [];
    host.onHostEvent((event) => hostEvents.push(event));
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    // Host starts the fixed local demo lifecycle (no real tool open yet).
    const demo = host.startDemo('s1');
    assert.equal(demo.ok, true);
    await new Promise((resolve) => setImmediate(resolve));
    // A REAL awaited question tool starts while the demo is pending.
    adapter.emitEvent({ type: 'tool_execution_start', toolName: 'bridge_decision', toolCallId: 't1' });
    // A UI select arrives: it is ambiguous (demo or real tool?).
    adapter.emitUi({ id: 'ui-amb', method: 'select', title: 'Ambiguous', options: ['A', 'B'] });
    host.tick(T0 + 1_000);
    const outbox = store.listPendingOutbox();
    const approvalRequests = outbox.filter((r) => r.kind === 'approval_request');
    assert.equal(approvalRequests.length, 0, 'an ambiguous dialog must never become an answerable request');
    assert.ok(hostEvents.some((e) => e.kind === 'dialog_ambiguous_refused'),
      'the refusal must be observed as a host event');
    assert.ok(hostEvents.some((e) => e.kind === 'demo_abandoned_ambiguous'),
      'the demo lifecycle must be abandoned so real dialogs classify cleanly');
    await host.dispose();
  });

  test('startDemo is refused while a real tool question is in flight', async () => {
    const { host, adapters } = setup();
    await host.startSession('s1');
    const adapter = adapters.get('s1');
    adapter.emitEvent({ type: 'tool_execution_start', toolName: 'bridge_decision', toolCallId: 't1' });
    const demo = host.startDemo('s1');
    assert.deepEqual(demo, { ok: false, reason: 'session_busy_real_tool' });
    await host.dispose();
  });
});
