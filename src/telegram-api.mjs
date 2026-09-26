// Telegram Bot API transport for the Pi Telegram bridge (T03).
//
// Security and reliability invariants:
// - The production origin is FIXED to https://api.telegram.org. There is no
//   configurable endpoint: the only test seam is the injected fetch, so no
//   test or misconfiguration can ever point production traffic elsewhere.
// - The bot token appears ONLY inside the request URL (Telegram's own
//   scheme). It is never written to errors, logs or thrown messages: every
//   failure surfaces as a fixed credential-free code.
// - Long polling uses a positive timeout and a fixed allowed_updates list
//   (message, callback_query). Webhooks are never registered or deleted.
// - Every request is abortable (external signal), bounded per attempt by a
//   timeout, and reads at most maxResponseBytes of body (never buffers an
//   unbounded response).
// - Transient failures (network, timeout, 5xx, 429, unparseable body) are
//   retried with exponential backoff + jitter; 429 honors retry_after.
//   401/403/409 and other definitive failures are NEVER retried.
// - File downloads (getFile + /file/bot<token>/<path>) follow the same
//   fixed-origin, credential-free, abortable, bounded discipline. Audio
//   bytes are never decoded as text, and Telegram's untrusted file_path is
//   validated before any download URL is ever built.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
export const TELEGRAM_ALLOWED_UPDATES = Object.freeze(['message', 'callback_query']);

const RETRYABLE_CODES = new Set(['network', 'timeout', 'server', 'rate_limited', 'bad_response']);

/** Fixed credential-free failure. The message is only the code. */
export class TelegramApiError extends Error {
  /**
   * @param {object} params
   * @param {string} params.code fixed code, e.g. 'unauthorized'
   * @param {number|null} [params.status] HTTP status when applicable
   * @param {number|null} [params.retryAfterMs] server-provided retry hint
   */
  constructor({ code, status = null, retryAfterMs = null }) {
    super(`telegram api error: ${code}`);
    this.name = 'TelegramApiError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  const onAbort = () => {
    clearTimeout(timer);
    reject(new TelegramApiError({ code: 'aborted' }));
  };
  const timer = setTimeout(() => {
    // Detach on normal completion too: retry sleeps run on a long-lived
    // external signal, and a leaked listener per retry grows unbounded.
    if (signal) signal.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
});

function codeFromStatus(status) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'http_error';
}

export class TelegramApi {
  /**
   * @param {object} options
   * @param {string} options.botToken bot token (validated by config; only
   *   used to build the fixed-origin URL)
   * @param {typeof fetch} [options.fetchImpl] injected fetch (test seam)
   * @param {number} [options.timeoutMs] per-attempt timeout for normal calls
   * @param {number} [options.longPollTimeoutSec] getUpdates long poll seconds
   * @param {number} [options.maxRetries] retries after the initial attempt
   * @param {number} [options.baseDelayMs] backoff base
   * @param {number} [options.maxDelayMs] backoff cap
   * @param {number} [options.jitterRatio] 0..1 multiplicative jitter
   * @param {number} [options.maxResponseBytes] response body cap
   * @param {number} [options.maxDownloadBytes] file download cap in bytes
   * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
   * @param {() => number} [options.random] jitter source (0..1)
   */
  constructor({
    botToken,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30000,
    longPollTimeoutSec = 25,
    maxRetries = 4,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    jitterRatio = 0.25,
    maxResponseBytes = 1_048_576,
    maxDownloadBytes = 20 * 1024 * 1024,
    sleep = defaultSleep,
    random = Math.random,
  } = {}) {
    if (typeof botToken !== 'string' || botToken.length === 0) {
      throw new TypeError('botToken is required');
    }
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('fetchImpl must be a function');
    }
    this.#botToken = botToken;
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#longPollTimeoutSec = longPollTimeoutSec;
    this.#maxRetries = maxRetries;
    this.#baseDelayMs = baseDelayMs;
    this.#maxDelayMs = maxDelayMs;
    this.#jitterRatio = jitterRatio;
    this.#maxResponseBytes = maxResponseBytes;
    this.#maxDownloadBytes = maxDownloadBytes;
    this.#sleep = sleep;
    this.#random = random;
  }

  #botToken;
  #fetchImpl;
  #timeoutMs;
  #longPollTimeoutSec;
  #maxRetries;
  #baseDelayMs;
  #maxDelayMs;
  #jitterRatio;
  #maxResponseBytes;
  #maxDownloadBytes;
  #sleep;
  #random;
  #closed = false;
  /** @type {Set<AbortController>} */
  #inFlight = new Set();

  /** URL is built here and never exposed, logged or included in errors. */
  #url(method) {
    return `${TELEGRAM_API_ORIGIN}/bot${this.#botToken}/${method}`;
  }

  /**
   * Download URL for a VALIDATED file_path. Built here and never exposed,
   * logged or included in errors, exactly like #url.
   */
  #fileUrl(filePath) {
    return `${TELEGRAM_API_ORIGIN}/file/bot${this.#botToken}/${filePath}`;
  }

  /**
   * Shared per-attempt discipline for every outbound request (JSON POST and
   * file GET alike): closed/aborted pre-check, an internal AbortController
   * bounded per attempt by `timeoutMs`, chained to the external `signal`,
   * tracked in-flight so close() aborts it, and timer/listener cleanup.
   * `consume(controller, timedOut)` performs the fetch AND consumes the
   * response while the attempt is still live (so the per-attempt timeout
   * covers the body read too); its result is returned untouched.
   */
  async #runAttempt(consume, signal, timeoutMs) {
    if (this.#closed || (signal?.aborted ?? false)) {
      throw new TelegramApiError({ code: 'aborted' });
    }
    const controller = new AbortController();
    this.#inFlight.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      return await consume(controller, () => timedOut);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      this.#inFlight.delete(controller);
    }
  }

  /**
   * Map a non-ok response to the fixed credential-free code, honouring the
   * server's retry_after hint. Shared by the JSON and download paths.
   */
  #errorFromResponse(response, data) {
    const status = response.status;
    const errorCode = typeof data?.error_code === 'number' ? data.error_code : status;
    const retryAfterRaw = data?.parameters?.retry_after;
    const retryAfterMs = typeof retryAfterRaw === 'number' && retryAfterRaw >= 0
      ? retryAfterRaw * 1000
      : null;
    return new TelegramApiError({
      code: codeFromStatus(errorCode),
      status,
      retryAfterMs,
    });
  }

  /**
   * One JSON POST attempt: returns Telegram's `result`. Throws
   * TelegramApiError with a fixed code; never includes the URL, token,
   * raw body or underlying cause text.
   */
  async #attempt(method, payload, signal, timeoutMs) {
    return this.#runAttempt(async (controller, timedOut) => {
      let response;
      try {
        // Multipart bodies (FormData) must carry their own content-type
        // with the fetch-chosen boundary: setting a JSON header here would
        // corrupt the upload. The JSON text path below is unchanged.
        const isForm = payload instanceof FormData;
        const init = {
          method: 'POST',
          body: isForm ? payload : JSON.stringify(payload),
          signal: controller.signal,
          // The URL carries the bot token and api.telegram.org never
          // legitimately redirects: refuse to follow a 3xx from an
          // intermediary instead of replaying the request to it.
          redirect: 'error',
        };
        if (!isForm) init.headers = { 'content-type': 'application/json' };
        response = await this.#fetchImpl(this.#url(method), init);
      } catch (error) {
        if (signal?.aborted || this.#closed) throw new TelegramApiError({ code: 'aborted' });
        if (timedOut()) throw new TelegramApiError({ code: 'timeout' });
        throw new TelegramApiError({ code: 'network' });
      }
      const text = await this.#readBounded(response);
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        // Retryable: an intermediary may have returned garbage once.
        throw new TelegramApiError({ code: 'bad_response' });
      }
      if (!response.ok || data?.ok !== true) {
        throw this.#errorFromResponse(response, data);
      }
      return data.result;
    }, signal, timeoutMs);
  }

  /** Read the response body with a hard cap; never buffer unbounded input. */
  async #readBounded(response) {
    const contentLength = Number(response.headers?.get?.('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > this.#maxResponseBytes) {
      // Cancel the body so the connection is not left hanging.
      try { await response.body?.cancel?.(); } catch { /* already gone */ }
      throw new TelegramApiError({ code: 'too_large' });
    }
    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
      const text = await response.text();
      if (text.length > this.#maxResponseBytes) {
        throw new TelegramApiError({ code: 'too_large' });
      }
      return text;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.#maxResponseBytes) {
        try { await reader.cancel(); } catch { /* already cancelled */ }
        throw new TelegramApiError({ code: 'too_large' });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  }

  /**
   * Read the response body as BYTES with a hard cap; audio is not UTF-8 and
   * must never pass through a TextDecoder. Same discipline as #readBounded:
   * a content-length over the cap is rejected before reading, and the
   * stream is cancelled rather than buffered past the cap.
   */
  async #readBoundedBytes(response, maxBytes) {
    const contentLength = Number(response.headers?.get?.('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      // Cancel the body so the connection is not left hanging.
      try { await response.body?.cancel?.(); } catch { /* already gone */ }
      throw new TelegramApiError({ code: 'too_large' });
    }
    const body = response.body;
    if (!body || typeof body.getReader !== 'function') {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        throw new TelegramApiError({ code: 'too_large' });
      }
      return Buffer.from(buffer);
    }
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* already cancelled */ }
        throw new TelegramApiError({ code: 'too_large' });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  /**
   * Request with bounded retries. `signal` aborts everything immediately
   * ('aborted'); retry sleeps honor server retry_after over local backoff.
   */
  async #withRetry(fn, { signal = undefined, retries = true } = {}) {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        const isApiError = error instanceof TelegramApiError;
        const code = isApiError ? error.code : 'network';
        if (
          !isApiError
          || code === 'aborted'
          || !retries
          || !RETRYABLE_CODES.has(code)
          || attempt >= this.#maxRetries
          || signal?.aborted
          || this.#closed
        ) {
          throw error;
        }
        const base = error.retryAfterMs
          ?? Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** attempt);
        const jitter = base * this.#jitterRatio * this.#random();
        await this.#sleep(base + jitter, signal);
        attempt += 1;
      }
    }
  }

  /**
   * JSON POST with bounded retries: the shared #withRetry loop driving the
   * shared per-attempt discipline, unchanged for every existing method.
   */
  async #request(method, payload, { signal = undefined, retries = true } = {}) {
    const timeoutMs = method === 'getUpdates'
      ? Math.max(this.#timeoutMs, (this.#longPollTimeoutSec + 5) * 1000)
      : this.#timeoutMs;
    return this.#withRetry(
      () => this.#attempt(method, payload, signal, timeoutMs),
      { signal, retries },
    );
  }

  /**
   * One file GET attempt: returns the raw bytes of a successful response.
   * A non-ok response still speaks JSON: read the error body bounded,
   * attempt to parse it and map through the same fixed codes as any other
   * call (retry_after honoured), so a 404/429/5xx download behaves like the
   * JSON path. Same per-attempt timeout, abort tracking and redirect
   * refusal as every other request.
   */
  async #downloadAttempt(url, signal, timeoutMs, maxBytes) {
    return this.#runAttempt(async (controller, timedOut) => {
      let response;
      try {
        response = await this.#fetchImpl(url, {
          method: 'GET',
          signal: controller.signal,
          // The URL carries the bot token and the fixed origin never
          // legitimately redirects: same refusal as the JSON path.
          redirect: 'error',
        });
      } catch (error) {
        if (signal?.aborted || this.#closed) throw new TelegramApiError({ code: 'aborted' });
        if (timedOut()) throw new TelegramApiError({ code: 'timeout' });
        throw new TelegramApiError({ code: 'network' });
      }
      if (!response.ok) {
        const text = await this.#readBounded(response);
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {
          // Not JSON: the status-only mapping below still applies.
        }
        throw this.#errorFromResponse(response, data);
      }
      return this.#readBoundedBytes(response, maxBytes);
    }, signal, timeoutMs);
  }

  /**
   * Telegram's `file_path` is UNTRUSTED input: validate it here so no
   * caller can skip the check. Fail closed with the fixed 'bad_file_path'
   * code; the rejected value itself is never echoed back.
   */
  #validateFilePath(filePath) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new TelegramApiError({ code: 'bad_file_path' });
    }
    // Control characters (including NUL, newline, carriage return).
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(filePath)) {
      throw new TelegramApiError({ code: 'bad_file_path' });
    }
    if (
      filePath.includes('\\')
      || filePath.startsWith('/')
      || filePath.startsWith('//')
      || filePath.includes('?')
      || filePath.includes('#')
      || filePath.includes(':')
    ) {
      throw new TelegramApiError({ code: 'bad_file_path' });
    }
    // '..' as a whole path segment only; a filename like 'a..b' is fine.
    if (filePath.split('/').some((segment) => segment === '..')) {
      throw new TelegramApiError({ code: 'bad_file_path' });
    }
    // Final alphabet check: anything outside Telegram's own file_path
    // shape is rejected outright.
    if (!/^[A-Za-z0-9._/-]+$/.test(filePath)) {
      throw new TelegramApiError({ code: 'bad_file_path' });
    }
    return filePath;
  }

  /**
   * Resolve an inbound file id to its (untrusted) download metadata.
   * A normal JSON POST through the existing path; the caller validates the
   * returned file_path via downloadFile.
   */
  getFile({ fileId, signal } = {}) {
    return this.#request('getFile', { file_id: fileId }, { signal });
  }

  /**
   * Download one file by its `file_path` (from getFile) and return the raw
   * bytes. The path is untrusted and validated HERE, so no caller can skip
   * the check; as defence in depth the final URL is asserted to still start
   * with the exact expected fixed-origin prefix before the request is
   * issued. The token stays encapsulated: never returned, never in an
   * error, never in a thrown message. Bounded by maxDownloadBytes.
   */
  async downloadFile({ filePath, signal } = {}) {
    const safePath = this.#validateFilePath(filePath);
    const url = this.#fileUrl(safePath);
    const prefix = `${TELEGRAM_API_ORIGIN}/file/bot${this.#botToken}/`;
    if (!url.startsWith(prefix)) {
      // Unreachable while validation holds: fail closed rather than ever
      // issuing a request outside the fixed origin.
      throw new TelegramApiError({ code: 'bad_file_path' });
    }
    return this.#withRetry(
      () => this.#downloadAttempt(url, signal, this.#timeoutMs, this.#maxDownloadBytes),
      { signal },
    );
  }

  /** Long poll. `offset` is the next update_id to fetch; the caller only
   * advances the durable offset after the update is handled atomically.
   */
  getUpdates({ offset, signal } = {}) {
    return this.#request('getUpdates', {
      offset,
      timeout: this.#longPollTimeoutSec,
      allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    }, { signal });
  }

  /** Plain text message (no parse_mode, ever) with optional inline keyboard. */
  sendMessage({ chatId, text, replyMarkup = null, signal } = {}) {
    const payload = { chat_id: chatId, text };
    if (replyMarkup !== null && replyMarkup !== undefined) {
      payload.reply_markup = replyMarkup;
    }
    return this.#request('sendMessage', payload, { signal });
  }

  /**
   * Multipart body for one photo, shared by sendPhoto and the offline
   * --dry-run builder in scripts/send-photo.mjs so the dry-run bytes are
   * EXACTLY the bytes a real send would produce.
   */
  static buildPhotoForm({ chatId, bytes, filename, caption = null }) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption !== null && caption !== undefined) {
      // Plain text only: this project never sets parse_mode, so Telegram
      // renders the caption exactly as sent. No parse_mode field is ever
      // appended here.
      form.append('caption', caption);
    }
    form.append('photo', new Blob([bytes]), filename);
    return form;
  }

  /**
   * One outbound photo as multipart/form-data: Telegram only accepts raw
   * bytes for a local file upload, so the JSON body path never applies
   * here. It reuses the exact same attempt discipline as every other
   * method: per-attempt timeout, abort awareness, redirect refusal,
   * bounded response read and the fixed credential-free codes.
   *
   * Validate the file with src/media-policy.mjs first; a failed local
   * read propagates as a plain fs error and is the caller's to map.
   * The caption, when given, is plain text: parse_mode is never set.
   */
  async sendPhoto({ chatId, filePath, caption = null, signal } = {}) {
    const bytes = await readFile(filePath);
    const form = TelegramApi.buildPhotoForm({ chatId, bytes, filename: basename(filePath), caption });
    return this.#request('sendPhoto', form, { signal });
  }

  /** Callback feedback; Telegram caps the text at 200 characters. */
  async answerCallbackQuery({ callbackQueryId, text = '', signal } = {}) {
    if (typeof text === 'string' && text.length > 200) {
      throw new RangeError('answerCallbackQuery text must be at most 200 chars');
    }
    return this.#request('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
    }, { signal });
  }

  /** Used once at startup: a non-empty webhook url means stop (no delete). */
  getWebhookInfo({ signal } = {}) {
    return this.#request('getWebhookInfo', {}, { signal });
  }

  /** Startup sanity check that the token is accepted. */
  getMe({ signal } = {}) {
    return this.#request('getMe', {}, { signal });
  }

  /** Abort every in-flight request; later calls fail with 'aborted'. */
  async close() {
    this.#closed = true;
    for (const controller of [...this.#inFlight]) controller.abort();
    this.#inFlight.clear();
  }
}
