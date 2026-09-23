// T04: RuntimeHost lifecycle — the detached owner of the Pi pipes.
// Uses fake adapters and a fake worker spawner; the control channel is a
// local typed file (distinct from the Telegram action queue, which the
// worker can never use to shut the host down), heartbeats live in
// host-meta.json, and a worker restart must never bump the host
// generation.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store.mjs';
import { SessionHost } from '../src/session-host.mjs';
import { RuntimeHost } from '../src/runtime-host.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const T0 = 1_700_000_000_000;
const INSTANCE = 'b'.repeat(32);

const drain = () => new Promise((resolve) => setImmediate(resolve));

class FakeAdapter {
  constructor(label) {
    this.label = label;
    this.started = false;
    this.sent = [];
    this.eventHandlers = [];
    this.uiHandlers = [];
    this.disposed = 0;
  }
  async start() {
    this.started = true;
    return { sessionId: `pi-${this.label}`, sessionFile: `fake-${this.label}.jsonl`, pid: 42424 };
  }
  onEvent(handler) { this.eventHandlers.push(handler); }
  onUiRequest(handler) { this.uiHandlers.push(handler); }
  send(command) { this.sent.push(command); return Promise.resolve({ success: true }); }
  respondUi(id, response) { this.uiResponses = this.uiResponses ?? []; this.uiResponses.push({ id, response }); }
  isRunning() { return this.started; }
  async dispose() { this.started = false; this.disposed++; }
  emitUi(request) { for (const h of this.uiHandlers) h(request); }
}

class FakeWorker {
  constructor() {
    this.pid = 30000 + Math.floor(Math.random() * 1000);
    this.stopped = 0;
    this.exitWaiters = [];
  }
  exited() {
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }
  emitExit() { for (const w of this.exitWaiters.splice(0)) w({ code: 0 }); }
  async stop() { this.stopped++; this.emitExit(); }
}

function setup({ demoMode = false, workerSpawner, mode, followupsEnabled = false } = {}) {
  const root = mkdtempSync(join(TEST_RUNS, 'rhost-'));
  const stateRoot = join(root, 'state');
  mkdirSync(stateRoot, { recursive: true });
  const store = new Store(join(stateRoot, 'bridge.sqlite'), {
    now: () => T0,
    isProcessAlive: () => false, // no external processes in tests
  });
  const adapters = new Map();
  const sessionHost = new SessionHost({
    store,
    ownerId: 'runtime-host-test',
    pid: 999,
    adapterFactory: ({ sessionId }) => {
      const adapter = new FakeAdapter(sessionId);
      adapters.set(sessionId, adapter);
      return adapter;
    },
    requestTtlMs: 60_000,
    now: () => T0,
  });
  const spawnLog = [];
  const spawner = workerSpawner ?? (async () => {
    const worker = new FakeWorker();
    spawnLog.push(worker);
    return worker;
  });
  const host = new RuntimeHost({
    store,
    sessionHost,
    instanceId: INSTANCE,
    stateRoot,
    sessionId: 'main',
    ownerId: 'runtime-host-test',
    mode: mode ?? (demoMode ? 'host_demo' : 'production'),
    followupsEnabled,
    workerSpawner: spawner,
    now: () => T0,
    isProcessAlive: () => false,
    tickIntervalMs: 0, // no automatic loop; tests drive tick()
    workerRestartDelayMs: 500,
  });
  return { root, stateRoot, store, sessionHost, host, adapters, spawnLog };
}

beforeEach(() => {});
afterEach(() => {});

describe('RuntimeHost: start and metadata', () => {

  test('start acquires ownership, writes host-meta and a heartbeat, and reports identity', async () => {
    const ctx = setup({});
    const { host, store, stateRoot } = ctx;
    const started = await host.start();
    assert.equal(started.sessionId, 'main');
    assert.equal(started.hostGeneration, store.getHostGeneration());
    assert.ok(started.hostGeneration >= 1);
    const metaPath = join(stateRoot, 'host-meta.json');
    assert.ok(existsSync(metaPath));
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.equal(meta.instanceId, INSTANCE);
    assert.equal(meta.hostGeneration, started.hostGeneration);
    assert.equal(meta.mode, 'production');
    assert.equal(meta.workerDesired, true);
    assert.ok(typeof meta.heartbeatAt === 'number');
    await host.shutdown('test');
    const after = JSON.parse(readFileSync(metaPath, 'utf8'));
    assert.equal(after.shutdownAt > 0, true, 'shutdown must be recorded');
    assert.equal(after.workerDesired, false);
  });

  test('worker restart does NOT bump the host generation (same Pi process ownership)', async () => {
    const ctx = setup({});
    const { host, store, spawnLog } = ctx;
    await host.start();
    const generationBefore = store.getHostGeneration();
    // Simulate the worker dying; the tick must respawn without a bump.
    spawnLog[0].emitExit();
    await drain();
    host.tick(T0 + 10_000);
    await drain();
    assert.equal(store.getHostGeneration(), generationBefore);
    assert.equal(spawnLog.length, 2, 'a replacement worker must be spawned');
    await host.shutdown('test');
  });

  test('worker can never shut the host down through the store action queue', async () => {
    const ctx = setup({});
    const { host, store } = ctx;
    await host.start();
    store.enqueueAction({ actionId: 'evil1', type: 'shutdown', payload: {} });
    store.enqueueAction({ actionId: 'evil2', type: 'stop-host', payload: {} });
    host.tick(T0 + 1_000);
    assert.equal(host.isShutdown(), false, 'unknown/foreign action types must be ignored as lifecycle commands');
    await host.shutdown('test');
  });
});

describe('RuntimeHost: local control channel', () => {
  test('stop-worker is honored and start-worker restores the worker', async () => {
    const ctx = setup({});
    const { host, spawnLog, stateRoot } = ctx;
    await host.start();
    assert.equal(spawnLog.length, 1);
    writeControl(stateRoot, INSTANCE, 'stop-worker');
    host.tick(T0 + 1_000);
    await drain();
    assert.equal(spawnLog[0].stopped, 1);
    host.tick(T0 + 2_000);
    await drain();
    assert.equal(spawnLog.length, 1, 'a stopped worker must not be respawned');
    writeControl(stateRoot, INSTANCE, 'start-worker');
    host.tick(T0 + 3_000);
    await drain();
    assert.equal(spawnLog.length, 2);
    await host.shutdown('test');
  });

  test('stop-host triggers a graceful shutdown: worker stopped, dialogs cancelled, lease released', async () => {
    const ctx = setup({});
    const { host, store, spawnLog, sessionHost } = ctx;
    await host.start();
    writeControl(stateRootjoin(ctx), INSTANCE, 'stop-host');
    host.tick(T0 + 1_000);
    await host.waitUntilStopped();
    assert.equal(host.isShutdown(), true);
    assert.equal(spawnLog[0].stopped, 1);
    // Host lease must be free afterwards: a new host may take over.
    const lease = store.acquireHostLease({ ownerId: 'next-owner', pid: 888 });
    assert.equal(lease.ok, true);
  });

  test('a control file from a different instance is ignored (same-owner spoof rejected)', async () => {
    const ctx = setup({});
    const { host, spawnLog, stateRoot } = ctx;
    await host.start();
    writeControl(stateRoot, 'c'.repeat(32), 'stop-host');
    host.tick(T0 + 1_000);
    assert.equal(host.isShutdown(), false);
    assert.equal(spawnLog.length, 1);
    await host.shutdown('test');
  });

  test('a consumed marker stays terminal across host ticks', async () => {
    const ctx = setup({});
    const { host, stateRoot } = ctx;
    await host.start();
    const controlPath = join(stateRoot, 'control.json');
    const marker = JSON.stringify({ consumedAt: 123 });
    writeFileSync(controlPath, marker);
    host.tick(T0 + 1_000);
    host.tick(T0 + 2_000);
    assert.equal(readFileSync(controlPath, 'utf8'), marker, 'the terminal marker must not be rewritten or re-logged');
    await host.shutdown('test');
  });
});

describe('RuntimeHost: host-only demo mode', () => {
  test('demo dialog is auto-answered and the demo result is recorded', async () => {
    const ctx = setup({ demoMode: true });
    const { host, adapters, stateRoot } = ctx;
    await host.start();
    // The demo command runs fire-and-forget; drive the dialog through.
    const adapter = adapters.get('main');
    const dialog = { id: 'ui-demo-1', method: 'select', title: 'Demo', options: ['Option A', 'Option B'] };
    adapter.emitUi(dialog);
    await drain();
    host.tick(T0 + 500);
    await drain();
    // The nonce-bound notify completes the lifecycle.
    // The extension sends it; in the fake we simulate the notify path via the adapter UI channel.
    adapter.emitUi({ id: 'ui-demo-2', method: 'notify', message: JSON.stringify({ nonce: host.getDemoNonce(), choice: 'Option A' }) });
    await drain();
    host.tick(T0 + 1_000);
    await drain();
    const meta = JSON.parse(readFileSync(join(stateRoot, 'host-meta.json'), 'utf8'));
    assert.equal(meta.lastDemoResult, 'completed');
    assert.equal(meta.mode, 'host_demo');
    await host.shutdown('test');
  });

  test('constructor requires followupsEnabled as an exact boolean and a known mode', () => {
    const ctx = setup({});
    const base = {
      store: ctx.store,
      sessionHost: ctx.sessionHost,
      instanceId: INSTANCE,
      stateRoot: ctx.stateRoot,
      sessionId: 'main',
      workerSpawner: async () => ({}),
      now: () => T0,
      followupsEnabled: false,
      mode: 'production',
    };
    assert.throws(() => new RuntimeHost({ ...base, followupsEnabled: 'yes' }), TypeError);
    const { followupsEnabled, ...missingFlag } = base;
    assert.throws(() => new RuntimeHost(missingFlag), TypeError);
    assert.throws(() => new RuntimeHost({ ...base, mode: 'nonsense' }), TypeError);
    const { mode, ...missingMode } = base;
    assert.throws(() => new RuntimeHost(missingMode), TypeError);
  });
});

describe('RuntimeHost: production and host-only-real demo wiring', () => {
  test('production start launches the fixed local demo WITHOUT auto-answering it and spawns the worker', async () => {
    const ctx = setup({ mode: 'production' });
    const { host, adapters, spawnLog, stateRoot } = ctx;
    const started = await host.start();
    assert.equal(started.demoStarted, true, 'the default production start must enqueue the /bridge-demo prompt');
    const adapter = adapters.get('main');
    assert.ok(adapter.sent.some((c) => c.type === 'prompt' && String(c.message).startsWith('/bridge-demo ')),
      'the demo command must go to the (real) adapter');
    // The demo select arrives: in production the host must NOT answer it.
    adapter.emitUi({ id: 'ui-prod-1', method: 'select', title: 'Demo', options: ['Option A', 'Option B'] });
    await drain();
    host.tick(T0 + 500);
    await drain();
    assert.equal((adapter.uiResponses ?? []).length, 0, 'production never auto-answers a pending demo dialog');
    assert.equal(spawnLog.length, 1, 'the worker is still spawned in production');
    const meta = JSON.parse(readFileSync(join(stateRoot, 'host-meta.json'), 'utf8'));
    assert.equal(meta.mode, 'production');
    assert.equal(meta.lastDemoResult, null, 'a pending demo must not be recorded as completed');
    await host.shutdown('test');
  });

  test('host-only-real start launches the demo, never the worker, and never answers', async () => {
    const ctx = setup({ mode: 'host_only_real', workerSpawner: async () => { throw new Error('worker must not be spawned'); } });
    const { host, adapters, stateRoot } = ctx;
    const started = await host.start();
    assert.equal(started.demoStarted, true);
    assert.equal(started.workerPid, null);
    const adapter = adapters.get('main');
    assert.ok(adapter.sent.some((c) => c.type === 'prompt' && String(c.message).startsWith('/bridge-demo ')));
    adapter.emitUi({ id: 'ui-hor-1', method: 'select', title: 'Demo', options: ['Option A', 'Option B'] });
    await drain();
    host.tick(T0 + 500);
    await drain();
    assert.equal((adapter.uiResponses ?? []).length, 0, 'host-only-real waits pending; no auto-answer');
    const meta = JSON.parse(readFileSync(join(stateRoot, 'host-meta.json'), 'utf8'));
    assert.equal(meta.mode, 'host_only_real');
    assert.equal(meta.workerDesired, false);
    await host.shutdown('test');
  });
});

// helpers
function writeControl(stateRoot, instanceId, command) {
  writeFileSync(join(stateRoot, 'control.json'), JSON.stringify({ instanceId, command, issuedAt: Date.now() }));
}

function stateRootjoin(ctx) {
  return ctx.stateRoot;
}

// T05: regression — runHostMain must build the adapter from the REAL
// pi-adapter.mjs export. The production/host-only-real path used to import a
// stale name (`PiAdapter`), so `new PiAdapter(...)` threw inside host.start()
// and startup died with ERR:host_start_failed before any child was created.
describe('real-Pi adapter factory (production/host_only_real)', () => {
  test('builds the actual PiRpcAdapter from the restrictive production launch, without starting Pi', async () => {
    const { createRealPiAdapterFactory } = await import('../src/runtime-host.mjs');
    const factory = await createRealPiAdapterFactory({
      config: { pi: { cliPath: '/fake/pi-cli.mjs', workspace: join(TEST_RUNS, 't05-ws') } },
      stateDir: mkdtempSync(join(TEST_RUNS, 't05-factory-')),
    });
    const adapter = factory({ sessionId: 't05-session' });
    const { PiRpcAdapter } = await import('../src/pi-adapter.mjs');
    assert.ok(adapter instanceof PiRpcAdapter, 'factory must build the real PiRpcAdapter export, not a stale/mocked name');
  });
});
