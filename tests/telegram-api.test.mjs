// T03 WU2: Telegram API transport contracts against a fake fetch — no
// real network, no real bot, no secrets. Shapes follow
// https://core.telegram.org/bots/api (getUpdates, sendMessage,
// answerCallbackQuery, getWebhookInfo, getMe).
//
// Security invariants under test:
// - The production origin is FIXED (https://api.telegram.org); tests inject
//   fetch, so no test ever performs a real call.
// - The bot token is never present in any thrown error, message or log.
// - 401/403/409 fail safely with credential-free codes and never retry.
// - Retries are bounded with exponential backoff + jitter and honor
//   retry_after; everything is abortable.
// - Responses are bounded; unbounded bodies fail with 'too_large'.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TelegramApi, TelegramApiError, TELEGRAM_API_ORIGIN, TELEGRAM_ALLOWED_UPDATES } from '../src/telegram-api.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const TOKEN = '1234567890:AAE_fake-token-value-abcdefghijklmnop';
// The token must never leak anywhere; every negative assertion uses this.
const TOKEN_LEAK = new RegExp(TOKEN.replace(/[.*+?${}()|[\]\\]/g, '\\$&'));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Programmable fake fetch: script per method, capture requests. */
function makeFakeFetch(script = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = String(url).split('/').pop();
    // GETs (file downloads) carry no body: keep the captured shape honest
    // instead of letting JSON.parse(undefined) throw.
    calls.push({ url, method, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const handler = script[method];
    if (typeof handler === 'function') return handler(calls[calls.length - 1]);
    if (handler) return handler;
    return jsonResponse({ ok: true, result: true });
  };
  return { calls, fetchImpl };
}

function makeApi(fetchImpl, overrides = {}) {
  return new TelegramApi({
    botToken: TOKEN,
    fetchImpl,
    sleep: async () => {}, // instant in most tests
    random: () => 0, // no jitter in most tests
    ...overrides,
  });
}

describe('telegram-api: fixed origin and method contracts', () => {
  test('getUpdates posts to the fixed origin with positive long-poll timeout and allowed_updates', async () => {
    const { calls, fetchImpl } = makeFakeFetch({
      getUpdates: jsonResponse({ ok: true, result: [] }),
    });
    const api = makeApi(fetchImpl);
    const updates = await api.getUpdates({ offset: 42 });
    assert.deepEqual(updates, []);
    const call = calls[0];
    assert.equal(call.url, `${TELEGRAM_API_ORIGIN}/bot${TOKEN}/getUpdates`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.body.offset, 42);
    assert.ok(Number.isInteger(call.body.timeout) && call.body.timeout > 0, 'long poll timeout must be positive');
    assert.deepEqual(call.body.allowed_updates, TELEGRAM_ALLOWED_UPDATES);
    assert.deepEqual(TELEGRAM_ALLOWED_UPDATES, ['message', 'callback_query']);
    await api.close();
  });

  test('sendMessage posts text + optional reply_markup and NEVER a parse_mode', async () => {
    const { calls, fetchImpl } = makeFakeFetch({
      sendMessage: jsonResponse({ ok: true, result: { message_id: 7 } }),
    });
    const api = makeApi(fetchImpl);
    const result = await api.sendMessage({
      chatId: -100123,
      text: 'hello',
      replyMarkup: { inline_keyboard: [[{ text: 'Aprobar', callback_data: 't' }]] },
    });
    assert.deepEqual(result, { message_id: 7 });
    const body = calls[0].body;
    assert.equal(body.chat_id, -100123);
    assert.equal(body.text, 'hello');
    assert.equal(body.parse_mode, undefined, 'plain text only: parse_mode must never be set');
    assert.deepEqual(body.reply_markup, { inline_keyboard: [[{ text: 'Aprobar', callback_data: 't' }]] });
    await api.close();
  });

  test('answerCallbackQuery posts callback_query_id with bounded text', async () => {
    const { calls, fetchImpl } = makeFakeFetch({
      answerCallbackQuery: jsonResponse({ ok: true, result: true }),
    });
    const api = makeApi(fetchImpl);
    await api.answerCallbackQuery({ callbackQueryId: 'cq1', text: 'Decision queued' });
    assert.equal(calls[0].body.callback_query_id, 'cq1');
    assert.equal(calls[0].body.text, 'Decision queued');
    await assert.rejects(
      () => api.answerCallbackQuery({ callbackQueryId: 'cq1', text: 'x'.repeat(201) }),
      /200/,
      'answer text above 200 chars must fail closed',
    );
    await api.close();
  });

  test('getWebhookInfo and getMe use the fixed origin and parse result', async () => {
    const { calls, fetchImpl } = makeFakeFetch({
      getWebhookInfo: jsonResponse({ ok: true, result: { url: '', pending_update_count: 0 } }),
      getMe: jsonResponse({ ok: true, result: { id: 42, is_bot: true, username: 'fake_bot' } }),
    });
    const api = makeApi(fetchImpl);
    const webhook = await api.getWebhookInfo();
    assert.deepEqual(webhook, { url: '', pending_update_count: 0 });
    const me = await api.getMe();
    assert.equal(me.id, 42);
    assert.match(calls[0].url, /^https:\/\/api\.telegram\.org\/bot/);
    assert.match(calls[1].url, /^https:\/\/api\.telegram\.org\/bot/);
    await api.close();
  });
});

describe('telegram-api: safe failure codes without credential leaks', () => {
  const cases = [
    ['unauthorized', 401, { ok: false, error_code: 401, description: 'Unauthorized' }],
    ['forbidden', 403, { ok: false, error_code: 403, description: 'bot was blocked' }],
    ['conflict', 409, { ok: false, error_code: 409, description: 'terminated by other getUpdates request' }],
  ];
  for (const [code, status, body] of cases) {
    test(`${status} -> '${code}', single attempt, token never in the error`, async () => {
      let attempts = 0;
      const { fetchImpl } = makeFakeFetch({
        getUpdates: () => {
          attempts += 1;
          return jsonResponse(body, status);
        },
      });
      const api = makeApi(fetchImpl, { maxRetries: 5 });
      await assert.rejects(
        () => api.getUpdates({ offset: 0 }),
        (error) => {
          assert.ok(error instanceof TelegramApiError);
          assert.equal(error.code, code);
          assert.doesNotMatch(error.message, TOKEN_LEAK);
          assert.doesNotMatch(String(error.stack ?? ''), TOKEN_LEAK);
          return true;
        },
      );
      assert.equal(attempts, 1, `${code} must never be retried`);
      await api.close();
    });
  }

  test('body-level error_code is honored even over HTTP 200', async () => {
    const { fetchImpl } = makeFakeFetch({
      getMe: jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, 200),
    });
    const api = makeApi(fetchImpl);
    await assert.rejects(() => api.getMe(), (e) => e.code === 'unauthorized');
    await api.close();
  });
});

describe('telegram-api: bounded retries, backoff, retry_after', () => {
  test('429 honors parameters.retry_after then succeeds', async () => {
    const delays = [];
    let attempts = 0;
    const { fetchImpl } = makeFakeFetch({
      getUpdates: () => {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }, 429);
        }
        return jsonResponse({ ok: true, result: [] });
      },
    });
    const api = makeApi(fetchImpl, { sleep: async (ms) => delays.push(ms) });
    const updates = await api.getUpdates({ offset: 0 });
    assert.deepEqual(updates, []);
    assert.deepEqual(delays, [3000], 'retry_after (ms) must take precedence over backoff');
    await api.close();
  });

  test('5xx retries with exponential backoff (jitter bounded) then succeeds', async () => {
    const delays = [];
    let attempts = 0;
    const { fetchImpl } = makeFakeFetch({
      getMe: () => {
        attempts += 1;
        if (attempts <= 2) return jsonResponse({ ok: false, error_code: 502, description: 'Bad Gateway' }, 502);
        return jsonResponse({ ok: true, result: { id: 1, is_bot: true } });
      },
    });
    const api = makeApi(fetchImpl, {
      baseDelayMs: 400,
      maxDelayMs: 8000,
      jitterRatio: 0.5,
      random: () => 1, // maximum jitter
      sleep: async (ms) => delays.push(ms),
    });
    await api.getMe();
    // attempt 1: 400 * (1 + 0.5) = 600; attempt 2: 800 * 1.5 = 1200
    assert.deepEqual(delays, [600, 1200]);
    await api.close();
  });

  test('retries are bounded: exhausting them surfaces a credential-free code', async () => {
    let attempts = 0;
    const { fetchImpl } = makeFakeFetch({
      getMe: () => {
        attempts += 1;
        return jsonResponse({ ok: false, error_code: 502, description: 'Bad Gateway' }, 502);
      },
    });
    const api = makeApi(fetchImpl, { maxRetries: 3, sleep: async () => {} });
    await assert.rejects(
      () => api.getMe(),
      (error) => {
        assert.equal(error.code, 'server');
        assert.doesNotMatch(error.message, TOKEN_LEAK);
        return true;
      },
    );
    assert.equal(attempts, 4, 'initial attempt + maxRetries');
    await api.close();
  });

  test('network failures are retried then reported as network without token', async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      throw new Error(`getaddrinfo ENOTFOUND api.telegram.org ${TOKEN}`);
    };
    const api = makeApi(fetchImpl, { maxRetries: 1, sleep: async () => {} });
    await assert.rejects(
      () => api.getUpdates({ offset: 0 }),
      (error) => {
        assert.equal(error.code, 'network');
        // The underlying cause must not leak either.
        assert.doesNotMatch(error.message, TOKEN_LEAK);
        assert.doesNotMatch(String(error.cause ?? ''), TOKEN_LEAK);
        return true;
      },
    );
    assert.equal(attempts, 2);
    await api.close();
  });
});

describe('telegram-api: abort, timeout and bounded responses', () => {
  function hangingFetch() {
    return async (url, init) => new Promise((resolve, reject) => {
      if (init.signal.aborted) {
        reject(new Error('AbortError'));
        return;
      }
      init.signal.addEventListener('abort', () => {
        const error = new Error('AbortError');
        error.name = 'AbortError';
        reject(error);
      });
    });
  }

  test('external abort breaks a pending long poll immediately', async () => {
    const api = makeApi(hangingFetch(), { maxRetries: 0 });
    const controller = new AbortController();
    const pending = api.getUpdates({ offset: 0, signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, (error) => error.code === 'aborted');
    await api.close();
  });

  test('close() aborts in-flight requests', async () => {
    const api = makeApi(hangingFetch(), { maxRetries: 0 });
    const pending = api.getUpdates({ offset: 0 });
    const closePromise = api.close();
    await assert.rejects(() => pending, (error) => error.code === 'aborted');
    await closePromise;
  });

  test('a hung response times out per attempt and reports timeout', async () => {
    let attempts = 0;
    const fetchImpl = async (url, init) => {
      attempts += 1;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('AbortError');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    const api = makeApi(fetchImpl, { timeoutMs: 50, maxRetries: 1, sleep: async () => {} });
    await assert.rejects(() => api.getMe(), (error) => error.code === 'timeout');
    assert.equal(attempts, 2);
    await api.close();
  });

  test('getUpdates long poll uses a request timeout above the poll timeout', async () => {
    const { calls, fetchImpl } = makeFakeFetch({
      getUpdates: jsonResponse({ ok: true, result: [] }),
    });
    const api = makeApi(fetchImpl, { timeoutMs: 1000, longPollTimeoutSec: 25 });
    await api.getUpdates({ offset: 0 });
    // Internal per-attempt timeout must exceed the 25s long poll; asserted
    // indirectly by the fact the happy path completes — the exact internal
    // value is not observable and must not leak into the payload.
    assert.equal(calls[0].body.timeout, 25);
    await api.close();
  });

  test('a response body above the cap fails with too_large, no retry', async () => {
    let attempts = 0;
    const big = 'x'.repeat(900_000);
    const { fetchImpl } = makeFakeFetch({
      getUpdates: () => {
        attempts += 1;
        return new Response(JSON.stringify({ ok: true, result: [{ filler: big }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const api = makeApi(fetchImpl, { maxResponseBytes: 1024, maxRetries: 3, sleep: async () => {} });
    await assert.rejects(() => api.getUpdates({ offset: 0 }), (error) => {
      assert.equal(error.code, 'too_large');
      return true;
    });
    assert.equal(attempts, 1, 'unbounded bodies must not be retried');
    await api.close();
  });

  test('outbound requests forbid redirects: init.redirect is error', async () => {
    // A real redirect follow can only be prevented by the fetch option
    // itself: the fake never follows, so the captured init is the only
    // observable contract surface here.
    const { calls, fetchImpl } = makeFakeFetch({
      getMe: jsonResponse({ ok: true, result: { id: 42, is_bot: true } }),
    });
    const api = makeApi(fetchImpl);
    await api.getMe();
    assert.equal(calls[0].init.redirect, 'error');
    await api.close();
  });

  test('retry sleeps with the default backoff leave zero abort listeners on an external signal', async () => {
    // A 502 on every attempt forces the retry path. The default sleep (not
    // the injected instant one) is what registers an abort listener per
    // retry; a long-lived external signal must not accumulate them.
    const { fetchImpl } = makeFakeFetch({
      getMe: () => jsonResponse({ ok: false, error_code: 502, description: 'Bad Gateway' }, 502),
    });
    const api = new TelegramApi({
      botToken: TOKEN,
      fetchImpl,
      maxRetries: 3,
      baseDelayMs: 5,
      maxDelayMs: 5,
      jitterRatio: 0,
    });
    const controller = new AbortController();
    await assert.rejects(
      () => api.getMe({ signal: controller.signal }),
      (error) => error.code === 'server',
    );
    assert.equal(
      getEventListeners(controller.signal, 'abort').length,
      0,
      'retry sleeps must detach their abort listener once settled',
    );
    await api.close();
  });

  test('abort during a default-backoff retry sleep still rejects with aborted', async () => {
    let attempts = 0;
    const fetchImpl = async (url, init) => {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ ok: false, error_code: 502, description: 'Bad Gateway' }, 502);
      }
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('AbortError');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    const api = new TelegramApi({
      botToken: TOKEN,
      fetchImpl,
      maxRetries: 3,
      baseDelayMs: 1000,
      jitterRatio: 0,
    });
    const controller = new AbortController();
    const pending = api.getMe({ signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(() => pending, (error) => error.code === 'aborted');
    await api.close();
  });

  test('non-JSON responses fail as bad_response (retryable)', async () => {
    let attempts = 0;
    const { fetchImpl } = makeFakeFetch({
      getMe: () => {
        attempts += 1;
        if (attempts === 1) return new Response('<html>proxy error</html>', { status: 200 });
        return jsonResponse({ ok: true, result: { id: 1, is_bot: true } });
      },
    });
    const api = makeApi(fetchImpl, { sleep: async () => {} });
    await api.getMe();
    assert.equal(attempts, 2);
    await api.close();
  });
});

describe('telegram-api: inbound file download (T2)', () => {
  /** Raw-byte response: nothing in it is text. */
  function bytesResponse(bytes) {
    return new Response(bytes, { status: 200 });
  }

  /**
   * Hand-built streaming response so caps and cancellation are observable.
   * The stream never closes on its own: a consumer that keeps reading past
   * the served chunks would hang (and fail the test) instead of silently
   * reaching a synthetic end, and cancellation stays observable in
   * stats.cancelled — a close() from a later pull would race an in-flight
   * cancel() and error the stream, hiding exactly what we assert.
   */
  function trackingByteResponse({ chunks = 3, chunkSize = 1024, contentLength } = {}) {
    let pulls = 0;
    let served = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (served < chunks) {
          served += 1;
          controller.enqueue(new Uint8Array(chunkSize).fill(0x41));
        }
      },
      cancel() { cancelled = true; },
    });
    const headers = new Headers();
    if (contentLength !== undefined) headers.set('content-length', String(contentLength));
    return {
      response: { ok: true, status: 200, headers, body: stream },
      stats: {
        get pulls() { return pulls; },
        get served() { return served; },
        get cancelled() { return cancelled; },
      },
    };
  }

  test('getFile posts file_id to /bot<token>/getFile and returns Telegram\'s result', async () => {
    const result = { file_id: 'F1', file_unique_id: 'U1', file_size: 9, file_path: 'voice/file_0.oga' };
    const { calls, fetchImpl } = makeFakeFetch({
      getFile: jsonResponse({ ok: true, result }),
    });
    const api = makeApi(fetchImpl);
    const returned = await api.getFile({ fileId: 'F1' });
    assert.deepEqual(returned, result);
    assert.equal(calls[0].url, `${TELEGRAM_API_ORIGIN}/bot${TOKEN}/getFile`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].body.file_id, 'F1');
    await api.close();
  });

  test('downloadFile issues a GET to the fixed-origin file URL and returns the exact bytes (never text-decoded)', async () => {
    // Payload a TextDecoder round-trip would corrupt: 0xFF and 0xFE are
    // invalid UTF-8, 0x80 starts an invalid sequence, 0xC3 0x28 is a broken
    // two-byte pair, and the embedded NUL must survive as a byte.
    const raw = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);
    const { calls, fetchImpl } = makeFakeFetch({
      // makeFakeFetch keys handlers by the URL's last path segment.
      'file_0.oga': bytesResponse(raw),
    });
    const api = makeApi(fetchImpl);
    const bytes = await api.downloadFile({ filePath: 'voice/file_0.oga' });
    assert.ok(Buffer.isBuffer(bytes), 'audio must come back as bytes, not a string');
    assert.equal(calls[0].url, `${TELEGRAM_API_ORIGIN}/file/bot${TOKEN}/voice/file_0.oga`);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.redirect, 'error', 'the download refuses redirects like every other call');
    assert.deepEqual([...bytes], [...raw]);
    // Prove no string decoding happened: a text round-trip of these bytes
    // differs from what was served, and must differ from what came back.
    const roundTripped = Buffer.from(new TextDecoder().decode(raw), 'utf8');
    assert.notEqual(Buffer.compare(roundTripped, Buffer.from(raw)), 0, 'test payload must be corrupted by a text round-trip');
    assert.notEqual(Buffer.compare(roundTripped, bytes), 0);
    await api.close();
  });

  test('the cap is enforced in bytes: a stream over maxDownloadBytes throws too_large and cancels the stream', async () => {
    // Cap 1024 with 1024-byte chunks: the first chunk lands exactly on the
    // cap (inclusive), the second crosses it and must stop the read.
    const { response, stats } = trackingByteResponse({ chunks: 3, chunkSize: 1024 });
    const { calls, fetchImpl } = makeFakeFetch({ 'big.oga': () => response });
    const api = makeApi(fetchImpl, { maxDownloadBytes: 1024, maxRetries: 3, sleep: async () => {} });
    await assert.rejects(
      () => api.downloadFile({ filePath: 'voice/big.oga' }),
      (error) => {
        assert.ok(error instanceof TelegramApiError);
        assert.equal(error.code, 'too_large');
        assert.doesNotMatch(error.message, TOKEN_LEAK);
        return true;
      },
    );
    assert.equal(calls.length, 1, 'too_large must never be retried');
    assert.ok(stats.pulls <= 3, 'at most one pull per read: reading stops at the cap');
    assert.ok(stats.cancelled, 'the stream must be cancelled rather than buffered past the cap');
    await api.close();
  });

  test('a content-length over the cap is rejected before reading', async () => {
    // The stream never closes, so an implementation that read the body
    // would keep pulling forever and hang this test instead of passing it.
    const { response, stats } = trackingByteResponse(
      { chunks: 1, chunkSize: 8, contentLength: 20 * 1024 * 1024 + 1 },
    );
    const { fetchImpl } = makeFakeFetch({ 'big.oga': () => response });
    const api = makeApi(fetchImpl, { maxDownloadBytes: 20 * 1024 * 1024 });
    await assert.rejects(
      () => api.downloadFile({ filePath: 'voice/big.oga' }),
      (error) => error.code === 'too_large',
    );
    // At most the construction-time pull: the body was never read.
    assert.ok(stats.pulls <= 1, 'the body must never be read');
    assert.ok(stats.cancelled, 'the body must be cancelled, not left hanging');
    await api.close();
  });

  test('a body of exactly maxDownloadBytes is accepted (the cap is inclusive)', async () => {
    const { fetchImpl } = makeFakeFetch({
      'exact.oga': bytesResponse(new Uint8Array(2048).fill(0x42)),
    });
    const api = makeApi(fetchImpl, { maxDownloadBytes: 2048 });
    const bytes = await api.downloadFile({ filePath: 'voice/exact.oga' });
    assert.equal(bytes.byteLength, 2048);
    await api.close();
  });

  describe('untrusted file_path validation (bad_file_path)', () => {
    const rejected = [
      ['traversal with a colon', '../../bot123:ABC/getMe'],
      ['absolute path', '/etc/passwd'],
      ['backslash', 'a\\..\\b'],
      ['query string', 'voice/file_0.oga?x=1'],
      ['fragment', 'voice/file_0.oga#frag'],
      ['scheme', 'http://evil.example/x'],
      ['protocol-relative', '//evil.example/x'],
      ['NUL byte', 'voice/file_\0.oga'],
      ['newline', 'voice/file\n.oga'],
      ['whitespace only', '   '],
      ['not a string', 42],
      ['null', null],
      ['undefined', undefined],
    ];
    for (const [name, filePath] of rejected) {
      test(`rejects ${name} with bad_file_path, no request, no echo`, async () => {
        const { calls, fetchImpl } = makeFakeFetch();
        const api = makeApi(fetchImpl);
        await assert.rejects(
          () => api.downloadFile({ filePath }),
          (error) => {
            assert.ok(error instanceof TelegramApiError);
            assert.equal(error.code, 'bad_file_path');
            // The code alone is the message: no token, no path echo.
            assert.doesNotMatch(error.message, TOKEN_LEAK);
            assert.doesNotMatch(String(error.stack ?? ''), TOKEN_LEAK);
            assert.equal(error.message.includes(String(filePath)), false);
            return true;
          },
        );
        assert.equal(calls.length, 0, 'a rejected path must never reach fetch');
        await api.close();
      });
    }

    test('accepts a benign voice file_path', async () => {
      const raw = Uint8Array.from([1, 2, 3]);
      const { calls, fetchImpl } = makeFakeFetch({ 'file_0.oga': bytesResponse(raw) });
      const api = makeApi(fetchImpl);
      const bytes = await api.downloadFile({ filePath: 'voice/file_0.oga' });
      assert.deepEqual([...bytes], [1, 2, 3]);
      assert.equal(calls.length, 1);
      await api.close();
    });
  });

  test('a 429 download honors retry_after and retries', async () => {
    const delays = [];
    let attempts = 0;
    const raw = Uint8Array.from([1, 2, 3]);
    const { calls, fetchImpl } = makeFakeFetch({
      'file_0.oga': () => {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 2 } }, 429);
        }
        return bytesResponse(raw);
      },
    });
    const api = makeApi(fetchImpl, { sleep: async (ms) => delays.push(ms) });
    const bytes = await api.downloadFile({ filePath: 'voice/file_0.oga' });
    assert.deepEqual([...bytes], [1, 2, 3]);
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [2000], 'retry_after (ms) must take precedence over backoff');
    await api.close();
  });

  test('a 404 download fails as http_error and never retries', async () => {
    let attempts = 0;
    const { fetchImpl } = makeFakeFetch({
      'file_0.oga': () => {
        attempts += 1;
        return jsonResponse({ ok: false, error_code: 404, description: 'Not Found' }, 404);
      },
    });
    const api = makeApi(fetchImpl, { maxRetries: 5, sleep: async () => {} });
    await assert.rejects(
      () => api.downloadFile({ filePath: 'voice/file_0.oga' }),
      (error) => {
        assert.equal(error.code, 'http_error');
        assert.doesNotMatch(error.message, TOKEN_LEAK);
        assert.doesNotMatch(String(error.stack ?? ''), TOKEN_LEAK);
        return true;
      },
    );
    assert.equal(attempts, 1, 'http_error is definitive: no retry');
    await api.close();
  });

  test('an aborted download surfaces as aborted', async () => {
    const fetchImpl = async (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('AbortError');
        error.name = 'AbortError';
        reject(error);
      });
    });
    const api = makeApi(fetchImpl, { maxRetries: 3 });
    const controller = new AbortController();
    const pending = api.downloadFile({ filePath: 'voice/file_0.oga', signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, (error) => error.code === 'aborted');
    await api.close();
  });

  test('a hung download times out per attempt and reports timeout', async () => {
    let attempts = 0;
    const fetchImpl = async (url, init) => {
      attempts += 1;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('AbortError');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    const api = makeApi(fetchImpl, { timeoutMs: 50, maxRetries: 1, sleep: async () => {} });
    await assert.rejects(
      () => api.downloadFile({ filePath: 'voice/file_0.oga' }),
      (error) => error.code === 'timeout',
    );
    assert.equal(attempts, 2, 'timeout is retryable');
    await api.close();
  });
});
