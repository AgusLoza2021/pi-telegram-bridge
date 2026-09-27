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
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  MAX_TUI_RECENT_PROJECTS,
  Store,
  TUI_PROJECT_RETENTION_MS,
} from '../src/store.mjs';
import { TuiBridgeClient } from '../src/tui-bridge-client.mjs';

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

// T1 (project library): durable per-project history behind the live TUI
// transport. The live transport semantics are untouched: tui_sessions rows
// are still deleted on disconnect. tui_projects is a separate bounded
// history that never exposes cwd, pids or connection/session ids.
describe('store: tui project history (T1 store foundation)', () => {
  let dir;
  let t;
  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'tui-project-'));
    t = T0;
    store = new Store(join(dir, 'main.sqlite'), {
      now: () => t,
      isProcessAlive: () => true,
    });
  });

  afterEach(() => {
    store.close();
  });

  const reg = (over = {}) => ({
    trackingId: 'a'.repeat(32),
    connectionId: 'c'.repeat(32),
    label: 'alpha',
    pid: 1111,
    staleCutoff: t + 30_000,
    ...over,
  });

  const getSession = (trackingId) =>
    store.getTuiSession({ trackingId, staleCutoff: t + 30_000 });

  // --- A. identity + color slot -----------------------------------------

  test('same normalized cwd yields one project key; cwd never leaks; objects frozen', () => {
    store.registerTuiSession(reg({ trackingId: 'a'.repeat(32), connectionId: '1'.repeat(32), cwd: 'C:\\Proj\\Alpha' }));
    store.registerTuiSession(reg({ trackingId: 'b'.repeat(32), connectionId: '2'.repeat(32), cwd: 'c:/proj/alpha/' }));
    store.registerTuiSession(reg({ trackingId: 'd'.repeat(32), connectionId: '3'.repeat(32), cwd: 'C:/Proj/ALPHA' }));
    const key = getSession('a'.repeat(32)).projectKey;
    assert.ok(/^[0-9a-f]{64}$/.test(key), 'project key must be 64 lowercase hex');
    assert.equal(getSession('b'.repeat(32)).projectKey, key, 'case/slash variants normalize to one key');
    assert.equal(getSession('d'.repeat(32)).projectKey, key, 'case variants normalize to one key');

    // A different cwd is a different project.
    store.registerTuiSession(reg({ trackingId: 'e'.repeat(32), connectionId: '4'.repeat(32), cwd: 'C:/proj/beta' }));
    assert.notEqual(getSession('e'.repeat(32)).projectKey, key);

    const project = store.listRecentTuiProjects({ since: 0 }).find((p) => p.projectKey === key);
    assert.ok(Number.isInteger(project.colorSlot) && project.colorSlot >= 0 && project.colorSlot <= 7);
    assert.ok(!('cwd' in project), 'project history must never expose cwd');
    assert.ok(
      !('pid' in project) && !('connectionId' in project)
        && !('shortId' in project) && !('lastTrackingId' in project),
    );
    assert.ok(!JSON.stringify(project).toLowerCase().includes('proj/alpha'));
    assert.throws(() => { project.label = 'mutated'; }, TypeError, 'project rows are frozen');
  });

  test('color slot is stable per project key across sessions and restarts', () => {
    store.registerTuiSession(reg({ trackingId: 'a'.repeat(32), connectionId: '1'.repeat(32), cwd: 'C:/Proj/Color' }));
    const first = store.listRecentTuiProjects({ since: 0 })[0];
    store.close();
    store = new Store(join(dir, 'main.sqlite'), { now: () => t, isProcessAlive: () => true });
    store.registerTuiSession(reg({ trackingId: 'b'.repeat(32), connectionId: '2'.repeat(32), cwd: 'c:/proj/color/' }));
    const second = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(second.projectKey, first.projectKey, 'one project after restart');
    assert.equal(second.colorSlot, first.colorSlot, 'color slot stable across process restart');
  });

  test('absent cwd derives a deterministic per-tracking fallback key', () => {
    const trackingId = 'e'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32) }));
    const expected = createHash('sha256').update(`tracking:${trackingId}`).digest('hex');
    assert.equal(getSession(trackingId).projectKey, expected);
    // A second session without cwd but a different tracking id is its own project.
    store.registerTuiSession(reg({ trackingId: 'f'.repeat(32), connectionId: '2'.repeat(32) }));
    assert.notEqual(getSession('f'.repeat(32)).projectKey, expected);
  });

  // --- B. lifecycle -------------------------------------------------------

  test('register/heartbeat/state/disconnect lifecycle drives project history; live row still deletes', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/life', label: 'life', branch: 'main' }));
    t += 1000;
    assert.equal(store.heartbeatTuiSession({ trackingId, connectionId: 'c'.repeat(32) }).ok, true);
    t += 1000;
    assert.equal(store.setTuiSessionState({ trackingId, connectionId: 'c'.repeat(32), state: 'busy' }).ok, true);
    let project = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(project.lastState, 'busy');
    assert.equal(project.branch, 'main');
    assert.equal(project.lastSeenAt, t, 'heartbeat and state updates bump last_seen_at');
    assert.equal(project.disconnectedAt, null);

    t += 1000;
    assert.equal(store.disconnectTuiSession({ trackingId, connectionId: 'c'.repeat(32) }).ok, true);
    assert.equal(getSession(trackingId), null, 'live row still deletes on disconnect');
    project = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(project.lastState, 'disconnected');
    assert.equal(project.disconnectedAt, t);
    assert.equal(project.lastSeenAt, t);
  });

  test('alias survives stale takeover and full disconnect/reconnect; latest branch wins; first_seen_at never changes', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/alias', label: 'v1', branch: 'main' }));
    const first = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(store.setTuiProjectAlias({ projectKey: first.projectKey, alias: 'my project' }).ok, true);

    t += 1000;
    store.registerTuiSession(reg({ trackingId, connectionId: '2'.repeat(32), cwd: 'C:/proj/alias', label: 'v2', branch: 'feature' }));
    let project = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(project.alias, 'my project', 'alias preserved on upsert');
    assert.equal(project.label, 'v2', 'latest safe label wins');
    assert.equal(project.branch, 'feature', 'latest branch wins');
    assert.equal(project.firstSeenAt, first.firstSeenAt);

    t += 1000;
    store.disconnectTuiSession({ trackingId, connectionId: '2'.repeat(32) });
    t += 1000;
    store.registerTuiSession(reg({ trackingId, connectionId: '3'.repeat(32), cwd: 'C:/proj/alias', label: 'v3' }));
    project = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(project.alias, 'my project', 'alias survives full disconnect/reconnect');
    assert.equal(project.branch, 'feature', 'branch persists when a register omits it');
    assert.equal(project.disconnectedAt, null, 'reconnect clears disconnected_at');
    assert.equal(project.lastState, 'connected');
    assert.equal(project.firstSeenAt, first.firstSeenAt, 'first_seen_at never changes');
  });

  test('setTuiProjectAlias validates, clears on null and refuses unknown keys without touching timestamps', () => {
    store.registerTuiSession(reg({ cwd: 'C:/proj/aliased' }));
    const project = store.listRecentTuiProjects({ since: 0 })[0];
    assert.deepEqual(store.setTuiProjectAlias({ projectKey: 'f'.repeat(64), alias: 'nope' }),
      { ok: false, reason: 'unknown_project' });
    assert.equal(store.setTuiProjectAlias({ projectKey: project.projectKey, alias: 'renamed' }).ok, true);
    assert.equal(store.listRecentTuiProjects({ since: 0 })[0].alias, 'renamed');
    const before = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(store.setTuiProjectAlias({ projectKey: project.projectKey, alias: null }).ok, true);
    assert.equal(store.listRecentTuiProjects({ since: 0 })[0].alias, null, 'null clears the alias');
    assert.equal(store.listRecentTuiProjects({ since: 0 })[0].lastSeenAt, before.lastSeenAt,
      'renaming must never fake activity');
    assert.throws(() => store.setTuiProjectAlias({ projectKey: project.projectKey, alias: 'x'.repeat(65) }), TypeError);
    assert.throws(() => store.setTuiProjectAlias({ projectKey: 'zz' }), TypeError);
  });

  test('optional branch is bounded like label; legacy callers registering without branch keep working', () => {
    assert.throws(() => store.registerTuiSession(reg({ branch: 'x'.repeat(129) })), TypeError);
    assert.equal(store.registerTuiSession(reg({ branch: 'feature/x' })).ok, true);
    assert.equal(getSession('a'.repeat(32)).branch, 'feature/x');
    assert.equal(store.registerTuiSession(reg({ trackingId: 'b'.repeat(32), connectionId: '2'.repeat(32), cwd: 'C:/proj/nob' })).ok, true);
    assert.equal(getSession('b'.repeat(32)).branch, null);
  });

  test('failed ownership CAS never updates project history', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/cas' }));
    t += 1000;
    assert.deepEqual(store.heartbeatTuiSession({ trackingId, connectionId: '9'.repeat(32) }),
      { ok: false, reason: 'not_owner' });
    assert.deepEqual(store.setTuiSessionState({ trackingId, connectionId: '9'.repeat(32), state: 'busy' }),
      { ok: false, reason: 'not_owner' });
    const project = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(project.lastState, 'connected');
    assert.equal(project.lastSeenAt, T0, 'a failed CAS must not bump last_seen_at');
  });

  // --- C. durable selected target ----------------------------------------

  test('durable selected target: set/get, mismatch refusal, unknown session, idempotent clear', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/sel' }));
    const projectKey = getSession(trackingId).projectKey;
    assert.equal(store.getSelectedTuiTarget(), null, 'nothing selected initially');
    assert.deepEqual(store.setSelectedTuiTarget({ trackingId, projectKey }), { ok: true });
    const selected = store.getSelectedTuiTarget();
    assert.deepEqual(selected, { trackingId, projectKey });
    assert.throws(() => { selected.trackingId = 'x'; }, TypeError, 'selection is frozen');

    assert.deepEqual(store.setSelectedTuiTarget({ trackingId, projectKey: 'f'.repeat(64) }),
      { ok: false, reason: 'project_mismatch' });
    assert.deepEqual(store.setSelectedTuiTarget({ trackingId: 'e'.repeat(32), projectKey }),
      { ok: false, reason: 'unknown_session' });

    assert.deepEqual(store.clearSelectedTuiTarget(), { ok: true });
    assert.deepEqual(store.clearSelectedTuiTarget(), { ok: true }, 'clear is idempotent');
    assert.equal(store.getSelectedTuiTarget(), null);
  });

  test('disconnecting the selected session clears the durable selection atomically', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/seldis' }));
    const projectKey = getSession(trackingId).projectKey;
    assert.equal(store.setSelectedTuiTarget({ trackingId, projectKey }).ok, true);
    assert.equal(store.disconnectTuiSession({ trackingId, connectionId: 'c'.repeat(32) }).ok, true);
    assert.equal(store.getSelectedTuiTarget(), null, 'disconnect clears the selection');
  });

  test('malformed or partial durable selected-target meta fails closed to null', () => {
    const dbPath = join(dir, 'main.sqlite');
    store.registerTuiSession(reg({ cwd: 'C:/proj/meta' }));
    store.close();
    // Partial meta: only one of the two keys present.
    let raw = new DatabaseSync(dbPath);
    raw.prepare("INSERT INTO meta (key, value) VALUES ('selected_tui_tracking_id', ?)").run('e'.repeat(32));
    raw.close();
    store = new Store(dbPath, { now: () => t, isProcessAlive: () => true });
    assert.equal(store.getSelectedTuiTarget(), null, 'partial meta fails closed');
    store.close();
    // Malformed meta: both keys present but invalid values.
    raw = new DatabaseSync(dbPath);
    raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('selected_tui_project_key', 'not-hex')").run();
    raw.close();
    store = new Store(dbPath, { now: () => t, isProcessAlive: () => true });
    assert.equal(store.getSelectedTuiTarget(), null, 'malformed meta fails closed');
  });

  // --- D. list validation and retention ----------------------------------

  test('listRecentTuiProjects validates since/limit, hard-caps at 20 and sorts newest first', () => {
    const ids = ['a', 'b', 'c'];
    for (let i = 0; i < 3; i++) {
      const trackingId = ids[i].repeat(32);
      const conn = String(i + 1).repeat(32);
      store.registerTuiSession(reg({ trackingId, connectionId: conn, cwd: `C:/proj/l${i}`, label: `l${i}` }));
      t += 1000;
    }
    const listed = store.listRecentTuiProjects({ since: 0 });
    assert.equal(listed.length, 3);
    for (let i = 1; i < listed.length; i++) {
      assert.ok(listed[i - 1].lastSeenAt >= listed[i].lastSeenAt, 'newest first');
    }
    const half = store.listRecentTuiProjects({ since: T0 + 1000 });
    assert.ok(half.every((p) => p.lastSeenAt >= T0 + 1000), 'rows older than since are excluded');
    assert.equal(half.length, 2);
    assert.throws(() => store.listRecentTuiProjects({ since: 'nope' }), RangeError);
    assert.throws(() => store.listRecentTuiProjects({ since: 0, limit: 0 }), RangeError);
    assert.equal(store.listRecentTuiProjects({ since: 0, limit: 500 }).length, 3,
      'limit above 20 is hard-capped, not an error');
    assert.equal(MAX_TUI_RECENT_PROJECTS, 20);
    assert.equal(TUI_PROJECT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  });

  test('pruneTuiProjectHistory deletes inactive rows older than cutoff and outside the newest limit; live rows preserved', () => {
    const ids = ['a', 'b', 'c'];
    for (let i = 0; i < 3; i++) {
      const trackingId = ids[i].repeat(32);
      const conn = String(i + 1).repeat(32);
      store.registerTuiSession(reg({ trackingId, connectionId: conn, cwd: `C:/proj/p${i}`, label: `p${i}` }));
      store.disconnectTuiSession({ trackingId, connectionId: conn });
      t += 1000;
    }
    store.registerTuiSession(reg({ trackingId: 'd'.repeat(32), connectionId: '9'.repeat(32), cwd: 'C:/proj/live', label: 'live' }));
    t += 1000;
    const res = store.pruneTuiProjectHistory({ olderThan: t - 10_000, limit: 1 });
    assert.deepEqual(res, { ok: true, deleted: 2 });
    const labels = store.listRecentTuiProjects({ since: 0 }).map((p) => p.label).sort();
    assert.deepEqual(labels, ['live', 'p2'], 'only the newest inactive project and the live one remain');
  });

  test('retention: auto-prune after register keeps the newest 20 inactive projects and any live project', () => {
    // Old disconnected project.
    store.registerTuiSession(reg({ trackingId: 'a'.repeat(32), connectionId: '1'.repeat(32), cwd: 'C:/proj/old', label: 'old' }));
    store.disconnectTuiSession({ trackingId: 'a'.repeat(32), connectionId: '1'.repeat(32) });
    // Old but still-live project.
    store.registerTuiSession(reg({ trackingId: 'b'.repeat(32), connectionId: '2'.repeat(32), cwd: 'C:/proj/liveold', label: 'liveold' }));

    t += 31 * 24 * 60 * 60 * 1000; // 31 days later
    // Registering a new project auto-prunes: the 31d-old inactive one goes.
    store.registerTuiSession(reg({ trackingId: 'c'.repeat(32), connectionId: '3'.repeat(32), cwd: 'C:/proj/new', label: 'new' }));
    let labels = store.listRecentTuiProjects({ since: 0 }).map((p) => p.label);
    assert.ok(!labels.includes('old'), 'inactive project older than 30d is pruned automatically');
    assert.ok(labels.includes('liveold'), 'live project survives pruning even when old');
    assert.ok(labels.includes('new'));

    // Fill with 25 disconnected projects: only the newest 20 stay.
    for (let i = 0; i < 25; i++) {
      t += 1000;
      const trackingId = String(i % 10).repeat(32);
      const conn = String((i + 1) % 10).repeat(32);
      store.registerTuiSession(reg({ trackingId, connectionId: conn, cwd: `C:/proj/fill${i}`, label: `fill${i}` }));
      store.disconnectTuiSession({ trackingId, connectionId: conn });
    }
    const listed = store.listRecentTuiProjects({ since: 0 });
    assert.equal(listed.length, 20, 'list hard-caps at 20');
    const fills = listed.filter((p) => p.label.startsWith('fill'));
    assert.equal(fills.length, 20, 'newest 20 inactive projects retained');
    for (let i = 1; i < listed.length; i++) {
      assert.ok(listed[i - 1].lastSeenAt >= listed[i].lastSeenAt, 'newest first under retention pressure');
    }
  });

  // --- E. additive migration / backfill -----------------------------------

  test('additive migration backfills project history from an old database schema', () => {
    const dbPath = join(dir, 'legacy.sqlite');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tui_sessions (
        tracking_id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL UNIQUE,
        pi_session_id TEXT,
        pi_session_file TEXT,
        cwd TEXT,
        label TEXT,
        pid INTEGER,
        connection_id TEXT NOT NULL,
        state TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
    `);
    raw.prepare(`
      INSERT INTO tui_sessions
        (tracking_id, short_id, cwd, label, pid, connection_id, state, connected_at, updated_at, heartbeat_at)
      VALUES (?, 'legacy1', ?, 'legacy', 4242, ?, 'connected', ?, ?, ?)
    `).run('a'.repeat(32), 'C:\\Legacy\\Proj', 'x'.repeat(32), T0, T0, T0);
    raw.close();

    const legacy = new Store(dbPath, { now: () => t, isProcessAlive: () => true });
    const row = legacy.getTuiSession({ trackingId: 'a'.repeat(32), staleCutoff: t + 30_000 });
    assert.equal(row.cwd, 'C:\\Legacy\\Proj', 'existing row data preserved');
    assert.equal(row.label, 'legacy');
    assert.equal(row.pid, 4242);
    assert.ok(/^[0-9a-f]{64}$/.test(row.projectKey), 'project key backfilled');
    assert.equal(row.branch, null, 'legacy rows have no branch');

    const project = legacy.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(project.projectKey, row.projectKey);
    assert.equal(project.label, 'legacy');
    assert.equal(project.lastState, 'connected');
    assert.equal(project.firstSeenAt, T0, 'first_seen_at from the original connected_at');
    assert.equal(project.lastSeenAt, T0);

    // A fresh registration on the migrated db with the same cwd (any
    // spelling) lands on the SAME backfilled project row.
    assert.equal(legacy.registerTuiSession(reg({
      trackingId: 'b'.repeat(32), connectionId: '2'.repeat(32), cwd: 'c:/legacy/proj/',
    })).ok, true);
    assert.equal(legacy.listRecentTuiProjects({ since: 0 }).length, 1, 'backfilled identity matches fresh identity');
    legacy.close();
  });

  // --- Correction 2 (F2): the public history API exposes no tracking,
  // session or connection identifiers of any kind.

  test('project history API exposes no tracking/session/connection identifiers', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/privacy' }));
    const project = store.listRecentTuiProjects({ since: 0 })[0];
    for (const forbidden of ['lastTrackingId', 'trackingId', 'connectionId', 'shortId', 'pid', 'cwd']) {
      assert.ok(!(forbidden in project), `${forbidden} must never be exposed`);
    }
    assert.ok(!JSON.stringify(project).includes(trackingId), 'no raw tracking id may leak');
  });

  // --- Correction 1 (F3): selection drift ------------------------------

  test('project identity change clears the durable selected target on refresh and replacement', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/drift' }));
    const oldKey = getSession(trackingId).projectKey;
    assert.equal(store.setSelectedTuiTarget({ trackingId, projectKey: oldKey }).ok, true);

    t += 1000;
    // Same-connection refresh that reports a DIFFERENT cwd: new identity.
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/drift2' }));
    assert.equal(store.getSelectedTuiTarget(), null, 'refresh onto a new project clears selection');

    // Replacement by a second connection, again a different cwd.
    store.registerTuiSession(reg({ trackingId, connectionId: '2'.repeat(32), cwd: 'C:/proj/drift3' }));
    assert.equal(store.getSelectedTuiTarget(), null, 'replacement onto a new project clears selection');

    // Re-selecting the new identity works and survives an unchanged refresh.
    const newKey = getSession(trackingId).projectKey;
    assert.notEqual(newKey, oldKey);
    assert.equal(store.setSelectedTuiTarget({ trackingId, projectKey: newKey }).ok, true);
    store.registerTuiSession(reg({ trackingId, connectionId: '2'.repeat(32), cwd: 'C:/proj/drift3' }));
    assert.deepEqual(store.getSelectedTuiTarget(), { trackingId, projectKey: newKey },
      'unchanged identity keeps the selection');
  });

  // --- Correction 3 (F5): monotonic history upsert ----------------------

  test('an older upsert can never regress a newer project history row', () => {
    const dbPath = join(dir, 'mono.sqlite');
    const legacyKey = createHash('sha256').update('c:/legacy/mono').digest('hex');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tui_sessions (
        tracking_id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL UNIQUE,
        pi_session_id TEXT,
        pi_session_file TEXT,
        cwd TEXT,
        label TEXT,
        pid INTEGER,
        connection_id TEXT NOT NULL,
        state TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
      CREATE TABLE tui_projects (
        project_key TEXT PRIMARY KEY,
        label TEXT,
        alias TEXT,
        branch TEXT,
        color_slot INTEGER NOT NULL,
        last_state TEXT NOT NULL,
        last_tracking_id TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        disconnected_at INTEGER
      );
    `);
    // Newer history evidence...
    raw.prepare(`INSERT INTO tui_projects
      (project_key, label, alias, branch, color_slot, last_state,
       last_tracking_id, first_seen_at, last_seen_at, disconnected_at)
      VALUES (?, 'newer', 'keepme', 'trunk', 3, 'busy', ?, ?, ?, ?)`)
      .run(legacyKey, 'f'.repeat(32), T0, T0 + 5000, T0 + 5000);
    // ...and an OLDER legacy live row for the SAME project.
    raw.prepare(`INSERT INTO tui_sessions
      (tracking_id, short_id, cwd, label, pid, connection_id, state,
       connected_at, updated_at, heartbeat_at)
      VALUES (?, 'mono1', 'C:/Legacy/Mono', 'older', 7, ?, 'connected', ?, ?, ?)`)
      .run('a'.repeat(32), 'x'.repeat(32), T0, T0, T0);
    raw.close();

    const mono = new Store(dbPath, { now: () => t, isProcessAlive: () => true });
    const project = mono.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(project.label, 'newer', 'older backfill must not regress the label');
    assert.equal(project.alias, 'keepme', 'alias is always preserved');
    assert.equal(project.branch, 'trunk');
    assert.equal(project.lastState, 'busy');
    assert.equal(project.lastSeenAt, T0 + 5000, 'last_seen_at is monotone');
    assert.equal(project.disconnectedAt, T0 + 5000, 'newer evidence must not be cleared');
    assert.equal(project.firstSeenAt, T0, 'first_seen_at stays preserved');
    // The session row still gains its backfilled project key.
    assert.equal(
      mono.getTuiSession({ trackingId: 'a'.repeat(32), staleCutoff: t + 30_000 }).projectKey,
      legacyKey,
    );
    mono.close();
  });

  // --- Correction 4 (F6): prune lives inside the register/disconnect
  // transaction; register stays re-entrant under withTransaction.

  test('register within an outer withTransaction stays atomic and still prunes', () => {
    store.withTransaction(() => {
      assert.equal(store.registerTuiSession(reg({ cwd: 'C:/proj/tx' })).ok, true);
    });
    assert.equal(store.listRecentTuiProjects({ since: 0 }).length, 1);
  });

  // --- Correction 6 (F4): drive-relative vs drive root ------------------

  test('drive-relative C: stays distinct from the drive root C:/', () => {
    store.registerTuiSession(reg({ trackingId: 'a'.repeat(32), connectionId: '1'.repeat(32), cwd: 'C:' }));
    store.registerTuiSession(reg({ trackingId: 'b'.repeat(32), connectionId: '2'.repeat(32), cwd: 'C:/' }));
    const keyA = getSession('a'.repeat(32)).projectKey;
    const keyB = getSession('b'.repeat(32)).projectKey;
    assert.notEqual(keyA, keyB, 'drive-relative and drive root must not merge');
    assert.equal(keyA, createHash('sha256').update('c:').digest('hex'));
    assert.equal(keyB, createHash('sha256').update('c:/').digest('hex'));
  });
});

describe('store: tui branch heartbeat refresh (T2 metadata pipeline)', () => {
  let dir;
  let t;
  let store;
  let client;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'tui-branch-'));
    t = T0;
    store = new Store(join(dir, 'main.sqlite'), {
      now: () => t,
      isProcessAlive: () => true,
    });
    client = new TuiBridgeClient(store);
  });

  afterEach(() => {
    store.close();
  });

  const reg = (over = {}) => ({
    trackingId: 'a'.repeat(32),
    connectionId: 'c'.repeat(32),
    label: 'alpha',
    pid: 1111,
    staleCutoff: t + 30_000,
    ...over,
  });

  const getSession = (trackingId) =>
    store.getTuiSession({ trackingId, staleCutoff: t + 30_000 });

  test('TuiBridgeClient forwards branch on connect and on heartbeat', () => {
    const connected = client.connect({
      label: 'forward',
      pid: process.pid,
      branch: 'main',
    });
    assert.equal(connected.ok, true);
    t += 1000;
    assert.equal(
      client.heartbeat({
        trackingId: connected.trackingId,
        connectionId: connected.connectionId,
        branch: 'feature/forwarded',
      }).ok,
      true,
    );
    const session = store.getTuiSession({
      trackingId: connected.trackingId,
      staleCutoff: t + 30_000,
    });
    assert.equal(session.branch, 'feature/forwarded');
    const project = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(project.branch, 'feature/forwarded');
  });

  test('heartbeat with a changed branch updates session and project history while preserving busy/waiting state', () => {
    const trackingId = 'a'.repeat(32);
    const connectionId = 'c'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId, cwd: 'C:/proj/branchy', branch: 'main' }));
    t += 1000;
    assert.equal(store.setTuiSessionState({ trackingId, connectionId, state: 'busy' }).ok, true);
    t += 1000;
    assert.equal(
      store.heartbeatTuiSession({ trackingId, connectionId, branch: 'feature/refresh' }).ok,
      true,
    );
    const session = getSession(trackingId);
    assert.equal(session.branch, 'feature/refresh');
    assert.equal(session.state, 'busy', 'heartbeat must never change state');
    const project = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(project.branch, 'feature/refresh');
    assert.equal(project.lastState, 'busy');
    assert.equal(project.lastSeenAt, t);
  });

  test('heartbeat without a branch (undefined or null) preserves the stored session and project branch', () => {
    const trackingId = 'a'.repeat(32);
    const connectionId = 'c'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId, cwd: 'C:/proj/keep', branch: 'keep/me' }));
    t += 1000;
    assert.equal(store.heartbeatTuiSession({ trackingId, connectionId }).ok, true);
    t += 1000;
    assert.equal(
      store.heartbeatTuiSession({ trackingId, connectionId, branch: null }).ok,
      true,
    );
    assert.equal(getSession(trackingId).branch, 'keep/me');
    const project = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(project.branch, 'keep/me');
  });

  test('F4: same-connection register refresh with a null/omitted branch preserves the stored branch', () => {
    const trackingId = 'a'.repeat(32);
    const connectionId = 'c'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId, cwd: 'C:/proj/f4refresh', branch: 'main' }));
    t += 1000;
    assert.equal(
      store.registerTuiSession(reg({ trackingId, connectionId, cwd: 'C:/proj/f4refresh' })).ok,
      true,
    );
    assert.equal(getSession(trackingId).branch, 'main', 'a null refresh branch must not erase the session branch');
    assert.equal(store.listRecentTuiProjects({ since: 0 })[0].branch, 'main');
  });

  test('F4: replacement takeover with a null/omitted branch preserves the prior branch', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/f4replace', branch: 'main' }));
    t += 1000;
    assert.equal(
      store.registerTuiSession(reg({ trackingId, connectionId: '2'.repeat(32), cwd: 'C:/proj/f4replace' })).ok,
      true,
    );
    assert.equal(getSession(trackingId).branch, 'main', 'a null replacement branch must not erase the session branch');
    assert.equal(store.listRecentTuiProjects({ since: 0 })[0].branch, 'main');
  });

  test('R1: replacement onto a changed project with a null branch clears the session branch and never crosses project histories', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/r1old', branch: 'main' }));
    const oldKey = getSession(trackingId).projectKey;
    assert.equal(store.setSelectedTuiTarget({ trackingId, projectKey: oldKey }).ok, true);
    // The NEW project gets an independent history row with its own branch.
    store.registerTuiSession(reg({ trackingId: 'b'.repeat(32), connectionId: '2'.repeat(32), cwd: 'C:/proj/r1new', branch: 'other' }));
    t += 1000;

    assert.equal(
      store.registerTuiSession(reg({ trackingId, connectionId: '3'.repeat(32), cwd: 'C:/proj/r1new' })).ok,
      true,
    );
    const session = getSession(trackingId);
    assert.notEqual(session.projectKey, oldKey, 'project identity changed');
    assert.equal(session.branch, null, 'the old project branch must never be carried into the new project');

    assert.equal(store.getSelectedTuiTarget(), null, 'durable selection remains cleared (T1)');

    const projects = store.listRecentTuiProjects({ since: 0 });
    assert.equal(projects.find((p) => p.projectKey === oldKey).branch, 'main',
      'old project history keeps its own branch');
    assert.equal(projects.find((p) => p.projectKey === session.projectKey).branch, 'other',
      'new project history keeps its independent branch, not the incoming null');
  });

  test('R1: same-connection refresh onto a changed project with a null branch clears the session branch', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/r1f-old', branch: 'main' }));
    const oldKey = getSession(trackingId).projectKey;
    t += 1000;
    assert.equal(
      store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/r1f-new' })).ok,
      true,
    );
    const session = getSession(trackingId);
    assert.notEqual(session.projectKey, oldKey, 'project identity changed');
    assert.equal(session.branch, null, 'refresh onto a new project must not carry the old branch');

    const projects = store.listRecentTuiProjects({ since: 0 });
    assert.equal(projects.find((p) => p.projectKey === oldKey).branch, 'main',
      'old project history is untouched by the refresh');
    assert.equal(projects.find((p) => p.projectKey === session.projectKey).branch, null,
      'new project without independent history stays null');
  });

  test('R1a: replacement onto a changed project with a non-null branch adopts the incoming branch', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/r1a-old', branch: 'main' }));
    const oldKey = getSession(trackingId).projectKey;
    assert.equal(store.setSelectedTuiTarget({ trackingId, projectKey: oldKey }).ok, true);
    // The NEW project gets an independent history row with its own branch.
    store.registerTuiSession(reg({ trackingId: 'b'.repeat(32), connectionId: '2'.repeat(32), cwd: 'C:/proj/r1a-new', branch: 'other' }));
    t += 1000;

    assert.equal(
      store.registerTuiSession(reg({ trackingId, connectionId: '3'.repeat(32), cwd: 'C:/proj/r1a-new', branch: 'incoming' })).ok,
      true,
    );
    const session = getSession(trackingId);
    assert.notEqual(session.projectKey, oldKey, 'project identity changed');
    assert.equal(session.branch, 'incoming', 'a non-null incoming branch wins on project change');

    assert.equal(store.getSelectedTuiTarget(), null, 'durable selection remains cleared (T1)');

    const projects = store.listRecentTuiProjects({ since: 0 });
    assert.equal(projects.find((p) => p.projectKey === oldKey).branch, 'main',
      'old project history keeps its own branch');
    assert.equal(projects.find((p) => p.projectKey === session.projectKey).branch, 'incoming',
      'new project history matches the session branch');
  });

  test('R1a: same-connection refresh onto a changed project with a non-null branch adopts the incoming branch', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/r1af-old', branch: 'main' }));
    const oldKey = getSession(trackingId).projectKey;
    t += 1000;
    assert.equal(
      store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/r1af-new', branch: 'incoming' })).ok,
      true,
    );
    const session = getSession(trackingId);
    assert.notEqual(session.projectKey, oldKey, 'project identity changed');
    assert.equal(session.branch, 'incoming', 'a non-null incoming branch wins on project change');

    const projects = store.listRecentTuiProjects({ since: 0 });
    assert.equal(projects.find((p) => p.projectKey === oldKey).branch, 'main',
      'old project history is untouched by the refresh');
    assert.equal(projects.find((p) => p.projectKey === session.projectKey).branch, 'incoming',
      'new project history matches the session branch');
  });

  test('a stale or replaced connection cannot update branch or history', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/casb', branch: 'main' }));
    const before = store.listRecentTuiProjects({ since: 0 })[0];
    t += 1000;
    assert.deepEqual(
      store.heartbeatTuiSession({ trackingId, connectionId: '9'.repeat(32), branch: 'hostile' }),
      { ok: false, reason: 'not_owner' },
    );
    assert.equal(getSession(trackingId).branch, 'main');
    let after = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(after.lastSeenAt, before.lastSeenAt, 'a failed CAS must not bump last_seen_at');
    assert.equal(after.branch, 'main');

    // A genuinely replaced connection (stale row takeover) also loses CAS.
    store.registerTuiSession(reg({ trackingId, connectionId: '2'.repeat(32), branch: 'replacement' }));
    t += 1000;
    assert.deepEqual(
      store.heartbeatTuiSession({ trackingId, connectionId: '1'.repeat(32), branch: 'old-owner' }),
      { ok: false, reason: 'not_owner' },
    );
    after = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(after.branch, 'replacement', 'the old owner must not overwrite the new branch');
  });

  test('heartbeat branch validation matches the registerTuiSession contract', () => {
    const trackingId = 'a'.repeat(32);
    const connectionId = 'c'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId, cwd: 'C:/proj/valid' }));
    assert.throws(
      () => store.heartbeatTuiSession({ trackingId, connectionId, branch: 'x'.repeat(129) }),
      TypeError,
    );
    assert.throws(
      () => store.heartbeatTuiSession({ trackingId, connectionId, branch: '' }),
      TypeError,
    );
    assert.equal(
      store.heartbeatTuiSession({ trackingId, connectionId, branch: 'b'.repeat(128) }).ok,
      true,
      'a 128-char branch is within the contract',
    );
    assert.equal(getSession(trackingId).branch, 'b'.repeat(128));
  });

  test('project history last_seen_at and branch never regress to an older heartbeat', () => {
    const trackingId = 'a'.repeat(32);
    const connectionId = 'c'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId, cwd: 'C:/proj/mono', branch: 'older' }));
    t = T0 + 5000;
    assert.equal(store.setTuiSessionState({ trackingId, connectionId, state: 'busy' }).ok, true);
    t = T0 + 1000; // clock moves backwards: older evidence
    assert.equal(
      store.heartbeatTuiSession({ trackingId, connectionId, branch: 'newer' }).ok,
      true,
    );
    const project = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(project.lastSeenAt, T0 + 5000, 'older evidence must not regress last_seen_at');
    assert.equal(project.branch, 'older', 'older evidence must not overwrite the stored branch');
    assert.equal(project.lastState, 'busy');
  });
});

// T4C1: additive durable per-session alias storage. tui_session_aliases is
// keyed by tracking_id and guarded by project_key; the live tui_sessions
// row is still deleted on disconnect while the alias survives (retention:
// unreferenced aliases are pruned after TUI_PROJECT_RETENTION_MS). The
// project-scoped tui_projects.alias fallback is untouched.
describe('store: tui session aliases (T4C1)', () => {
  let dir;
  let t;
  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'tui-alias-'));
    t = T0;
    store = new Store(join(dir, 'main.sqlite'), {
      now: () => t,
      isProcessAlive: () => true,
    });
  });

  afterEach(() => {
    store.close();
  });

  const reg = (over = {}) => ({
    trackingId: 'a'.repeat(32),
    connectionId: 'c'.repeat(32),
    label: 'alpha',
    pid: 1111,
    staleCutoff: t + 30_000,
    ...over,
  });

  const getSession = (trackingId) =>
    store.getTuiSession({ trackingId, staleCutoff: t + 30_000 });

  test('migration is additive, idempotent and never backfills from the project alias', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/alias-mig' }));
    const dbPath = join(dir, 'main.sqlite');
    store.close();
    // Reopening an existing database twice must be safe (idempotent).
    store = new Store(dbPath, { now: () => t, isProcessAlive: () => true });
    store.close();
    store = new Store(dbPath, { now: () => t, isProcessAlive: () => true });
    const db = new DatabaseSync(dbPath);
    try {
      const columns = db.prepare('PRAGMA table_info(tui_session_aliases)').all().map((r) => r.name);
      assert.deepEqual(
        columns.sort(),
        ['alias', 'created_at', 'project_key', 'tracking_id', 'updated_at'].sort(),
        'exact additive schema: tracking_id PK, project_key, alias, timestamps',
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM tui_session_aliases').get().n,
        0,
        'no backfill from the project alias',
      );
    } finally {
      db.close();
    }
  });

  test('set/read alias across a Store reopen (durable, keyed by tracking id)', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/durable' }));
    assert.deepEqual(store.setTuiSessionAlias({ trackingId, alias: 'my session' }), { ok: true });
    assert.equal(getSession(trackingId).alias, 'my session');
    const dbPath = join(dir, 'main.sqlite');
    store.close();
    store = new Store(dbPath, { now: () => t, isProcessAlive: () => true });
    assert.equal(getSession(trackingId).alias, 'my session', 'alias survives a broker restart');
  });

  test('same-project stale takeover preserves the session alias', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/takeover' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'kept' }).ok, true);
    t += 1000;
    const replaced = store.registerTuiSession(reg({
      trackingId, connectionId: '2'.repeat(32), cwd: 'C:/proj/takeover',
    }));
    assert.equal(replaced.ok, true);
    assert.equal(replaced.replaced, true, 'the stale row was actually taken over');
    assert.equal(getSession(trackingId).alias, 'kept', 'same-project takeover keeps the alias');
  });

  test('disconnect deletes the live row but the alias survives a same-tracking re-register', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/reconn' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'sticky' }).ok, true);
    t += 1000;
    assert.equal(store.disconnectTuiSession({ trackingId, connectionId: '1'.repeat(32) }).ok, true);
    assert.equal(getSession(trackingId), null, 'live row still deletes on disconnect');
    t += 1000;
    assert.equal(store.registerTuiSession(reg({
      trackingId, connectionId: '2'.repeat(32), cwd: 'C:/proj/reconn',
    })).ok, true);
    assert.equal(getSession(trackingId).alias, 'sticky', 'same-tracking reconnect restores the alias');
  });

  test('correction: disconnect + re-register with a changed project physically deletes the orphaned alias (INSERT path)', () => {
    const trackingId = 'a'.repeat(32);
    const dbPath = join(dir, 'main.sqlite');
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/orphan-old' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'stale' }).ok, true);
    t += 1000;
    assert.equal(store.disconnectTuiSession({ trackingId, connectionId: '1'.repeat(32) }).ok, true);
    t += 1000;
    assert.equal(store.registerTuiSession(reg({
      trackingId, connectionId: '2'.repeat(32), cwd: 'C:/proj/orphan-new',
    })).ok, true);
    assert.equal(getSession(trackingId).alias, null, 'the hidden alias never surfaces');
    const db = new DatabaseSync(dbPath);
    try {
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM tui_session_aliases WHERE tracking_id = ?').get(trackingId).n,
        0,
        'the stale alias row is physically deleted, not prune-protected by the new live row',
      );
    } finally {
      db.close();
    }
  });

  test('correction: disconnect + re-register with the same project preserves the alias (INSERT path)', () => {
    const trackingId = 'a'.repeat(32);
    const dbPath = join(dir, 'main.sqlite');
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/orphan-same' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'kept' }).ok, true);
    t += 1000;
    assert.equal(store.disconnectTuiSession({ trackingId, connectionId: '1'.repeat(32) }).ok, true);
    t += 1000;
    assert.equal(store.registerTuiSession(reg({
      trackingId, connectionId: '2'.repeat(32), cwd: 'c:/proj/orphan-same/',
    })).ok, true, 'same project (any cwd spelling) re-registers cleanly');
    assert.equal(getSession(trackingId).alias, 'kept', 'a same-project alias survives the INSERT path');
    const db = new DatabaseSync(dbPath);
    try {
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM tui_session_aliases WHERE tracking_id = ?').get(trackingId).n,
        1,
      );
    } finally {
      db.close();
    }
  });

  test('project drift on refresh and replacement deletes the session alias atomically', () => {
    const trackingId = 'a'.repeat(32);
    const dbPath = join(dir, 'main.sqlite');
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/drift-a' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'before' }).ok, true);
    t += 1000;
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/drift-b' }));
    assert.equal(getSession(trackingId).alias, null, 'refresh onto a new project clears the alias');
    let db = new DatabaseSync(dbPath);
    try {
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM tui_session_aliases WHERE tracking_id = ?').get(trackingId).n,
        0,
        'the alias row itself is deleted, not just unjoined',
      );
    } finally {
      db.close();
    }
    // A fresh alias on the new project is independent of the old one.
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'after' }).ok, true);
    assert.equal(getSession(trackingId).alias, 'after');
    t += 1000;
    store.registerTuiSession(reg({ trackingId, connectionId: '2'.repeat(32), cwd: 'C:/proj/drift-c' }));
    assert.equal(getSession(trackingId).alias, null, 'replacement onto a new project clears the alias');
    db = new DatabaseSync(dbPath);
    try {
      assert.equal(
        db.prepare('SELECT COUNT(*) AS n FROM tui_session_aliases WHERE tracking_id = ?').get(trackingId).n,
        0,
      );
    } finally {
      db.close();
    }
  });

  test('null clears the alias and clearing is idempotent', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/clear' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'x' }).ok, true);
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: null }).ok, true);
    assert.equal(getSession(trackingId).alias, null, 'null clears the alias');
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: null }).ok, true, 'clear is idempotent');
    assert.equal(store.setTuiSessionAlias({ trackingId }).ok, true, 'undefined clears too');
    assert.equal(getSession(trackingId).alias, null);
  });

  test('unknown session fails closed', () => {
    assert.deepEqual(
      store.setTuiSessionAlias({ trackingId: 'e'.repeat(32), alias: 'x' }),
      { ok: false, reason: 'unknown_session' },
    );
  });

  test('alias validation matches the optional-string/64-char contract; tracking id is validated', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/valid' }));
    assert.throws(() => store.setTuiSessionAlias({ trackingId, alias: 'x'.repeat(65) }), TypeError);
    assert.throws(() => store.setTuiSessionAlias({ trackingId, alias: 42 }), TypeError);
    assert.throws(() => store.setTuiSessionAlias({ trackingId, alias: '' }), TypeError);
    assert.throws(() => store.setTuiSessionAlias({ trackingId: 'short', alias: 'x' }), TypeError);
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'a'.repeat(64) }).ok, true,
      'a 64-char alias is within the contract');
  });

  test('renaming is not activity: session and project timestamps untouched', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/quiet' }));
    const beforeSession = getSession(trackingId);
    const beforeProject = store.listRecentTuiProjects({ since: 0 })[0];
    t += 1000;
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'quiet' }).ok, true);
    const afterSession = getSession(trackingId);
    const afterProject = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(afterSession.updatedAt, beforeSession.updatedAt);
    assert.equal(afterSession.heartbeatAt, beforeSession.heartbeatAt);
    assert.equal(afterSession.connectedAt, beforeSession.connectedAt);
    assert.equal(afterProject.lastSeenAt, beforeProject.lastSeenAt);
    assert.equal(afterProject.lastState, beforeProject.lastState);
  });

  test('auto-prune keeps live-session aliases, keeps recent disconnected aliases and removes aged unreferenced ones', () => {
    const liveId = 'a'.repeat(32);
    const goneId = 'b'.repeat(32);
    const dbPath = join(dir, 'main.sqlite');
    store.registerTuiSession(reg({ trackingId: liveId, connectionId: '1'.repeat(32), cwd: 'C:/proj/prune-live' }));
    store.registerTuiSession(reg({ trackingId: goneId, connectionId: '2'.repeat(32), cwd: 'C:/proj/prune-gone' }));
    store.setTuiSessionAlias({ trackingId: liveId, alias: 'live-alias' });
    store.setTuiSessionAlias({ trackingId: goneId, alias: 'gone-alias' });
    store.disconnectTuiSession({ trackingId: goneId, connectionId: '2'.repeat(32) });
    // Before the cutoff the disconnected alias is still protected: a
    // register-triggered prune must not remove it.
    t += 1000;
    store.registerTuiSession(reg({
      trackingId: 'd'.repeat(32), connectionId: '4'.repeat(32), cwd: 'C:/proj/prune-early',
    }));
    let db = new DatabaseSync(dbPath);
    try {
      const kept = db.prepare('SELECT tracking_id FROM tui_session_aliases').all().map((r) => r.tracking_id).sort();
      assert.deepEqual(kept, [liveId, goneId].sort(), 'recent disconnected alias survives before 30d');
    } finally {
      db.close();
    }
    // 31 days later the aged unreferenced alias goes on the next register.
    t += 31 * 24 * 60 * 60 * 1000;
    store.registerTuiSession(reg({
      trackingId: 'e'.repeat(32), connectionId: '5'.repeat(32), cwd: 'C:/proj/prune-late',
    }));
    assert.equal(getSession(liveId).alias, 'live-alias', 'a live-session alias is never pruned');
    db = new DatabaseSync(dbPath);
    try {
      const kept = db.prepare('SELECT tracking_id FROM tui_session_aliases').all().map((r) => r.tracking_id).sort();
      assert.deepEqual(kept, [liveId], 'aged unreferenced alias pruned; live alias preserved');
    } finally {
      db.close();
    }
  });

  test('explicit prune API validates olderThan, preserves referenced aliases and reports the deleted count', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/explicit' }));
    store.setTuiSessionAlias({ trackingId, alias: 'kept' });
    store.disconnectTuiSession({ trackingId, connectionId: 'c'.repeat(32) });
    t += 1000;
    assert.throws(() => store.pruneTuiSessionAliases({ olderThan: 'nope' }), RangeError);
    assert.deepEqual(store.pruneTuiSessionAliases({ olderThan: t }), { ok: true, deleted: 1 });
    // Re-registering the same tracking id restores nothing: the alias is gone.
    store.registerTuiSession(reg({ trackingId, connectionId: '2'.repeat(32), cwd: 'C:/proj/explicit' }));
    assert.equal(getSession(trackingId).alias, null);
  });

  test('project alias and session alias coexist; session aliasing never touches the project alias', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/coexist' }));
    const projectKey = getSession(trackingId).projectKey;
    assert.equal(store.setTuiProjectAlias({ projectKey, alias: 'project-alias' }).ok, true);
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'session-alias' }).ok, true);
    assert.equal(getSession(trackingId).alias, 'session-alias');
    const project = store.listRecentTuiProjects({ since: 0 }).find((p) => p.projectKey === projectKey);
    assert.equal(project.alias, 'project-alias', 'project alias unchanged');
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: null }).ok, true);
    assert.equal(
      store.listRecentTuiProjects({ since: 0 }).find((p) => p.projectKey === projectKey).alias,
      'project-alias',
      'clearing the session alias never clears the project alias',
    );
  });

  test('session objects are frozen and expose a nullable alias; listTuiSessions surfaces it', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/frozen' }));
    const plain = getSession(trackingId);
    assert.equal(plain.alias, null, 'alias is null before it is set');
    assert.throws(() => { plain.alias = 'mutated'; }, TypeError, 'session rows are frozen');
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'frozen' }).ok, true);
    const listed = store.listTuiSessions({ staleCutoff: t + 30_000 });
    const row = listed.find((s) => s.trackingId === trackingId);
    assert.equal(row.alias, 'frozen', 'listTuiSessions surfaces the alias');
    assert.throws(() => { row.alias = 'mutated'; }, TypeError);
  });

  test('project history never gains a session alias, session ids or raw paths', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/privacy2' }));
    store.setTuiSessionAlias({ trackingId, alias: 'session-only' });
    store.setTuiProjectAlias({ projectKey: getSession(trackingId).projectKey, alias: 'project-name' });
    const project = store.listRecentTuiProjects({ since: 0 })[0];
    assert.equal(project.alias, 'project-name', 'the project-history alias stays the project alias');
    assert.ok(!JSON.stringify(project).includes('session-only'), 'no session alias leaks into project history');
    assert.ok(!JSON.stringify(project).includes(trackingId), 'no raw tracking id may leak');
    assert.ok(!JSON.stringify(project).toLowerCase().includes('proj/privacy2'), 'no raw cwd may leak');
    for (const forbidden of ['trackingId', 'connectionId', 'shortId', 'pid', 'cwd']) {
      assert.ok(!(forbidden in project), `${forbidden} must never be exposed`);
    }
  });

  test('malformed legacy alias rows fail closed (project mismatch never surfaces an alias)', () => {
    const trackingId = 'a'.repeat(32);
    const dbPath = join(dir, 'main.sqlite');
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/legacy' }));
    store.setTuiSessionAlias({ trackingId, alias: 'good' });
    store.close();
    let db = new DatabaseSync(dbPath);
    try {
      db.prepare('UPDATE tui_session_aliases SET project_key = ? WHERE tracking_id = ?')
        .run('not-hex', trackingId);
    } finally {
      db.close();
    }
    store = new Store(dbPath, { now: () => t, isProcessAlive: () => true });
    assert.equal(getSession(trackingId).alias, null, 'a project mismatch fails closed to null');
    // Repairing the row restores the join; a fresh store open is still safe.
    store.close();
    db = new DatabaseSync(dbPath);
    try {
      db.prepare('DELETE FROM tui_session_aliases WHERE tracking_id = ?').run(trackingId);
    } finally {
      db.close();
    }
    store = new Store(dbPath, { now: () => t, isProcessAlive: () => true });
    assert.equal(getSession(trackingId).alias, null);
  });
});

// T4B1: durable bounded display-identity snapshot on each TUI event.
// Pending tui_events can outlive both broker memory and their tui_sessions
// row, so every append path atomically snapshots the CURRENT display
// identity (session label, per-session alias, branch, project key) into
// nullable TEXT columns on the event row itself. The snapshot is immutable
// at emit time; later alias/branch/label changes never rewrite old events.
// Legacy pending events get a best-effort one-time backfill (exact current
// session first, else the newest project row whose last_tracking_id exactly
// matches); acknowledged legacy events are never touched.
describe('store: tui event identity snapshots (T4B1)', () => {
  let dir;
  let t;
  let store;
  let dbPath;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'tui-event-id-'));
    t = T0;
    dbPath = join(dir, 'main.sqlite');
    store = new Store(dbPath, { now: () => t, isProcessAlive: () => true });
  });

  afterEach(() => {
    store.close();
  });

  const reg = (over = {}) => ({
    trackingId: 'a'.repeat(32),
    connectionId: 'c'.repeat(32),
    label: 'alpha',
    branch: 'main',
    pid: 1111,
    staleCutoff: t + 30_000,
    ...over,
  });

  const getSession = (trackingId) =>
    store.getTuiSession({ trackingId, staleCutoff: t + 30_000 });

  const brokerEvents = () => store.listPendingBrokerTuiEvents({});

  const reopen = () => {
    store.close();
    store = new Store(dbPath, { now: () => t, isProcessAlive: () => true });
  };

  const withRawDb = (fn) => {
    const db = new DatabaseSync(dbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  /** Simulate a pre-T4B1 legacy event row: only the original columns. */
  const insertLegacyEvent = (trackingId, kind, { acked = false } = {}) => {
    withRawDb((db) => {
      db.prepare(
        `INSERT INTO tui_events (tracking_id, kind, payload_json, created_at, acknowledged_at)
         VALUES (?, ?, 'null', ?, ?)`,
      ).run(trackingId, kind, t, acked ? t : null);
    });
  };

  const snapshotColumns = () => withRawDb((db) =>
    db.prepare('PRAGMA table_info(tui_events)').all().map((r) => r.name));

  const snapshotRows = () => withRawDb((db) =>
    db.prepare(
      'SELECT session_label, session_alias, session_branch, project_key FROM tui_events ORDER BY event_id',
    ).all());

  test('every event kind snapshots the current session identity atomically', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/all-kinds' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'win-1' }).ok, true);
    const projectKey = getSession(trackingId).projectKey;
    t += 1000;
    // Same-project replacement: the new 'connected' event must snapshot
    // the PRESERVED per-session alias.
    const replaced = store.registerTuiSession(reg({
      trackingId, connectionId: '2'.repeat(32), cwd: 'C:/proj/all-kinds',
    }));
    assert.equal(replaced.ok, true);
    assert.equal(replaced.replaced, true);
    store.appendTuiEvent({ trackingId, kind: 'status', payload: null });
    store.appendTuiEvent({ trackingId, kind: 'final_output', payload: { text: 'done' } });
    store.appendTuiEvent({ trackingId, kind: 'command_result', payload: { ok: true } });
    const events = brokerEvents().filter((e) => e.kind !== 'connected'
      || e.createdAt === T0 + 1000);
    const byKind = Object.fromEntries(events.map((e) => [e.kind, e]));
    for (const kind of ['connected', 'status', 'final_output', 'command_result']) {
      const event = byKind[kind];
      assert.ok(event, `${kind} event is pending`);
      assert.equal(event.label, 'alpha', `${kind} snapshots the session label`);
      assert.equal(event.alias, 'win-1', `${kind} snapshots the per-session alias`);
      assert.equal(event.branch, 'main', `${kind} snapshots the branch`);
      assert.equal(event.projectKey, projectKey, `${kind} snapshots the project key`);
    }
  });

  test('connected and disconnected events capture the alias and branch bound at emit time', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({
      trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/lifecycle', branch: 'feature/x',
    }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'window A' }).ok, true);
    t += 1000;
    // Same-project replacement: the 'connected' event snapshots the
    // preserved per-session alias at emit time.
    const replaced = store.registerTuiSession(reg({
      trackingId, connectionId: '2'.repeat(32), cwd: 'C:/proj/lifecycle', branch: 'feature/x',
    }));
    assert.equal(replaced.ok, true);
    assert.equal(replaced.replaced, true);
    t += 1000;
    assert.equal(store.disconnectTuiSession({ trackingId, connectionId: '2'.repeat(32) }).ok, true);
    const events = brokerEvents();
    const connected = events.filter((e) => e.kind === 'connected').at(-1);
    const disconnected = events.find((e) => e.kind === 'disconnected');
    assert.equal(connected.alias, 'window A');
    assert.equal(connected.branch, 'feature/x');
    assert.equal(disconnected.alias, 'window A', 'the disconnected event still carries the alias');
    assert.equal(disconnected.branch, 'feature/x');
    assert.equal(disconnected.label, 'alpha');
    assert.equal(disconnected.projectKey, connected.projectKey);
  });

  test('the disconnected event remains readable after the session row is deleted', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/gone-row' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'still-readable' }).ok, true);
    t += 1000;
    store.disconnectTuiSession({ trackingId, connectionId: 'c'.repeat(32) });
    assert.equal(getSession(trackingId), null, 'the live row is deleted on disconnect');
    const disconnected = brokerEvents().find((e) => e.kind === 'disconnected');
    assert.ok(disconnected, 'the disconnected event is still drainable');
    assert.equal(disconnected.label, 'alpha');
    assert.equal(disconnected.alias, 'still-readable');
    assert.equal(disconnected.branch, 'main');
    assert.ok(typeof disconnected.projectKey === 'string' && disconnected.projectKey.length === 64);
  });

  test('Store close/reopen preserves pending snapshots', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/restart' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'durable' }).ok, true);
    t += 1000;
    store.appendTuiEvent({ trackingId, kind: 'final_output', payload: { text: 'kept' } });
    const before = brokerEvents().find((e) => e.kind === 'final_output');
    reopen();
    const after = brokerEvents().find((e) => e.kind === 'final_output');
    assert.deepEqual(
      { label: after.label, alias: after.alias, branch: after.branch, projectKey: after.projectKey },
      { label: before.label, alias: before.alias, branch: before.branch, projectKey: before.projectKey },
      'pending snapshots survive a broker restart',
    );
  });

  test('later alias and branch changes never rewrite already-emitted events', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/immutable', branch: 'main' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'before' }).ok, true);
    t += 1000;
    store.appendTuiEvent({ trackingId, kind: 'final_output', payload: { text: 'old' } });
    t += 1000;
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'after' }).ok, true);
    assert.equal(store.heartbeatTuiSession({ trackingId, connectionId: 'c'.repeat(32), branch: 'renamed' }).ok, true);
    t += 1000;
    store.appendTuiEvent({ trackingId, kind: 'final_output', payload: { text: 'new' } });
    const events = brokerEvents().filter((e) => e.kind === 'final_output');
    assert.equal(events[0].alias, 'before', 'the old event keeps its frozen alias');
    assert.equal(events[0].branch, 'main', 'the old event keeps its frozen branch');
    assert.equal(events[1].alias, 'after', 'the new event snapshots the new alias');
    assert.equal(events[1].branch, 'renamed', 'the new event snapshots the new branch');
  });

  test('same-project multiple windows retain distinct frozen aliases', () => {
    const one = 'a'.repeat(32);
    const two = 'b'.repeat(32);
    store.registerTuiSession(reg({ trackingId: one, connectionId: '1'.repeat(32), cwd: 'C:/proj/shared' }));
    store.registerTuiSession(reg({ trackingId: two, connectionId: '2'.repeat(32), cwd: 'c:/proj/shared/' }));
    assert.equal(store.setTuiSessionAlias({ trackingId: one, alias: 'left window' }).ok, true);
    assert.equal(store.setTuiSessionAlias({ trackingId: two, alias: 'right window' }).ok, true);
    t += 1000;
    store.appendTuiEvent({ trackingId: one, kind: 'status', payload: null });
    store.appendTuiEvent({ trackingId: two, kind: 'status', payload: null });
    const events = brokerEvents().filter((e) => e.kind === 'status');
    assert.equal(events[0].alias, 'left window');
    assert.equal(events[1].alias, 'right window');
    assert.equal(events[0].projectKey, events[1].projectKey, 'same project identity, distinct aliases');
  });

  test('project drift never attaches the old alias or old project to new events', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/drift-old' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'old-project alias' }).ok, true);
    t += 1000;
    // Refresh path onto a new project identity.
    assert.equal(store.registerTuiSession(reg({
      trackingId, connectionId: '1'.repeat(32), cwd: 'C:/proj/drift-new',
    })).ok, true);
    store.appendTuiEvent({ trackingId, kind: 'status', payload: null });
    const refreshed = brokerEvents().filter((e) => e.kind === 'status').at(-1);
    assert.equal(refreshed.alias, null, 'a drifted project never carries the old alias');
    const newKey = getSession(trackingId).projectKey;
    assert.equal(refreshed.projectKey, newKey);
    // INSERT path after disconnect onto yet another project.
    assert.equal(store.disconnectTuiSession({ trackingId, connectionId: '1'.repeat(32) }).ok, true);
    t += 1000;
    assert.equal(store.registerTuiSession(reg({
      trackingId, connectionId: '2'.repeat(32), cwd: 'C:/proj/drift-third',
    })).ok, true);
    store.appendTuiEvent({ trackingId, kind: 'status', payload: null });
    const inserted = brokerEvents().filter((e) => e.kind === 'status').at(-1);
    assert.equal(inserted.alias, null);
    assert.notEqual(inserted.projectKey, newKey, 'the third project has its own identity');
    assert.equal(withRawDb((db) =>
      db.prepare('SELECT COUNT(*) AS n FROM tui_session_aliases WHERE tracking_id = ?').get(trackingId).n,
    ), 0, 'no stale alias row exists anywhere');
  });

  test('legacy pending events backfill from the exact current session (including its session alias)', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/backfill-live', branch: 'legacy' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'legacy alias' }).ok, true);
    const projectKey = getSession(trackingId).projectKey;
    reopen();
    insertLegacyEvent(trackingId, 'status');
    insertLegacyEvent(trackingId, 'command_result');
    reopen();
    const events = brokerEvents().filter((e) => e.kind === 'status' || e.kind === 'command_result');
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.label, 'alpha');
      assert.equal(event.alias, 'legacy alias', 'the session alias joins on tracking_id + project_key');
      assert.equal(event.branch, 'legacy');
      assert.equal(event.projectKey, projectKey);
    }
    // Idempotent: another reopen must not change anything.
    reopen();
    const after = brokerEvents().filter((e) => e.kind === 'status' || e.kind === 'command_result');
    assert.equal(after.length, 2);
    for (const event of after) {
      assert.equal(event.alias, 'legacy alias');
      assert.equal(event.projectKey, projectKey);
    }
  });

  test('legacy pending events with a deleted session fall back to the newest exactly-matching project row', () => {
    const trackingId = 'a'.repeat(32);
    const otherId = 'b'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/fallback', branch: 'fb-branch' }));
    assert.equal(store.setTuiSessionAlias({ trackingId, alias: 'fb alias' }).ok, true);
    // An unrelated window in another project must not be picked up.
    store.registerTuiSession(reg({
      trackingId: otherId, connectionId: '2'.repeat(32), cwd: 'C:/proj/unrelated', label: 'other',
    }));
    assert.equal(store.disconnectTuiSession({ trackingId, connectionId: 'c'.repeat(32) }).ok, true);
    const projectKey = store.listRecentTuiProjects({ since: 0 })
      .find((p) => p.label === 'alpha').projectKey;
    reopen();
    insertLegacyEvent(trackingId, 'command_result');
    reopen();
    const event = brokerEvents().find((e) => e.kind === 'command_result');
    assert.equal(event.label, 'alpha');
    assert.equal(event.alias, 'fb alias', 'the alias joins only on the exact matched project');
    assert.equal(event.branch, 'fb-branch');
    assert.equal(event.projectKey, projectKey);
  });

  test('acknowledged legacy events are never touched by the backfill', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/acked' }));
    reopen();
    // 'command_result' is unique to the legacy row in this scenario.
    insertLegacyEvent(trackingId, 'command_result', { acked: true });
    reopen();
    const rows = withRawDb((db) =>
      db.prepare("SELECT session_label, session_alias, session_branch, project_key FROM tui_events WHERE kind = 'command_result'").all());
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [rows[0].session_label, rows[0].session_alias, rows[0].session_branch, rows[0].project_key],
      [null, null, null, null],
      'acked legacy rows stay exactly as they were',
    );
  });

  test('missing identity stays null without throwing; the backfill never guesses', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/never-again' }));
    assert.equal(store.disconnectTuiSession({ trackingId, connectionId: 'c'.repeat(32) }).ok, true);
    reopen();
    // A tracking id matching NO current session and NO project row.
    insertLegacyEvent('f'.repeat(32), 'final_output');
    reopen();
    const event = brokerEvents().find((e) => e.trackingId === 'f'.repeat(32));
    assert.ok(event, 'the legacy event is still drainable');
    assert.deepEqual(
      { label: event.label, alias: event.alias, branch: event.branch, projectKey: event.projectKey },
      { label: null, alias: null, branch: null, projectKey: null },
      'no match means no invented identity',
    );
  });

  test('the backfill never uses the project alias as a session alias', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/no-project-alias' }));
    const projectKey = getSession(trackingId).projectKey;
    assert.equal(store.setTuiProjectAlias({ projectKey, alias: 'project-only name' }).ok, true);
    assert.equal(store.disconnectTuiSession({ trackingId, connectionId: 'c'.repeat(32) }).ok, true);
    reopen();
    insertLegacyEvent(trackingId, 'disconnected');
    reopen();
    const event = brokerEvents().find((e) => e.kind === 'disconnected');
    assert.equal(event.label, 'alpha', 'label/branch/project come from the project row');
    assert.equal(event.alias, null, 'the project alias is NOT a session alias');
  });

  test('migration is additive, nullable and idempotent across reopen', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/mig' }));
    store.appendTuiEvent({ trackingId, kind: 'status', payload: null });
    reopen();
    reopen();
    const columns = snapshotColumns();
    for (const col of ['session_label', 'session_alias', 'session_branch', 'project_key']) {
      assert.ok(columns.includes(col), `${col} exists`);
    }
    const rows = snapshotRows();
    assert.equal(rows.length, 2, 'connected + status, no duplication');
    assert.equal(rows[0].session_label, 'alpha');
    assert.equal(rows[0].project_key, getSession(trackingId).projectKey);
    reopen();
    assert.equal(snapshotRows().length, 2, 'no duplication on re-migration');
  });

  test('returned broker events are frozen', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({ trackingId, cwd: 'C:/proj/frozen-events' }));
    store.appendTuiEvent({ trackingId, kind: 'status', payload: null });
    const event = brokerEvents()[0];
    assert.throws(() => { event.label = 'mutated'; }, TypeError);
    assert.throws(() => { event.alias = 'mutated'; }, TypeError);
    assert.throws(() => { event.projectKey = 'mutated'; }, TypeError);
  });

  test('no snapshot column or value contains cwd, pid, shortId, connection or pi-session data', () => {
    const trackingId = 'a'.repeat(32);
    store.registerTuiSession(reg({
      trackingId,
      cwd: 'C:/proj/very-secret-path',
      piSessionId: 'pi-session-xyz',
      piSessionFile: 'C:/proj/very-secret-path/session.jsonl',
    }));
    store.setTuiSessionAlias({ trackingId, alias: 'private window' });
    t += 1000;
    store.appendTuiEvent({ trackingId, kind: 'final_output', payload: { text: 'hello' } });
    store.disconnectTuiSession({ trackingId, connectionId: 'c'.repeat(32) });
    const events = brokerEvents();
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('very-secret-path'), 'no raw cwd in returned events');
    assert.ok(!serialized.includes('pi-session-xyz'), 'no pi session id in returned events');
    for (const forbidden of ['cwd', 'pid', 'shortId', 'connectionId', 'piSessionId', 'piSessionFile']) {
      for (const event of events) {
        assert.ok(!(forbidden in event), `${forbidden} must never be exposed`);
      }
    }
    const columns = snapshotColumns();
    for (const col of columns) {
      assert.ok(
        !['cwd', 'pid', 'short_id', 'connection_id', 'pi_session_id', 'pi_session_file'].includes(col),
        `no forbidden column ${col}`,
      );
    }
    for (const row of snapshotRows()) {
      const values = JSON.stringify(row);
      assert.ok(!values.includes('very-secret-path'), 'no raw cwd in stored snapshot columns');
      assert.ok(!values.includes('pi-session-xyz'), 'no pi session id in stored snapshot columns');
    }
  });
});
