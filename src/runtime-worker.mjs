// T04: runtime worker wiring.
//
// The worker process is spawned by RuntimeHost and receives its Telegram
// credentials EXCLUSIVELY over its stdin pipe (never argv, never env,
// never a file). This module provides:
//  - parseWorkerCredentials: strict validation of that stdin payload;
//  - createRuntimeWorker: construction with the identical followup
//    permission validation the host applies (no divergence by design);
//  - runWorkerMain: the process entrypoint used by runtime-host.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { Store } from './store.mjs';
import { TelegramApi } from './telegram-api.mjs';
import { TelegramWorker } from './telegram-worker.mjs';
import { validateCredentials } from './dpapi-credentials.mjs';
import { loadRuntimeConfig } from './runtime-config.mjs';

export class WorkerBootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkerBootstrapError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate the credentials payload delivered over the stdin pipe.
 * Accepts only the exact typed shape; anything else fails closed with a
 * fixed code. Error messages never quote the payload.
 */
export function parseWorkerCredentials(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkerBootstrapError('bad_input', 'credentials payload is not valid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new WorkerBootstrapError('bad_input', 'credentials payload shape rejected');
  }
  try {
    validateCredentials(parsed);
  } catch {
    throw new WorkerBootstrapError('bad_input', 'credentials payload rejected');
  }
  return parsed;
}

/**
 * Construct a TelegramWorker with the operator configuration.
 * The followups flag is validated here with the same strictness as the
 * host (boolean, no coercion) so a misconfigured ops config fails on
 * both sides instead of silently diverging.
 *
 * @param {object} options
 * @param {import('./store.mjs').Store} options.store
 * @param {object} options.api TelegramApi-compatible transport (real or
 *   test seam; the token lives inside the api, never in worker state)
 * @param {{botToken: string, allowedUserId: string, allowedChatId: string}} options.credentials
 * @param {boolean} options.followupsEnabled
 * @param {object} options.config normalized operator config
 */
export function createRuntimeWorker({ store, api, credentials, followupsEnabled, config, logger = () => {}, ownerId = 'telegram-worker' }) {
  if (!store) throw new WorkerBootstrapError('bad_input', 'store required');
  if (!api) throw new WorkerBootstrapError('bad_input', 'api required');
  if (typeof followupsEnabled !== 'boolean') {
    throw new WorkerBootstrapError('bad_config', 'followupsEnabled must be a boolean');
  }
  if (!isPlainObject(config) || !isPlainObject(config.telegram)
    || config.telegram.allowedUserId !== credentials.allowedUserId
    || config.telegram.allowedChatId !== credentials.allowedChatId) {
    throw new WorkerBootstrapError('bad_config', 'config identity must match credentials');
  }
  return new TelegramWorker({
    store,
    api,
    config,
    followupsEnabled,
    logger,
    ownerId,
  });
}

/**
 * Process entrypoint: `node src/runtime-worker.mjs --state-dir <dir> --config <path>`
 * with the credentials JSON arriving on stdin (anonymous pipe written by
 * the host, closed immediately after). Exits when stdin closes or on
 * SIGTERM/SIGINT, releasing the worker lease on the way out.
 */
export async function runWorkerMain(argv = process.argv.slice(2), io = process) {
  let stateDir = null;
  let configPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state-dir' && argv[i + 1]) stateDir = argv[i + 1];
    else if (argv[i] === '--config' && argv[i + 1]) configPath = argv[i + 1];
  }
  if (!stateDir || !configPath) {
    io.stderr.write('ERR:bad_usage\n');
    return 1;
  }

  let credentials;
  try {
    const raw = await readStdin(io);
    credentials = parseWorkerCredentials(raw);
  } catch (error) {
    io.stderr.write(`ERR:${error && error.code ? error.code : 'bad_input'}\n`);
    return 1;
  }

  let config;
  try {
    config = loadRuntimeConfig(configPath);
  } catch {
    io.stderr.write('ERR:bad_config\n');
    return 1;
  }

  const store = new Store(join(stateDir, 'bridge.sqlite'));
  const api = new TelegramApi({ botToken: credentials.botToken });
  const worker = createRuntimeWorker({
    store,
    api,
    credentials,
    followupsEnabled: config.bridge.followupsEnabled,
    config: {
      telegram: {
        allowedUserId: credentials.allowedUserId,
        allowedChatId: credentials.allowedChatId,
      },
      // The worker relies on the operator config defaults (limits are
      // validated by TelegramWorker itself).
      bridge: {
        maxMessageChars: 3800,
        rateLimit: { max: 10, windowMs: 60_000 },
      },
    },
  });

  const abort = new AbortController();
  const stop = () => abort.abort();
  io.on?.('SIGTERM', stop);
  io.on?.('SIGINT', stop);

  try {
    await worker.run({ signal: abort.signal });
  } catch (error) {
    if (!(abort.signal.aborted)) {
      io.stderr.write('ERR:worker_failed\n');
    }
  } finally {
    io.off?.('SIGTERM', stop);
    io.off?.('SIGINT', stop);
    try {
      await worker.dispose();
    } catch {
      /* lease release races at shutdown are tolerated */
    }
  }
  return 0;
}

function readStdin(io) {
  return new Promise((resolve, reject) => {
    const stdin = io.stdin;
    let raw = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { raw += chunk; });
    stdin.on('end', () => resolve(raw));
    stdin.on('error', () => reject(new WorkerBootstrapError('bad_input', 'stdin unavailable')));
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  runWorkerMain().then((code) => {
    process.exitCode = code;
  });
}
