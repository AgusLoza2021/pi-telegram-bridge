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
   * One request attempt: timeout-bounded, abort-aware, response-bounded.
   * Throws TelegramApiError with a fixed code; never includes the URL,
   * token, raw body or underlying cause text.
   */
  async #attempt(method, payload, signal, timeoutMs) {
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
      let response;
      try {
        response = await this.#fetchImpl(this.#url(method), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
          // The URL carries the bot token and api.telegram.org never
          // legitimately redirects: refuse to follow a 3xx from an
          // intermediary instead of replaying the request to it.
          redirect: 'error',
        });
      } catch (error) {
        if (signal?.aborted || this.#closed) throw new TelegramApiError({ code: 'aborted' });
        if (timedOut) throw new TelegramApiError({ code: 'timeout' });
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
        const status = response.status;
        const errorCode = typeof data?.error_code === 'number' ? data.error_code : status;
        const retryAfterRaw = data?.parameters?.retry_after;
        const retryAfterMs = typeof retryAfterRaw === 'number' && retryAfterRaw >= 0
          ? retryAfterRaw * 1000
          : null;
        throw new TelegramApiError({
          code: codeFromStatus(errorCode),
          status,
          retryAfterMs,
        });
      }
      return data.result;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      this.#inFlight.delete(controller);
    }
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
   * Request with bounded retries. `signal` aborts everything immediately
   * ('aborted'); retry sleeps honor server retry_after over local backoff.
   */
  async #request(method, payload, { signal = undefined, retries = true } = {}) {
    const timeoutMs = method === 'getUpdates'
      ? Math.max(this.#timeoutMs, (this.#longPollTimeoutSec + 5) * 1000)
      : this.#timeoutMs;
    let attempt = 0;
    for (;;) {
      try {
        return await this.#attempt(method, payload, signal, timeoutMs);
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
   * Long poll. `offset` is the next update_id to fetch; the caller only
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
