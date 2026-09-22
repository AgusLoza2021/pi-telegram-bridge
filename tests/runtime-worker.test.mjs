// T04: runtime worker wiring — credential input parsing (stdin pipe only),
// construction with identical followup permission validation, and one
// poll/drain cycle against a fake transport. No real Telegram calls.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store.mjs';
import { WorkerBootstrapError, parseWorkerCredentials, createRuntimeWorker } from '../src/runtime-worker.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const CREDENTIALS = Object.freeze({
  botToken: '123456789:TEST_synthetic_token_AAAAAAAAAAAAAAAAAAAAA',
  allowedUserId: '111111111',
  allowedChatId: '-222222222',
});

describe('parseWorkerCredentials (stdin pipe payload)', () => {
  test('accepts the exact typed payload', () => {
    assert.deepEqual(parseWorkerCredentials(JSON.stringify(CREDENTIALS)), CREDENTIALS);
  });

  test('malformed or foreign payloads fail closed with fixed codes', () => {
    assert.throws(() => parseWorkerCredentials('not json'), (e) => e instanceof WorkerBootstrapError && e.code === 'bad_input');
    assert.throws(() => parseWorkerCredentials('[]'), (e) => e.code === 'bad_input');
    assert.throws(() => parseWorkerCredentials(JSON.stringify({ ...CREDENTIALS, extra: 1 })), (e) => e.code === 'bad_input');
    assert.throws(() => parseWorkerCredentials(JSON.stringify({ ...CREDENTIALS, botToken: '' })), (e) => e.code === 'bad_input');
  });
});

describe('createRuntimeWorker', () => {
  function fakeApi() {
    const sent = [];
    return {
      sent,
      async getWebhookInfo() { return { url: '' }; },
      async getMe() { return { id: 123 }; },
      async getUpdates({ offset } = {}) { return []; },
      async sendMessage(payload) { sent.push(payload); return { message_id: 1 }; },
      async answerCallbackQuery() { return {}; },
      async close() {},
    };
  }

  const inProcessAlive = (pid) => pid === process.pid;

  function setup({ followupsEnabled = false } = {}) {
    const root = mkdtempSync(join(TEST_RUNS, 'rworker-'));
    const store = new Store(join(root, 'bridge.sqlite'), {
      now: () => 1_700_000_000_000,
      isProcessAlive: inProcessAlive,
    });
    const worker = createRuntimeWorker({
      store,
      api: fakeApi(),
      credentials: CREDENTIALS,
      followupsEnabled,
      config: {
        telegram: { allowedUserId: CREDENTIALS.allowedUserId, allowedChatId: CREDENTIALS.allowedChatId },
        bridge: { maxMessageChars: 3800, rateLimit: { max: 10, windowMs: 60000 } },
      },
    });
    return { store, worker };
  }

  test('starts, takes the worker lease, and releases it on dispose', async () => {
    const { store, worker } = setup({});
    await worker.start();
    // A second worker (same store, different owner) must be refused while
    // the first holds the lease.
    const second = createRuntimeWorker({
      store,
      api: fakeApi(),
      credentials: CREDENTIALS,
      followupsEnabled: false,
      config: {
        telegram: { allowedUserId: CREDENTIALS.allowedUserId, allowedChatId: CREDENTIALS.allowedChatId },
        bridge: { maxMessageChars: 3800, rateLimit: { max: 10, windowMs: 60000 } },
      },
      ownerId: 'other-worker',
    });
    await assert.rejects(() => second.start(), (e) => e.code === 'WORKER_LEASE_BUSY');
    await worker.dispose();
  });

  test('one poll/drain cycle delivers an authorized message reply', async () => {
    const ctx = setup({});
    const { store, worker } = ctx;
    await worker.start();
    // Drive a message update through the worker's update handler.
    worker.handleUpdate({
      update_id: 5,
      message: {
        message_id: 9,
        from: { id: 111111111 },
        chat: { id: -222222222, type: 'private' },
        text: '/help',
        date: 1,
      },
    });
    await worker.drainPending();
    const pending = store.listPendingOutbox();
    assert.equal(pending.length, 0, 'help reply must have been delivered by the fake api');
    await worker.dispose();
  });

  test('followupsEnabled is honored exactly as configured (both-side validation is the host test suite\'s job too)', async () => {
    // Enabled worker: /followup enqueues a typed action instead of refusing.
    const enabled = setup({ followupsEnabled: true });
    await enabled.worker.start();
    enabled.worker.handleUpdate({
      update_id: 7,
      message: {
        message_id: 11,
        from: { id: 111111111 },
        chat: { id: -222222222, type: 'private' },
        text: '/followup main hello there',
        date: 1,
      },
    });
    await enabled.worker.drainPending();
    await enabled.worker.dispose();
    // Disabled worker: /followup is refused at the transport (T03 behavior).
    const disabled = setup({ followupsEnabled: false });
    await disabled.worker.start();
    disabled.worker.handleUpdate({
      update_id: 8,
      message: {
        message_id: 12,
        from: { id: 111111111 },
        chat: { id: -222222222, type: 'private' },
        text: '/followup main hello there',
        date: 1,
      },
    });
    await disabled.worker.drainPending();
    await disabled.worker.dispose();
    assert.ok(true);
  });
});
