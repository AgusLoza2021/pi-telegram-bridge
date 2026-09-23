// T03: broker-only runtime entrypoint for the selective TUI transport.
// T06: loads the broker-specific ops config (loadBrokerRuntimeConfig),
// which requires only the validated instanceId and the state/config
// identity - NO pi CLI/workspace discovery (the broker never spawns or
// owns Pi). Legacy headless-shaped configs stay readable/migratable.
//
// `node src/runtime-broker.mjs --state-dir <dir>`
//
// Responsibilities (and non-responsibilities):
// - parses a REQUIRED state directory (validated through the confined
//   state-path helpers), loads the nonsecret ops config (runtime.json)
//   through the broker-specific loader (validated instanceId + config
//   identity only; a legacy headless-shaped config is accepted without
//   requiring its pi section to be consumable) and reveals the Telegram
//   credentials ONLY through the
//   existing DPAPI helper chain — the plaintext never touches argv, env,
//   logs or files;
// - creates the Store, the TelegramApi and the SelectiveTelegramBroker and
//   polls until SIGINT/SIGTERM or a state-root broker-control.json stop
//   request bound to the exact ops-config instanceId;
// - writes a credential-free broker-meta.json heartbeat (pid, start,
//   shutdown timestamps) atomically for the status surface;
// - NEVER spawns or owns Pi: only connected extensions own that side.
//
// Logging is bounded, code-only, under the state logs directory: no
// credentials, no tokens, no URLs and no absolute path dumps.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Store } from './store.mjs';
import { TelegramApi } from './telegram-api.mjs';
import { SelectiveTelegramBroker } from './selective-telegram-broker.mjs';
import { loadBrokerRuntimeConfig } from './runtime-config.mjs';
import { revealCredentialsForSpawn } from './runtime-credentials.mjs';
import { ensureStateRoot, resolveStatePath } from './state-paths.mjs';

export class BrokerBootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrokerBootstrapError';
    this.code = code;
  }
}

const CONTROL_COMMANDS = new Set(['stop-broker']);
const CONTROL_POLL_MS = 1000;
const META_HEARTBEAT_MS = 10_000;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_RATE = { max: 10, windowMs: 60_000 };

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Atomic JSON write (tmp + rename) so a crash never leaves partial meta. */
function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

/**
 * Default pid liveness probe: signal 0 tests existence without killing.
 * Throws (e.g. ESRCH) when the pid is gone; the caller treats any throw
 * as "not alive".
 */
function defaultIsPidAlive(pid) {
  process.kill(pid, 0);
  return true;
}

/**
 * Startup visibility for an unclean previous death. Reads the previous
 * broker-meta.json (before the first meta write clobbers it) and decides
 * whether the previous run ended without recording a shutdown.
 *
 * Returns the diagnostic payload, or null:
 * - no previous meta (first ever start) -> null;
 * - previous meta with a non-null shutdownAt (clean stop) -> null;
 * - shutdownAt === null and the previous pid is still alive -> null
 *   (a second instance racing the capability lock, not a death);
 * - shutdownAt === null and the pid is dead, missing or unverifiable ->
 *   { code, previousPid, previousStartedAt, startedAt }.
 *
 * Never throws: a missing, corrupt or unreadable previous meta is
 * swallowed and startup continues exactly as it does today.
 */
export function readUncleanPreviousRun(metaPath, startedAt, isPidAlive = defaultIsPidAlive) {
  try {
    const previous = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (!isPlainObject(previous) || previous.shutdownAt !== null) return null;
    const previousPid = previous.pid;
    let previousAlive = false;
    try {
      previousAlive = Number.isInteger(previousPid) && previousPid > 0 && isPidAlive(previousPid) === true;
    } catch {
      previousAlive = false; // dead or unverifiable pid is the real case
    }
    if (previousAlive) return null;
    return {
      code: 'broker_unclean_restart',
      previousPid,
      previousStartedAt: previous.startedAt,
      startedAt,
    };
  } catch {
    return null; // first ever start, or unreadable/corrupt meta: stay silent
  }
}

/**
 * Bounded code-only JSONL logger with size-cap rotation into a local
 * archive dir. Events carry fixed codes and counts only; callers must
 * never place credentials, tokens, URLs or raw payloads into events.
 */
export function createBrokerLogger({
  logFile,
  archiveDir,
  maxSizeBytes = MAX_LOG_BYTES,
  now = Date.now,
} = {}) {
  if (typeof logFile !== 'string' || logFile.length === 0) {
    throw new TypeError('logFile required');
  }
  mkdirSync(dirname(logFile), { recursive: true });
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
      /* logging must never take the broker down */
    }
  };
}

/**
 * Pure broker-control verdict: returns 'stop', 'foreign', 'invalid',
 * 'unknown' or 'empty'. The stop command is honored only when the
 * instanceId matches the ops config exactly; foreign or malformed
 * payloads are consumed and ignored (fail closed).
 */
export function parseBrokerControl(raw, instanceId) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'empty';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'invalid';
  }
  if (!isPlainObject(parsed) || parsed.instanceId !== instanceId) return 'foreign';
  if (!CONTROL_COMMANDS.has(parsed.command)) return 'unknown';
  return parsed.command === 'stop-broker' ? 'stop' : 'unknown';
}

/**
 * Process entrypoint. Returns the process exit code.
 *
 * @param {string[]} argv
 * @param {object} [io] injectable process surface for tests
 */
export async function runBrokerMain(argv = process.argv.slice(2), io = process) {
  let stateDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state-dir' && argv[i + 1]) stateDir = argv[i + 1];
  }
  if (!stateDir) {
    io.stderr?.write('ERR:bad_usage\n');
    return 1;
  }

  let stateRoot;
  try {
    stateRoot = ensureStateRoot(stateDir);
  } catch {
    io.stderr?.write('ERR:bad_state_dir\n');
    return 1;
  }

  let config;
  try {
    config = loadBrokerRuntimeConfig(join(stateRoot, 'runtime.json'));
  } catch {
    io.stderr?.write('ERR:bad_config\n');
    return 1;
  }

  // Credentials are revealed exactly once per start, strictly through the
  // existing DPAPI helper chain (plaintext only ever crosses anonymous
  // pipes), and live only inside the TelegramApi instance.
  const moduleRoot = fileURLToPath(new URL('..', import.meta.url));
  let credentials;
  try {
    credentials = await revealCredentialsForSpawn({ moduleRoot, stateRoot });
  } catch {
    io.stderr?.write('ERR:credentials_unavailable\n');
    return 1;
  }

  let store;
  try {
    store = new Store(join(stateRoot, 'bridge.sqlite'));
  } catch {
    io.stderr?.write('ERR:store_failed\n');
    return 1;
  }

  let logger;
  try {
    logger = createBrokerLogger({
      logFile: resolveStatePath({ root: stateRoot, relative: 'logs/broker.log' }),
      archiveDir: resolveStatePath({ root: stateRoot, relative: 'log-archive' }),
    });
  } catch {
    io.stderr?.write('ERR:log_failed\n');
    try { store.close(); } catch { /* best effort */ }
    return 1;
  }

  const api = new TelegramApi({ botToken: credentials.botToken });
  const broker = new SelectiveTelegramBroker({
    store,
    api,
    config: {
      telegram: {
        allowedUserId: credentials.allowedUserId,
        allowedChatId: credentials.allowedChatId,
      },
      bridge: {
        maxMessageChars: 3800,
        rateLimit: { max: MAX_RATE.max, windowMs: MAX_RATE.windowMs },
      },
    },
    ownerId: 'telegram-broker',
    logger,
  });

  let metaPath;
  let controlPath;
  try {
    metaPath = resolveStatePath({ root: stateRoot, relative: 'broker-meta.json' });
    controlPath = resolveStatePath({ root: stateRoot, relative: 'broker-control.json' });
  } catch {
    io.stderr?.write('ERR:bad_state_dir\n');
    try { store.close(); } catch { /* best effort */ }
    return 1;
  }

  const startedAt = Date.now();

  // Startup visibility: before the first meta write clobbers the previous
  // run's evidence, report a previous run that never recorded a shutdown.
  // A live previous pid means a second instance is racing the capability
  // lock, not a death, so that case stays silent. Never throws.
  const uncleanRestart = readUncleanPreviousRun(metaPath, startedAt);
  if (uncleanRestart) logger(uncleanRestart);

  const writeMeta = (heartbeatAt, extra = {}) => {
    try {
      // Credential-free by construction: fixed fields only.
      writeJsonAtomic(metaPath, {
        instanceId: config.instanceId,
        pid: process.pid,
        startedAt,
        heartbeatAt,
        shutdownAt: null,
        ...extra,
      });
    } catch {
      logger({ code: 'meta_write_error' });
    }
  };

  const abort = new AbortController();
  let stopping = false;
  const stop = (reason) => {
    if (stopping) return;
    stopping = true;
    logger({ code: 'broker_stop_requested', reason });
    abort.abort();
  };

  // Local control channel (state-root broker-control.json), consumed
  // first and decided second so a stop request applies at most once.
  const controlTimer = setInterval(() => {
    let raw;
    try {
      raw = readFileSync(controlPath, 'utf8');
    } catch {
      return;
    }
    if (raw.trim().length === 0) return;
    try {
      writeJsonAtomic(controlPath, { consumedAt: Date.now() });
    } catch {
      logger({ code: 'control_reset_error' });
    }
    const verdict = parseBrokerControl(raw, config.instanceId);
    if (verdict === 'stop') stop('control');
    else if (verdict === 'invalid') logger({ code: 'control_invalid' });
    else if (verdict === 'foreign') logger({ code: 'control_rejected' });
    else if (verdict === 'unknown') logger({ code: 'control_unknown' });
  }, CONTROL_POLL_MS);
  controlTimer.unref?.();

  const heartbeatTimer = setInterval(() => writeMeta(Date.now()), META_HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  const onSignal = () => stop('signal');
  io.on?.('SIGINT', onSignal);
  io.on?.('SIGTERM', onSignal);

  writeMeta(startedAt);
  let exitCode = 0;
  try {
    await broker.run({ signal: abort.signal });
  } catch (error) {
    if (!abort.signal.aborted) {
      logger({ code: 'broker_failed' });
      io.stderr?.write('ERR:broker_failed\n');
      exitCode = 1;
    }
  } finally {
    clearInterval(controlTimer);
    clearInterval(heartbeatTimer);
    io.off?.('SIGINT', onSignal);
    io.off?.('SIGTERM', onSignal);
    try {
      await broker.dispose();
    } catch {
      /* transport close races at shutdown are tolerated */
    }
    writeMeta(Date.now(), { shutdownAt: Date.now() });
    try {
      store.close();
    } catch {
      /* best effort */
    }
  }
  return exitCode;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runBrokerMain().then((code) => {
    process.exitCode = code;
  });
}
