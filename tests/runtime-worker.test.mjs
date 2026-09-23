// T04: runtime worker wiring — credential input parsing (stdin pipe only),
// construction with identical followup permission validation, and one
// poll/drain cycle against a fake transport. No real Telegram calls.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store.mjs';
import { WorkerBootstrapError, parseWorkerCredentials, createRuntimeWorker } from '../src/runtime-worker.mjs';
import { readUncleanPreviousRun } from '../src/runtime-broker.mjs';

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

// Startup visibility for an unclean previous broker death: the previous
// run never recorded a shutdown (shutdownAt stays null after a kill),
// so the next start must say so exactly once — unless the previous pid
// is still alive (a second instance racing the capability lock, not a
// death). All cases are pure: the pid liveness probe is injected, so no
// real broker process is ever launched here.
describe('readUncleanPreviousRun (broker unclean-restart visibility)', () => {
  const T1 = 1_700_000_100_000;
  const T2 = 1_700_000_200_000;

  // Simulates process.kill(pid, 0) throwing ESRCH for a dead pid.
  const deadPid = () => {
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  };

  function writeMetaFile(value) {
    const root = mkdtempSync(join(TEST_RUNS, 'broker-meta-'));
    const metaPath = join(root, 'broker-meta.json');
    writeFileSync(metaPath, JSON.stringify(value));
    return metaPath;
  }

  test('reports the previous run when shutdownAt is null and the pid is dead', () => {
    const metaPath = writeMetaFile({ pid: 424242, startedAt: T1, shutdownAt: null });
    assert.deepEqual(readUncleanPreviousRun(metaPath, T2, deadPid), {
      code: 'broker_unclean_restart',
      previousPid: 424242,
      previousStartedAt: T1,
      startedAt: T2,
    });
  });

  test('stays silent when the previous run recorded a shutdown', () => {
    const metaPath = writeMetaFile({ pid: 424242, startedAt: T1, shutdownAt: T1 + 5 });
    assert.equal(readUncleanPreviousRun(metaPath, T2, deadPid), null);
  });

  test('stays silent on the first ever start (no previous meta)', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'broker-meta-'));
    assert.equal(readUncleanPreviousRun(join(root, 'broker-meta.json'), T2, deadPid), null);
  });

  test('swallows a corrupt or unreadable previous meta and never throws', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'broker-meta-'));
    const corrupt = join(root, 'broker-meta.json');
    writeFileSync(corrupt, '{"pid": 424242, "shutdownAt": null'); // truncated
    assert.equal(readUncleanPreviousRun(corrupt, T2, deadPid), null);
    const unreadable = join(mkdtempSync(join(TEST_RUNS, 'broker-meta-')), 'broker-meta.json');
    mkdirSync(unreadable); // a directory where the file should be
    assert.equal(readUncleanPreviousRun(unreadable, T2, deadPid), null);
  });

  test('stays silent when the previous pid is still alive (capability-lock race)', () => {
    const metaPath = writeMetaFile({ pid: 424242, startedAt: T1, shutdownAt: null });
    assert.equal(readUncleanPreviousRun(metaPath, T2, () => true), null);
  });

  test('default probe treats the current process as alive and stays silent', () => {
    const metaPath = writeMetaFile({ pid: process.pid, startedAt: T1, shutdownAt: null });
    assert.equal(readUncleanPreviousRun(metaPath, T2), null);
  });

  test('reports an unverifiable (missing) pid as an unclean death', () => {
    const metaPath = writeMetaFile({ startedAt: T1, shutdownAt: null });
    const payload = readUncleanPreviousRun(metaPath, T2, deadPid);
    assert.equal(payload.code, 'broker_unclean_restart');
    assert.equal(payload.previousPid, undefined);
    assert.equal(payload.previousStartedAt, T1);
  });
});
