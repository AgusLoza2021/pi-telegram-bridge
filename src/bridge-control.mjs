// T04: bridge-control — read-only status aggregation and the local
// control writer used by the PowerShell scripts.
//
// The status surface is credential-free and identity-free: it reports
// liveness, heartbeat age, request states and counters, never Telegram
// ids, tokens or chat identities. The control writer is the only way the
// PS scripts talk to a running host: a typed command file bound to the
// instance id.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Store } from './store.mjs';

export class ControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControlError';
    this.code = code;
  }
}

const INSTANCE_RE = /^[0-9a-f]{32}$/;
export const CONTROL_COMMANDS = ['stop-worker', 'start-worker', 'stop-host'];
export const DEFAULT_HEARTBEAT_MAX_AGE_MS = 30_000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

/**
 * Aggregate a credential-free runtime status document.
 *
 * @param {object} options
 * @param {import('./store.mjs').Store|null} options.store open store (may
 *   be null when the database has not been created yet)
 * @param {string} options.metaPath path to host-meta.json
 * @param {null|string} [options.expectedInstanceId] instance id from the
 *   ops config; mismatch is surfaced (same-owner spoof detection)
 * @param {(pid: number) => boolean} [options.isProcessAlive]
 * @param {() => number} [options.now]
 * @param {number} [options.heartbeatMaxAgeMs]
 * @param {null|string} [options.credentialsBlobPath] DPAPI blob path;
 *   presence only, never contents
 * @param {null|string} [options.logArchiveDir] archive dir measured for
 *   the size budget warning
 */
export function readRuntimeStatus({
  store,
  metaPath,
  expectedInstanceId = null,
  isProcessAlive = defaultProcessAlive,
  now = Date.now,
  heartbeatMaxAgeMs = DEFAULT_HEARTBEAT_MAX_AGE_MS,
  credentialsBlobPath = null,
  logArchiveDir = null,
} = {}) {
  const status = {
    ok: true,
    state: 'not_initialized',
    hostLive: false,
    workerLive: false,
    piLive: false,
    heartbeatFresh: false,
    heartbeatAgeMs: null,
    instanceIdMatch: false,
    hostGeneration: null,
    sessionId: null,
    piSessionFile: null,
    piSessionFileExists: null,
    mode: null,
    workerDesired: null,
    credentialsPresent: credentialsBlobPath ? existsSync(credentialsBlobPath) : null,
    pendingRequests: 0,
    logArchiveBytes: 0,
    logArchiveOverBudget: false,
    shutdown: false,
  };
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    return status; // no meta yet: a clean not_initialized shape
  }
  if (!isPlainObject(meta)) return status;

  const nowMs = now();
  status.instanceId = undefined; // identity is internal; not part of the surface
  status.hostGeneration = typeof meta.hostGeneration === 'number' ? meta.hostGeneration : null;
  status.sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : null;
  status.piSessionFile = typeof meta.piSessionFile === 'string' ? meta.piSessionFile : null;
  status.piSessionFileExists = status.piSessionFile ? existsSync(status.piSessionFile) : null;
  status.mode = typeof meta.mode === 'string' ? meta.mode : null;
  status.workerDesired = meta.workerDesired === true;
  status.shutdown = meta.shutdownAt != null;
  status.instanceIdMatch = expectedInstanceId == null ? true : meta.instanceId === expectedInstanceId;

  const heartbeatAt = typeof meta.heartbeatAt === 'number' ? meta.heartbeatAt : null;
  if (heartbeatAt != null) {
    status.heartbeatAgeMs = Math.max(0, nowMs - heartbeatAt);
    status.heartbeatFresh = status.heartbeatAgeMs <= heartbeatMaxAgeMs;
  }
  status.hostLive = heartbeatAt != null
    && status.heartbeatFresh
    && !status.shutdown
    && status.instanceIdMatch
    && (Number.isSafeInteger(meta.pid) ? isProcessAlive(meta.pid) : false);
  status.workerLive = Number.isSafeInteger(meta.workerPid)
    && meta.workerPid > 0
    && isProcessAlive(meta.workerPid)
    && status.heartbeatFresh;
  status.piLive = Number.isSafeInteger(meta.piPid)
    && meta.piPid > 0
    && isProcessAlive(meta.piPid);

  if (logArchiveDir && existsSync(logArchiveDir)) {
    let total = 0;
    for (const entry of readdirSync(logArchiveDir)) {
      try {
        total += statSync(join(logArchiveDir, entry)).size;
      } catch {
        /* transient file churn */
      }
    }
    status.logArchiveBytes = total;
    status.logArchiveOverBudget = total > 20 * 1024 * 1024;
  }

  if (store) {
    try {
      status.pendingRequests = store.listRecoverableRequests().length;
    } catch {
      status.pendingRequests = 0;
    }
  }

  status.state = status.hostLive ? aggregateActiveState(store) : aggregateStoppedState(status, store);
  return status;
}

function aggregateActiveState(store) {
  if (!store) return 'running';
  try {
    for (const request of store.listRecoverableRequests()) {
      if (request.state === 'waiting_decision') return 'waiting_decision';
      if (request.state === 'resuming') return 'resuming';
    }
  } catch {
    return 'running';
  }
  return 'running';
}

function aggregateStoppedState(status, store) {
  if (status.mode == null) return 'not_initialized';
  if (store && status.pendingRequests > 0) return 'stopped_with_pending';
  return 'stopped';
}

/**
 * Write a typed control command bound to the instance id.
 * Codes: 'bad_command', 'bad_instance', 'no_state'.
 */
export function writeControlCommand({ stateRoot, instanceId, command, now = Date.now }) {
  if (!CONTROL_COMMANDS.includes(command)) {
    throw new ControlError('bad_command', 'unknown control command');
  }
  if (typeof instanceId !== 'string' || !INSTANCE_RE.test(instanceId)) {
    throw new ControlError('bad_instance', 'instance id must be 32 hex chars');
  }
  if (typeof stateRoot !== 'string' || !existsSync(stateRoot)) {
    throw new ControlError('no_state', 'state root does not exist');
  }
  const payload = { instanceId, command, issuedAt: now() };
  const target = join(stateRoot, 'control.json');
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, target);
  return { ok: true, path: target };
}

// ---------------------------------------------------------------------------
// CLI entrypoints used by the PowerShell scripts (status.ps1 / stop.ps1):
//   node src/bridge-control.mjs status --state-dir <dir> [--json]
//   node src/bridge-control.mjs control --command <stop-host|stop-worker|start-worker>
//                                    --state-dir <dir> --instance <32hex>

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * CLI surface. Exit codes: 0 ok, 3 usage/state error.
 * Output is always credential-free and identity-free.
 */
export async function main(argv = process.argv.slice(2), io = process) {
  const [command] = argv;
  const stateDir = flag(argv, 'state-dir');
  if ((command !== 'status' && command !== 'control') || !stateDir) {
    io.stderr.write('ERR:bad_usage\n');
    return 3;
  }
  const metaPath = join(stateDir, 'host-meta.json');
  const blobPath = join(stateDir, 'credentials.bin');
  const configPath = join(stateDir, 'runtime.json');
  let expectedInstanceId = null;
  try {
    expectedInstanceId = loadRuntimeConfig(configPath).instanceId;
  } catch {
    /* status is still meaningful without the ops config */
  }

  if (command === 'control') {
    const controlCommand = flag(argv, 'command');
    const instanceId = flag(argv, 'instance') ?? expectedInstanceId;
    try {
      writeControlCommand({ stateRoot: stateDir, instanceId, command: controlCommand });
    } catch (error) {
      const code = error && error.code ? error.code : 'control_failed';
      io.stderr.write(`ERR:${code}\n`);
      return 3;
    }
    io.stdout.write(`OK control:${controlCommand}\n`);
    return 0;
  }

  // status
  let store = null;
  const dbPath = join(stateDir, 'bridge.sqlite');
  if (existsSync(dbPath)) {
    try {
      store = new Store(dbPath, { isProcessAlive: defaultProcessAlive });
    } catch {
      store = null;
    }
  }
  const status = readRuntimeStatus({
    store,
    metaPath,
    expectedInstanceId,
    credentialsBlobPath: blobPath,
    logArchiveDir: join(stateDir, 'log-archive'),
  });
  try {
    store?.close?.();
  } catch {
    /* close races are harmless on the status path */
  }
  if (argv.includes('--json')) {
    io.stdout.write(`${JSON.stringify(status)}\n`);
    return 0;
  }
  io.stdout.write(`state: ${status.state}\n`);
  io.stdout.write(`host: ${status.hostLive ? 'running' : 'stopped'}\n`);
  io.stdout.write(`worker: ${status.workerLive ? 'running' : 'stopped'} (desired: ${status.workerDesired})\n`);
  io.stdout.write(`pi: ${status.piLive ? 'running' : 'stopped'}\n`);
  if (status.heartbeatAgeMs != null) {
    io.stdout.write(`heartbeat age: ${status.heartbeatAgeMs}ms\n`);
  }
  io.stdout.write(`credentials: ${status.credentialsPresent ? 'present' : 'missing'}\n`);
  io.stdout.write(`pending requests: ${status.pendingRequests}\n`);
  if (status.logArchiveOverBudget) {
    io.stdout.write('warning: log archive over size budget\n');
  }
  if (status.instanceIdMatch === false) {
    io.stdout.write('warning: instance id mismatch (config/meta)\n');
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  main().then((code) => { process.exitCode = code; });
}
