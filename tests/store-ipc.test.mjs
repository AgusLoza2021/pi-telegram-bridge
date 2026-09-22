// T02 WU2: persistent SQLite-only IPC — typed action queue (at-most-once),
// host singleton lease with PID-liveness takeover, atomic generation bump,
// session listing. Databases live only under module .local/test-runs.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const T0 = 1_700_000_000_000;

describe('store ipc: typed action queue (at-most-once)', () => {
  let store;
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'ipc-'));
    store = new Store(join(dir, 'main.sqlite'), { now: () => T0 });
  });
  afterEach(() => store.close());

  test('enqueue deduplicates by actionId (at-most-once)', () => {
    const first = store.enqueueAction({ actionId: 'a1', type: 'decision', payload: { choice: 0 } });
    const duplicate = store.enqueueAction({ actionId: 'a1', type: 'decision', payload: { choice: 0 } });
    assert.equal(first, true);
    assert.equal(duplicate, false);
  });

  test('claim returns oldest pending action and marks it claimed for the owner', () => {
    store.enqueueAction({ actionId: 'a1', type: 'decision', payload: { requestId: 'r1' } });
    store.enqueueAction({ actionId: 'a2', type: 'cancel', payload: { requestId: 'r1' } });
    const claim = store.claimNextAction({ ownerId: 'host-1', now: T0 });
    assert.equal(claim.ok, true);
    assert.equal(claim.action.actionId, 'a1');
    assert.equal(claim.action.type, 'decision');
    assert.deepEqual(claim.action.payload, { requestId: 'r1' });

    // Second claim gets the next one; owner binding is recorded.
    const second = store.claimNextAction({ ownerId: 'host-1', now: T0 + 1 });
    assert.equal(second.ok, true);
    assert.equal(second.action.actionId, 'a2');
  });

  test('claim on empty queue reports empty, not an error', () => {
    const claim = store.claimNextAction({ ownerId: 'host-1', now: T0 });
    assert.equal(claim.ok, false);
    assert.equal(claim.reason, 'empty');
  });

  test('completeAction only succeeds for the claiming owner while claimed', () => {
    store.enqueueAction({ actionId: 'a1', type: 'decision', payload: {} });
    store.claimNextAction({ ownerId: 'host-1', now: T0 });

    const wrongOwner = store.completeAction({ actionId: 'a1', ownerId: 'host-2' });
    assert.equal(wrongOwner.ok, false);
    assert.equal(wrongOwner.reason, 'not_owner');

    const ok = store.completeAction({ actionId: 'a1', ownerId: 'host-1' });
    assert.equal(ok.ok, true);

    // Completing twice fails closed (at-most-once processing).
    const again = store.completeAction({ actionId: 'a1', ownerId: 'host-1' });
    assert.equal(again.ok, false);
  });

  test('crash-after-claim: stale claim is failed, never replayed', () => {
    store.enqueueAction({ actionId: 'a1', type: 'decision', payload: {} });
    store.claimNextAction({ ownerId: 'host-crashed', now: T0 });

    const failed = store.failStaleClaimedActions({ now: T0 + 60_000, claimTimeoutMs: 30_000 });
    assert.deepEqual(failed, ['a1']);

    // Not re-claimable after the crash — the action is dead, never replayed.
    const claim = store.claimNextAction({ ownerId: 'host-2', now: T0 + 60_001 });
    assert.equal(claim.ok, false);
    assert.equal(claim.reason, 'empty');
  });

  test('fresh claims are not expired by failStaleClaimedActions', () => {
    store.enqueueAction({ actionId: 'a1', type: 'decision', payload: {} });
    store.claimNextAction({ ownerId: 'host-1', now: T0 });
    const failed = store.failStaleClaimedActions({ now: T0 + 1_000, claimTimeoutMs: 30_000 });
    assert.deepEqual(failed, []);
    const claim = store.claimNextAction({ ownerId: 'host-2', now: T0 + 1_001 });
    assert.equal(claim.ok, false, 'still claimed, not claimable by others');
  });
});

describe('store ipc: host singleton lease', () => {
  let store;
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'lease-'));
  });
  afterEach(() => store.close());

  test('acquires when free, renews for the same owner', () => {
    store = new Store(join(dir, 'a.sqlite'), { now: () => T0 });
    const first = store.acquireHostLease({ ownerId: 'host-1', pid: 111 });
    assert.equal(first.ok, true);

    const renew = store.renewHostLease({ ownerId: 'host-1', now: T0 + 1000 });
    assert.equal(renew.ok, true);

    const reacquire = store.acquireHostLease({ ownerId: 'host-1', pid: 111 });
    assert.equal(reacquire.ok, true);
  });

  test('denies takeover while the previous owner PID is alive', () => {
    store = new Store(join(dir, 'b.sqlite'), { now: () => T0, isProcessAlive: () => true });
    store.acquireHostLease({ ownerId: 'host-1', pid: 111 });
    const steal = store.acquireHostLease({ ownerId: 'host-2', pid: 222 });
    assert.equal(steal.ok, false);
    assert.equal(steal.reason, 'lease_busy');
  });

  test('takes over only when the previous owner PID is verifiably dead', () => {
    store = new Store(join(dir, 'c.sqlite'), { now: () => T0, isProcessAlive: () => false });
    store.acquireHostLease({ ownerId: 'host-1', pid: 111 });
    const steal = store.acquireHostLease({ ownerId: 'host-2', pid: 222 });
    assert.equal(steal.ok, true);
    // Old owner cannot renew after takeover.
    assert.equal(store.renewHostLease({ ownerId: 'host-1', now: T0 + 1 }).ok, false);
  });

  test('release frees the lease for anyone', () => {
    store = new Store(join(dir, 'd.sqlite'), { now: () => T0, isProcessAlive: () => true });
    store.acquireHostLease({ ownerId: 'host-1', pid: 111 });
    const wrong = store.releaseHostLease({ ownerId: 'host-2' });
    assert.equal(wrong.ok, false);
    assert.equal(store.releaseHostLease({ ownerId: 'host-1' }).ok, true);
    assert.equal(store.acquireHostLease({ ownerId: 'host-3', pid: 333 }).ok, true);
  });

  test('default liveness probe never signals the process (kill(pid, 0) only)', () => {
    // Against the integration contract: the default probe uses signal 0,
    // which cannot kill anything. Verify behaviorally on our own PID.
    store = new Store(join(dir, 'e.sqlite'), { now: () => T0 });
    assert.equal(store.acquireHostLease({ ownerId: 'host-1', pid: process.pid }).ok, true);
    const other = store.acquireHostLease({ ownerId: 'host-2', pid: process.pid });
    assert.equal(other.ok, false, 'own live PID must count as alive');
  });

  test('same owner with a DIFFERENT live pid cannot sneak past the lease', () => {
    // Two live hosts under one ownerId would break singleton guarantees.
    store = new Store(join(dir, 'f.sqlite'), { now: () => T0, isProcessAlive: () => true });
    store.acquireHostLease({ ownerId: 'host-1', pid: 111 });
    const second = store.acquireHostLease({ ownerId: 'host-1', pid: 222 });
    assert.equal(second.ok, false, 'a second live host must be denied even with the same owner');
    assert.equal(second.reason, 'lease_busy');
    // Lease record still points at the original live process.
    assert.equal(store.acquireHostLease({ ownerId: 'host-2', pid: 333 }).ok, false);
  });

  test('same owner with a different DEAD pid takes over (host restarted)', () => {
    store = new Store(join(dir, 'g.sqlite'), { now: () => T0, isProcessAlive: () => false });
    store.acquireHostLease({ ownerId: 'host-1', pid: 111 });
    const restarted = store.acquireHostLease({ ownerId: 'host-1', pid: 222 });
    assert.equal(restarted.ok, true);
    assert.equal(restarted.tookOver, true);
  });

  test('failAction moves a claimed action to terminal failed by its owner', () => {
    store = new Store(join(dir, 'h.sqlite'), { now: () => T0 });
    store.enqueueAction({ actionId: 'act-1', type: 'cancel_request', payload: {} });
    const claim = store.claimNextAction({ ownerId: 'host-1', now: T0 });
    assert.equal(claim.ok, true);
    const wrong = store.failAction({ actionId: 'act-1', ownerId: 'host-2' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason, 'not_owner');
    assert.equal(store.failAction({ actionId: 'act-1', ownerId: 'host-1' }).ok, true);
    // Terminal: not claimable again, not completable.
    assert.equal(store.claimNextAction({ ownerId: 'host-1', now: T0 + 1 }).ok, false);
    const done = store.completeAction({ actionId: 'act-1', ownerId: 'host-1' });
    assert.equal(done.ok, false);
  });
});

describe('store ipc: generation bump and session listing', () => {
  let store;
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'gen-'));
    store = new Store(join(dir, 'a.sqlite'), { now: () => T0 });
  });
  afterEach(() => store.close());

  test('incrementHostGeneration bumps atomically and returns the new value', () => {
    assert.equal(store.incrementHostGeneration(), 1);
    assert.equal(store.incrementHostGeneration(), 2);
    assert.equal(store.getHostGeneration(), 2);
  });

  test('listSessions reports each session with its active request state', () => {
    store.setHostGeneration(1);
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    store.createSession({ sessionId: 's2', piSessionId: 'pi-2' });
    store.createRequest({ sessionId: 's1', action: { kind: 'ask' } });

    const sessions = store.listSessions();
    assert.equal(sessions.length, 2);
    const s1 = sessions.find((s) => s.sessionId === 's1');
    const s2 = sessions.find((s) => s.sessionId === 's2');
    assert.equal(s1.activeRequestState, 'running');
    assert.equal(s2.activeRequestState, null);
    assert.equal(s1.piSessionId, 'pi-1');
  });

  test('listSessions clears activeRequestState after terminal state', () => {
    store.setHostGeneration(1);
    store.createSession({ sessionId: 's1', piSessionId: 'pi-1' });
    const res = store.createRequest({ sessionId: 's1', action: { kind: 'ask' } });
    store.cancelRequest({ requestId: res.request.requestId });
    const sessions = store.listSessions();
    assert.equal(sessions[0].activeRequestState, null);
  });
});
