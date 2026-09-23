// T03 WU1: narrow Store IPC additions for the Telegram worker.
// - Worker singleton lease DISTINCT from the host lease (same PID-liveness
//   takeover semantics; a live host lease never blocks the worker lease).
// - Single-use opaque callback tokens bound to an immutable request +
//   decision payload (CAS consumed exactly once).
// - Outbox delivery bookkeeping (attempts, definitive failure with a fixed
//   error code) so an uncertain Telegram send never silently loses a
//   pending question.
// - withTransaction: one atomic unit for update receipt + action + outbox
//   + offset advance (offset may only move after durable handling).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../src/store.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const T0 = 1_700_000_000_000;

describe('store: worker lease distinct from host lease', () => {
  test('a live host lease does not block the worker lease', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-lease-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    try {
      const host = store.acquireHostLease({ ownerId: 'host-1', pid: 111 });
      assert.equal(host.ok, true);
      const worker = store.acquireWorkerLease({ ownerId: 'worker-1', pid: 222 });
      assert.equal(worker.ok, true, 'worker lease must be independent of the host lease');
    } finally {
      store.close();
    }
  });

  test('worker lease is singleton: a second live pid is rejected', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-lease-'));
    const store = new Store(join(dir, 'main.sqlite'), {
      now: () => T0,
      isProcessAlive: (pid) => pid === 222,
    });
    try {
      assert.equal(store.acquireWorkerLease({ ownerId: 'w1', pid: 222 }).ok, true);
      const second = store.acquireWorkerLease({ ownerId: 'w2', pid: 333 });
      assert.equal(second.ok, false);
      assert.equal(second.reason, 'lease_busy');
    } finally {
      store.close();
    }
  });

  test('worker lease takeover only from a verifiably dead pid', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-lease-'));
    const store = new Store(join(dir, 'main.sqlite'), {
      now: () => T0,
      isProcessAlive: (pid) => pid !== 222,
    });
    try {
      assert.equal(store.acquireWorkerLease({ ownerId: 'w1', pid: 222 }).ok, true);
      const taken = store.acquireWorkerLease({ ownerId: 'w2', pid: 333 });
      assert.equal(taken.ok, true);
      assert.equal(taken.tookOver, true);
      assert.equal(taken.previousOwner, 'w1');
    } finally {
      store.close();
    }
  });

  test('worker lease renew and release are owner-checked', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-lease-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    try {
      store.acquireWorkerLease({ ownerId: 'w1', pid: 222 });
      assert.equal(store.renewWorkerLease({ ownerId: 'other', now: T0 + 1 }).ok, false);
      assert.equal(store.renewWorkerLease({ ownerId: 'w1', now: T0 + 1 }).ok, true);
      assert.equal(store.releaseWorkerLease({ ownerId: 'other' }).ok, false);
      assert.equal(store.releaseWorkerLease({ ownerId: 'w1' }).ok, true);
      // Released: a new worker can acquire.
      assert.equal(store.acquireWorkerLease({ ownerId: 'w2', pid: 333 }).ok, true);
    } finally {
      store.close();
    }
  });

  test('host lease release does not release the worker lease', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-lease-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    try {
      store.acquireHostLease({ ownerId: 'host-1', pid: 111 });
      store.acquireWorkerLease({ ownerId: 'worker-1', pid: 222 });
      store.releaseHostLease({ ownerId: 'host-1' });
      assert.equal(store.renewWorkerLease({ ownerId: 'worker-1', now: T0 + 1 }).ok, true);
    } finally {
      store.close();
    }
  });
});

describe('store: single-use callback tokens', () => {
  let store;
  let requestId;
  beforeEach(() => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-token-'));
    store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    requestId = store.createRequest({
      sessionId: 's1',
      action: { kind: 'dialog', method: 'select', options: ['A', 'B'] },
    }).request.requestId;
  });

  test('create binds request + decision immutably; consume is exactly once', () => {
    const created = store.createCallbackToken({
      requestId,
      kind: 'decision',
      decision: { value: 'A' },
    });
    assert.equal(created.ok, true);
    assert.match(created.token, /^[0-9a-f]{32}$/);
    assert.ok(Buffer.byteLength(created.token, 'utf8') <= 64, 'token must fit Telegram 64-byte callback data');

    const first = store.consumeCallbackToken({ token: created.token, now: T0 + 1 });
    assert.equal(first.ok, true);
    assert.equal(first.kind, 'decision');
    assert.equal(first.requestId, requestId);
    assert.deepEqual(first.decision, { value: 'A' });

    const second = store.consumeCallbackToken({ token: created.token, now: T0 + 2 });
    assert.equal(second.ok, false, 'a token is single-use');
  });

  test('unknown token and malformed input fail closed', () => {
    assert.equal(store.consumeCallbackToken({ token: 'deadbeef', now: T0 }).ok, false);
    const missing = store.createCallbackToken({ requestId: 'nope', kind: 'decision', decision: { value: 'A' } });
    assert.equal(missing.ok, false);
    const badDecision = store.createCallbackToken({ requestId, kind: 'decision', decision: null });
    assert.equal(badDecision.ok, false);
  });

  test('non-decision kinds need no decision payload; decision kind validates', () => {
    const details = store.createCallbackToken({ requestId, kind: 'details' });
    assert.equal(details.ok, true);
    const cancel = store.createCallbackToken({ requestId, kind: 'cancel' });
    assert.equal(cancel.ok, true);
    const consumed = store.consumeCallbackToken({ token: details.token, now: T0 + 1 });
    assert.equal(consumed.ok, true);
    assert.equal(consumed.kind, 'details');
  });
});

describe('store: outbox delivery bookkeeping', () => {
  test('attempts increment and definitive failure stops pending delivery', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-outbox-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    try {
      const id = store.enqueueOutbox({ kind: 'tg_keyboard', payload: { requestId: 'r1' } });
      assert.equal(store.incrementOutboxAttempts(id).attempts, 1);
      assert.equal(store.incrementOutboxAttempts(id).attempts, 2);

      store.markOutboxFailed(id, 'send_failed');
      const pending = store.listPendingOutbox();
      assert.equal(pending.length, 0, 'a definitively failed row leaves the pending queue');
    } finally {
      store.close();
    }
  });

  test('listPendingOutbox surfaces attempts for bounded retries', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-outbox-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    try {
      const id = store.enqueueOutbox({ kind: 'tg_text', payload: { text: 'x' } });
      store.incrementOutboxAttempts(id);
      const pending = store.listPendingOutbox();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].attempts, 1);
    } finally {
      store.close();
    }
  });

  test('legacy outbox schema (without new columns) is migrated on open', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-outbox-'));
    const dbPath = join(dir, 'legacy.sqlite');
    {
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE outbox (
          outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          delivered_at INTEGER
        );
      `);
      legacy.prepare(
        `INSERT INTO outbox (request_id, kind, payload_json, created_at) VALUES ('r', 'tg_text', '{}', 1)`,
      ).run();
      legacy.close();
    }
    const store = new Store(dbPath, { now: () => T0 });
    try {
      const pending = store.listPendingOutbox();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].attempts, 0);
      assert.equal(store.incrementOutboxAttempts(pending[0].outboxId).attempts, 1);
      store.markOutboxFailed(pending[0].outboxId, 'send_failed');
      assert.equal(store.listPendingOutbox().length, 0);
    } finally {
      store.close();
    }
  });
});

describe('store: inbox schema is a dedup ledger, not a work queue', () => {
  test('fresh schema has no processed_at column and no markInboxProcessed method', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-inbox-schema-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    const dbPath = join(dir, 'main.sqlite');
    try {
      assert.equal(
        typeof store.markInboxProcessed,
        'undefined',
        'markInboxProcessed must not exist: dedup is by primary key via recordInbox',
      );
      assert.equal(store.recordInbox({ inboxId: 'tg:1', kind: 'message', payload: {} }), true);
    } finally {
      store.close();
    }
    const db = new DatabaseSync(dbPath);
    try {
      const columns = db.prepare('PRAGMA table_info(inbox)').all().map((row) => row.name);
      assert.ok(
        !columns.includes('processed_at'),
        `processed_at must not exist in a fresh schema; columns: ${columns.join(',')}`,
      );
    } finally {
      db.close();
    }
  });
});

describe('store: atomic transport update unit', () => {
  test('withTransaction commits inbox + action + outbox + offset together', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-tx-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    try {
      store.withTransaction(() => {
        assert.equal(store.recordInbox({ inboxId: 'tg:7', kind: 'message', payload: { type: 'message' } }), true);
        store.enqueueAction({ actionId: 'cb:x', type: 'decision', payload: { requestId: 'r', decision: { confirmed: true } } });
        store.enqueueOutbox({ kind: 'tg_text', payload: { text: 'ack' } });
        store.advanceTransportOffset(8);
      });
      assert.equal(store.getTransportOffset(), 8);
      assert.equal(store.listPendingOutbox().length, 1);
    } finally {
      store.close();
    }
  });

  test('a failure inside withTransaction rolls back receipt, action and offset', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-tx-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    try {
      assert.throws(() => {
        store.withTransaction(() => {
          store.recordInbox({ inboxId: 'tg:7', kind: 'message', payload: { type: 'message' } });
          store.enqueueAction({ actionId: 'cb:x', type: 'decision', payload: {} });
          store.advanceTransportOffset(8);
          throw new Error('send planning failed');
        });
      }, /send planning failed/);
      // Nothing persisted: the offset must not advance past unhandled work.
      assert.equal(store.getTransportOffset(), 0);
      // Retry of the same update is a first sighting again.
      store.withTransaction(() => {
        assert.equal(store.recordInbox({ inboxId: 'tg:7', kind: 'message', payload: { type: 'message' } }), true);
        store.advanceTransportOffset(8);
      });
      assert.equal(store.getTransportOffset(), 8);
    } finally {
      store.close();
    }
  });

  test('duplicate inbox id inside a transaction is still a no-op', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-tx-'));
    const store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
    try {
      store.recordInbox({ inboxId: 'tg:1', kind: 'message', payload: { type: 'message' } });
      store.withTransaction(() => {
        assert.equal(store.recordInbox({ inboxId: 'tg:1', kind: 'message', payload: { type: 'message' } }), false);
      });
    } finally {
      store.close();
    }
  });
});

describe('outbox request summary (worker dispatch guard + recovery)', () => {
  let store;
  beforeEach(() => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-sum-'));
    store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
  });
  afterEach(() => store.close());

  test('counts text and keyboard rows by delivery state for one request', () => {
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const req = store.createRequest({ sessionId: 's1', action: { kind: 'dialog', method: 'confirm' } });
    const requestId = req.request.requestId;
    store.enqueueOutbox({ requestId, kind: 'tg_text', payload: { text: 'a' } });
    store.enqueueOutbox({ requestId, kind: 'tg_text', payload: { text: 'b' } });
    store.enqueueOutbox({ requestId, kind: 'tg_keyboard', payload: { requestId, replyMarkup: {} } });
    assert.deepEqual(store.outboxRequestSummary(requestId), {
      totalText: 2, failedText: 0, totalKeyboard: 1, failedKeyboard: 0,
    });
    // Deliver one chunk, fail the other, fail the keyboard.
    const pending = store.listPendingOutbox();
    store.markOutboxDelivered(pending[0].outboxId);
    store.markOutboxFailed(pending[1].outboxId, 'forbidden');
    store.markOutboxFailed(pending[2].outboxId, 'network');
    assert.deepEqual(store.outboxRequestSummary(requestId), {
      totalText: 2, failedText: 1, totalKeyboard: 1, failedKeyboard: 1,
    });
  });

  test('unknown request id yields an all-zero summary', () => {
    assert.deepEqual(store.outboxRequestSummary('deadbeef'), {
      totalText: 0, failedText: 0, totalKeyboard: 0, failedKeyboard: 0,
    });
  });
});

describe('store: per-render outbox batch summary (D1)', () => {
  let store;
  beforeEach(() => {
    const dir = mkdtempSync(join(TEST_RUNS, 't03-batch-'));
    store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
  });
  afterEach(() => store.close());

  test('counts only tg_text rows of the exact batch, independent of request history', () => {
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const req = store.createRequest({ sessionId: 's1', action: { kind: 'dialog', method: 'confirm' } });
    const requestId = req.request.requestId;
    // Old batch: a permanently failed chunk (must never block a new batch).
    store.enqueueOutbox({ requestId, kind: 'tg_text', payload: { text: 'old' }, batchId: 'batch-old' });
    const oldPending = store.listPendingOutbox();
    store.markOutboxFailed(oldPending[0].outboxId, 'forbidden');
    // New batch: two fresh chunks, one delivered one pending.
    store.enqueueOutbox({ requestId, kind: 'tg_text', payload: { text: 'new-1' }, batchId: 'batch-new' });
    store.enqueueOutbox({ requestId, kind: 'tg_text', payload: { text: 'new-2' }, batchId: 'batch-new' });
    store.enqueueOutbox({ requestId, kind: 'tg_keyboard', payload: { requestId, batchId: 'batch-new', replyMarkup: {} }, batchId: 'batch-new' });
    store.markOutboxDelivered(store.listPendingOutbox().find((r) => r.payload.text === 'new-1').outboxId);
    assert.deepEqual(store.outboxBatchSummary('batch-new'), { total: 2, delivered: 1, failed: 0 });
    assert.deepEqual(store.outboxBatchSummary('batch-old'), { total: 1, delivered: 0, failed: 1 });
  });

  test('keyboard rows and non-text kinds are excluded from batch context counts', () => {
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    store.enqueueOutbox({ requestId: null, kind: 'tg_keyboard', payload: { requestId: null, batchId: 'b1', replyMarkup: {} }, batchId: 'b1' });
    store.enqueueOutbox({ requestId: null, kind: 'tg_callback', payload: { callbackQueryId: 'x' }, batchId: 'b1' });
    assert.deepEqual(store.outboxBatchSummary('b1'), { total: 0, delivered: 0, failed: 0 });
  });

  test('rejects invalid batch ids and unknown batch yields zeros', () => {
    assert.deepEqual(store.outboxBatchSummary('nope'), { total: 0, delivered: 0, failed: 0 });
    assert.throws(() => store.outboxBatchSummary(''), RangeError);
    assert.throws(() => store.outboxBatchSummary(123), RangeError);
  });
});
