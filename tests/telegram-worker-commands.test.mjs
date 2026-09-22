// T03 WU3: worker commands, followups and free-text input routing.
// /start can only show help (no model call); free text dispatches ONLY when
// exactly one text-input request awaits (two sessions = ambiguous, fail
// closed); followups are disabled by default and are refused when they
// contain line-start slash commands; /cancel is deduplicated and correlates
// the exact request.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store.mjs';
import { TelegramWorker } from '../src/telegram-worker.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const T0 = 1_700_000_000_000;
const USER_ID = 777000;
const CHAT_ID = -100123;

function makeStubApi() {
  const calls = [];
  return {
    calls,
    async sendMessage(params) { calls.push({ api: 'sendMessage', ...params }); return { message_id: calls.length }; },
    async answerCallbackQuery(params) { calls.push({ api: 'answerCallbackQuery', ...params }); return true; },
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
    ownerId: 'test-worker',
    pid: 4242,
    now: () => T0,
    ...overrides,
  });
}

function text(updateId, body) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: USER_ID, is_bot: false },
      chat: { id: CHAT_ID, type: 'private' },
      text: body,
    },
  };
}

async function drainAll(storeRef, worker) {
  for (let i = 0; i < 50 && storeRef.listPendingOutbox().length > 0; i++) {
    await worker.drainOnce();
  }
}

function lastReplyText(calls) {
  return calls.filter((c) => c.api === 'sendMessage').map((c) => c.text).join('\n---\n');
}

describe('worker: commands', () => {
  let store;
  let api;
  let worker;
  beforeEach(() => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-cmd-'));
    store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    api = makeStubApi();
    worker = makeWorker(store, api);
  });

  test('/start and /help only show help: no actions, no host interaction', async () => {
    await worker.handleUpdate(text(1, '/start'));
    await worker.handleUpdate(text(2, '/help'));
    const replies = store.listPendingOutbox().filter((r) => r.kind === 'tg_text');
    assert.equal(replies.length, 2);
    assert.match(replies[0].payload.text, /help/i);
    for (const owner of ['host-1', 'worker-x']) {
      assert.equal(store.claimNextAction({ ownerId: owner }).ok, false, 'no host action queued');
    }
  });

  test('/status reports sessions and pending states from the store only', async () => {
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    await worker.handleUpdate(text(3, '/status'));
    await drainAll(store, worker);
    assert.match(lastReplyText(api.calls), /s1/);
    assert.doesNotMatch(lastReplyText(api.calls), /pi-1/, 'raw pi session id is not public metadata');
  });

  test('/pending lists waiting decisions and the empty case', async () => {
    await worker.handleUpdate(text(4, '/pending'));
    await drainAll(store, worker);
    assert.match(lastReplyText(api.calls), /no pending/i);
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const req = store.createRequest({ sessionId: 's1', action: { kind: 'dialog', method: 'confirm', title: 'Write file?' } });
    store.markWaitingDecision(req.request.requestId);
    await worker.handleUpdate(text(5, '/pending'));
    await drainAll(store, worker);
    assert.match(lastReplyText(api.calls), new RegExp(req.request.requestId));
    assert.match(lastReplyText(api.calls), /Write file\?/);
  });

  test('/details renders only stored bounded data; unknown id fails fixed', async () => {
    await worker.handleUpdate(text(6, '/details deadbeefdeadbeefdeadbeefdeadbeef'));
    await drainAll(store, worker);
    assert.match(lastReplyText(api.calls), /not found/i);
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const req = store.createRequest({
      sessionId: 's1',
      action: { kind: 'dialog', method: 'select', title: 'Pick', options: ['Option A', 'Option B'] },
    });
    await worker.handleUpdate(text(7, `/details ${req.request.requestId}`));
    await drainAll(store, worker);
    const rendered = lastReplyText(api.calls);
    assert.match(rendered, /Option A/);
    assert.match(rendered, /Option B/);
    assert.match(rendered, /select/);
    assert.doesNotMatch(rendered, /uiId/, 'internal ui ids are not public data');
  });

  test('/cancel enqueues exactly one cancel action (deduplicated) and answers queued', async () => {
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const req = store.createRequest({ sessionId: 's1', action: { kind: 'dialog', method: 'confirm' } });
    store.markWaitingDecision(req.request.requestId);
    const id = req.request.requestId;
    await worker.handleUpdate(text(8, `/cancel ${id}`));
    await worker.handleUpdate(text(9, `/cancel ${id}`));
    const claim = store.claimNextAction({ ownerId: 'host-1' });
    assert.equal(claim.ok, true);
    assert.equal(claim.action.type, 'cancel');
    assert.equal(claim.action.payload.requestId, id);
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false, 'second /cancel deduplicates');
  });

  test('/cancel on a finished request is refused', async () => {
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const req = store.createRequest({ sessionId: 's1', action: { kind: 'dialog', method: 'confirm' } });
    store.markWaitingDecision(req.request.requestId);
    const id = req.request.requestId;
    store.failRequest({ requestId: id, sessionId: 's1', reason: { error: 'test' } });
    await worker.handleUpdate(text(10, `/cancel ${id}`));
    await drainAll(store, worker);
    assert.match(lastReplyText(api.calls), /no longer active/i);
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false);
  });

  test('unknown slash commands get help, never an implicit dispatch', async () => {
    await worker.handleUpdate(text(11, '/frobnicate now'));
    await drainAll(store, worker);
    assert.match(lastReplyText(api.calls), /help/i);
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false);
  });
});

describe('worker: followups', () => {
  let store;
  let api;
  let worker;
  beforeEach(() => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-fup-'));
    store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    api = makeStubApi();
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    worker = makeWorker(store, api);
  });

  test('followups are disabled by default: fixed refusal, nothing queued', async () => {
    await worker.handleUpdate(text(20, '/followup s1 continue the task'));
    await drainAll(store, worker);
    assert.match(lastReplyText(api.calls), /disabled/i);
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false);
  });

  test('explicitly enabled: constrained followup queues a typed action, no model call', async () => {
    const enabled = makeWorker(store, api, { followupsEnabled: true });
    await enabled.handleUpdate(text(21, '/followup s1 continue the task'));
    await drainAll(store, enabled);
    assert.match(lastReplyText(api.calls), /queued/i);
    const claim = store.claimNextAction({ ownerId: 'host-1' });
    assert.equal(claim.ok, true);
    assert.equal(claim.action.type, 'followup');
    assert.equal(claim.action.payload.sessionId, 's1');
    assert.equal(claim.action.payload.text, 'continue the task');
    // No API call can trigger a model: the worker only ever enqueues.
    assert.ok(api.calls.every((c) => ['sendMessage', 'answerCallbackQuery'].includes(c.api)));
  });

  test('enabled: line-start slash in the followup text is refused by the worker', async () => {
    const enabled = makeWorker(store, api, { followupsEnabled: true });
    await enabled.handleUpdate(text(22, '/followup s1\n/help'));
    await drainAll(store, enabled);
    assert.match(lastReplyText(api.calls), /refused/i);
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false);
  });

  test('enabled: multi-line slash at any line start is refused', async () => {
    const enabled = makeWorker(store, api, { followupsEnabled: true });
    await enabled.handleUpdate(text(23, '/followup s1 do this\n/bridge-demo 123'));
    await drainAll(store, enabled);
    assert.match(lastReplyText(api.calls), /refused/i);
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false);
  });

  test('enabled: unknown session fails closed', async () => {
    const enabled = makeWorker(store, api, { followupsEnabled: true });
    await enabled.handleUpdate(text(24, '/followup ghost hello'));
    await drainAll(store, enabled);
    assert.match(lastReplyText(api.calls), /not found|unknown/i);
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false);
  });

  test('enabled: identical followup text deduplicates (stable action id)', async () => {
    const enabled = makeWorker(store, api, { followupsEnabled: true });
    await enabled.handleUpdate(text(25, '/followup s1 continue'));
    await enabled.handleUpdate(text(26, '/followup s1 continue'));
    const first = store.claimNextAction({ ownerId: 'host-1' });
    assert.equal(first.ok, true);
    assert.equal(first.action.type, 'followup');
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false, 'duplicate text must not queue twice');
  });
});

describe('worker: free text routing', () => {
  let store;
  let api;
  let worker;
  beforeEach(() => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-free-'));
    store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    api = makeStubApi();
    worker = makeWorker(store, api);
  });

  function seedInputRequest(sessionId = 's1') {
    store.createSession({ sessionId, piSessionId: `pi-${sessionId}` });
    const req = store.createRequest({
      sessionId,
      action: { kind: 'dialog', method: 'input', title: 'Provide value' },
      ttlMs: 600000,
    });
    store.markWaitingDecision(req.request.requestId);
    return req.request;
  }

  test('exactly one awaiting input request: free text becomes its value', async () => {
    const req = seedInputRequest('s1');
    await worker.handleUpdate(text(30, 'my custom value'));
    const claim = store.claimNextAction({ ownerId: 'host-1' });
    assert.equal(claim.ok, true);
    assert.equal(claim.action.type, 'decision');
    assert.equal(claim.action.payload.requestId, req.requestId);
    assert.deepEqual(claim.action.payload.decision, { value: 'my custom value' });
  });

  test('no awaiting input: explicit guidance, never implicit dispatch', async () => {
    await worker.handleUpdate(text(31, 'just some words'));
    await drainAll(store, worker);
    assert.match(lastReplyText(api.calls), /followup/i);
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false);
  });

  test('two pending sessions with input requests: ambiguity fails closed', async () => {
    seedInputRequest('s1');
    seedInputRequest('s2');
    await worker.handleUpdate(text(32, 'which session am I answering?'));
    await drainAll(store, worker);
    assert.match(lastReplyText(api.calls), /followup|ambiguous/i);
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false, 'never guess a session');
  });

  test('free text containing a line-start slash is refused (host mirrors this)', async () => {
    seedInputRequest('s1');
    await worker.handleUpdate(text(33, 'please answer\n/bridge-demo abc'));
    await drainAll(store, worker);
    assert.match(lastReplyText(api.calls), /refused/i);
    assert.equal(store.claimNextAction({ ownerId: 'host-1' }).ok, false);
  });

  test('expired input request does not capture free text', async () => {
    const req = seedInputRequest('s1');
    store.expireRequests(T0 + 600_001);
    const late = makeWorker(store, api, { now: () => T0 + 600_002 });
    await late.handleUpdate(text(34, 'too late'));
    await drainAll(store, late);
    assert.match(lastReplyText(api.calls), /followup/i);
    assert.equal(store.getRequest(req.requestId).state, 'expired');
  });
});

describe('worker: inbound rate limiting', () => {
  test('flooded owner gets offset advances but no replies', async () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-rate-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    const api = makeStubApi();
    const worker = makeWorker(store, api, {
      config: {
        telegram: { allowedUserId: String(USER_ID), allowedChatId: String(CHAT_ID) },
        bridge: { maxMessageChars: 3800, rateLimit: { max: 2, windowMs: 60000 } },
      },
    });
    await worker.handleUpdate(text(40, '/help'));
    await worker.handleUpdate(text(41, '/help'));
    await worker.handleUpdate(text(42, '/help'));
    const replies = store.listPendingOutbox().filter((r) => r.kind === 'tg_text');
    assert.equal(replies.length, 2, 'third update inside the window is dropped (no reply)');
    assert.equal(store.getTransportOffset(), 43, 'receipt still persisted + offset advanced');
  });
});
