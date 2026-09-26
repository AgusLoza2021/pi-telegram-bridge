// sendPhoto transport + CLI dry-run tests (additive slice): no network,
// no real credentials. The transport tests use the same injected-fetch
// seam as tests/telegram-api.test.mjs; the CLI tests inject the reveal
// seam so no DPAPI blob is ever read.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { TelegramApi, TelegramApiError, TELEGRAM_API_ORIGIN } from '../src/telegram-api.mjs';
import { MAX_PHOTO_BYTES, PHOTO_EXTENSIONS } from '../src/media-policy.mjs';
import { main as sendPhotoMain } from '../scripts/send-photo.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const TOKEN = '1234567890:AAE_fake-token-value-abcdefghijklmnop';
const TOKEN_LEAK = new RegExp(TOKEN.replace(/[.*+?${}()|[\]\\]/g, '\\$&'));
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeApi(fetchImpl, overrides = {}) {
  return new TelegramApi({
    botToken: TOKEN,
    fetchImpl,
    sleep: async () => {},
    random: () => 0,
    ...overrides,
  });
}

/** A real on-disk photo: sendPhoto reads the file itself. */
function makePhotoFile(label = 'api') {
  const dir = mkdtempSync(join(tmpdir(), `sendphoto-${label}-`));
  const file = join(dir, 'matter.png');
  writeFileSync(file, PNG_BYTES);
  return file;
}

async function formSnapshot(form) {
  const entries = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      entries[key] = value;
    } else {
      entries[key] = {
        name: value.name,
        bytes: Buffer.from(await value.arrayBuffer()),
      };
    }
  }
  return entries;
}

describe('sendPhoto: multipart transport contracts', () => {
  test('posts FormData to <origin>/bot<token>/sendPhoto with the file bytes, chat id and no parse_mode', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true, result: { message_id: 9 } });
    };
    const api = makeApi(fetchImpl);
    const file = makePhotoFile('happy');
    const result = await api.sendPhoto({ chatId: -100123, filePath: file });
    assert.deepEqual(result, { message_id: 9 });

    const call = calls[0];
    assert.ok(call.url.endsWith('/sendPhoto'), 'the request URL must end in sendPhoto');
    assert.ok(call.url.startsWith(`${TELEGRAM_API_ORIGIN}/bot`));
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    // fetch must choose the boundary itself: no hardcoded multipart or
    // JSON content-type may override it.
    assert.equal(call.init.headers, undefined, 'multipart must not set a content-type header');
    assert.ok(call.init.body instanceof FormData, 'the body must be FormData');

    const body = await formSnapshot(call.init.body);
    assert.equal(body.chat_id, '-100123');
    assert.equal(body.photo.name, 'matter.png');
    assert.ok(body.photo.bytes.equals(PNG_BYTES), 'the exact file bytes must be carried');
    assert.equal(body.caption, undefined, 'no caption field unless a caption was given');
    for (const key of call.init.body.keys()) {
      assert.notEqual(key, 'parse_mode', 'parse_mode must never be set, in any field');
    }
    await api.close();
  });

  test('a caption is appended as plain text only', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true, result: true });
    };
    const api = makeApi(fetchImpl);
    const file = makePhotoFile('caption');
    await api.sendPhoto({ chatId: 42, filePath: file, caption: 'Pi finished the task' });
    const body = await formSnapshot(calls[0].init.body);
    assert.equal(body.caption, 'Pi finished the task');
    assert.ok(![...calls[0].init.body.keys()].includes('parse_mode'));
    await api.close();
  });

  test('non-ok and malformed responses map to the fixed credential-free codes', async () => {
    const cases = [
      ['unauthorized', () => jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, 401)],
      ['forbidden', () => jsonResponse({ ok: false, error_code: 403, description: 'blocked' }, 403)],
      ['http_error', () => jsonResponse({ ok: false, error_code: 400, description: 'bad request' }, 400)],
      ['bad_response', () => new Response('<html>proxy</html>', { status: 200 })],
    ];
    for (const [code, handler] of cases) {
      let attempts = 0;
      const fetchImpl = async () => {
        attempts += 1;
        return handler();
      };
      const api = makeApi(fetchImpl);
      const file = makePhotoFile(`err-${code}`);
      await assert.rejects(
        () => api.sendPhoto({ chatId: 42, filePath: file }),
        (error) => {
          assert.ok(error instanceof TelegramApiError);
          assert.equal(error.code, code);
          assert.doesNotMatch(error.message, TOKEN_LEAK);
          return true;
        },
      );
      assert.equal(
        attempts,
        code === 'bad_response' ? 5 : 1,
        'definitive codes never retry; bad_response is retryable by design',
      );
      await api.close();
    }
  });

  test('external abort rejects with the fixed aborted code', async () => {
    const fetchImpl = async (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('AbortError');
        error.name = 'AbortError';
        reject(error);
      });
    });
    const api = makeApi(fetchImpl, { maxRetries: 0 });
    const file = makePhotoFile('abort');
    const controller = new AbortController();
    const pending = api.sendPhoto({ chatId: 42, filePath: file, signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, (error) => error.code === 'aborted');
    await api.close();
  });
});

describe('send-photo CLI', () => {
  function capture() {
    const lines = [];
    const stdout = new Writable({
      write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); },
    });
    return { stdout, lines };
  }

  function makePhotoDir(label) {
    const dir = mkdtempSync(join(tmpdir(), `sendphoto-${label}-`));
    writeFileSync(join(dir, 'pic.png'), PNG_BYTES);
    return dir;
  }

  test('--help prints the usage and exits 0 without touching credentials or the network', async () => {
    const { stdout, lines } = capture();
    const code = await sendPhotoMain(['--help'], {
      stdout,
      // Throws loudly if the help path ever reaches for credentials. Asking
      // how the tool works must never read the DPAPI blob.
      revealCredentials: () => { throw new Error('help must not reveal credentials'); },
    });
    assert.equal(code, 0, 'help is a success, not a usage error');
    const out = lines.join('');
    assert.match(out, /^Send one photo to the enrolled allowed chat\./);
    assert.match(out, /Usage:/);
    assert.ok(!out.startsWith('FAILED:'), 'help must not report a failure');
    assert.notEqual(out.trimEnd(), 'SENT', 'help is not a send result');
  });

  test('-h is an alias for --help, and --help wins next to malformed arguments', async () => {
    const first = capture();
    assert.equal(await sendPhotoMain(['-h'], { stdout: first.stdout }), 0);

    // The bug this pins: the unknown-flag throw used to fire before --help
    // could be honoured, so `--help --bogus` printed FAILED: bad_usage.
    const second = capture();
    assert.equal(
      await sendPhotoMain(['--help', '--bogus'], { stdout: second.stdout }),
      0,
      'a usage request must not be defeated by the rest of the command line',
    );
    assert.equal(first.lines.join(''), second.lines.join(''), '-h and --help print the same text');
  });

  test('the usage quotes the real policy limits instead of drifting from them', async () => {
    const { stdout, lines } = capture();
    await sendPhotoMain(['--help'], { stdout });
    const out = lines.join('');
    for (const ext of PHOTO_EXTENSIONS) {
      assert.ok(out.includes(ext), `usage must list the enforced extension ${ext}`);
    }
    assert.ok(
      out.includes(`${MAX_PHOTO_BYTES / (1024 * 1024)} MB`),
      'usage must state the enforced size cap',
    );
  });

  test('--dry-run validates and reports success with exit 0, no network and no credentials', async () => {
    const dir = makePhotoDir('dry');
    const { stdout, lines } = capture();
    const code = await sendPhotoMain([join(dir, 'pic.png'), '--root', dir, '--dry-run'], { stdout });
    assert.equal(code, 0);
    assert.equal(lines.join(''), 'DRY-RUN OK\n', 'exactly one final line, without SENT');
  });

  test('--dry-run with a caption still reports success and refuses unknown flags', async () => {
    const dir = makePhotoDir('cap');
    const { stdout, lines } = capture();
    const code = await sendPhotoMain(
      [join(dir, 'pic.png'), '--root', dir, '--caption', 'done', '--dry-run'],
      { stdout },
    );
    assert.equal(code, 0);
    assert.equal(lines.join(''), 'DRY-RUN OK\n');
  });

  test('refuses a non-photo file with its fixed code and exit 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sendphoto-txt-'));
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    const { stdout, lines } = capture();
    const code = await sendPhotoMain([join(dir, 'notes.txt'), '--root', dir, '--dry-run'], { stdout });
    assert.equal(code, 1);
    assert.equal(lines.join(''), 'FAILED: bad_extension\n');
  });

  test('refuses an arbitrary --chat-id on the command line', async () => {
    const dir = makePhotoDir('chatid');
    for (const argv of [
      [join(dir, 'pic.png'), '--chat-id', '12345', '--dry-run'],
      [join(dir, 'pic.png'), '--chat-id=12345', '--dry-run'],
    ]) {
      const { stdout, lines } = capture();
      const code = await sendPhotoMain(argv, { stdout });
      assert.equal(code, 2);
      assert.equal(lines.join(''), 'FAILED: bad_usage\n');
    }
  });

  test('refuses missing or doubled file arguments with bad_usage', async () => {
    const { stdout, lines } = capture();
    assert.equal(await sendPhotoMain([], { stdout }), 2);
    assert.equal(lines.join(''), 'FAILED: bad_usage\n');
    const { stdout: s2, lines: l2 } = capture();
    assert.equal(await sendPhotoMain(['a.png', 'b.png', '--dry-run'], { stdout: s2 }), 2);
    assert.equal(l2.join(''), 'FAILED: bad_usage\n');
  });

  test('a real send uses the enrolled allowed chat from the sanctioned reveal seam', async () => {
    const dir = makePhotoDir('send');
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true, result: { message_id: 3 } });
    };
    const revealed = [];
    const revealCredentials = async ({ stateRoot }) => {
      revealed.push({ stateRoot });
      return { botToken: TOKEN, allowedUserId: '777', allowedChatId: '424242' };
    };
    const { stdout, lines } = capture();
    const code = await sendPhotoMain([join(dir, 'pic.png'), '--root', dir, '--caption', 'hi'], {
      stdout,
      fetchImpl,
      revealCredentials,
    });
    assert.equal(code, 0);
    assert.equal(lines.join(''), 'SENT\n');
    assert.equal(revealed.length, 1, 'credentials revealed exactly once');
    const body = await formSnapshot(calls[0].init.body);
    assert.equal(body.chat_id, '424242', 'the chat id must come from the enrolled credentials');
    assert.ok(calls[0].url.endsWith('/sendPhoto'));
    assert.ok(body.photo.bytes.equals(PNG_BYTES));
  });

  test('a failing send maps to FAILED: <code> without leaking the token or a stack', async () => {
    const dir = makePhotoDir('fail');
    const fetchImpl = async () => jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
    const revealCredentials = async () => ({ botToken: TOKEN, allowedUserId: '1', allowedChatId: '424242' });
    const { stdout, lines } = capture();
    const code = await sendPhotoMain([join(dir, 'pic.png'), '--root', dir], {
      stdout,
      fetchImpl,
      revealCredentials,
    });
    assert.equal(code, 1);
    assert.equal(lines.join(''), 'FAILED: unauthorized\n');
    assert.equal(lines.length, 1, 'exactly one output line');
    const output = lines[0];
    assert.doesNotMatch(output, TOKEN_LEAK);
    assert.doesNotMatch(output, /Error|at\s/, 'no stack trace may reach the output');
  });
});
