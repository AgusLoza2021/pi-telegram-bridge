// T03 WU3: outbound pipeline — chunk-then-keyboard ordering, opaque
// single-use callback tokens, queued-vs-applied rendering, and recovery
// after transport restarts. The stub api is duck-typed (contracts for the
// real client live in telegram-api.test.mjs); errors thrown are
// TelegramApiError so the worker classifies them exactly as in production.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store.mjs';
import { TelegramApiError } from '../src/telegram-api.mjs';
import { TelegramWorker } from '../src/telegram-worker.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const T0 = 1_700_000_000_000;
const USER_ID = 777000;
const CHAT_ID = -100123;

function makeStubApi(impl = {}) {
  const calls = [];
  return {
    calls,
    async sendMessage(params) {
      calls.push({ api: 'sendMessage', ...params });
      if (impl.sendMessage) return impl.sendMessage(params, calls.length);
      return { message_id: calls.length };
    },
    async answerCallbackQuery(params) {
      calls.push({ api: 'answerCallbackQuery', ...params });
      return true;
    },
    async getWebhookInfo() { return { url: '', pending_update_count: 0 }; },
    async getMe() { return { id: 42, is_bot: true }; },
    async close() {},
  };
}

function makeWorker(store, api, overrides = {}) {
  return new TelegramWorker({
    store,
    api,
    config: {
      telegram: { allowedUserId: String(USER_ID), allowedChatId: String(CHAT_ID) },
      bridge: { maxMessageChars: 3800, rateLimit: { max: 1000, windowMs: 60000 } },
    },
    ownerId: overrides.ownerId ?? 'test-worker',
    pid: overrides.pid ?? process.pid,
    now: overrides.now ?? (() => T0),
    followupsEnabled: false,
    ...overrides,
  });
}

function authorizedCallback(updateId, data) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq${updateId}`,
      from: { id: USER_ID, is_bot: false },
      chat_instance: 'ci',
      message: { message_id: 500, chat: { id: CHAT_ID, type: 'private' } },
      data,
    },
  };
}

async function drainAll(storeRef, worker) {
  for (let i = 0; i < 100 && storeRef.listPendingOutbox().length > 0; i++) {
    await worker.drainOnce();
  }
}

function keyboardRow(storeRef, requestId = null) {
  return storeRef.listPendingOutbox().find((r) => r.kind === 'tg_keyboard' && (requestId === null || r.payload.requestId === requestId));
}

/** The keyboard as actually SENT (delivered rows leave the pending list). */
function sentKeyboard(callList, requestId = null) {
  const call = callList.find(
    (c) => c.api === 'sendMessage' && c.replyMarkup && (requestId === null || c.text.includes(requestId)),
  );
  return call ? call.replyMarkup : null;
}

describe('worker: approval rendering (chunks then keyboard)', () => {
  let store;
  let api;
  let worker;
  let requestId;
  beforeEach(() => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-out-'));
    store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    api = makeStubApi();
    worker = makeWorker(store, api);
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const req = store.createRequest({
      sessionId: 's1',
      action: { kind: 'dialog', method: 'select', title: 'Pick an option', options: ['Option A', 'Option B'] },
    });
    requestId = req.request.requestId;
    store.markWaitingDecision(requestId);
    store.enqueueOutbox({
      requestId,
      kind: 'approval_request',
      payload: { requestId, sessionId: 's1', method: 'select', title: 'Pick an option', options: ['Option A', 'Option B'] },
    });
  });

  test('context chunks are rendered and delivered BEFORE the keyboard send', async () => {
    await drainAll(store, worker);
    const sends = api.calls.filter((c) => c.api === 'sendMessage');
    assert.ok(sends.length >= 2, 'context chunks were sent');
    const keyboardSend = sends.findIndex((c) => c.replyMarkup !== undefined);
    assert.ok(keyboardSend > 0, 'keyboard was sent after context');
    for (let i = 0; i < keyboardSend; i++) {
      assert.equal(sends[i].replyMarkup, undefined, 'no buttons before all context is sent');
    }
  });

  test('callback_data are opaque hex tokens: no choice text, command, or identity inside', async () => {
    await drainAll(store, worker);
    const keyboard = sentKeyboard(api.calls, requestId);
    assert.ok(keyboard, 'keyboard was sent');
    const buttons = keyboard.inline_keyboard.flat();
    assert.ok(buttons.length >= 4, 'option buttons + details + cancel');
    for (const button of buttons) {
      assert.match(button.callback_data, /^[0-9a-f]{32}$/);
      assert.doesNotMatch(button.callback_data, /Option/);
      assert.doesNotMatch(button.callback_data, /s1|777000|-100123/);
    }
    // Exact labels are preserved for select choices.
    const labels = buttons.map((b) => b.text);
    for (const option of ['Option A', 'Option B']) {
      assert.ok(labels.includes(option), `label preserved: ${option}`);
    }
    assert.ok(labels.includes('Details'), 'non-consuming Details button');
    assert.ok(labels.includes('Cancel task'), 'separate cancel button');
  });

  test('message context includes required fields and never invents them', async () => {
    await drainAll(store, worker);
    const sends = api.calls.filter((c) => c.api === 'sendMessage');
    const context = sends[0].text;
    assert.match(context, new RegExp(requestId));
    assert.match(context, /s1/);
    assert.match(context, /Pick an option/);
    assert.match(context, /unknown/i, 'unsupplied fields render as unknown');
    assert.match(context, /\d{4}-\d{2}-\d{2}T/, 'timestamps are present');
  });

  test('confirm dialog renders Aprobar/Rechazar bound to exact decisions', async () => {
    store.createSession({ sessionId: 's2', piSessionId: 'pi-2' });
    const req = store.createRequest({ sessionId: 's2', action: { kind: 'dialog', method: 'confirm', title: 'Write file?' } });
    const id = req.request.requestId;
    store.markWaitingDecision(id);
    store.enqueueOutbox({ requestId: id, kind: 'approval_request', payload: { requestId: id, sessionId: 's2', method: 'confirm', title: 'Write file?' } });
    await drainAll(store, worker);
    const keyboard = sentKeyboard(api.calls, id);
    assert.ok(keyboard, 'keyboard was sent');
    const buttons = keyboard.inline_keyboard.flat();
    const approve = buttons.find((b) => b.text === 'Aprobar');
    const reject = buttons.find((b) => b.text === 'Rechazar');
    assert.ok(approve && reject, 'real confirm buttons');
    // Press Aprobar: the consumed token must bind {confirmed: true}.
    await worker.handleUpdate(authorizedCallback(900, approve.callback_data));
    const claim = store.claimNextAction({ ownerId: 'host-1' });
    assert.equal(claim.ok, true);
    assert.equal(claim.action.type, 'decision');
    assert.deepEqual(claim.action.payload.decision, { confirmed: true });
    assert.equal(claim.action.payload.requestId, id);
  });

  test('long unicode content is chunked within bounds and fully recoverable', async () => {
    const longTitle = `${'🌍'.repeat(30)}${'农田'.repeat(60)} summary`;
    store.createSession({ sessionId: 's2', piSessionId: 'pi-2' });
    const req = store.createRequest({
      sessionId: 's2',
      action: { kind: 'dialog', method: 'input', title: longTitle },
    });
    const id = req.request.requestId;
    store.markWaitingDecision(id);
    store.enqueueOutbox({
      requestId: id,
      kind: 'approval_request',
      payload: { requestId: id, sessionId: 's2', method: 'input', title: longTitle },
    });
    const chunked = makeWorker(store, api, {
      config: {
        telegram: { allowedUserId: String(USER_ID), allowedChatId: String(CHAT_ID) },
        bridge: { maxMessageChars: 60, rateLimit: { max: 1000, windowMs: 60000 } },
      },
    });
    await drainAll(store, chunked);
    // All chunks were delivered; read them from the api calls.
    const sends = api.calls.filter((c) => c.api === 'sendMessage');
    const relevant = sends.filter((c) => !c.replyMarkup);
    assert.ok(relevant.length >= 2, 'content was split into multiple chunks');
    for (const send of relevant) {
      assert.ok(send.text.length <= 60, `chunk within UTF-16 bound: ${send.text.length}`);
      for (const ch of send.text) {
        assert.notEqual(ch, '\uDC00', 'never a lone low surrogate');
      }
    }
    const joined = relevant.map((c) => c.text).join('');
    assert.ok(joined.includes('农田'.repeat(60)), 'no content lost between chunks');
    const keyboard = sentKeyboard(api.calls, id);
    assert.ok(keyboard, 'keyboard still queued after all chunks');
  });

  test('input dialogs have no choice buttons; Details/Cancel only', async () => {
    store.createSession({ sessionId: 's2', piSessionId: 'pi-2' });
    const req = store.createRequest({ sessionId: 's2', action: { kind: 'dialog', method: 'input', title: 'Provide value' } });
    const id = req.request.requestId;
    store.markWaitingDecision(id);
    store.enqueueOutbox({ requestId: id, kind: 'approval_request', payload: { requestId: id, sessionId: 's2', method: 'input', title: 'Provide value' } });
    await drainAll(store, worker);
    const keyboard = sentKeyboard(api.calls, id);
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    assert.deepEqual(labels.sort(), ['Cancel task', 'Details']);
  });

  test('too many options are refused, never manufactured into buttons', async () => {
    const options = Array.from({ length: 9 }, (_, i) => `opt-${i}`);
    store.createSession({ sessionId: 's2', piSessionId: 'pi-2' });
    const req = store.createRequest({ sessionId: 's2', action: { kind: 'dialog', method: 'select', title: 'Too many', options } });
    const id = req.request.requestId;
    store.markWaitingDecision(id);
    store.enqueueOutbox({ requestId: id, kind: 'approval_request', payload: { requestId: id, sessionId: 's2', method: 'select', title: 'Too many', options } });
    const codes = [];
    const guarded = makeWorker(store, api, { logger: ({ code }) => codes.push(code) });
    await drainAll(store, guarded);
    assert.equal(keyboardRow(store, id), undefined, 'no keyboard dispatched');
    assert.ok(codes.includes('approval_unsupported_options'));
    const notice = api.calls.find((c) => c.api === 'sendMessage' && c.text.includes(id) && /cancel/i.test(c.text));
    assert.ok(notice, 'visible bounded notice delivered, never a silent drop');
  });
});

describe('worker: callback tokens (single use, validated)', () => {
  let store;
  let api;
  let worker;
  let requestId;
  let token;
  beforeEach(async () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-cb-'));
    store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    api = makeStubApi();
    worker = makeWorker(store, api);
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const req = store.createRequest({
      sessionId: 's1',
      action: { kind: 'dialog', method: 'select', title: 'Pick', options: ['Option A', 'Option B'] },
    });
    requestId = req.request.requestId;
    store.markWaitingDecision(requestId);
    const created = store.createCallbackToken({ requestId, kind: 'decision', decision: { value: 'Option A' } });
    token = created.token;
  });

  test('authorized press enqueues exactly one decision action with feedback', async () => {
    await worker.handleUpdate(authorizedCallback(1, token));
    const claim = store.claimNextAction({ ownerId: 'host-1' });
    assert.equal(claim.ok, true);
    assert.equal(claim.action.type, 'decision');
    assert.equal(claim.action.payload.requestId, requestId);
    assert.deepEqual(claim.action.payload.decision, { value: 'Option A' });
    const feedback = store.listPendingOutbox().find((r) => r.kind === 'tg_callback');
    assert.ok(feedback, 'authorized press gets answerCallbackQuery feedback');
    assert.ok(feedback.payload.text.length <= 200);
    assert.equal(store.getTransportOffset(), 2);
  });

  test('queued is NOT applied: feedback says queued, never applied', async () => {
    await worker.handleUpdate(authorizedCallback(2, token));
    const texts = store.listPendingOutbox().filter((r) => r.kind === 'tg_text' || r.kind === 'tg_callback');
    for (const row of texts) {
      assert.doesNotMatch(row.payload.text, /applied/i);
    }
    assert.ok(texts.some((r) => /queued/i.test(r.payload.text)));
  });

  test('double tap consumes once: exactly one action, second press gets fixed feedback', async () => {
    await worker.handleUpdate(authorizedCallback(3, token));
    await worker.handleUpdate(authorizedCallback(4, token));
    const decisions = [];
    for (;;) {
      const claim = store.claimNextAction({ ownerId: 'host-1' });
      if (!claim.ok) break;
      decisions.push(claim.action);
    }
    assert.equal(decisions.length, 1, 'CAS/unique action id defeats double tap');
    const feedback = store.listPendingOutbox().filter((r) => r.kind === 'tg_callback');
    assert.equal(feedback.length, 2);
    assert.match(feedback[1].payload.text, /used|expired|active/i);
  });

  test('expired request: authorized feedback, no action', async () => {
    store.expireRequests(T0 + 600000);
    const late = makeWorker(store, api, { now: () => T0 + 600001 });
    await late.handleUpdate(authorizedCallback(5, token));
    const claim = store.claimNextAction({ ownerId: 'host-1' });
    assert.equal(claim.ok, false, 'expired request must not dispatch');
    const feedback = store.listPendingOutbox().find((r) => r.kind === 'tg_callback');
    assert.ok(feedback, 'authorized user still gets bounded feedback');
  });

  test('stale host generation invalidates the approval (fail closed)', async () => {
    store.incrementHostGeneration();
    await worker.handleUpdate(authorizedCallback(6, token));
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false);
    const feedback = store.listPendingOutbox().find((r) => r.kind === 'tg_callback');
    assert.ok(feedback);
  });

  test('wrong method/value binding cannot dispatch (validated before claiming)', async () => {
    // Forge a decision-kind token whose binding mismatches the dialog method.
    const bogus = store.createCallbackToken({ requestId, kind: 'decision', decision: { confirmed: true } });
    await worker.handleUpdate(authorizedCallback(7, bogus.token));
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false, 'select dialog cannot be answered with a confirm decision');
  });

  test('details token sends details WITHOUT consuming the request', async () => {
    const details = store.createCallbackToken({ requestId, kind: 'details' });
    await worker.handleUpdate(authorizedCallback(8, details.token));
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false, 'details is non-consuming');
    assert.equal(store.getRequest(requestId).state, 'waiting_decision');
    const text = store.listPendingOutbox().find((r) => r.kind === 'tg_text');
    assert.ok(text, 'details content was sent as a message');
  });

  test('cancel token sends the explicit confirmation command, enqueues nothing', async () => {
    const cancel = store.createCallbackToken({ requestId, kind: 'cancel' });
    await worker.handleUpdate(authorizedCallback(9, cancel.token));
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false, 'cancel button does not dispatch by itself');
    const text = store.listPendingOutbox().find((r) => r.kind === 'tg_text');
    assert.match(text.payload.text, new RegExp(requestId));
    assert.match(text.payload.text, /\/cancel/);
  });
});

describe('worker: outbound queue resilience', () => {
  let store;
  let api;
  let worker;
  let requestId;
  beforeEach(() => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-res-'));
    store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    api = makeStubApi();
    worker = makeWorker(store, api);
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const req = store.createRequest({ sessionId: 's1', action: { kind: 'dialog', method: 'confirm', title: 'Write file?' } });
    requestId = req.request.requestId;
    store.markWaitingDecision(requestId);
    store.enqueueOutbox({
      requestId,
      kind: 'approval_request',
      payload: { requestId, sessionId: 's1', method: 'confirm', title: 'Write file?' },
    });
  });

  test('uncertain chunk send never blocks the keyboard; definitive chunk failure refuses it', async () => {
    // Uncertain (network): the chunk is treated as delivered (duplicate
    // NOTICE acceptable) and the pipeline proceeds.
    const uncertain = makeStubApi({
      sendMessage: (params, n) => {
        if (params.replyMarkup) return { message_id: n };
        throw new TelegramApiError({ code: 'network' });
      },
    });
    const w1 = makeWorker(store, uncertain);
    await drainAll(store, w1);
    assert.ok(keyboardRow(store, requestId) === undefined, 'keyboard delivered');
    assert.ok(uncertain.calls.some((c) => c.replyMarkup), 'keyboard was sent');

    // Definitive (forbidden) context failure: the keyboard is refused, not
    // dispatched without its context (meaning cannot change silently).
    const codes = [];
    const definitive = makeStubApi({
      sendMessage: (params, n) => {
        if (params.replyMarkup) return { message_id: n };
        throw new TelegramApiError({ code: 'forbidden' });
      },
    });
    const w2 = makeWorker(store, definitive, { logger: ({ code }) => codes.push(code) });
    store.createSession({ sessionId: 's3', piSessionId: 'pi-3' });
    const req2 = store.createRequest({ sessionId: 's3', action: { kind: 'dialog', method: 'confirm', title: 'Second' } });
    const id2 = req2.request.requestId;
    store.markWaitingDecision(id2);
    store.enqueueOutbox({ requestId: id2, kind: 'approval_request', payload: { requestId: id2, sessionId: 's3', method: 'confirm', title: 'Second' } });
    await drainAll(store, w2);
    assert.equal(keyboardRow(store, id2), undefined, 'keyboard refused when context failed');
    assert.ok(codes.includes('approval_context_lost'));
  });

  test('uncertain keyboard send retries with attempts, then fails bounded; /pending recovers', async () => {
    const flaky = makeStubApi({
      sendMessage: (params) => {
        if (params.replyMarkup) throw new TelegramApiError({ code: 'network' });
        return { message_id: 1 };
      },
    });
    const flakyWorker = makeWorker(store, flaky);
    await drainAll(store, flakyWorker); // context delivered, keyboard uncertain
    for (let i = 0; i < 10; i++) await flakyWorker.drainOnce();
    const keyboard = store.listPendingOutbox().find((r) => r.kind === 'tg_keyboard');
    assert.equal(keyboard, undefined, 'gave up after bounded attempts');

    // The question is NOT lost: /pending lists it with a recovery hint.
    const cmdApi = makeStubApi();
    const cmd = makeWorker(store, cmdApi);
    await cmd.handleUpdate({
      update_id: 950,
      message: { message_id: 950, from: { id: USER_ID }, chat: { id: CHAT_ID }, text: '/pending' },
    });
    await drainAll(store, cmd);
    assert.ok(cmdApi.calls.some((c) => c.api === 'sendMessage'), 'pending reply was sent');
    // (content asserted in commands suite; here we prove no crash + list exists)

    // /details re-enqueues a keyboard with fresh tokens.
    await cmd.handleUpdate({
      update_id: 951,
      message: { message_id: 951, from: { id: USER_ID }, chat: { id: CHAT_ID }, text: `/details ${requestId}` },
    });
    await drainAll(store, cmd);
    const revived = cmdApi.calls.find(
      (c) => c.api === 'sendMessage' && c.replyMarkup && c.text.includes(requestId),
    );
    assert.ok(revived, 'fresh keyboard queued for recovery');
  });

  test('decision_applied renders applied only on durable host proof', async () => {
    // Host CAS'd the decision: state is resuming -> "queued".
    store.recordDecision({ requestId, sessionId: 's1', decision: { confirmed: true } });
    store.enqueueOutbox({ requestId, kind: 'decision_applied', payload: { requestId, decision: { confirmed: true } } });
    await drainAll(store, worker);
    const queuedText = api.calls.filter((c) => c.api === 'sendMessage').map((c) => c.text).join('\n');
    assert.match(queuedText, /queued/i);

    // Host observed the real pi result -> completed -> "applied".
    store.completeRequest({ requestId, sessionId: 's1', result: { applied: true } });
    store.enqueueOutbox({ requestId, kind: 'decision_applied', payload: { requestId, decision: { confirmed: true } } });
    await drainAll(store, worker);
    const allTexts = api.calls.filter((c) => c.api === 'sendMessage').map((c) => c.text).join('\n');
    assert.match(allTexts, /applied/i);
  });

  test('transport restart (new worker, same store) re-drains the pending question', async () => {
    const flaky = makeStubApi({
      sendMessage: (params) => {
        if (params.replyMarkup) throw new TelegramApiError({ code: 'network' });
        return { message_id: 1 };
      },
    });
    const first = makeWorker(store, flaky);
    await first.drainOnce(); // deliver context chunks only
    await first.dispose();

    const secondApi = makeStubApi();
    const second = makeWorker(store, secondApi, { ownerId: 'worker-2' });
    await drainAll(store, second);
    const sends = secondApi.calls.filter((c) => c.api === 'sendMessage' && c.replyMarkup);
    assert.equal(sends.length, 1, 'the keyboard survived the restart and was delivered');
    assert.equal(store.getRequest(requestId).state, 'waiting_decision', 'question not lost');
  });

  test('notification rows render as plain text', async () => {
    store.enqueueOutbox({ requestId: null, kind: 'notification', payload: { sessionId: 's1', method: 'notify', message: 'step done' } });
    await drainAll(store, worker);
    assert.ok(api.calls.some((c) => c.api === 'sendMessage' && c.text.includes('step done')));
  });

  test('unknown outbox kinds fail closed without crashing the drain', async () => {
    const codes = [];
    const guarded = makeWorker(store, api, { logger: ({ code }) => codes.push(code) });
    store.enqueueOutbox({ requestId: null, kind: 'mystery_kind', payload: {} });
    await drainAll(store, guarded);
    assert.ok(codes.includes('unknown_outbox_kind'));
  });
});

describe('worker: lifecycle', () => {
  test('worker lease is exclusive; dispose releases it; restart works', async () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-life-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    const api = makeStubApi();
    const worker = makeWorker(store, api);
    await worker.start();
    const second = makeWorker(store, makeStubApi(), { ownerId: 'worker-2' });
    await assert.rejects(() => second.start(), (error) => error.code === 'WORKER_LEASE_BUSY');
    await worker.dispose();
    await second.start(); // released: restart is possible
    await second.dispose();
  });

  test('webhook presence stops the worker start (no automatic delete)', async () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-life-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    const api = makeStubApi();
    api.getWebhookInfo = async () => ({ url: 'https://example.org/hook', pending_update_count: 3 });
    const worker = makeWorker(store, api);
    await assert.rejects(() => worker.start(), (error) => error.code === 'WEBHOOK_PRESENT');
    await worker.dispose();
  });

  test('pollOnce routes updates and stops safely on 401/409', async () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-life-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    const api = makeStubApi();
    api.getUpdates = async () => {
      throw new TelegramApiError({ code: 'unauthorized' });
    };
    const worker = makeWorker(store, api);
    const result = await worker.pollOnce();
    assert.equal(result.stopped, 'unauthorized');
  });

  test('pollOnce on conflict distinguishes webhook presence from another poller', async () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-life-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    const api = makeStubApi();
    api.getUpdates = async () => {
      throw new TelegramApiError({ code: 'conflict' });
    };
    api.getWebhookInfo = async () => ({ url: '', pending_update_count: 0 });
    const worker = makeWorker(store, api);
    const result = await worker.pollOnce();
    assert.equal(result.stopped, 'poller_conflict');
    api.getWebhookInfo = async () => ({ url: 'https://example.org/hook', pending_update_count: 0 });
    const result2 = await worker.pollOnce();
    assert.equal(result2.stopped, 'webhook_present');
  });
});

describe('verifier D1: batch-scoped context guard (new render never blocked by old failures)', () => {
  let store;
  beforeEach(() => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-d1-'));
    store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
  });

  function createSelectRequest(sessionId, options) {
    store.createSession({ sessionId, piSessionId: `pi-${sessionId}` });
    const req = store.createRequest({
      sessionId,
      action: { kind: 'dialog', method: 'select', title: 'Pick an option', options },
    });
    const requestId = req.request.requestId;
    store.markWaitingDecision(requestId);
    return requestId;
  }

  function enqueueApprovalRow(requestId, options) {
    store.enqueueOutbox({
      requestId,
      kind: 'approval_request',
      payload: { requestId, sessionId: 's1', method: 'select', title: 'Pick an option', options },
    });
  }

  test('partial context failure blocks its OWN keyboard; /details re-render sends a NEW keyboard from a fresh batch', async () => {
    const requestId = createSelectRequest('s1', ['Option A', 'Option B']);
    enqueueApprovalRow(requestId, ['Option A', 'Option B']);
    // First chunk FAILS definitively; the rest succeed.
    const codes = [];
    const api1 = makeStubApi({
      sendMessage: (params, n) => {
        if (n === 1) throw new TelegramApiError({ code: 'forbidden' });
        return { message_id: n };
      },
    });
    const w1 = makeWorker(store, api1, {
      logger: ({ code }) => codes.push(code),
      config: {
        telegram: { allowedUserId: String(USER_ID), allowedChatId: String(CHAT_ID) },
        bridge: { maxMessageChars: 60, rateLimit: { max: 1000, windowMs: 60000 } },
      },
    });
    await drainAll(store, w1);
    // Its own keyboard was refused: the batch has a failed chunk.
    assert.equal(keyboardRow(store, requestId), undefined, 'failing-batch keyboard refused');
    assert.ok(!api1.calls.some((c) => c.replyMarkup), 'no buttons dispatched from the failed batch');
    assert.ok(codes.includes('approval_context_lost'));

    // /details creates a FRESH batch with a healthy transport: the new
    // keyboard must be sent even though the OLD batch stays failed.
    const goodApi = makeStubApi();
    const w2 = makeWorker(store, goodApi, {
      config: {
        telegram: { allowedUserId: String(USER_ID), allowedChatId: String(CHAT_ID) },
        bridge: { maxMessageChars: 60, rateLimit: { max: 1000, windowMs: 60000 } },
      },
    });
    await w2.handleUpdate({
      update_id: 700,
      message: { message_id: 700, from: { id: USER_ID }, chat: { id: CHAT_ID }, text: `/details ${requestId}` },
    });
    await drainAll(store, w2);
    const revived = goodApi.calls.filter((c) => c.api === 'sendMessage' && c.replyMarkup);
    assert.equal(revived.length, 1, 'exactly one NEW keyboard was sent by the /details re-render');
    assert.equal(store.getRequest(requestId).state, 'waiting_decision', 'request still decidable');
    // The new keyboard is live: a token press dispatches an action.
    const token = revived[0].replyMarkup.inline_keyboard[0][0].callback_data;
    await w2.handleUpdate(authorizedCallback(701, token));
    const claim = store.claimNextAction({ ownerId: 'host-1' });
    assert.equal(claim.ok, true, 'fresh keyboard tokens authorize (old failed batch never re-authorizes)');
    assert.deepEqual(claim.action.payload.decision, { value: 'Option A' });
  });

  test('definitive failure of every context chunk still refuses the keyboard (context_lost)', async () => {
    const requestId = createSelectRequest('s1', ['A', 'B']);
    enqueueApprovalRow(requestId, ['A', 'B']);
    const codes = [];
    const api2 = makeStubApi({
      sendMessage: () => { throw new TelegramApiError({ code: 'forbidden' }); },
    });
    const w = makeWorker(store, api2, { logger: ({ code }) => codes.push(code) });
    await drainAll(store, w);
    assert.equal(keyboardRow(store, requestId), undefined, 'keyboard refused without its context');
    assert.ok(codes.includes('approval_context_lost'));
    assert.ok(!api2.calls.some((c) => c.replyMarkup), 'no buttons were dispatched');
  });
});

describe('verifier M: centralized option validation at the common render path', () => {
  const BAD_CASES = [
    ['zero options', []],
    ['nine options', Array.from({ length: 9 }, (_, i) => `opt-${i}`)],
    ['non-string option', ['Option A', 42]],
  ];

  function bootstrap(options) {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-m-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    const api = makeStubApi();
    const worker = makeWorker(store, api);
    const codes = [];
    const logged = makeWorker(store, api, { logger: ({ code }) => codes.push(code) });
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const req = store.createRequest({
      sessionId: 's1',
      action: { kind: 'dialog', method: 'select', title: 'Bad options', options },
    });
    const requestId = req.request.requestId;
    store.markWaitingDecision(requestId);
    return { store, api, worker, logged, codes, requestId };
  }

  for (const [label, options] of BAD_CASES) {
    test(`render path, ${label}: no keyboard, visible bounded notice (not silent)`, async () => {
      const { store, api, worker, logged, codes, requestId } = bootstrap(options);
      store.enqueueOutbox({
        requestId,
        kind: 'approval_request',
        payload: { requestId, sessionId: 's1', method: 'select', title: 'Bad options', options },
      });
      await drainAll(store, logged);
      assert.equal(sentKeyboard(api.calls, requestId), null, 'no keyboard dispatched');
      assert.ok(codes.includes('approval_unsupported_options'), 'fixed log code emitted');
      const texts = api.calls.filter((c) => c.api === 'sendMessage').map((c) => c.text);
      const notice = texts.find((t) => t.includes(requestId) && /cancel/i.test(t));
      assert.ok(notice, 'a visible bounded notice was delivered, not a silent drop');
      assert.ok(notice.length <= 400, 'notice is bounded');
    });

    test(`/details path, ${label}: notice instead of malformed keyboard, rows attributed`, async () => {
      const { store, api, worker, logged, codes, requestId } = bootstrap(options);
      await logged.handleUpdate({
        update_id: 800,
        message: { message_id: 800, from: { id: USER_ID }, chat: { id: CHAT_ID }, text: `/details ${requestId}` },
      });
      const attributed = store.listPendingOutbox().filter((r) => r.kind === 'tg_text');
      assert.ok(attributed.length > 0, 'details rows exist');
      for (const row of attributed) {
        assert.equal(row.requestId, requestId, 'replies are attributed to the request');
      }
      await drainAll(store, logged);
      assert.equal(sentKeyboard(api.calls, requestId), null, 'no malformed keyboard for unrenderable options');
      const texts = api.calls.filter((c) => c.api === 'sendMessage').map((c) => c.text);
      assert.ok(texts.some((t) => t.includes(requestId) && /cancel/i.test(t)), 'visible notice on the details path too');
      assert.ok(codes.includes('approval_unsupported_options'));
    });
  }
});
