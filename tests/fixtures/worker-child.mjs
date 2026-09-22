// T03 WU4 fixture: the Telegram worker running in a REAL child process,
// wired to the parent only through the SQLite database and a JSON control
// file. The transport is the real TelegramApi with an injected fake fetch
// that reads pending updates from the control file and records every send
// to a JSONL log. No network, no token, no Telegram.

import { readFileSync, appendFileSync } from 'node:fs';

import { Store } from '../../src/store.mjs';
import { TelegramApi } from '../../src/telegram-api.mjs';
import { TelegramWorker } from '../../src/telegram-worker.mjs';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

const dbPath = arg('db');
const controlPath = arg('control');
const logPath = arg('log');
const configPath = arg('config');

function readControl() {
  return JSON.parse(readFileSync(controlPath, 'utf8'));
}

function appendLog(entry) {
  appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`, 'utf8');
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
// Test clock: the parent store runs on a fixed base time; the child must
// agree with it or every request looks expired. now = base + real elapsed.
const nowBaseArg = arg('now-base');
const nowBase = nowBaseArg === null ? null : Number(nowBaseArg);
const startedAtReal = Date.now();
const now = nowBase === null ? Date.now : () => nowBase + (Date.now() - startedAtReal);
const store = new Store(dbPath, { now });

/**
 * Fake fetch: derives the method from the URL path (the URL itself is
 * never logged — it carries the token), serves updates from the control
 * file, and logs every send for parent-side assertions.
 */
async function fakeFetch(url, init) {
  const method = url.slice(url.lastIndexOf('/') + 1).replace(/^bot[^/]+\//, '');
  const body = JSON.parse(init.body);
  if (method !== 'getUpdates') {
    appendLog({
      api: method,
      text: typeof body.text === 'string' ? body.text : '',
      hasMarkup: body.reply_markup !== undefined,
      hasButtons: body.reply_markup?.inline_keyboard !== undefined,
    });
  }
  if (method === 'getUpdates') {
    const control = readControl();
    if (control.webhook) {
      return new Response(JSON.stringify({ ok: false, error_code: 409, description: 'webhook conflict' }), { status: 409 });
    }
    const offset = typeof body.offset === 'number' ? body.offset : 0;
    const updates = (control.updates ?? []).filter((u) => u.update_id >= offset);
    return new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 });
  }
  if (method === 'getWebhookInfo') {
    const control = readControl();
    return new Response(JSON.stringify({ ok: true, result: { url: control.webhook ?? '', pending_update_count: 0 } }), { status: 200 });
  }
  if (method === 'getMe') {
    return new Response(JSON.stringify({ ok: true, result: { id: 42, is_bot: true, username: 'fake_local_test_bot' } }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
}

const api = new TelegramApi({
  // Placeholder only: the child never talks to the network (fetch is local).
  botToken: '000000000:LOCAL_TEST_FAKE_TOKEN',
  fetchImpl: fakeFetch,
  timeoutMs: 2000,
  longPollTimeoutSec: 0,
  maxRetries: 0,
});

const worker = new TelegramWorker({
  store,
  api,
  config,
  ownerId: 'worker-child',
  pid: process.pid,
  now,
  logger: ({ code }) => appendLog({ event: 'log', code }),
});

const control = readControl();
const cycles = control.cycles ?? 20;
const gapMs = control.gapMs ?? 20;

try {
  appendLog({ event: 'started' });
  await worker.start();
  for (let i = 0; i < cycles; i++) {
    await worker.pollOnce();
    await worker.drainPending();
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  appendLog({ event: 'stopped' });
} catch (error) {
  appendLog({ event: 'error', code: error?.code ?? 'unknown' });
  process.exitCode = 1;
} finally {
  await worker.dispose();
  store.close();
}
