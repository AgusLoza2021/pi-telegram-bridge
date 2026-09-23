// T04: RuntimeHost — the detached Windows process that owns the Pi pipes.
//
// Responsibilities (and non-responsibilities):
//  - owns the SessionHost (Pi session lifecycle, host lease, dialogs);
//  - supervises the Telegram worker as a child WITHOUT ever bumping the
//    host generation (worker death/restart must not disturb Pi);
//  - consumes a LOCAL typed control channel (state-root control.json);
//    the Telegram action queue is never a lifecycle channel, so the
//    worker cannot shut the host down;
//  - writes host-meta.json (identity, heartbeat, mode, worker desired,
//    demo result, shutdown marker) for the status surface;
//  - hosts demo mode: the host itself auto-answers the demo dialog so no
//    Telegram round trip is needed to validate the pipe.
//
// Bounded failure policy: repeated tick failures trigger a graceful
// shutdown instead of a hot crash loop.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRuntimeConfig } from './runtime-config.mjs';
import { SessionHost } from './session-host.mjs';

export class RuntimeHostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeHostError';
    this.code = code;
  }
}

const INSTANCE_RE = /^[0-9a-f]{32}$/;
const CONTROL_COMMANDS = new Set(['stop-worker', 'start-worker', 'stop-host']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteMs(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function defaultProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Bounded JSONL logger with size-cap rotation into a local archive dir. */
export function createBoundedLogger({
  logFile,
  archiveDir,
  maxSizeBytes = 512 * 1024,
  now = Date.now,
} = {}) {
  if (typeof logFile !== 'string' || logFile.length === 0) throw new TypeError('logFile required');
  mkdirSync(archiveDir, { recursive: true });
  return function log(event) {
    if (!isPlainObject(event) || typeof event.code !== 'string' || event.code.length === 0) return;
    let row;
    try {
      row = JSON.stringify({ ts: new Date(now()).toISOString(), ...event });
    } catch {
      return; // events that do not serialize are dropped, never crash ticks
    }
    try {
      if (statSync(logFile).size > maxSizeBytes) {
        renameSync(logFile, join(archiveDir, `${new Date(now()).toISOString().replace(/[:.]/g, '-')}.log`));
      }
    } catch {
      /* missing file or busy archive dir: appending is still safe */
    }
    try {
      appendFileSync(logFile, `${row}\n`);
    } catch {
      /* logging must never take the host down */
    }
  };
}

export class RuntimeHost {
  /**
   * @param {object} options
   * @param {import('./store.mjs').Store} options.store
   * @param {import('./session-host.mjs').SessionHost} options.sessionHost
   * @param {string} options.instanceId 32 hex chars from the ops config
   * @param {string} options.stateRoot validated state root (must exist)
   * @param {string} [options.ownerId] host lease owner (must match the
   *   SessionHost owner so the lease can be renewed here)
   * @param {string} [options.sessionId] Pi session name ('main')
   * @param {boolean} [options.demoMode] host-only demo (no worker)
   * @param {null | ((opts: {followupsEnabled: boolean}) => any)} options.workerSpawner
   * @param {() => number} [options.now]
   * @param {(pid: number) => boolean} [options.isProcessAlive]
   * @param {number} [options.tickIntervalMs] 0 disables the automatic loop
   * @param {number} [options.workerRestartDelayMs]
   * @param {number} [options.maxConsecutiveTickFailures]
   * @param {(event: {code: string}) => void} [options.logger]
   * @param {boolean} [options.followupsEnabled] forwarded to worker spawn
   */
  constructor({
    store,
    sessionHost,
    instanceId,
    stateRoot,
    ownerId = 'runtime-host',
    sessionId = 'main',
    mode = null,
    demoMode = null, // deprecated alias for mode (host_demo when true)
    workerSpawner = null,
    now = Date.now,
    isProcessAlive = defaultProcessAlive,
    tickIntervalMs = 1000,
    workerRestartDelayMs = 5000,
    maxConsecutiveTickFailures = 5,
    logger = () => {},
    followupsEnabled,
  } = {}) {
    if (!store || typeof store.getHostGeneration !== 'function') throw new TypeError('store required');
    if (!sessionHost || typeof sessionHost.startSession !== 'function') throw new TypeError('sessionHost required');
    if (typeof instanceId !== 'string' || !INSTANCE_RE.test(instanceId)) throw new TypeError('instanceId must be 32 hex chars');
    if (typeof stateRoot !== 'string' || stateRoot.length === 0) throw new TypeError('stateRoot required');
    // T04r: the followup opt-in is an exact boolean on BOTH sides
    // (host and worker); it is never defaulted silently.
    if (typeof followupsEnabled !== 'boolean') {
      throw new TypeError('followupsEnabled must be an exact boolean');
    }
    const HOST_MODES = ['production', 'host_only_real', 'host_demo'];
    if (mode === null && typeof demoMode === 'boolean') mode = demoMode ? 'host_demo' : 'production';
    if (!HOST_MODES.includes(mode)) {
      throw new TypeError(`mode must be one of ${HOST_MODES.join(', ')}`);
    }
    if (mode === 'production' && typeof workerSpawner !== 'function') {
      throw new TypeError('workerSpawner required in production mode');
    }
    this.#store = store;
    this.#sessionHost = sessionHost;
    this.#instanceId = instanceId;
    this.#stateRoot = stateRoot;
    this.#ownerId = ownerId;
    this.#sessionId = sessionId;
    this.#mode = mode;
    this.#workerSpawner = workerSpawner;
    this.#now = now;
    this.#isProcessAlive = isProcessAlive;
    this.#tickIntervalMs = tickIntervalMs;
    this.#workerRestartDelayMs = workerRestartDelayMs;
    this.#maxConsecutiveTickFailures = maxConsecutiveTickFailures;
    this.#log = logger;
    this.#followupsEnabled = followupsEnabled;
    this.#metaPath = join(stateRoot, 'host-meta.json');
    this.#controlPath = join(stateRoot, 'control.json');
    this.#logDir = join(stateRoot, 'logs');
    this.#archiveDir = join(stateRoot, 'log-archive');
  }

  #store;
  #sessionHost;
  #instanceId;
  #stateRoot;
  #ownerId;
  #sessionId;
  #mode;
  #workerSpawner;
  #now;
  #isProcessAlive;
  #tickIntervalMs;
  #workerRestartDelayMs;
  #maxConsecutiveTickFailures;
  #followupsEnabled;
  #log;
  #metaPath;
  #controlPath;
  #logDir;
  #archiveDir;

  #started = false;
  #shutdown = false;
  #shutdownPromise = null;
  #stopRequested = false;
  #tickFailures = 0;
  #tickTimer = null;
  #worker = null;
  #workerDesired = false;
  #lastWorkerStart = 0;
  #startedAt = 0;
  #startResult = null;
  #demoNonce = null;
  #demoAwaiting = false;

  /** Start Pi (or the demo), acquire ownership, write meta, spawn worker. */
  async start() {
    if (this.#started) throw new RuntimeHostError('already_started', 'RuntimeHost.start called twice');
    if (this.#shutdown) throw new RuntimeHostError('already_stopped', 'RuntimeHost already shut down');
    this.#started = true;
    mkdirSync(this.#logDir, { recursive: true });

    this.#workerDesired = this.#mode === 'production';
    this.#startResult = await this.#sessionHost.startSession(this.#sessionId);
    this.#startedAt = this.#now();
    this.#renewLeaseSafe();
    this.#writeMeta(this.#startedAt);
    this.#log({ code: 'host_started', mode: this.#mode });

    // T04r: EVERY mode launches the fixed local /bridge-demo lifecycle.
    // Only host_demo (the explicitly named test mode) auto-answers; the
    // production and host-only-real hosts leave the demo pending so the
    // worker phone (or the owner's local tooling) answers it.
    this.#installDemoTracking();
    const demo = this.#sessionHost.startDemo(this.#sessionId);
    const demoStarted = demo && typeof demo === 'object' && demo.ok !== false;
    if (demoStarted) {
      this.#demoNonce = this.#sessionHost.getDemoNonce(this.#sessionId);
      this.#demoAwaiting = true;
      this.#writeMeta(this.#now());
    } else {
      this.#log({ code: 'demo_start_refused', reason: demo && demo.reason ? demo.reason : 'unknown' });
    }

    if (this.#mode === 'production') {
      await this.#ensureWorker(this.#startedAt);
    }

    if (this.#tickIntervalMs > 0) this.#startTicking();
    return {
      sessionId: this.#sessionId,
      hostGeneration: this.#store.getHostGeneration(),
      mode: this.#mode,
      workerPid: this.#worker ? this.#worker.pid : null,
      demoStarted: Boolean(this.#demoNonce),
    };
  }

  #installDemoTracking() {
    // Outbox messages of kind 'approval_request' are dialogs waiting for a
    // decision. In the explicitly named host_demo TEST mode the host
    // itself answers with the first option so the demo lifecycle can
    // complete without Telegram. In production and host-only-real the
    // dialog stays pending: only a human decides.
    this.#sessionHost.onOutbox((msg) => {
      if (this.#mode !== 'host_demo' || this.#shutdown) return;
      const row = msg && typeof msg === 'object' ? msg : null;
      if (!row || row.kind !== 'approval_request') return;
      // Emitted messages carry requestId/options at top level; store rows
      // wrap them in payload. Accept both so the handler is shape-proof.
      const payload = isPlainObject(row.payload) ? row.payload : row;
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
      const options = Array.isArray(payload.options) ? payload.options : [];
      if (typeof requestId !== 'string' || options.length === 0) return;
      queueMicrotask(() => {
        try {
          this.#sessionHost.submitDecision({ requestId, decision: { value: options[0] } });
          this.#log({ code: 'demo_auto_answer', requestId });
        } catch {
          this.#log({ code: 'demo_auto_answer_refused', requestId });
        }
      });
    });
    // Track the demo lifecycle so the status surface can show the result.
    this.#sessionHost.onHostEvent((event) => {
      if (!this.#demoAwaiting || !isPlainObject(event)) return;
      if (event.kind === 'request_completed') this.#recordDemoResult('completed');
      else if (event.kind === 'request_failed') this.#recordDemoResult('failed');
      else if (event.kind === 'request_expired') this.#recordDemoResult('expired');
    });
  }

  #recordDemoResult(result) {
    this.#demoAwaiting = false;
    this.#demoResult = result;
    this.#demoAt = this.#now();
    this.#log({ code: 'demo_result', result });
    this.#writeMeta(this.#demoAt);
  }

  #demoResult = null;
  #demoAt = 0;

  /** Nonce of the in-flight host-only demo (null when absent). */
  getDemoNonce() {
    return this.#demoNonce;
  }

  /** One host tick: control channel, lease, session, worker, meta. */
  tick(now = this.#now()) {
    if (!this.#started || this.#shutdown) return;
    try {
      this.#processControl(now);
      if (this.#shutdown) return;
      this.#renewLeaseSafe();
      this.#sessionHost.tick(now);
      this.#superviseWorker(now);
      this.#writeMeta(now);
      this.#tickFailures = 0;
    } catch {
      this.#tickFailures += 1;
      this.#log({ code: 'tick_error', count: this.#tickFailures });
      if (this.#tickFailures > this.#maxConsecutiveTickFailures) {
        this.#runShutdown('tick_failures');
      }
    }
    if (this.#stopRequested && !this.#shutdownPromise) {
      this.#runShutdown('control');
    }
  }

  #processControl(now) {
    let raw;
    try {
      raw = readFileSync(this.#controlPath, 'utf8');
    } catch {
      return;
    }
    if (raw.trim().length === 0) return;
    let parsed;
    let parseFailed = false;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parseFailed = true;
    }
    // A consumed command rests as a bare { consumedAt } marker. It is
    // terminal: re-consuming it would rewrite the file and log a rejection
    // on every host tick for the life of the process.
    if (!parseFailed && isPlainObject(parsed)
        && parsed.command === undefined && typeof parsed.consumedAt === 'number') return;
    // Consume before applying a fresh command, so it applies at most once
    // even if the host crashes mid-processing. Keep the file, rather than
    // deleting it, for operators.
    try {
      writeFileSync(this.#controlPath, JSON.stringify({ consumedAt: now }));
    } catch {
      this.#log({ code: 'control_reset_error' });
    }
    if (parseFailed) {
      this.#log({ code: 'control_invalid' });
      return;
    }
    if (!isPlainObject(parsed) || parsed.instanceId !== this.#instanceId) {
      // Foreign or malformed control payloads are consumed but ignored.
      this.#log({ code: 'control_rejected' });
      return;
    }
    if (!CONTROL_COMMANDS.has(parsed.command)) {
      this.#log({ code: 'control_unknown' });
      return;
    }
    if (parsed.command === 'stop-worker') {
      this.#workerDesired = false;
      this.#stopWorkerSafe();
    } else if (parsed.command === 'start-worker') {
      this.#workerDesired = true;
      void this.#ensureWorker(now);
    } else if (parsed.command === 'stop-host') {
      this.#stopRequested = true;
    }
    this.#log({ code: 'control_applied', command: parsed.command });
  }

  #renewLeaseSafe() {
    try {
      const result = this.#store.renewHostLease({ ownerId: this.#ownerId });
      if (result && result.ok === false) {
        // Another host took over: this instance must step down.
        this.#log({ code: 'lease_lost' });
        this.#runShutdown('lease_lost');
      }
    } catch {
      /* lease renew races are tolerated; next tick retries */
    }
  }

  #ensureWorker(now) {
    if (!this.#workerDesired || this.#worker || this.#shutdown) {
      return this.#worker ? Promise.resolve(this.#worker) : Promise.resolve(null);
    }
    if (this.#workerPid && this.#isProcessAlive(this.#workerPid)) {
      // A worker from a previous host incarnation is still alive: adopt
      // it instead of spawning a duplicate (Pi ownership is unchanged).
      this.#log({ code: 'worker_adopted', pid: this.#workerPid });
      return Promise.resolve(null);
    }
    if (this.#lastWorkerStart !== 0 && now - this.#lastWorkerStart < this.#workerRestartDelayMs) {
      return Promise.resolve(null); // bounded restart cadence
    }
    this.#lastWorkerStart = now;
    return Promise.resolve()
      .then(() => this.#workerSpawner({ followupsEnabled: this.#followupsEnabled }))
      .then((worker) => {
        if (this.#shutdown || !worker) return null;
        this.#worker = worker;
        this.#workerPid = worker.pid;
        if (typeof worker.exited === 'function') {
          Promise.resolve(worker.exited()).then(() => {
            if (this.#worker === worker) this.#worker = null;
            this.#log({ code: 'worker_exit' });
          }, () => {});
        }
        this.#log({ code: 'worker_started', pid: worker.pid });
        this.#writeMeta(this.#now());
        return worker;
      })
      .catch(() => {
        this.#log({ code: 'worker_spawn_failed' });
        return null;
      });
  }

  #workerPid = null;

  #superviseWorker(now) {
    if (this.#workerDesired) {
      void this.#ensureWorker(now);
    } else if (this.#worker) {
      this.#stopWorkerSafe();
    }
  }

  #stopWorkerSafe() {
    const worker = this.#worker;
    this.#worker = null;
    // T04r: forget the stale pid immediately so host-meta.json (and the
    // stop.ps1 -WorkerOnly wait) sees workerPid: null after the stop.
    this.#workerPid = null;
    if (!worker) return;
    Promise.resolve()
      .then(() => worker.stop())
      .then(() => this.#log({ code: 'worker_stopped' }), () => this.#log({ code: 'worker_stop_error' }));
  }

  #writeMeta(now) {
    const meta = {
      instanceId: this.#instanceId,
      pid: process.pid,
      hostGeneration: this.#store.getHostGeneration(),
      sessionId: this.#sessionId,
      // The REAL Pi session identity (from the adapter start result), not
      // the logical session name: the sessions table binds requests to
      // this id, so the status surface must report the same value.
      piSessionId: this.#startResult?.piSessionId ?? null,
      piSessionFile: this.#startResult?.sessionFile ?? null,
      piPid: this.#startResult?.pid ?? null,
      startedAt: this.#startedAt,
      heartbeatAt: now,
      mode: this.#mode,
      workerDesired: this.#workerDesired,
      workerPid: this.#worker ? this.#worker.pid : this.#workerPid,
      lastDemoResult: this.#demoResult,
      demoAt: this.#demoAt || null,
      shutdownAt: this.#shutdownAt ?? null,
    };
    try {
      writeJsonAtomic(this.#metaPath, meta);
    } catch {
      this.#log({ code: 'meta_write_error' });
    }
  }

  #shutdownAt = null;

  #startTicking() {
    this.#tickTimer = setInterval(() => {
      if (this.#shutdown) {
        clearInterval(this.#tickTimer);
        this.#tickTimer = null;
        return;
      }
      this.tick();
    }, this.#tickIntervalMs);
  }

  isShutdown() {
    return this.#shutdown || this.#shutdownPromise !== null;
  }

  /** Resolves when the graceful shutdown has fully completed. */
  waitUntilStopped() {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    if (this.#shutdown) return Promise.resolve();
    return Promise.reject(new RuntimeHostError('not_stopping', 'no shutdown in progress'));
  }

  /** Graceful shutdown: stop worker, cancel real dialogs, dispose Pi, meta. */
  shutdown(reason = 'manual') {
    return this.#runShutdown(reason);
  }

  #runShutdown(reason) {
    if (!this.#shutdownPromise) {
      this.#shutdownPromise = this.#shutdownInternal(reason).catch(() => {
        this.#log({ code: 'host_shutdown_error' });
      });
    }
    return this.#shutdownPromise;
  }

  async #shutdownInternal(reason) {
    this.#shutdown = true;
    this.#log({ code: 'host_shutdown_begin', reason });
    if (this.#tickTimer) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
    // 1. The worker goes down first: no new Telegram traffic after the
    //    decision to stop has been made.
    this.#workerDesired = false;
    this.#stopWorkerSafe();
    // 2. Cancel outstanding requests: real dialogs are explicitly
    //    cancelled with the user (no silent abandonment), aborts fire.
    try {
      for (const request of this.#store.listRecoverableRequests()) {
        try {
          this.#sessionHost.cancelRequest({ requestId: request.requestId });
        } catch {
          /* keep cancelling the rest */
        }
      }
    } catch {
      this.#log({ code: 'shutdown_cancel_error' });
    }
    // 3. Dispose Pi adapters and release the host lease.
    try {
      await this.#sessionHost.dispose();
    } catch {
      this.#log({ code: 'session_host_dispose_error' });
    }
    // 4. Final meta heartbeat so status.ps1 shows a clean stop.
    this.#shutdownAt = this.#now();
    this.#writeMeta(this.#shutdownAt);
    this.#log({ code: 'host_shutdown_done', reason });
  }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// CLI entrypoint: node src/runtime-host.mjs --state-dir <dir> --config <path> [--demo]
// The host process is started detached by scripts/start.ps1. In --demo mode
// no worker, no credentials and no real pi process are needed (host-only
// smoke of the Windows process lifecycle).

/**
 * @param {string[]} argv
 * @param {object} [io] injectable process surface for tests
 * @returns {Promise<number>} exit code
 */
/**
 * Build the adapter factory shared by production and host-only-real modes.
 * Exported so the real-Pi wiring (the exact names imported from
 * pi-adapter.mjs) can be unit-tested without starting a Pi child.
 * Returns ({ sessionId }) => PiRpcAdapter built from buildProductionLaunch;
 * the restrictive launch contract lives in pi-adapter.mjs and is unchanged.
 */
export async function createRealPiAdapterFactory({ config, stateDir }) {
  const { PiRpcAdapter, buildProductionLaunch } = await import('./pi-adapter.mjs');
  const extensionPath = fileURLToPath(new URL('../extension/bridge-extension.ts', import.meta.url));
  const sessionDir = join(stateDir, 'sessions');
  return ({ sessionId }) => new PiRpcAdapter(buildProductionLaunch({
    sessionId,
    cliPath: config.pi.cliPath,
    workspaceRoot: config.pi.workspace,
    extensionPath,
    sessionDir,
  }));
}

export async function runHostMain(argv = process.argv.slice(2), io = process) {
  let stateDir = null;
  let configPath = null;
  let demoMode = false;
  let hostOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state-dir' && argv[i + 1]) stateDir = argv[i + 1];
    else if (argv[i] === '--config' && argv[i + 1]) configPath = argv[i + 1];
    else if (argv[i] === '--demo') demoMode = true;
    else if (argv[i] === '--host-only') hostOnly = true;
  }
  if (!stateDir || !configPath) {
    io.stderr?.write('ERR:bad_usage\n');
    return 1;
  }
  if (demoMode && hostOnly) {
    // Ambiguity refusal: --demo (fake adapter test) and --host-only
    // (real Pi, no worker) are mutually exclusive startup modes.
    io.stderr?.write('ERR:ambiguous_mode\n');
    return 1;
  }
  const mode = demoMode ? 'host_demo' : hostOnly ? 'host_only_real' : 'production';

  let config;
  try {
    config = loadRuntimeConfig(configPath);
  } catch {
    io.stderr?.write('ERR:bad_config\n');
    return 1;
  }

  const { Store } = await import('./store.mjs');
  const { createBoundedLogger } = await import('./runtime-host.mjs');
  const logDir = join(stateDir, 'logs');
  const logger = createBoundedLogger({
    logFile: join(logDir, 'host.log'),
    archiveDir: join(stateDir, 'log-archive'),
  });

  let store;
  try {
    store = new Store(join(stateDir, 'bridge.sqlite'));
  } catch {
    io.stderr?.write('ERR:store_failed\n');
    return 1;
  }
  let adapterFactory;
  if (mode === 'host_demo') {
    // Explicitly named TEST mode: the local fake adapter. Never the
    // default; production and host-only-real always launch real Pi.
    const { DemoAdapter } = await import('./demo-adapter.mjs');
    adapterFactory = () => new DemoAdapter();
  } else {
    adapterFactory = await createRealPiAdapterFactory({ config, stateDir });
  }

  let sessionHost;
  try {
    sessionHost = buildRuntimeSessionHost({
      store,
      followupsEnabled: config.bridge.followupsEnabled,
      adapterFactory,
    });
  } catch {
    io.stderr?.write('ERR:bad_config\n');
    return 1;
  }

  const host = new RuntimeHost({
    store,
    sessionHost,
    instanceId: config.instanceId,
    stateRoot: stateDir,
    ownerId: 'bridge-host',
    mode,
    workerSpawner: mode === 'production' ? (async ({ followupsEnabled }) => {
      // The worker child receives its credentials over stdin (anonymous
      // pipe written here, closed immediately); they are revealed from the
      // DPAPI blob strictly through the helper's redirected stdout.
      const { spawn } = await import('node:child_process');
      const { revealCredentialsForSpawn } = await import('./runtime-credentials.mjs');
      const moduleRoot = fileURLToPath(new URL('..', import.meta.url));
      const stateRootAbs = stateDir;
      const credentials = await revealCredentialsForSpawn({ moduleRoot, stateRoot: stateRootAbs });
      const child = spawn(process.execPath, [
        join(moduleRoot, 'src', 'runtime-worker.mjs'),
        '--state-dir', stateRootAbs,
        '--config', configPath,
      ], {
        cwd: moduleRoot,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.write(JSON.stringify(credentials));
      child.stdin.end(); // pipe closed; credentials never pass through argv/env
      const exited = new Promise((resolve) => {
        child.on('exit', (code) => resolve({ code }));
        child.on('error', () => resolve({ code: -1 }));
      });
      return { pid: child.pid, exited, stop: () => new Promise((resolve) => { if (child.exitCode != null || child.signalCode) resolve(); else child.on('exit', resolve); child.kill(); }) };
    }) : null,
    followupsEnabled: config.bridge.followupsEnabled,
    tickIntervalMs: 1000,
    logger,
  });

  const stop = () => { void host.shutdown('signal'); };
  io.on?.('SIGTERM', stop);
  io.on?.('SIGINT', stop);

  try {
    await host.start();
  } catch (error) {
    const code = error && error.code === 'LEASE_BUSY' ? 'lease_busy' : 'host_start_failed';
    io.stderr?.write(`ERR:${code}\n`);
    // T04r: partial startup must not leak resources (orphan Pi, open DB).
    try { await sessionHost.dispose(); } catch { /* best effort */ }
    try { store.close(); } catch { /* best effort */ }
    return 1;
  }

  if (mode === 'host_demo') {
    // Host-only demo: wait for the demo result, then stop cleanly.
    const metaPath = join(stateDir, 'host-meta.json');
    const deadline = Date.now() + 60_000;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      let meta = null;
      try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch { /* not written yet */ }
      if (meta && meta.lastDemoResult) {
        await host.shutdown('demo_done');
        return meta.lastDemoResult === 'completed' ? 0 : 3;
      }
      if (host.isShutdown()) return 3;
      if (Date.now() > deadline) {
        await host.shutdown('demo_timeout');
        return 3;
      }
    }
  }

  await host.waitUntilStopped().catch(() => {});
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runHostMain().then((code) => { process.exitCode = code; });
}

/**
 * T04r: the ONE place where the runtime host wires the SessionHost.
 * The followup opt-in is passed identically here and to the worker
 * spawn (both sides validate the exact boolean), so the actual gate in
 * SessionHost can never silently stay false while the worker believes
 * it is enabled.
 */
export function buildRuntimeSessionHost({ store, followupsEnabled, adapterFactory, ownerId = 'bridge-host' } = {}) {
  if (typeof followupsEnabled !== 'boolean') {
    throw new TypeError('followupsEnabled must be an exact boolean');
  }
  return new SessionHost({ store, ownerId, adapterFactory, followupsEnabled });
}
