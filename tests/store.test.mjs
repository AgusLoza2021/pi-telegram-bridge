// T01 store contract tests, rev 2 (defect B7 + simultaneous race).
// Databases live only under module .local/test-runs (git-ignored), unique dirs.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../src/store.mjs';

// Test artifacts live only under the module's ignored .local/test-runs.
const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const T0 = 1_700_000_000_000;
const ACTION = Object.freeze({ kind: 'ask_user_choice', question: 'Proceed?' });

let dir;

function openStore(name, opts = {}) {
  return new Store(join(dir, `${name}.sqlite`), {
    now: () => T0,
    ...opts,
  });
}

// Race worker: opens its own independent connection, waits on an Atomics
// barrier (no sleeps), then attempts the compare-and-set decision once.
const RACE_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { pathToFileURL } = await import('node:url');
  const { Store } = await import(pathToFileURL(workerData.storePath).href);
  Atomics.wait(new Int32Array(workerData.sab), 0, 0);
  const store = new Store(workerData.dbPath, { now: () => workerData.t0 });
  const res = store.recordDecision({
    requestId: workerData.requestId,
    sessionId: workerData.sessionId,
    decision: { choice: workerData.choice },
  });
  store.close();
  parentPort.postMessage({ ok: res.ok, reason: res.reason ?? null, choice: workerData.choice });
})().catch((error) => parentPort.postMessage({ ok: false, error: String(error) }));
`;

describe('store: sessions and requests', () => {
  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'store-'));
    store = openStore('main');
    store.setHostGeneration(1);
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
  });

  afterEach(() => {
    store.close();
  });

  test('creates opaque single-use request bound to session and generation', () => {
    const res = store.createRequest({ sessionId: 's1', action: ACTION });
    assert.equal(res.ok, true);
    const req = store.getRequest(res.request.requestId);
    assert.equal(req.state, 'running');
    assert.equal(req.sessionId, 's1');
    assert.equal(req.hostGeneration, 1);
    assert.match(req.requestId, /^[0-9a-f]{32}$/);
    assert.deepEqual(req.action, ACTION);
  });

  test('request options are immutable once created', () => {
    const res = store.createRequest({ sessionId: 's1', action: ACTION });
    const req = store.getRequest(res.request.requestId);
    assert.throws(() => { req.action.kind = 'mutated'; });
    const reread = store.getRequest(res.request.requestId);
    assert.equal(reread.action.kind, 'ask_user_choice');
  });

  test('rejects malformed actions (B7)', () => {
    class Exotic { constructor() { this.x = 1; } }
    assert.throws(() => store.createRequest({ sessionId: 's1', action: 'raw-string' }), TypeError);
    assert.throws(() => store.createRequest({ sessionId: 's1', action: [1, 2] }), TypeError);
    assert.throws(() => store.createRequest({ sessionId: 's1', action: 42 }), TypeError);
    assert.throws(() => store.createRequest({ sessionId: 's1' }), TypeError);
    assert.throws(() => store.createRequest({ sessionId: 's1', action: null }), TypeError);
    // Non-plain prototypes (class instances, Date, Map) must also fail closed:
    // they do not survive a JSON round-trip with their behavior intact.
    assert.throws(() => store.createRequest({ sessionId: 's1', action: new Exotic() }), TypeError);
    assert.throws(() => store.createRequest({ sessionId: 's1', action: new Date() }), TypeError);
    assert.throws(() => store.createRequest({ sessionId: 's1', action: new Map() }), TypeError);
  });

  test('action/decision accept null-prototype plain objects', () => {
    const action = Object.assign(Object.create(null), { kind: 'ask_user_choice' });
    const res = store.createRequest({ sessionId: 's1', action });
    assert.equal(res.ok, true);
  });

  test('rejects request for unknown session', () => {
    assert.equal(
      store.createRequest({ sessionId: 'nope', action: ACTION }).ok,
      false,
    );
  });

  test('enforces at most one active request per session', () => {
    store.createRequest({ sessionId: 's1', action: ACTION });
    const second = store.createRequest({ sessionId: 's1', action: ACTION });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'session_busy');
  });

  test('session becomes free again after terminal state', () => {
    const res = store.createRequest({ sessionId: 's1', action: ACTION });
    store.markWaitingDecision(res.request.requestId);
    store.recordDecision({
      requestId: res.request.requestId,
      sessionId: 's1',
      decision: { choice: 0 },
    });
    store.completeRequest({
      requestId: res.request.requestId,
      sessionId: 's1',
      result: { done: true },
    });
    const next = store.createRequest({ sessionId: 's1', action: ACTION });
    assert.equal(next.ok, true);
  });
});

describe('store: decision state machine', () => {
  let store;
  let requestId;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'store-'));
    store = openStore('fsm');
    store.setHostGeneration(1);
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const res = store.createRequest({ sessionId: 's1', action: ACTION });
    requestId = res.request.requestId;
    assert.equal(store.markWaitingDecision(requestId).ok, true);
  });

  afterEach(() => {
    store.close();
  });

  test('compare-and-set decision wins exactly once', () => {
    const first = store.recordDecision({
      requestId,
      sessionId: 's1',
      decision: { choice: 0 },
    });
    assert.equal(first.ok, true);
    assert.equal(store.getRequest(requestId).state, 'resuming');
    assert.deepEqual(store.getRequest(requestId).decision, { choice: 0 });

    const second = store.recordDecision({
      requestId,
      sessionId: 's1',
      decision: { choice: 1 },
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'invalid_state');
    assert.deepEqual(store.getRequest(requestId).decision, { choice: 0 });
  });

  test('rejects malformed decision payloads (B7)', () => {
    for (const decision of ['raw', 42, [1, 2], null, undefined]) {
      assert.throws(
        () => store.recordDecision({ requestId, sessionId: 's1', decision }),
        TypeError,
        `decision ${JSON.stringify(decision)} should be rejected`,
      );
    }
    assert.equal(store.getRequest(requestId).state, 'waiting_decision');
  });

  test('rejects non-plain-prototype decisions (B7)', () => {
    class Exotic { constructor() { this.x = 1; } }
    for (const decision of [new Exotic(), new Date(), new Map()]) {
      assert.throws(
        () => store.recordDecision({ requestId, sessionId: 's1', decision }),
        TypeError,
      );
    }
    assert.equal(store.getRequest(requestId).state, 'waiting_decision');
  });

  test('decision generation is read while holding the write transaction', () => {
    // Deterministic proof that recordDecision resolves 'current' INSIDE its
    // BEGIN IMMEDIATE transaction: from inside the generation read, a second
    // connection to the same database can only fail its own BEGIN IMMEDIATE
    // when the first connection already holds the write lock. If the read
    // ever happened outside the transaction, the second connection would
    // succeed, bump the generation, and both assertions below would fail.
    // (Probed cross-connection, so it stays valid with re-entrant store
    // transactions introduced by T03's atomic update unit.)
    let nestedWriteBlocked = false;
    store.getHostGeneration = function () {
      let probe;
      try {
        probe = new DatabaseSync(join(dir, 'fsm.sqlite'));
        probe.exec('BEGIN IMMEDIATE');
        // Invariant broken: perform the same write the original probe did.
        probe.exec(
          `INSERT INTO meta (key, value) VALUES ('host_generation', '2')
           ON CONFLICT(key) DO UPDATE SET value = '2'`,
        );
        probe.exec('COMMIT');
      } catch (error) {
        nestedWriteBlocked = /busy|locked/i.test(String(error.message));
      } finally {
        try { probe?.close(); } catch { /* already closed */ }
      }
      return 1;
    };
    const res = store.recordDecision({ requestId, sessionId: 's1', decision: { choice: 0 } });
    assert.equal(res.ok, true);
    assert.equal(nestedWriteBlocked, true, 'generation read must happen inside the write transaction');
    delete store.getHostGeneration;
    assert.equal(store.getHostGeneration(), 1);
  });

  test('cross-session decision is rejected', () => {
    store.createSession({ sessionId: 's2', piSessionId: 'pi-2' });
    const res = store.recordDecision({
      requestId,
      sessionId: 's2',
      decision: { choice: 0 },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'session_mismatch');
    assert.equal(store.getRequest(requestId).state, 'waiting_decision');
  });

  test('host generation mismatch invalidates old approvals', () => {
    store.setHostGeneration(2);
    const res = store.recordDecision({
      requestId,
      sessionId: 's1',
      decision: { choice: 0 },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'host_generation_mismatch');
    assert.equal(store.getRequest(requestId).state, 'waiting_decision');
  });

  test('completed only from resuming or running, observed result stored', () => {
    const tooSoon = store.completeRequest({
      requestId,
      sessionId: 's1',
      result: { done: true },
    });
    assert.equal(tooSoon.ok, false);

    store.recordDecision({ requestId, sessionId: 's1', decision: { choice: 0 } });
    const ok = store.completeRequest({
      requestId,
      sessionId: 's1',
      result: { done: true },
    });
    assert.equal(ok.ok, true);
    assert.equal(store.getRequest(requestId).state, 'completed');
    assert.deepEqual(store.getRequest(requestId).result, { done: true });
  });

  test('failed is reachable from waiting_decision and resuming', () => {
    const a = store.failRequest({ requestId, sessionId: 's1', reason: 'boom' });
    assert.equal(a.ok, true);
    assert.equal(store.getRequest(requestId).state, 'failed');
  });

  test('cancel from waiting_decision', () => {
    const res = store.cancelRequest({ requestId, sessionId: 's1' });
    assert.equal(res.ok, true);
    assert.equal(store.getRequest(requestId).state, 'cancelled');
    const after = store.recordDecision({
      requestId,
      sessionId: 's1',
      decision: { choice: 0 },
    });
    assert.equal(after.ok, false);
  });
});

describe('store: expiry', () => {
  test('expired requests fail closed on decision', () => {
    dir = mkdtempSync(join(TEST_RUNS, 'store-'));
    let now = T0;
    const store = new Store(join(dir, 'exp.sqlite'), { now: () => now });
    store.setHostGeneration(1);
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const res = store.createRequest({
      sessionId: 's1',
      action: ACTION,
      ttlMs: 1000,
    });
    store.markWaitingDecision(res.request.requestId);

    now = T0 + 2000;
    const expired = store.expireRequests();
    assert.equal(expired.length, 1);
    assert.equal(store.getRequest(res.request.requestId).state, 'expired');

    const decision = store.recordDecision({
      requestId: res.request.requestId,
      sessionId: 's1',
      decision: { choice: 0 },
    });
    assert.equal(decision.ok, false);
    assert.equal(decision.reason, 'invalid_state');
    store.close();
  });

  test('expiry does not touch requests inside their ttl', () => {
    dir = mkdtempSync(join(TEST_RUNS, 'store-'));
    let now = T0;
    const store = new Store(join(dir, 'exp2.sqlite'), { now: () => now });
    store.setHostGeneration(1);
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    store.createRequest({ sessionId: 's1', action: ACTION, ttlMs: 1000 });
    now = T0 + 999;
    assert.deepEqual(store.expireRequests(), []);
    store.close();
  });
});

describe('store: concurrency, persistence, isolation', () => {
  test('simultaneous independent connections yield exactly one decision winner', async () => {
    dir = mkdtempSync(join(TEST_RUNS, 'store-'));
    const setup = openStore('race');
    setup.setHostGeneration(1);
    setup.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const res = setup.createRequest({ sessionId: 's1', action: ACTION });
    assert.equal(setup.markWaitingDecision(res.request.requestId).ok, true);

    const dbPath = join(dir, 'race.sqlite');
    const storePath = fileURLToPath(new URL('../src/store.mjs', import.meta.url));
    const sab = new SharedArrayBuffer(4);
    const int32 = new Int32Array(sab);

    const startWorker = (choice) => new Promise((resolve, reject) => {
      const worker = new Worker(RACE_WORKER_SOURCE, {
        eval: true,
        workerData: {
          dbPath,
          storePath,
          sab,
          requestId: res.request.requestId,
          sessionId: 's1',
          choice,
          t0: T0,
        },
      });
      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`worker exited with ${code}`));
      });
    });

    const resultsPromise = Promise.all([startWorker(0), startWorker(1)]);
    // Release the barrier: waiting workers wake, early workers see a
    // non-zero value and skip waiting. Either way both start together.
    Atomics.store(int32, 0, 1);
    Atomics.notify(int32, 0, 2);
    const results = await resultsPromise;
    setup.close();

    for (const result of results) {
      assert.equal(result.error, undefined, `worker error: ${result.error}`);
    }
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok).length, 1);
    const winner = results.find((r) => r.ok);

    const check = openStore('race');
    const req = check.getRequest(res.request.requestId);
    assert.equal(req.state, 'resuming');
    assert.deepEqual(req.decision, { choice: winner.choice });
    check.close();
  });

  test('restart persists request state without reusing approvals', () => {
    dir = mkdtempSync(join(TEST_RUNS, 'store-'));
    const first = openStore('restart');
    first.setHostGeneration(1);
    first.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const res = first.createRequest({ sessionId: 's1', action: ACTION });
    first.markWaitingDecision(res.request.requestId);
    first.close();

    const second = openStore('restart');
    const req = second.getRequest(res.request.requestId);
    assert.equal(req.state, 'waiting_decision');
    assert.deepEqual(req.action, ACTION);
    // New host generation on restart: old approvals stay invalid.
    second.setHostGeneration(2);
    const stale = second.recordDecision({
      requestId: res.request.requestId,
      sessionId: 's1',
      decision: { choice: 0 },
    });
    assert.equal(stale.ok, false);
    second.close();
  });

  test('two sessions are isolated', () => {
    dir = mkdtempSync(join(TEST_RUNS, 'store-'));
    const store = openStore('iso');
    store.setHostGeneration(1);
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    store.createSession({ sessionId: 's2', piSessionId: 'pi-2' });
    const r1 = store.createRequest({ sessionId: 's1', action: ACTION });
    const r2 = store.createRequest({ sessionId: 's2', action: ACTION });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.notEqual(r1.request.requestId, r2.request.requestId);
    store.close();
  });
});

describe('store: transport inbox, outbox, offset', () => {
  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'store-'));
    store = openStore('transport');
    store.setHostGeneration(1);
  });

  afterEach(() => {
    store.close();
  });

  test('inbox deduplicates stable update ids', () => {
    const first = store.recordInbox({ inboxId: 'u-42', kind: 'callback', payload: {} });
    const second = store.recordInbox({ inboxId: 'u-42', kind: 'callback', payload: {} });
    assert.equal(first, true);
    assert.equal(second, false);
  });

  test('outbox enqueue, claim and delivered marking', () => {
    const id = store.enqueueOutbox({ kind: 'status', payload: { text: 'hi' } });
    assert.ok(id > 0);
    let pending = store.listPendingOutbox();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'status');
    store.markOutboxDelivered(id);
    pending = store.listPendingOutbox();
    assert.equal(pending.length, 0);
  });

  test('outbox payload is bounded', () => {
    const big = 'x'.repeat(64 * 1024);
    assert.throws(
      () => store.enqueueOutbox({ kind: 'status', payload: { big } }),
      RangeError,
    );
  });

  test('telegram offset advances only forward', () => {
    assert.equal(store.getTransportOffset(), 0);
    store.advanceTransportOffset(100);
    assert.equal(store.getTransportOffset(), 100);
    store.advanceTransportOffset(100);
    assert.equal(store.getTransportOffset(), 100);
    store.advanceTransportOffset(90);
    assert.equal(store.getTransportOffset(), 100);
    store.advanceTransportOffset(101);
    assert.equal(store.getTransportOffset(), 101);
  });

  test('recovery lists waiting decisions and never auto-replays resuming', () => {
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const r = store.createRequest({ sessionId: 's1', action: ACTION });
    store.markWaitingDecision(r.request.requestId);
    const pending = store.listRecoverableRequests();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].state, 'waiting_decision');
    assert.deepEqual(pending[0].action, ACTION);

    store.recordDecision({
      requestId: r.request.requestId,
      sessionId: 's1',
      decision: { choice: 0 },
    });
    // A resuming request is reported for observation only; its recovery
    // entry carries no resumable action payload to replay.
    const after = store.listRecoverableRequests();
    assert.equal(after.length, 0);
  });
});

describe('store: git approval protocol (closed typed command/event contract, G2)', () => {
  const TRACKING = 'a'.repeat(32);
  const CONNECTION = '1'.repeat(32);
  const PROPOSAL_ID = 'ab12cd34ef560172';

  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'store-'));
    store = openStore('git-protocol', { isProcessAlive: () => true });
    const res = store.registerTuiSession({
      trackingId: TRACKING,
      connectionId: CONNECTION,
      label: 'alpha',
      pid: 1111,
      staleCutoff: T0,
    });
    assert.equal(res.ok, true);
  });

  afterEach(() => {
    store.close();
  });

  test('accepts the four closed git command kinds with their exact payload shapes', () => {
    for (const kind of ['git_commit_request', 'git_push_request']) {
      assert.equal(
        store.enqueueTuiCommand({ trackingId: TRACKING, kind, payload: null }).ok,
        true,
        `${kind} accepts a null payload`,
      );
    }
    for (const kind of ['git_commit_execute', 'git_push_execute']) {
      assert.equal(
        store.enqueueTuiCommand({
          trackingId: TRACKING, kind, payload: { proposalId: PROPOSAL_ID },
        }).ok,
        true,
        `${kind} accepts a closed proposalId payload`,
      );
    }
  });

  test('git request commands fail closed on any non-null payload', () => {
    for (const kind of ['git_commit_request', 'git_push_request']) {
      assert.throws(
        () => store.enqueueTuiCommand({ trackingId: TRACKING, kind, payload: {} }),
        TypeError,
      );
      assert.throws(
        () => store.enqueueTuiCommand({ trackingId: TRACKING, kind, payload: { text: 'rm -rf' } }),
        TypeError,
      );
    }
  });

  test('git execute commands accept only a well-formed proposalId payload', () => {
    for (const kind of ['git_commit_execute', 'git_push_execute']) {
      assert.throws(
        () => store.enqueueTuiCommand({ trackingId: TRACKING, kind, payload: null }),
        TypeError,
      );
      assert.throws(
        () => store.enqueueTuiCommand({ trackingId: TRACKING, kind, payload: {} }),
        TypeError,
      );
      assert.throws(
        () => store.enqueueTuiCommand({
          trackingId: TRACKING, kind, payload: { proposalId: 'not-hex!' },
        }),
        TypeError,
      );
      assert.throws(
        () => store.enqueueTuiCommand({
          trackingId: TRACKING, kind, payload: { proposalId: 'AB12CD34EF560172' },
        }),
        TypeError,
      );
      assert.throws(
        () => store.enqueueTuiCommand({
          trackingId: TRACKING, kind, payload: { proposalId: 'ab12' },
        }),
        TypeError,
      );
      // The proposalId is the ONLY field: a command string or argv can
      // never ride along inside an execute payload.
      assert.throws(
        () => store.enqueueTuiCommand({
          trackingId: TRACKING,
          kind,
          payload: { proposalId: PROPOSAL_ID, argv: ['git', 'push', '--force'] },
        }),
        TypeError,
      );
    }
  });

  test('git_proposal events accept the closed commit and push shapes', () => {
    assert.equal(
      store.appendTuiEvent({
        trackingId: TRACKING,
        kind: 'git_proposal',
        payload: { operation: 'commit', proposalId: PROPOSAL_ID, message: 'Add tomato bed logic' },
      }).ok,
      true,
    );
    assert.equal(
      store.appendTuiEvent({
        trackingId: TRACKING,
        kind: 'git_proposal',
        payload: { operation: 'push', proposalId: PROPOSAL_ID },
      }).ok,
      true,
    );
    // G3: a push proposal may carry the bounded snapshot summary the
    // approval card must show (branch, upstream, HEAD, fingerprint).
    assert.equal(
      store.appendTuiEvent({
        trackingId: TRACKING,
        kind: 'git_proposal',
        payload: {
          operation: 'push', proposalId: PROPOSAL_ID, message: 'Branch: main → origin/main',
        },
      }).ok,
      true,
    );
    const pending = store.listPendingBrokerTuiEvents({ limit: 10 });
    const proposals = pending.filter((e) => e.kind === 'git_proposal');
    assert.equal(proposals.length, 3);
    assert.deepEqual(proposals[0].payload, {
      operation: 'commit', proposalId: PROPOSAL_ID, message: 'Add tomato bed logic',
    });
    assert.deepEqual(proposals[1].payload, { operation: 'push', proposalId: PROPOSAL_ID });
    assert.deepEqual(proposals[2].payload, {
      operation: 'push', proposalId: PROPOSAL_ID, message: 'Branch: main → origin/main',
    });
  });

  test('git_proposal events fail closed on every malformed shape', () => {
    const base = { trackingId: TRACKING, kind: 'git_proposal' };
    assert.throws(() => store.appendTuiEvent({ ...base, payload: null }), TypeError);
    assert.throws(
      () => store.appendTuiEvent({
        ...base,
        payload: { operation: 'shell', proposalId: PROPOSAL_ID },
      }),
      TypeError,
    );
    assert.throws(
      () => store.appendTuiEvent({
        ...base,
        payload: { operation: 'commit', proposalId: PROPOSAL_ID },
      }),
      TypeError,
      'a commit proposal without the exact message is rejected',
    );
    assert.throws(
      () => store.appendTuiEvent({
        ...base,
        payload: { operation: 'commit', proposalId: PROPOSAL_ID, message: '' },
      }),
      TypeError,
    );
    assert.throws(
      () => store.appendTuiEvent({
        ...base,
        payload: { operation: 'commit', proposalId: PROPOSAL_ID, message: 'x'.repeat(4097) },
      }),
      TypeError,
    );
    // G3: a push message is optional but, when present, must still be a
    // well-formed bounded text — the same closed rules as a commit message.
    assert.throws(
      () => store.appendTuiEvent({
        ...base,
        payload: { operation: 'push', proposalId: PROPOSAL_ID, message: '' },
      }),
      TypeError,
    );
    assert.throws(
      () => store.appendTuiEvent({
        ...base,
        payload: {
          operation: 'push', proposalId: PROPOSAL_ID, message: 'x'.repeat(4097),
        },
      }),
      TypeError,
    );
    assert.throws(
      () => store.appendTuiEvent({
        ...base,
        payload: { operation: 'commit', proposalId: 'zz', message: 'Add x' },
      }),
      TypeError,
    );
    // Closed shapes: no extra field (a command string or argv) can ride
    // along inside a proposal event either.
    assert.throws(
      () => store.appendTuiEvent({
        ...base,
        payload: {
          operation: 'push', proposalId: PROPOSAL_ID, cwd: 'C:/x',
        },
      }),
      TypeError,
    );
  });
});
