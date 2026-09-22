// T03 WU3: worker update classification + authorization. Both numeric user
// AND chat must match (security.authorize); unauthorized senders get NO
// reply and NO answerCallbackQuery, and only a fixed rejection code is
// observable. Update receipt is persisted atomically BEFORE the offset
// advances, so a re-delivered update never causes a repeated decision.

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
    async sendMessage(params) {
      calls.push({ api: 'sendMessage', ...params });
      return { message_id: calls.length };
    },
    async answerCallbackQuery(params) {
      calls.push({ api: 'answerCallbackQuery', ...params });
      return true;
    },
    async getWebhookInfo() { return { url: '', pending_update_count: 0 }; },
    async getMe() { return { id: 42, is_bot: true, username: 'fake_bot' }; },
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

function userMessage(updateId, text, overrides = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: USER_ID, is_bot: false, first_name: 'Owner' },
      chat: { id: CHAT_ID, type: 'private' },
      text,
      ...overrides.message,
    },
    ...overrides.update,
  };
}

function callbackQuery(updateId, data, overrides = {}) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq${updateId}`,
      from: { id: USER_ID, is_bot: false, first_name: 'Owner' },
      chat_instance: 'ci',
      message: {
        message_id: 500,
        from: { id: 42, is_bot: true },
        chat: { id: CHAT_ID, type: 'private' },
      },
      data,
      ...overrides.callback,
    },
    ...overrides.update,
  };
}

describe('worker: atomic update handling and authorization', () => {
  let store;
  let api;
  let worker;
  let codes;
  beforeEach(() => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-auth-'));
    store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    api = makeStubApi();
    codes = [];
    worker = makeWorker(store, api, { logger: ({ code }) => codes.push(code) });
  });

  test('authorized /help produces exactly one durable reply and advances the offset', async () => {
    await worker.handleUpdate(userMessage(1, '/help'));
    const pending = store.listPendingOutbox();
    assert.equal(pending.length, 1, 'exactly one reply row enqueued');
    assert.equal(pending[0].kind, 'tg_text');
    assert.equal(pending[0].requestId, null);
    assert.equal(store.getTransportOffset(), 2, 'offset advances only after durable handling');
    assert.equal(api.calls.length, 0, 'handleUpdate never sends directly; the drain does');
  });

  test('user/chat mismatch is denied silently: no reply, no identities in the log', async () => {
    await worker.handleUpdate(userMessage(2, '/cancel whatever', {
      message: { from: { id: 111 } },
    }));
    assert.equal(store.listPendingOutbox().length, 0, 'no reply to unauthorized senders');
    assert.equal(store.getTransportOffset(), 3, 'receipt still persisted + offset advanced');
    assert.deepEqual(codes, ['auth_rejected'], 'only the fixed rejection code is observable');
    await worker.handleUpdate(userMessage(3, '/help', { message: { chat: { id: -999 } } }));
    assert.deepEqual(codes, ['auth_rejected', 'auth_rejected']);
    assert.equal(store.listPendingOutbox().length, 0);
  });

  test('sender_chat (channel/anonymous impersonation) is rejected silently', async () => {
    await worker.handleUpdate(userMessage(4, '/help', {
      message: { sender_chat: { id: CHAT_ID } },
    }));
    assert.equal(store.listPendingOutbox().length, 0);
    assert.deepEqual(codes, ['auth_rejected']);
  });

  test('inline-mode callback (no message/chat) is rejected silently without answering', async () => {
    await worker.handleUpdate(callbackQuery(5, 'deadbeef', {
      callback: { message: undefined },
    }));
    assert.equal(store.listPendingOutbox().length, 0, 'no answerCallbackQuery, no reply');
    assert.equal(store.getTransportOffset(), 6);
    assert.ok(codes.every((c) => c === 'callback_missing_chat' || c === 'auth_rejected'));
  });

  test('callback from a mismatched user never receives answerCallbackQuery', async () => {
    await worker.handleUpdate(callbackQuery(6, 'deadbeef', {
      callback: { from: { id: 111 } },
    }));
    assert.equal(store.listPendingOutbox().length, 0);
    assert.deepEqual(codes, ['auth_rejected']);
  });

  test('edited/channel/business/unknown update types are persisted and skipped', async () => {
    await worker.handleUpdate({ update_id: 7, edited_message: { text: 'x' } });
    await worker.handleUpdate({ update_id: 8, channel_post: { text: 'x' } });
    await worker.handleUpdate({ update_id: 9, business_message: { text: 'x' } });
    await worker.handleUpdate({ update_id: 10, unknown_thing: {} });
    for (const id of [7, 8, 9, 10]) {
      assert.equal(store.getTransportOffset() >= id + 1, true, `update ${id} must be consumed`);
    }
    assert.equal(store.listPendingOutbox().length, 0, 'no replies for skipped types');
    assert.ok(codes.every((c) => c === 'update_rejected'));
  });

  test('re-delivered update (same update_id) causes no repeated decision or reply', async () => {
    await worker.handleUpdate(userMessage(11, '/help'));
    assert.equal(store.listPendingOutbox().length, 1);
    await worker.handleUpdate(userMessage(11, '/help'));
    assert.equal(store.listPendingOutbox().length, 1, 'recovery must not duplicate the reply');
    assert.equal(store.getTransportOffset(), 12, 'offset never regresses');
  });

  test('malformed updates (missing ids) are rejected without crashing', async () => {
    await worker.handleUpdate({});
    await worker.handleUpdate({ update_id: 'x', message: {} });
    await worker.handleUpdate(null);
    await worker.handleUpdate(userMessage(12, null, { message: { text: undefined } }));
    assert.equal(store.listPendingOutbox().length, 0);
    assert.ok(codes.every((c) => c === 'update_rejected' || c === 'auth_rejected' || c === 'ignore'));
  });

  test('unauthorized /cancel enqueues no action', async () => {
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const req = store.createRequest({ sessionId: 's1', action: { kind: 'dialog', method: 'confirm' } });
    await worker.handleUpdate(userMessage(13, `/cancel ${req.request.requestId}`, {
      message: { from: { id: 111 } },
    }));
    // Host queue drained by a fake host owner: nothing to claim.
    const claim = store.claimNextAction({ ownerId: 'host-check' });
    assert.equal(claim.ok, false, 'no action may be enqueued for unauthorized senders');
  });
});
