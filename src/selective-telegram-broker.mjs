// Selective Telegram broker for the tracked live-TUI transport (T03).
//
// This is the ONLY side that talks to Telegram in the selective flow. It
// runs in its own broker process (see runtime-broker.mjs), never spawns or
// owns Pi, and reaches opted-in interactive TUIs exclusively through the
// durable tui_sessions/tui_commands/tui_events transport in the store.
//
// Security and routing invariants:
// - Outbound Telegram long polling only; no webhook, no listener.
// - Every update is authorized by the EXACT configured numeric user id AND
//   chat id via the shared security primitives; unknown/unauthorized or
//   malformed update shapes are consumed silently (receipt + offset only),
//   never answered.
// - Update receipt, command enqueues and the offset advance commit in ONE
//   store transaction per update, deduplicated through the inbox table, so
//   a re-delivered update can never enqueue duplicate TUI commands.
// - Short ids resolve EXACTLY against LIVE sessions (30s heartbeat cutoff).
//   Explicit-id misses fail closed with fixed guidance. Selection is
//   memory-only and self-clears when the selection goes stale.
// - Beginner auto-selection is NARROW: when the memory-only selection is
//   absent or stale and EXACTLY ONE live session exists, that session is
//   targeted directly ONLY for ordinary plain text and /status — no
//   /sessions, /use or /send required. Advanced routed commands (/send,
//   /steer, /followup, /abort, /disconnect) sent without an explicit id
//   keep their previous fail-closed selection-required response and enqueue
//   nothing, even when one live session exists; explicit short ids remain
//   unchanged. With zero live sessions the broker fails closed with
//   beginner guidance (open Pi and type /tg); with several live sessions
//   and no selection it fails closed with a choice notice and NEVER
//   guesses or exposes short ids.
// - Inline keyboards exist ONLY for the bounded cards: the
//   Projects dashboard (v1:r, v1:s:<sid>, v1:p:<sid>:<pid>, v1:c),
//   the busy decision card (v1:f/t/a:<sid>:<pid>, v1:n:<pid>), the action
//   keyboards (v1:q/x/d/D:<sid>, v1:C) and the remote choice card
//   (v1:w:<requestId>:<index>, v1:W:<requestId> — rendered and registered by
//   T2B1 and consumed by T2B2 exactly once: an authorized tap on a live,
//   unexpired request whose captured connection still owns the session
//   enqueues exactly one bounded choice_response with the deterministic
//   command id choice_<requestId> and a fixed accepted/cancelled toast;
//   every unknown, expired, replayed, malformed, out-of-range-index or
//   replaced-connection tap chooses nothing and gets the fixed out-of-date
//   toast, and the pending row is dropped only AFTER the transaction
//   commits). Data never carries labels,
//   prompt text, cwd, tokens or secrets; short ids and opaque request ids
//   stay inside callback_data, never in beginner-visible card text. Authorized
//   callbacks get a best-effort answerCallbackQuery queued only AFTER the
//   transaction and offset commit (and only when the API implements it);
//   a failed answer never replays a command. Unauthorized or malformed
//   callbacks are dropped without replies.
// - Remote choice requests (T2B1) render ONLY when the already-Store-validated
//   payload is still structurally safe, unexpired, free of credential shapes,
//   and its tracking id resolves to exactly one currently live session with a
//   valid current connection id. Every refusal logs one fixed code, echoes
//   nothing, sends nothing and acknowledges the event so it never blocks the
//   queue. A bounded memory-only registry (max 32 live entries, keyed by the
//   opaque 16-hex request id) tracks definitively SENT pending requests as
//   {trackingId, connectionId, optionCount, expiresAt} — registration happens
//   only after #sendChunks returns 'sent' and before the acknowledgement, and
//   a restart empties it (fail closed). Plain text never answers a pending
//   choice; it gets a fixed guard reply and enqueues nothing.
// - Text payloads are bounded and any line whose first non-whitespace
//   character is '/' is rejected: remote input can never ride into local
//   extension commands, skills or prompt templates. '!', CMD and PowerShell
//   strings get no interpretation here — every accepted text is forwarded
//   verbatim as a typed prompt/steer/follow-up for the Pi extension.
// - Drained TUI events render ONLY: connected/disconnected notices,
//   requested factual status, finalized assistant output, fixed
//   command-result acknowledgements and bounded remote choice cards (T2B1). Never thinking/reasoning, tool
//   args/results, session files, credentials or raw exception text. Every
//   beginner-visible message names the session as `Pi · <label>` (T04:
//   copy comes from beginner-copy.mjs; the old [label · shortId] prefix is
//   gone from the normal event path) and is chunked through the shared
//   UTF-16-safe chunking helper.
// - A TUI event is acknowledged only after ALL of its chunks were sent.
//   Uncertain deliveries stay unacknowledged and are retried whole (a
//   duplicate notice is acceptable; lost output is not), and a delivery
//   failure is never converted into another command.
// - No credentials, tokens, URLs or raw payloads are ever logged: logging
//   is bounded, code-only.

import { randomBytes } from 'node:crypto';

import { TUI_PROJECT_RETENTION_MS } from './store.mjs';
import { TelegramApiError } from './telegram-api.mjs';
import { authorize, chunkMessage, createRateLimiter } from './security.mjs';
import { createTranscriber } from './audio-transcription.mjs';
import * as copy from './beginner-copy.mjs';

const MAX_TEXT_CHARS = 4000;
const MAX_LABEL_CHARS = 64;
const DEFAULT_STALE_AFTER_MS = 30000;
const MAX_LISTED_SESSIONS = 32;
const MAX_EVENTS_PER_DRAIN = 32;
const MAX_PENDING_REPLIES = 64;

const SHORT_ID_RE = /^[a-z0-9]{3,32}$/;

// T03a session-chooser callback grammar: strict shapes only, so anything
// else is a malformed callback that must never dispatch.
const CALLBACK_REFRESH_RE = /^v1:r$/;
const CALLBACK_SELECT_RE = /^v1:s:([a-z0-9]{3,32})$/;
const CALLBACK_PROMPT_RE = /^v1:p:([a-z0-9]{3,32}):([0-9a-f]{16})$/;
// Telegram Bot API 10.3: disabled is the button ACTION field `disabled: {}`,
// never a style value — section headers and recent rows carry no callback
// data at all, so they cannot be tapped or routed.
// T03b busy-decision callbacks: the held prompt generation decides, the
// short id only names the target session.
const CALLBACK_FOLLOWUP_RE = /^v1:f:([a-z0-9]{3,32}):([0-9a-f]{16})$/;
const CALLBACK_STEER_RE = /^v1:t:([a-z0-9]{3,32}):([0-9a-f]{16})$/;
const CALLBACK_ABORT_PROMPT_RE = /^v1:a:([a-z0-9]{3,32}):([0-9a-f]{16})$/;
const CALLBACK_DISCARD_RE = /^v1:n:([0-9a-f]{16})$/;
// T03b per-session action callbacks.
const CALLBACK_STATUS_RE = /^v1:q:([a-z0-9]{3,32})$/;
const CALLBACK_STOP_RE = /^v1:x:([a-z0-9]{3,32})$/;
const CALLBACK_DISCONNECT_ASK_RE = /^v1:d:([a-z0-9]{3,32})$/;
const CALLBACK_DISCONNECT_CONFIRM_RE = /^v1:D:([a-z0-9]{3,32})$/;
const CALLBACK_CHOOSER_RE = /^v1:c$/;
const CALLBACK_CANCEL_RE = /^v1:C$/;
// T2B2 remote ordinary choice callbacks: strictly bounded, opaque. The
// request id is exactly 16 lowercase hex chars and the option index is one
// digit 0..3; the index is additionally re-validated against the request's
// own option count in the consumer, and anything else stays malformed.
const CALLBACK_MAX_DATA_BYTES = 64;
const CALLBACK_CHOICE_OPTION_RE = /^v1:w:([0-9a-f]{16}):([0-3])$/;
const CALLBACK_CHOICE_CANCEL_RE = /^v1:W:([0-9a-f]{16})$/;
const REFRESH_BUTTON_TEXT = 'Refresh';

// T2B1 remote ordinary choice cards: a bounded memory-only pending registry
// and render guards. The v1:w / v1:W callback grammar rendered here is
// consumed exactly once by the T2B2 parser branch and consumer below.
const MAX_PENDING_CHOICES = 32;
const CHOICE_REQUEST_ID_RE = /^[0-9a-f]{16}$/;
const MIN_CHOICE_OPTIONS = 2;
const MAX_CHOICE_OPTIONS = 4;
// T03b busy-decision button labels: readable outcomes only; short ids stay
// inside callback_data and the held prompt text is never echoed back. All
// other beginner-visible copy (notices, acks, event cards, /start, /help)
// comes from the centralized beginner-copy module (T04).
const BUSY_BUTTON_FOLLOWUP = 'Add my message for after this task';
const BUSY_BUTTON_STEER = 'Redirect the current task';
const BUSY_BUTTON_ABORT_PROMPT = 'Stop the task and use my message';
const BUSY_BUTTON_DISCARD = 'Leave it alone';

// Advanced-layer notices below keep their technical wording on purpose:
// they only reach users who opted into slash commands. Short ids stay
// visible here by design (BEGINNER_UX.md section 11).
const NO_LIVE_SESSIONS_ADVANCED_NOTICE =
  'No Pi session is connected. Open Pi on your computer and type /tg, then try again.\n'
  + '(Advanced: /telegram-connect in an interactive Pi TUI, then /sessions.)';

/** Fresh pending-prompt generation id: 16 lowercase hex chars. */
function freshPendingId() {
  return randomBytes(8).toString('hex');
}

/**
 * Strict T03a/T03b/T2B2 callback grammar. Anything else — unknown version,
 * unknown action, bad shape — is null. Data carries only the version, the
 * action, the opaque session short id, the pending generation id and (for
 * choice callbacks) the opaque request id plus the bounded option index:
 * never labels, prompt text, cwd or secrets.
 */
function parseCallbackData(data) {
  if (CALLBACK_REFRESH_RE.test(data)) return { action: 'refresh' };
  if (CALLBACK_CHOOSER_RE.test(data)) return { action: 'chooser' };
  if (CALLBACK_CANCEL_RE.test(data)) return { action: 'cancel' };
  const select = CALLBACK_SELECT_RE.exec(data);
  if (select !== null) return { action: 'select', shortId: select[1] };
  const prompt = CALLBACK_PROMPT_RE.exec(data);
  if (prompt !== null) return { action: 'prompt', shortId: prompt[1], pendingId: prompt[2] };
  const followup = CALLBACK_FOLLOWUP_RE.exec(data);
  if (followup !== null) return { action: 'followup', shortId: followup[1], pendingId: followup[2] };
  const steer = CALLBACK_STEER_RE.exec(data);
  if (steer !== null) return { action: 'steer', shortId: steer[1], pendingId: steer[2] };
  const abortPrompt = CALLBACK_ABORT_PROMPT_RE.exec(data);
  if (abortPrompt !== null) {
    return { action: 'abort_prompt', shortId: abortPrompt[1], pendingId: abortPrompt[2] };
  }
  const discard = CALLBACK_DISCARD_RE.exec(data);
  if (discard !== null) return { action: 'discard', pendingId: discard[1] };
  const status = CALLBACK_STATUS_RE.exec(data);
  if (status !== null) return { action: 'status_cb', shortId: status[1] };
  const stop = CALLBACK_STOP_RE.exec(data);
  if (stop !== null) return { action: 'stop', shortId: stop[1] };
  const disconnectAsk = CALLBACK_DISCONNECT_ASK_RE.exec(data);
  if (disconnectAsk !== null) return { action: 'disconnect_ask', shortId: disconnectAsk[1] };
  const disconnectConfirm = CALLBACK_DISCONNECT_CONFIRM_RE.exec(data);
  if (disconnectConfirm !== null) {
    return { action: 'disconnect_confirm', shortId: disconnectConfirm[1] };
  }
  const choiceOption = CALLBACK_CHOICE_OPTION_RE.exec(data);
  if (choiceOption !== null) {
    return { action: 'choice_option', requestId: choiceOption[1], index: Number(choiceOption[2]) };
  }
  const choiceCancel = CALLBACK_CHOICE_CANCEL_RE.exec(data);
  if (choiceCancel !== null) return { action: 'choice_cancel', requestId: choiceCancel[1] };
  return null;
}

// Same uncertainty family the legacy worker treats as "may have arrived":
// the message may or may not exist on Telegram's side.
const OUTBOUND_UNCERTAIN = new Set(['network', 'timeout', 'server', 'rate_limited', 'bad_response']);

const USAGE = {
  use: 'Usage: /use <shortId> — see /sessions.',
  alias: 'Usage: /alias <name> — rename the selected Pi. /alias clear — reset it. '
    + '/alias <shortId> <name|clear> — rename a specific window.',
  status: 'Usage: /status [shortId]',
  prompt: 'Usage: /send [shortId] <text>',
  steer: 'Usage: /steer [shortId] <text>',
  followup: 'Usage: /followup [shortId] <text>',
  abort: 'Usage: /abort [shortId]',
  disconnect: 'Usage: /disconnect [shortId]',
};

const ACK_TEXT = {
  status: 'Status requested.',
  prompt: 'Prompt queued.',
  steer: 'Steer queued.',
  followup: 'Follow-up queued.',
  abort: 'Abort queued.',
  disconnect: 'Disconnect requested.',
};

const MULTIPLE_LIVE_SESSIONS_NOTICE =
  'More than one Pi session is connected. Tell me which one to use before I can deliver anything.\n'
  + '(Advanced: /sessions to list them, /use <shortId> to choose.)';

const NO_SELECTION_NOTICE =
  'No session selected (or the selection went stale). Send /use <shortId> — see /sessions.';

const SLASH_LINE_NOTICE = 'Refused: lines starting with "/" are not allowed in the text.';

// Fixed, content-free audio failure reply: no error codes, no paths, no
// stderr and no transcript echo — a transcription failure must never leak
// what went wrong (T4). One short sentence, same tone as the other replies.
const AUDIO_FAILURE_NOTICE = "I couldn't transcribe that audio. Type it as a message instead.";

const MISSING_TARGET_NOTICE = (shortId) =>
  `No live session with short id "${shortId}". Send /sessions to list live TUIs.`;

const AMBIGUOUS_TARGET_NOTICE = (shortId) =>
  `Short id "${shortId}" is ambiguous. Send /sessions and use /use <shortId>.`;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function clip(text, maxChars) {
  return typeof text === 'string' ? (text.length > maxChars ? text.slice(0, maxChars) : text) : '';
}

function boundedLabel(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return 'pi';
  return text.length > MAX_LABEL_CHARS ? text.slice(0, MAX_LABEL_CHARS) : text;
}

/** Any line whose first non-whitespace character is '/' is rejected. */
function hasSlashInitialLine(text) {
  return text.split('\n').some((line) => /^\s*\//.test(line));
}

/** Trim + whitespace collapse: the ONLY normalization an alias input gets. */
function normalizeAliasInput(raw) {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Alias input character policy (Unicode-aware):
 * - ALL category Cc is rejected: C0 controls, DEL and the C1 controls
 *   (including U+0085 NEL).
 * - Category Cf is rejected EXCEPT the two permitted joiners and the
 *   Unicode tag characters: this refuses every spoofing/invisible format
 *   character (U+00AD, U+061C, U+180E, U+200B, U+200E/U+200F,
 *   U+202A-U+202E, U+2060-U+206F, U+FEFF and any other Cf) while normal
 *   emoji keep working.
 * - Permitted Cf: U+200C ZWNJ and U+200D ZWJ (legitimate scripts and
 *   emoji sequences) and U+E0000-U+E007F (tag characters used by valid
 *   emoji flag/subdivision sequences).
 */
const ALIAS_CONTROL_RE = /\p{Cc}/u;
const ALIAS_FORMAT_RE = /\p{Cf}/u;
const ALIAS_PERMITTED_JOINER_RE = /[\u200C\u200D]/u;
const ALIAS_PERMITTED_TAG_RE = /[\u{E0000}-\u{E007F}]/u;
/** Everything with no visual weight: whitespace and combining marks. */
const ALIAS_INVISIBLE_RE = /[\s\p{M}\u200C\u200D\u{E0000}-\u{E007F}]/gu;

/**
 * A visible alias must keep at least one base character once whitespace,
 * combining marks, permitted joiners and permitted tag characters are
 * ignored.
 */
function hasVisibleBase(text) {
  return text.replace(ALIAS_INVISIBLE_RE, '').length > 0;
}

/**
 * An alias survives only as bounded visible text: 1..64 UTF-16 chars,
 * no leading '/', no control characters (Cc) and no format characters
 * (Cf) beyond the permitted joiners and emoji tag characters. Normal
 * emoji, letters and combining marks are never rejected, and an alias
 * that is invisible-only (joiners, tags, combining marks, whitespace)
 * is refused. Everything else is refused before the store is ever called.
 */
function isValidAlias(text) {
  if (text.length === 0 || text.length > 64 || text.startsWith('/')) return false;
  if (ALIAS_CONTROL_RE.test(text)) return false;
  if (ALIAS_FORMAT_RE.test(text)) {
    for (const ch of text) {
      if (!ALIAS_FORMAT_RE.test(ch)) continue;
      if (ALIAS_PERMITTED_JOINER_RE.test(ch) || ALIAS_PERMITTED_TAG_RE.test(ch)) continue;
      return false;
    }
  }
  return hasVisibleBase(text);
}

export class SelectiveTelegramBroker {
  /**
   * @param {object} options
   * @param {import('./store.mjs').Store} options.store durable transport
   * @param {object} options.api transport client (duck-typed: getUpdates,
   *   sendMessage, getWebhookInfo, getMe, close; answerCallbackQuery is
   *   optional and used only when present)
   * @param {object} options.config { telegram: { allowedUserId, allowedChatId },
   *   bridge: { maxMessageChars, rateLimit } }
   * @param {string} [options.ownerId] logging identity only (no lease: the
   *   broker process is the single owner of its memory-only selection)
   * @param {() => number} [options.now]
   * @param {({code: string}) => void} [options.logger] fixed-code logging
   * @param {{transcribe: (input: {bytes: Uint8Array}) => Promise<{text: string}>}}
   *   [options.transcriber] injected transcription seam (T4). When absent
   *   AND config.transcription?.enabled is true, the real local
   *   transcriber is constructed from the config; when transcription is
   *   disabled no transcriber exists and voice updates behave exactly as
   *   before (silently dropped by the text-only plan).
   */
  constructor({
    store,
    api,
    config,
    ownerId = 'telegram-broker',
    now = Date.now,
    logger = () => {},
    transcriber = undefined,
  }) {
    if (!store || typeof store.withTransaction !== 'function') {
      throw new TypeError('store is required');
    }
    if (typeof store.getBrokerTransportOffset !== 'function'
      || typeof store.advanceBrokerTransportOffset !== 'function'
      || typeof store.recordInbox !== 'function'
      || typeof store.listTuiSessions !== 'function'
      || typeof store.listRecentTuiProjects !== 'function'
      || typeof store.enqueueTuiCommand !== 'function'
      || typeof store.listPendingBrokerTuiEvents !== 'function'
      || typeof store.acknowledgeTuiEvents !== 'function'
      || typeof store.getSelectedTuiTarget !== 'function'
      || typeof store.setSelectedTuiTarget !== 'function'
      || typeof store.clearSelectedTuiTarget !== 'function'
      || typeof store.setTuiSessionAlias !== 'function') {
      throw new TypeError('store is missing the broker transport methods');
    }
    if (!api || typeof api !== 'object') {
      throw new TypeError('api is required');
    }
    if (!isPlainObject(config?.telegram) || !isPlainObject(config?.bridge)) {
      throw new TypeError('config must contain telegram and bridge objects');
    }
    const maxMessageChars = config.bridge.maxMessageChars;
    if (!Number.isInteger(maxMessageChars) || maxMessageChars < 2 || maxMessageChars > 3800) {
      throw new RangeError('bridge.maxMessageChars must be an integer between 2 and 3800');
    }
    this.#store = store;
    this.#api = api;
    this.#config = config;
    this.#ownerId = ownerId;
    this.#maxMessageChars = maxMessageChars;
    this.#now = now;
    this.#logger = typeof logger === 'function' ? logger : () => {};
    this.#limiter = createRateLimiter(config.bridge.rateLimit);
    if (transcriber !== undefined
      && (transcriber === null || typeof transcriber.transcribe !== 'function')) {
      throw new TypeError('transcriber must provide a transcribe() function');
    }
    this.#transcriber = transcriber !== undefined
      ? transcriber
      : (config.transcription?.enabled === true ? createTranscriber(config.transcription) : null);
  }

  #store;
  #api;
  #config;
  #ownerId;
  #maxMessageChars;
  #now;
  #logger;
  #limiter;
  /** Local transcriber (T4); null whenever transcription is disabled. */
  #transcriber;
  /**
   * Memory-only outbound throttle state: while non-zero, the current
   * throttle episode already logged its record and retries wait until this
   * timestamp instead of re-attempting (and re-logging) the limiter.
   */
  #outboundRetryNotBefore = 0;
  /** Memory-only selected tracking id; mirrored into the durable store
   * through #selectTarget/#clearSelection only — never written directly. */
  #selectedTrackingId = null;
  /**
   * trackingId -> { label, alias, branch, projectKey, shortId }; identity
   * for headers and drained events (T4B2). The alias is the per-session
   * alias only; the project alias is resolved separately through
   * #projectAliasFor so it can act as a CURRENT project-level fallback.
   */
  #identityCache = new Map();
  /** projectKey -> project alias (or null for a known alias-less project);
   * a bounded read fallback fed from listRecentTuiProjects (T4B2). */
  #projectAliasCache = new Map();
  /** Bounded in-memory replies ({text, replyMarkup}) waiting to be flushed. */
  #pendingReplies = [];
  /** Broker-memory pending prompt {pendingId, text}; a restart loses it fail-closed. */
  #pendingPrompt = null;
  /**
   * T2B1 memory-only pending remote choices, keyed by the opaque 16-hex
   * requestId. Values are exactly {trackingId, connectionId, optionCount,
   * expiresAt} — never labels, descriptions, values or option text. Bounded
   * to 32 live entries; expired entries (expiresAt <= now) are pruned before
   * every lookup and registration. A broker restart naturally empties it,
   * so stale callbacks can never choose anything (fail closed).
   */
  #pendingChoices = new Map();
  /**
   * Bounded callback answers waiting for a best-effort answerCallbackQuery:
   * objects of the shape { callbackQueryId, text } where text is the
   * optional toast (empty for every normal callback).
   */
  #pendingAnswers = [];

  // --- lifecycle -----------------------------------------------------------

  /**
   * Verify the transport. Refuses to poll while a webhook is configured
   * (getUpdates would 409); deleting the webhook is a human decision,
   * never automatic.
   */
  async start() {
    const info = await this.#api.getWebhookInfo();
    if (isPlainObject(info) && typeof info.url === 'string' && info.url.length > 0) {
      const error = new Error('broker start refused: a webhook is configured');
      error.code = 'WEBHOOK_PRESENT';
      this.#log('webhook_present');
      throw error;
    }
    const me = await this.#api.getMe();
    if (!isPlainObject(me) || !Number.isSafeInteger(me.id)) {
      const error = new Error('getMe sanity check failed');
      error.code = 'GET_ME_FAILED';
      throw error;
    }
    this.#adoptDurableSelection();
    this.#log('broker_started');
  }

  /**
   * Durable selected-destination adoption at broker start (T4A): after the
   * transport sanity checks, adopt the store's durable selection ONLY when
   * EXACTLY ONE current broker-live session matches BOTH its trackingId
   * and projectKey. Anything else — a stale/offline row, a missing row, a
   * project mismatch, a malformed persisted target or an ambiguous match —
   * is cleared (durable + memory) and never routed. Adoption is memory
   * rehydration only: it never enqueues commands and never sends Telegram.
   */
  #adoptDurableSelection() {
    let target = null;
    try {
      target = this.#store.getSelectedTuiTarget();
    } catch {
      target = null;
    }
    if (target === null) return; // nothing durable to adopt
    if (!isPlainObject(target)
      || typeof target.trackingId !== 'string'
      || typeof target.projectKey !== 'string') {
      this.#clearSelection();
      return;
    }
    const matches = this.#liveSessions().filter((session) =>
      session.trackingId === target.trackingId
      && session.projectKey === target.projectKey);
    if (matches.length === 1) {
      this.#selectedTrackingId = matches[0].trackingId;
      return;
    }
    this.#clearSelection();
  }

  /**
   * The single selection mutation helper (T4A/T4E): memory and durable
   * store move together or not at all. A session is selected only when it
   * carries a valid trackingId and the store ACCEPTS the write (row
   * identity + project match, or T4E authoritative repair). A legacy
   * keyless live snapshot passes projectKey: null; the store derives the
   * canonical identity from the row's own stored cwd, repairs the row and
   * its history, and returns the canonical projectKey, which this helper
   * consumes in its result. Any refusal or throw fails closed: the memory
   * selection is dropped and the durable selection is cleared best-effort,
   * so a store-refused selection can never route. The boolean truthiness
   * is preserved for legacy callers; the full result also reports whether
   * the selected tracking id CHANGED (T4E slice B same-target taps).
   * Called inside the handleUpdate receipt/offset transaction, the
   * re-entrant store calls join that SAME transaction.
   */
  #selectTarget(session) {
    const trackingId = isPlainObject(session)
      && typeof session.trackingId === 'string' && session.trackingId.length > 0
      ? session.trackingId
      : null;
    // null (not a rejection) when the live snapshot is legacy-keyless:
    // the store repairs the row and returns the canonical key (T4E).
    const projectKey = isPlainObject(session)
      && typeof session.projectKey === 'string' && session.projectKey.length > 0
      ? session.projectKey
      : null;
    if (trackingId !== null) {
      const previous = this.#selectedTrackingId;
      try {
        const result = this.#store.setSelectedTuiTarget({ trackingId, projectKey });
        if (isPlainObject(result) && result.ok === true
          && typeof result.projectKey === 'string' && result.projectKey.length > 0) {
          this.#selectedTrackingId = trackingId;
          return {
            ok: true,
            projectKey: result.projectKey,
            changed: previous !== trackingId,
          };
        }
      } catch {
        // Fall through to the fail-closed path below.
      }
    }
    this.#log('selection_persist_failed');
    this.#clearSelection();
    return false;
  }

  /**
   * The single selection clear helper (T4A): drops the memory selection
   * AND the durable selection, idempotently. A durable clear failure never
   * wedges the caller: it is logged and the memory selection is dropped
   * regardless (fail closed).
   */
  #clearSelection() {
    this.#selectedTrackingId = null;
    try {
      this.#store.clearSelectedTuiTarget();
    } catch {
      this.#log('selection_clear_failed');
    }
  }

  /**
   * Poll loop: poll updates, flush queued ack replies, drain TUI events.
   * Stops on authorization failures, conflicts and aborts; transient poll
   * errors are logged and retried next cycle.
   */
  async run({ signal = undefined, pollGapMs = 300, cycles = Infinity } = {}) {
    await this.start();
    for (let i = 0; i < cycles && !signal?.aborted; i++) {
      const result = await this.pollOnce(signal);
      if (result.stopped) {
        this.#log(result.stopped);
        return result;
      }
      await this.flushReplies();
      await this.drainTuiEvents();
      if (!signal?.aborted && i + 1 < cycles) {
        await new Promise((resolve) => setTimeout(resolve, pollGapMs));
      }
    }
    return { stopped: signal?.aborted ? 'aborted' : null };
  }

  /** Map a getUpdates failure to a stop reason or a retryable poll error. */
  async #mapPollError(error) {
    const code = error instanceof TelegramApiError ? error.code : 'unknown';
    if (code === 'aborted') return { stopped: 'aborted' };
    if (code === 'unauthorized' || code === 'forbidden') {
      return { stopped: code };
    }
    if (code === 'conflict') {
      // 409: either a webhook is set or another poller runs. Distinguish
      // without ever deleting the webhook automatically.
      let webhook = false;
      try {
        const info = await this.#api.getWebhookInfo();
        webhook = isPlainObject(info) && typeof info.url === 'string' && info.url.length > 0;
      } catch {
        webhook = false;
      }
      return { stopped: webhook ? 'webhook_present' : 'poller_conflict' };
    }
    this.#log('poll_error');
    return { processed: 0 };
  }

  /** One poll + all pending update handling. Exposed for tests and the CLI. */
  async pollOnce(signal = undefined) {
    let updates;
    try {
      updates = await this.#api.getUpdates({
        offset: this.#store.getBrokerTransportOffset(),
        signal,
      });
    } catch (error) {
      return await this.#mapPollError(error);
    }
    if (!Array.isArray(updates)) {
      this.#log('poll_error');
      return { processed: 0 };
    }
    let processed = 0;
    for (const update of updates) {
      try {
        // T4: any voice/audio transcription resolves HERE, before the
        // transaction opens, so handleUpdate and #planMessage stay fully
        // synchronous and the receipt/offset atomicity is never split.
        const resolvedAudio = await this.#resolveAudio(update);
        this.handleUpdate(update, resolvedAudio);
        processed++;
      } catch {
        // A throwing bug must never wedge the offset or the loop.
        this.#log('update_error');
      }
    }
    return { processed };
  }

  /** Close the transport. Memory-only state dies with the process. */
  async dispose() {
    try {
      await this.#api.close();
    } catch {
      this.#log('close_error');
    }
    this.#log('broker_stopped');
  }

  // --- update handling (atomic unit) ----------------------------------------

  /**
   * One atomic unit per update: inbox receipt -> planning -> command
   * enqueues -> offset advance. Re-delivered updates hit the inbox dedup
   * and commit nothing else, so duplicates never enqueue commands.
   * @param {object} update
   * @param {{state: 'ok', text: string}
   *   |{state: 'failed'}
   *   |{state: 'rate_limited'}} [resolvedAudio] the ALREADY SETTLED
   *   transcription outcome for a voice/audio message, resolved in
   *   pollOnce before this transaction opened (T4); undefined for every
   *   other update and whenever transcription is disabled.
   */
  handleUpdate(update, resolvedAudio = undefined) {
    // Keep the identity and project-alias caches CURRENT before planning:
    // a rename (session alias set/cleared, project alias set/cleared)
    // between cycles must be visible on the very next reply (T4B2).
    this.#refreshIdentities();
    const parsed = this.#classifyUpdate(update);
    if (parsed === null) {
      this.#log('update_rejected');
      return;
    }
    const { updateId, type, payload } = parsed;
    const inboxId = `tgbroker:${updateId}`;
    const offset = updateId + 1;
    // { callbackQueryId, text } — the toast is empty for every normal
    // callback; only the consumed/stale pending-prompt path carries text.
    let callbackAnswer = null;
    // T2B2: the consumed pending-choice row is deleted only AFTER this
    // transaction committed (receipt + command + offset). A thrown
    // transaction never reaches the deletion, so the row survives.
    let consumeChoiceRequestId = null;
    this.#store.withTransaction(() => {
      const first = this.#store.recordInbox({ inboxId, kind: type, payload: { type } });
      if (!first) return; // re-delivery: no repeated planning, no duplicate commands
      if (type === 'callback_query') {
        const plan = this.#planCallback(payload);
        if (plan !== null) {
          callbackAnswer = plan.answerId !== null
            ? { callbackQueryId: plan.answerId, text: plan.answerText ?? '' }
            : null;
          if (typeof plan.consumeChoiceRequestId === 'string') {
            consumeChoiceRequestId = plan.consumeChoiceRequestId;
          }
          if (plan.command !== null) {
            const result = this.#store.enqueueTuiCommand({
              trackingId: plan.command.trackingId,
              kind: plan.command.kind,
              payload: plan.command.payload,
            });
            if (result.ok || result.reason === 'duplicate_command') {
              // At-most-once enqueue: a duplicate id is already durable,
              // so the acknowledgement stays truthful.
              this.#queueReply(plan.command.ackReply);
            } else if (plan.command.staleReply) {
              this.#queueReply(plan.command.staleReply);
            } else {
              this.#log('command_enqueue_failed');
            }
          }
          if (plan.choiceCommand != null) {
            // T2B2: at-most-once choice_response with the deterministic
            // explicit command id. An accepted enqueue answers the fixed
            // accepted/cancelled toast; a duplicate or failed enqueue is
            // stale (never success) and answers the fixed out-of-date
            // toast. The answer is queued only after this whole unit
            // (receipt + command + offset) commits; a throw rolls back
            // and queues nothing.
            const choiceCommand = plan.choiceCommand;
            const result = this.#store.enqueueTuiCommand({
              trackingId: choiceCommand.trackingId,
              kind: choiceCommand.kind,
              payload: choiceCommand.payload,
              commandId: choiceCommand.commandId,
            });
            callbackAnswer = plan.answerId !== null
              ? {
                  callbackQueryId: plan.answerId,
                  text: result.ok ? choiceCommand.acceptedToast : copy.staleChoiceToast,
                }
              : null;
          }
          if (Array.isArray(plan.commands) && plan.commands.length > 0) {
            // T03b multi-command plans (abort then prompt): enqueue in
            // order and stop at the first rejection — the held prompt is
            // cleared ONLY after every command of the plan was accepted.
            let allAccepted = true;
            for (const command of plan.commands) {
              if (!allAccepted) break;
              const result = this.#store.enqueueTuiCommand({
                trackingId: command.trackingId,
                kind: command.kind,
                payload: command.payload,
              });
              if (result.ok || result.reason === 'duplicate_command') {
                this.#queueReply(command.ackReply);
              } else if (command.staleReply) {
                this.#queueReply(command.staleReply);
                allAccepted = false;
              } else {
                this.#log('command_enqueue_failed');
                allAccepted = false;
              }
            }
            if (allAccepted && plan.clearPending === true) {
              this.#pendingPrompt = null;
            }
          }
          if (plan.reply !== null) this.#queueReply(plan.reply);
        }
      } else if (type === 'message') {
        try {
          const plan = this.#planMessage(payload, resolvedAudio);
          for (const command of plan.commands) {
            const result = this.#store.enqueueTuiCommand({
              trackingId: command.trackingId,
              kind: command.kind,
              payload: command.payload,
            });
            if (result.ok || result.reason === 'duplicate_command') {
              // At-most-once enqueue: a duplicate id is already durable,
              // so the acknowledgement stays truthful.
              this.#queueReply(command.ackReply);
            } else if (command.staleReply) {
              this.#queueReply(command.staleReply);
            } else {
              this.#log('command_enqueue_failed');
            }
          }
          for (const reply of plan.replies) this.#queueReply(reply);
        } catch {
          this.#log('update_error');
        }
      } else {
        // Edited messages, channel posts, business events, unknown types:
        // consume them (receipt + offset advance) and ignore the content.
        this.#log('update_rejected');
      }
      this.#store.advanceBrokerTransportOffset(offset);
    });
    if (consumeChoiceRequestId !== null) {
      // T2B2: drop the consumed pending-choice row only after the enclosing
      // transaction returned successfully (a throw above never gets here).
      this.#pendingChoices.delete(consumeChoiceRequestId);
    }
    if (callbackAnswer !== null) {
      // Best-effort feedback, queued only AFTER the transaction (receipt,
      // commands and offset) committed inside the store. Objects carry the
      // optional toast text next to the id; the queue stays bounded.
      if (this.#pendingAnswers.length < MAX_PENDING_REPLIES) {
        this.#pendingAnswers.push(callbackAnswer);
      } else {
        this.#log('reply_overflow');
      }
    }
  }

  async #resolveAudio(update) {
    if (this.#transcriber === null) return undefined;
    const message = isPlainObject(update) && isPlainObject(update.message) ? update.message : null;
    if (message === null) return undefined;
    const media = isPlainObject(message.voice)
      ? message.voice
      : isPlainObject(message.audio) ? message.audio : null;
    if (media === null) return undefined;
    // 1. Authorize first, spend nothing otherwise: an unauthorized voice
    //    note must cause ZERO downloads and ZERO transcription.
    const fromId = isPlainObject(message.from) ? message.from.id : null;
    const chatId = isPlainObject(message.chat) ? message.chat.id : null;
    if (!authorize({ userId: fromId, chatId }, this.#config).allowed) {
      return undefined; // handleUpdate follows today's silent-drop outcome.
    }
    // 2. Rate-limit peek: no token, no download, no CPU. The marker makes
    //    the plan's own failed take produce the same rate-limit reply as
    //    rate-limited text.
    if (!this.#limiter.peek('inbound', this.#now()).allowed) {
      return { state: 'rate_limited' };
    }
    // 3. Download + transcribe. Telegram's claimed duration/file_size are
    //    never trusted: the transcriber measures and caps by itself.
    const fileId = typeof media.file_id === 'string' ? media.file_id : null;
    if (fileId === null) {
      this.#log('audio_transcription_failed');
      return { state: 'failed' };
    }
    try {
      const file = await this.#api.getFile({ fileId });
      const bytes = await this.#api.downloadFile({ filePath: file?.file_path });
      const { text } = await this.#transcriber.transcribe({ bytes });
      if (typeof text === 'string' && text.trim().length > 0) {
        return { state: 'ok', text };
      }
      // An empty transcript is silence, never an empty prompt.
      this.#log('audio_transcription_failed');
      return { state: 'failed' };
    } catch {
      // Fixed token only: never the error code, message, path, stderr or
      // the transcript itself.
      this.#log('audio_transcription_failed');
      return { state: 'failed' };
    }
  }

  #classifyUpdate(update) {
    if (!isPlainObject(update)) return null;
    const updateId = safeInt(update.update_id);
    if (updateId === null || updateId < 0) return null;
    if (isPlainObject(update.message)) {
      return { updateId, type: 'message', payload: update.message };
    }
    if (isPlainObject(update.callback_query)) {
      return { updateId, type: 'callback_query', payload: update.callback_query };
    }
    return { updateId, type: 'rejected_kind', payload: null };
  }

  /**
   * T03a callback handling. Returns null when the callback must be dropped
   * entirely (unauthorized, non-private chat, missing pieces): no reply and
   * no answerCallbackQuery. Otherwise returns { answerId, reply, command }:
   * a best-effort answer id (null when the query carries none), an optional
   * queued reply (with or without an inline keyboard) and an optional
   * command to enqueue. Every dead-session, stale-generation, duplicate-tap
   * and malformed case re-renders the safest current chooser (or the
   * no-live guidance) and never dispatches anything — EXCEPT the consumed
   * or stale pending-prompt generation (T5B2), which sends no chat reply
   * at all and is answered with the fixed out-of-date toast via
   * answerText, and the T2B2 remote-choice taps, which likewise never
   * send a chat reply: stale taps are answered with the fixed stale
   * choice toast, and an accepted tap enqueues exactly one bounded
   * choice_response (see #planChoiceResponse).
   */
  #planCallback(cq) {
    const messageId = isPlainObject(cq.message) ? cq.message : null;
    const chat = messageId !== null && isPlainObject(messageId.chat) ? messageId.chat : null;
    if (chat === null) {
      this.#log('callback_missing_chat');
      return null;
    }
    if (chat.type !== 'private' || isPlainObject(messageId.sender_chat)) {
      this.#log('auth_rejected');
      return null;
    }
    const from = isPlainObject(cq.from) ? cq.from : null;
    if (from === null || !Number.isSafeInteger(from.id) || from.is_bot === true) {
      this.#log('auth_rejected');
      return null;
    }
    const auth = authorize({ userId: from.id, chatId: chat.id }, this.#config);
    if (!auth.allowed) {
      this.#log('auth_rejected');
      return null;
    }
    const answerId = typeof cq.id === 'string' && cq.id.length > 0 ? cq.id : null;
    const data = typeof cq.data === 'string' ? cq.data : null;
    const parsed = data !== null && Buffer.byteLength(data, 'utf8') <= CALLBACK_MAX_DATA_BYTES
      ? parseCallbackData(data)
      : null;
    if (parsed === null) {
      // Oversized, non-string or malformed data: silently consumed, never dispatched.
      this.#log('callback_rejected');
      return { answerId, reply: null, command: null };
    }
    switch (parsed.action) {
      case 'refresh':
        return {
          answerId,
          reply: this.#projectsReply(),
          command: null,
        };
      case 'select': {
        const live = this.#liveSessions();
        const matches = live.filter((session) => session.shortId === parsed.shortId);
        if (matches.length !== 1) {
          // Dead, stale or ambiguous target: say the named Pi closed when it
          // is known, then re-render the safest current dashboard.
          return {
            answerId,
            reply: this.#staleProjectsReply(parsed.shortId),
            command: null,
          };
        }
        const result = this.#selectTarget(matches[0]);
        // T3: the tap re-renders the dashboard with the ✓/primary selection
        // instead of navigating away. No command is enqueued. T4E slice B:
        // a repeated tap on the ALREADY-SELECTED same trackingId still
        // re-resolves, validates and persists, but queues NO additional
        // Telegram message — only the callback answer stops the spinner.
        // A first successful change re-renders exactly once; a failed
        // selection stays fail-closed and re-renders the safest dashboard
        // (never a success claim). No time-based suppression anywhere.
        return {
          answerId,
          reply: isPlainObject(result) && result.changed === false
            ? null
            : this.#projectsReply(),
          command: null,
        };
      }
      case 'prompt': {
        const pending = this.#pendingPrompt;
        if (pending === null || pending.pendingId !== parsed.pendingId) {
          // A second tap, a replaced generation or a keyboard from before a
          // restart: the generation is consumed, never dispatched. It is
          // answered with the fixed out-of-date toast and sends NO chat
          // reply — a stale tap must never spawn a replacement dashboard
          // (T5B2); the toast is the entire visible answer.
          this.#log('callback_pending_generation_stale');
          return {
            answerId,
            reply: null,
            command: null,
            answerText: copy.staleCallbackToast,
          };
        }
        const live = this.#liveSessions();
        const matches = live.filter((session) => session.shortId === parsed.shortId);
        if (matches.length !== 1) {
          // Dead or ambiguous session: name it when known, keep the pending
          // prompt alive and re-render the current p-choices.
          this.#log('callback_target_not_live');
          return { answerId, reply: this.#staleProjectsReply(parsed.shortId), command: null };
        }
        const [session] = matches;
        this.#selectTarget(session);
        this.#pendingPrompt = null;
        return {
          answerId,
          reply: null,
          command: {
            trackingId: session.trackingId,
            kind: 'prompt',
            payload: { text: clip(pending.text, MAX_TEXT_CHARS) },
            ackReply: { text: copy.pendingSent(this.#sessionHeader(session)) },
            staleReply: { text: copy.sessionGone(this.#sessionHeader(session)) },
          },
        };
      }
      case 'chooser':
        // v1:c — the Projects dashboard, identical safety to v1:r.
        return {
          answerId,
          reply: this.#projectsReply(),
          command: null,
        };
      case 'cancel':
        // v1:C — acknowledge the cancellation; no command, no state change.
        return { answerId, reply: { text: copy.CANCEL_NOTICE }, command: null };
      case 'followup':
      case 'steer':
        return this.#planBusyTextAction(parsed, parsed.action, answerId);
      case 'abort_prompt':
        return this.#planBusyAbortPrompt(parsed, answerId);
      case 'discard':
        return this.#planBusyDiscard(parsed, answerId);
      case 'status_cb':
        return this.#planSidCommand(parsed, 'status', answerId);
      case 'stop':
        return this.#planSidCommand(parsed, 'abort', answerId);
      case 'disconnect_ask': {
        const live = this.#liveSessions();
        const matches = live.filter((session) => session.shortId === parsed.shortId);
        if (matches.length !== 1) {
          // Dead or ambiguous target: no confirmation card at all.
          this.#log('callback_target_not_live');
          return {
            answerId,
            reply: this.#staleProjectsReply(parsed.shortId),
            command: null,
          };
        }
        const [session] = matches;
        return {
          answerId,
          reply: {
            text: copy.disconnectAsk(this.#sessionHeader(session)),
            replyMarkup: { inline_keyboard: [[
              { text: copy.DISCONNECT_BUTTON, callback_data: `v1:D:${session.shortId}`, style: 'danger' },
              { text: copy.CANCEL_BUTTON, callback_data: 'v1:C' },
            ]] },
          },
          command: null,
        };
      }
      case 'disconnect_confirm':
        return this.#planSidCommand(parsed, 'disconnect', answerId);
      case 'choice_option':
        return this.#planChoiceResponse(
          parsed.requestId,
          { index: parsed.index },
          answerId,
        );
      case 'choice_cancel':
        return this.#planChoiceResponse(parsed.requestId, { cancelled: true }, answerId);
      default:
        return { answerId, reply: null, command: null };
    }
  }

  /**
   * T2B2: consume a rendered v1:w (option) or v1:W (cancel) callback
   * exactly once. Authorized taps are validated against the memory-only
   * pending registry (expired rows pruned first), then against the LIVE
   * sessions: the request's tracking id must resolve to exactly one live
   * session whose CURRENT connection id still equals the captured one.
   *
   * Unknown, expired, replayed and post-restart requests, and dead or
   * replaced connections, never choose anything: no command, no chat
   * message, only the fixed out-of-date toast — and the dead/replaced
   * row is dropped after the enclosing Store transaction commits (the
   * plan carries consumeChoiceRequestId; deletion happens in
   * handleUpdate, so a thrown transaction keeps the row). An index
   * outside the request's own option range keeps the still-valid request
   * registered. An accepted tap enqueues exactly one bounded
   * choice_response under the deterministic command id `choice_<requestId>`
   * — never an option label, description or value — and answers the fixed
   * accepted/cancelled toast only after that enqueue is accepted.
   */
  #planChoiceResponse(requestId, response, answerId) {
    this.#pruneExpiredChoices();
    const pending = this.#pendingChoices.get(requestId) ?? null;
    const stale = (dropRow) => {
      this.#log('choice_callback_stale');
      return {
        answerId,
        reply: null,
        command: null,
        answerText: copy.staleChoiceToast,
        ...(dropRow ? { consumeChoiceRequestId: requestId } : {}),
      };
    };
    if (pending === null) return stale(false);
    const live = this.#liveSessions()
      .filter((session) => session.trackingId === pending.trackingId);
    if (live.length !== 1 || live[0].connectionId !== pending.connectionId) {
      // Dead, stale or replaced connection: the request can never reach
      // its captured owner again, so drop this row after the commit.
      return stale(true);
    }
    if (response.cancelled !== true) {
      const { index } = response;
      if (!Number.isSafeInteger(index) || index < 0 || index >= pending.optionCount) {
        // Out of range for THIS request: the still-valid request stays
        // registered so a correct tap can still answer it.
        this.#log('choice_callback_invalid_index');
        return {
          answerId,
          reply: null,
          command: null,
          answerText: copy.staleChoiceToast,
        };
      }
    }
    return {
      answerId,
      reply: null,
      command: null,
      choiceCommand: {
        trackingId: live[0].trackingId,
        kind: 'choice_response',
        payload: response.cancelled === true
          ? { requestId, cancelled: true }
          : { requestId, index: response.index },
        commandId: `choice_${requestId}`,
        acceptedToast: response.cancelled === true
          ? copy.choiceCancelledToast
          : copy.choiceAnsweredToast,
      },
      consumeChoiceRequestId: requestId,
    };
  }

  /** The exactly-one live session with this short id, or null. */
  #liveByShortId(shortId) {
    const matches = this.#liveSessions().filter((session) => session.shortId === shortId);
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * The live session behind the current selection, or null — no
   * auto-select and no guess (T4C2). A stale selection is cleared
   * (memory AND durable) exactly like every other selection refresh.
   */
  #selectedLiveSession() {
    if (this.#selectedTrackingId === null) return null;
    const selected = this.#liveSessions()
      .find((session) => session.trackingId === this.#selectedTrackingId) ?? null;
    if (selected === null) this.#clearSelection();
    return selected;
  }

  /** Shared fail-closed paths for the T03b busy callbacks. */
  #busyActionStaleGeneration(answerId) {
    // Missing or replaced generation: never dispatch; re-render the safest
    // current dashboard (which carries the CURRENT generation when held).
    this.#log('callback_pending_generation_stale');
    return { answerId, reply: this.#projectsReply(), command: null };
  }

  #busyActionTargetNotLive(answerId, shortId) {
    // Dead or ambiguous session: name the closed Pi when it is known, keep
    // the held prompt preserved for a retry against a live target, and
    // dispatch nothing.
    this.#log('callback_target_not_live');
    return { answerId, reply: this.#staleProjectsReply(shortId), command: null };
  }

  /**
   * v1:f / v1:t — dispatch the matching held prompt as exactly one
   * follow-up or steer. The pending generation is cleared only after the
   * enqueue was accepted (see the commands handling in handleUpdate).
   */
  #planBusyTextAction(parsed, kind, answerId) {
    const pending = this.#pendingPrompt;
    if (pending === null || pending.pendingId !== parsed.pendingId) {
      return this.#busyActionStaleGeneration(answerId);
    }
    const live = this.#liveSessions();
    const matches = live.filter((session) => session.shortId === parsed.shortId);
    if (matches.length !== 1) {
      return this.#busyActionTargetNotLive(answerId, parsed.shortId);
    }
    const [session] = matches;
    this.#selectTarget(session);
    return {
      answerId,
      reply: null,
      command: null,
      commands: [{
        trackingId: session.trackingId,
        kind,
        payload: { text: clip(pending.text, MAX_TEXT_CHARS) },
        ackReply: { text: copy.cbAck(kind, this.#sessionHeader(session)) },
        staleReply: { text: copy.sessionGone(this.#sessionHeader(session)) },
      }],
      clearPending: true,
    };
  }

  /**
   * v1:a — stop the running turn, then send the held prompt as a new
   * prompt: abort first, prompt second, in that exact order, both cleared
   * from the pending generation only after both enqueues were accepted.
   */
  #planBusyAbortPrompt(parsed, answerId) {
    const pending = this.#pendingPrompt;
    if (pending === null || pending.pendingId !== parsed.pendingId) {
      return this.#busyActionStaleGeneration(answerId);
    }
    const live = this.#liveSessions();
    const matches = live.filter((session) => session.shortId === parsed.shortId);
    if (matches.length !== 1) {
      return this.#busyActionTargetNotLive(answerId, parsed.shortId);
    }
    const [session] = matches;
    this.#selectTarget(session);
    return {
      answerId,
      reply: null,
      command: null,
      commands: [
        {
          trackingId: session.trackingId,
          kind: 'abort',
          payload: null,
          // Session-scoped: the first abort acknowledgement names the
          // session instead of staying anonymous (T4B2).
          ackReply: { text: copy.cbAck('abort', this.#sessionHeader(session)) },
          staleReply: { text: copy.sessionGone(this.#sessionHeader(session)) },
        },
        {
          trackingId: session.trackingId,
          kind: 'prompt',
          payload: { text: clip(pending.text, MAX_TEXT_CHARS) },
          ackReply: { text: copy.cbAck('prompt_after_abort', this.#sessionHeader(session)) },
          staleReply: { text: copy.sessionGone(this.#sessionHeader(session)) },
        },
      ],
      clearPending: true,
    };
  }

  /**
   * v1:n — discard the matching held prompt and leave the task alone:
   * nothing is enqueued, only the matching generation is consumed.
   */
  #planBusyDiscard(parsed, answerId) {
    const pending = this.#pendingPrompt;
    if (pending === null || pending.pendingId !== parsed.pendingId) {
      return this.#busyActionStaleGeneration(answerId);
    }
    this.#pendingPrompt = null;
    return { answerId, reply: { text: copy.busyDiscard }, command: null };
  }

  /**
   * v1:q / v1:x / v1:D — one existing typed command (status, abort,
   * disconnect) against exactly one live session. The x button only
   * renders while the state is busy; the callback itself stays a plain
   * abort so a state change between render and tap stays harmless.
   */
  #planSidCommand(parsed, kind, answerId) {
    const session = this.#liveByShortId(parsed.shortId);
    if (session === null) {
      return this.#busyActionTargetNotLive(answerId, parsed.shortId);
    }
    this.#selectTarget(session);
    return {
      answerId,
      reply: null,
      command: {
        trackingId: session.trackingId,
        kind,
        payload: null,
        ackReply: { text: copy.cbAck(kind, this.#sessionHeader(session)) },
        staleReply: { text: copy.sessionGone(this.#sessionHeader(session)) },
      },
    };
  }

  /**
   * The last-known identity of a short id, or null when it was never
   * seen. Used to name a dead/stale target without ever exposing the id.
   */
  #lastKnownIdentity(shortId) {
    for (const identity of this.#identityCache.values()) {
      if (identity.shortId === shortId) return identity;
    }
    return null;
  }

  /**
   * The stale/dead-target reply (T04/T4B2): when the named Pi is known (it
   * was seen live earlier), say it just closed or disconnected under its
   * full identity header, then show the fresh Projects dashboard — or the
   * no-live guidance when none are left. Never exposes the short id itself.
   */
  #staleProjectsReply(shortId) {
    const dashboard = this.#projectsReply();
    const identity = this.#lastKnownIdentity(shortId);
    if (identity === null) return dashboard;
    const header = copy.identityHeader({
      colorSlot: this.#colorSlotOf(identity.projectKey),
      sessionAlias: identity.alias,
      projectAlias: this.#projectAliasFor(identity.projectKey),
      label: identity.label,
      branch: identity.branch,
    });
    return {
      text: `${copy.sessionGone(header)}\n${dashboard.text}`,
      replyMarkup: dashboard.replyMarkup,
    };
  }

  /**
   * The Projects dashboard (T3): an `Active now` row per live session, a
   * `Recent` row per 30-day project history entry not currently active
   * (newest first, capped by the store), plus Refresh. Selected live rows
   * render ✓ + primary; live connected rows success; busy/waiting rows the
   * default style; headers and recent rows are the native disabled action
   * buttons (`disabled: {}`, no callback_data) so they cannot be tapped. With a pending
   * prompt, live rows dispatch the CURRENT pending generation (v1:p);
   * otherwise they select (v1:s). Recent rows never route. Short ids stay
   * inside callback_data, never in visible text; a history read failure
   * degrades to the live-only view instead of throwing.
   */
  #projectsReply() {
    const live = this.#liveSessions();
    const recent = this.#recentProjects();
    const activeKeys = new Set(
      live
        .map((session) => (isPlainObject(session) ? session.projectKey : null))
        .filter((key) => typeof key === 'string' && key.length > 0),
    );
    const aliasByKey = new Map();
    const recentRows = [];
    for (const project of recent) {
      if (!isPlainObject(project) || typeof project.projectKey !== 'string' || project.projectKey.length === 0) continue;
      const alias = typeof project.alias === 'string' && project.alias.trim().length > 0
        ? project.alias
        : null;
      if (alias !== null) aliasByKey.set(project.projectKey, alias);
      if (!activeKeys.has(project.projectKey)) recentRows.push(project);
    }
    const pendingId = this.#pendingPrompt !== null ? this.#pendingPrompt.pendingId : null;
    const rows = [];
    if (live.length > 0) {
      rows.push([this.#sectionButton(copy.PROJECT_SECTION_ACTIVE)]);
      for (const session of live.slice(0, MAX_LISTED_SESSIONS)) {
        const button = this.#liveRowButton(session, pendingId, aliasByKey);
        if (button !== null) rows.push([button]);
      }
    }
    if (recentRows.length > 0) {
      rows.push([this.#sectionButton(copy.PROJECT_SECTION_RECENT)]);
      for (const project of recentRows) {
        rows.push([{
          text: copy.projectRowLabel({
            colorSlot: project.colorSlot,
            offline: true,
            name: project.alias ?? project.label,
            branch: project.branch,
          }),
          disabled: {},
        }]);
      }
    }
    if (rows.length > 0) rows.push([{ text: REFRESH_BUTTON_TEXT, callback_data: 'v1:r' }]);
    const text = this.#pendingPrompt !== null
      ? copy.pendingSaved
      : live.length === 0 && recentRows.length === 0
        ? copy.homeNoLive
        : copy.projectsTitle;
    return rows.length > 0
      ? { text, replyMarkup: { inline_keyboard: rows } }
      : { text };
  }

  /** A native disabled section header row (Telegram Bot API 10.3 action
   * field, no callback_data, nothing to tap). */
  #sectionButton(text) {
    return { text, disabled: {} };
  }

  /**
   * One live session as a dashboard row. The callback binds to the current
   * pending generation when one is held (v1:p), otherwise it selects
   * (v1:s). Selected → ✓ + primary; connected → success; busy/waiting →
   * default. Unusable rows render as null and are skipped.
   */
  #liveRowButton(session, pendingId, aliasByKey) {
    if (!isPlainObject(session)) return null;
    const shortId = this.#shortIdOf(session);
    if (shortId === null) return null;
    const selected = session.trackingId === this.#selectedTrackingId;
    const style = selected
      ? 'primary'
      : session.state === 'connected' ? 'success' : undefined;
    const sessionAlias = typeof session.alias === 'string' && session.alias.trim().length > 0
      ? session.alias
      : null;
    const projectAlias = typeof session.projectKey === 'string'
      ? aliasByKey.get(session.projectKey)
      : undefined;
    const button = {
      text: copy.projectRowLabel({
        selected,
        colorSlot: this.#colorSlotOf(session.projectKey),
        state: session.state,
        name: sessionAlias ?? projectAlias ?? session.label,
        branch: session.branch,
      }),
      callback_data: pendingId !== null
        ? `v1:p:${shortId}:${pendingId}`
        : `v1:s:${shortId}`,
    };
    if (style !== undefined) button.style = style;
    return button;
  }

  /**
   * The stable color slot for a project key, mirroring the store's
   * derivation (first 8 hex chars mod 8). Malformed keys fall back to the
   * neutral palette slot instead of throwing.
   */
  #colorSlotOf(projectKey) {
    if (typeof projectKey !== 'string' || !/^[0-9a-f]{8,64}$/.test(projectKey)) return null;
    return parseInt(projectKey.slice(0, 8), 16) % 8;
  }

  /**
   * The store's 30-day recent project history (newest first, capped).
   * A missing or failing store degrades to an empty history: the dashboard
   * renders the live view and never throws.
   */
  #recentProjects() {
    try {
      return this.#store.listRecentTuiProjects({ since: this.#now() - TUI_PROJECT_RETENTION_MS });
    } catch {
      this.#log('projects_history_unavailable');
      return [];
    }
  }

  #planMessage(message, resolvedAudio = undefined) {
    if (isPlainObject(message.sender_chat)) {
      // Anonymous/channel impersonation: silent, fixed code only.
      this.#log('auth_rejected');
      return { replies: [], commands: [] };
    }
    const fromId = isPlainObject(message.from) ? message.from.id : null;
    const chatId = isPlainObject(message.chat) ? message.chat.id : null;
    const auth = authorize({ userId: fromId, chatId }, this.#config);
    if (!auth.allowed) {
      this.#log('auth_rejected');
      return { replies: [], commands: [] };
    }
    const text = typeof message.text === 'string' ? message.text : null;
    // T4: voice/audio are accepted ONLY while transcription is enabled;
    // disabled, they fall through to today's exact silent drop below.
    const audio = this.#transcriber !== null
      && (isPlainObject(message.voice) || isPlainObject(message.audio));
    if (text === null && !audio) {
      this.#log('ignore');
      return { replies: [], commands: [] };
    }
    if (!this.#limiter.take('inbound', this.#now()).allowed) {
      // Offset still advances (receipt is durable); just no replies.
      this.#log('rate_limited_inbound');
      return { replies: [], commands: [] };
    }
    if (text !== null) {
      if (text.startsWith('/')) return this.#planCommand(text);
      return this.#planFreeText(text);
    }
    // Audio branch (T4): the outcome was resolved before this transaction
    // opened; the plan stays a pure, synchronous function of it.
    if (isPlainObject(resolvedAudio)
      && resolvedAudio.state === 'ok'
      && typeof resolvedAudio.text === 'string'
      && resolvedAudio.text.trim().length > 0) {
      // One channel, one code path: the transcript enters the EXISTING
      // free-text path exactly as if the owner had typed it.
      return this.#planFreeText(resolvedAudio.text);
    }
    if (isPlainObject(resolvedAudio) && resolvedAudio.state === 'rate_limited') {
      // peek/take race (the peek saw an exhausted limiter but the take
      // passed anyway): the token was spent, nothing was downloaded or
      // transcribed — consume silently exactly like rate-limited text.
      return { replies: [], commands: [] };
    }
    // 'failed', a missing outcome, or any unexpected shape: fail closed.
    return { replies: [AUDIO_FAILURE_NOTICE], commands: [] };
  }

  // --- commands -----------------------------------------------------------

  #planCommand(text) {
    const newlineAt = text.indexOf('\n');
    const firstLine = newlineAt === -1 ? text : text.slice(0, newlineAt);
    const rest = newlineAt === -1 ? '' : text.slice(newlineAt + 1);
    const match = /^\/([a-zA-Z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(firstLine);
    if (!match) {
      // Not even a command-shaped line: the same friendly guidance (T04).
      return { replies: [copy.unknownCommand], commands: [] };
    }
    const name = match[1].toLowerCase();
    let args = match[2] ?? '';
    if (rest.length > 0) args = args.length > 0 ? `${args}\n${rest}` : rest;

    switch (name) {
      case 'start':
        return this.#planStart();
      case 'help':
        return { replies: [copy.HELP_TEXT], commands: [] };
      case 'projects':
        return this.#planProjects();
      case 'sessions':
        return this.#planSessions();
      case 'use':
        return this.#planUse(args);
      case 'alias':
        return this.#planAlias(args);
      case 'status':
        return this.#planRouted(args, 'status');
      case 'send':
        return this.#planRouted(args, 'prompt');
      case 'steer':
        return this.#planRouted(args, 'steer');
      case 'followup':
        return this.#planRouted(args, 'followup');
      case 'abort':
        return this.#planRouted(args, 'abort');
      case 'disconnect':
        return this.#planRouted(args, 'disconnect');
      default:
        // MSG-E4: an unknown slash command is friendly guidance, never a
        // stack trace or jargon (BEGINNER_UX.md section 11).
        return { replies: [copy.unknownCommand], commands: [] };
    }
  }

  /**
   * The state-aware /start home (BEGINNER_UX.md section 6, T04): zero live
   * sessions point at /tg, exactly one is auto-selected with its T03b
   * action row, several present the Projects dashboard. No command is ever
   * enqueued from /start itself.
   */
  #planStart() {
    const live = this.#liveSessions();
    if (live.length === 0) {
      this.#clearSelection();
      return { replies: [{ text: copy.homeNoLive }], commands: [] };
    }
    if (live.length === 1) {
      const [sole] = live;
      // Auto-select, mirroring the beginner plain-text rule. A store
      // refusal fails closed: the reply still renders, but nothing is
      // selected in memory or durably.
      this.#selectTarget(sole);
      return {
        replies: [{
          text: copy.homeOne(this.#sessionHeader(sole)),
          replyMarkup: this.#sessionActionKeyboard(sole),
        }],
        commands: [],
      };
    }
    return { replies: [this.#projectsReply()], commands: [] };
  }

  /**
   * /projects (T3): the Projects dashboard. Selection is preserved,
   * nothing is ever enqueued, and a zero/zero store renders the no-live
   * beginner guidance without buttons.
   */
  #planProjects() {
    return { replies: [this.#projectsReply()], commands: [] };
  }

  #planSessions() {
    const live = this.#liveSessions();
    if (live.length === 0) {
      return { replies: [NO_LIVE_SESSIONS_ADVANCED_NOTICE], commands: [] };
    }
    const lines = ['Live TUI sessions:'];
    for (const session of live.slice(0, MAX_LISTED_SESSIONS)) {
      // Safe columns only (advanced layer): tg:<shortId>, the T4B2
      // alias-aware identity header and the store-validated state word.
      // Never cwd, pid, tracking/project/session/connection ids or raw
      // model internals: local paths stay on this PC.
      lines.push(`tg:${session.shortId} · ${this.#sessionHeader(session)} · state: ${session.state}`);
    }
    if (live.length > MAX_LISTED_SESSIONS) {
      lines.push(`…and ${live.length - MAX_LISTED_SESSIONS} more.`);
    }
    return { replies: [lines.join('\n')], commands: [] };
  }

  #planUse(args) {
    const shortId = args.trim().split(/\s+/)[0] ?? '';
    if (!SHORT_ID_RE.test(shortId)) {
      return { replies: [USAGE.use], commands: [] };
    }
    const target = this.#resolveTarget(shortId, false);
    if (!target.ok) {
      return { replies: [target.reply], commands: [] };
    }
    if (!this.#selectTarget(target.session)) {
      // A refused durable set never selects: fail closed instead of
      // acknowledging a selection that did not happen.
      return { replies: [NO_SELECTION_NOTICE], commands: [] };
    }
    return { replies: [this.#prefixed(target.session, 'Selected.')], commands: [] };
  }

  /**
   * T4C2 /alias: per-session human aliases. Targeting fails closed:
   * - `/alias` alone shows usage and mutates nothing.
   * - `/alias clear` clears the SELECTED live session's alias.
   * - `/alias <name>` renames the SELECTED live session only — never a
   *   guess and never a sole-session auto-select.
   * - `/alias <shortId> <name|clear>` targets that exact unique live
   *   session and leaves the current selection untouched. The first
   *   token is treated as a short id ONLY while it uniquely resolves
   *   against the live sessions; otherwise the whole argument is the
   *   selected session's alias (so names like `home pc` never misparse).
   * Input is normalized (trim + whitespace collapse) and refused BEFORE
   * the store when it is empty, longer than 64 UTF-16 chars, starts with
   * '/' or still carries control characters — fixed safe copy, never an
   * echo of the rejected input. A store refusal or throw replies with
   * one fixed failure line, logs one fixed code and never enqueues a TUI
   * command; the receipt and offset still commit. On success the
   * Projects dashboard re-renders immediately under a concise fixed
   * acknowledgement so the renamed row is visible at once.
   */
  #planAlias(args) {
    const normalized = normalizeAliasInput(args);
    if (normalized.length === 0) {
      return { replies: [USAGE.alias], commands: [] };
    }
    const spaceAt = normalized.indexOf(' ');
    const first = spaceAt === -1 ? normalized : normalized.slice(0, spaceAt);
    const rest = spaceAt === -1 ? '' : normalized.slice(spaceAt + 1).trim();

    let target = null;
    let aliasValue = null; // null = clear the alias
    let valueGiven = false;
    if (rest !== '') {
      const matches = this.#liveSessions().filter((session) => session.shortId === first);
      if (matches.length === 1) {
        // The advanced form: that exact unique live session, selection untouched.
        target = matches[0];
        if (rest !== 'clear') {
          aliasValue = rest;
          valueGiven = true;
        }
      } else {
        // A nonmatching first word is part of the alias, never a target.
        aliasValue = normalized;
        valueGiven = true;
      }
    } else if (first !== 'clear'
      && this.#liveSessions().filter((session) => session.shortId === first).length === 1) {
      // A bare unique live short id without <name|clear>: usage, no mutation.
      return { replies: [USAGE.alias], commands: [] };
    } else if (first !== 'clear') {
      aliasValue = normalized;
      valueGiven = true;
    }
    // `first === 'clear'` with no rest falls through: clear the selected session.

    if (target === null) {
      target = this.#selectedLiveSession();
      if (target === null) {
        return { replies: [copy.aliasNoSelection], commands: [] };
      }
    }
    if (valueGiven && !isValidAlias(aliasValue)) {
      this.#log('alias_input_refused');
      return { replies: [copy.aliasInvalid], commands: [] };
    }
    let result = null;
    try {
      result = this.#store.setTuiSessionAlias({ trackingId: target.trackingId, alias: aliasValue });
    } catch {
      result = null;
    }
    if (!isPlainObject(result) || result.ok !== true) {
      this.#log('alias_persist_failed');
      return { replies: [copy.aliasFailed], commands: [] };
    }
    this.#log('alias_saved');
    const dashboard = this.#projectsReply();
    const ack = valueGiven ? copy.aliasSaved : copy.aliasCleared;
    return {
      replies: [dashboard.replyMarkup
        ? { text: `${ack}\n${dashboard.text}`, replyMarkup: dashboard.replyMarkup }
        : { text: ack }],
      commands: [],
    };
  }

  /**
   * Commands with an optional leading [shortId] and, for the text kinds,
   * a bounded payload. Omitting the id resolves through the centralized
   * beginner resolution: an explicit live selection for every command,
   * plus sole-session auto-selection ONLY for /status (text commands keep
   * their selection-required fail closed). Resolution and payload rules
   * fail closed.
   */
  #planRouted(args, kind) {
    const needsText = kind === 'prompt' || kind === 'steer' || kind === 'followup';
    const { shortId, text } = this.#splitIdAndText(args);
    if (needsText && text.length === 0) {
      return { replies: [USAGE[kind]], commands: [] };
    }
    const target = this.#resolveTarget(shortId, kind === 'status');
    if (!target.ok) {
      return { replies: [target.reply], commands: [] };
    }
    let payload = null;
    if (needsText) {
      const clipped = clip(text, MAX_TEXT_CHARS);
      if (hasSlashInitialLine(clipped)) {
        this.#log('input_refused');
        return { replies: [SLASH_LINE_NOTICE], commands: [] };
      }
      payload = { text: clipped };
    }
    const staleReply = { text: copy.sessionGone(this.#sessionHeader(target.session)) };
    return {
      replies: [],
      commands: [{
        trackingId: target.session.trackingId,
        kind,
        payload,
        ackReply: this.#prefixed(target.session, ACK_TEXT[kind]),
        staleReply,
      }],
    };
  }

  /**
   * T03b busy decision card: hold the message behind a fresh generation
   * and let the human choose. Exactly four readable buttons; short ids and
   * prompt text never appear in the card text.
   */
  #busyCardReply(session, pendingId) {
    const sid = session.shortId;
    return {
      text: copy.busyCard(this.#sessionHeader(session)),
      replyMarkup: { inline_keyboard: [
        [{ text: BUSY_BUTTON_FOLLOWUP, callback_data: `v1:f:${sid}:${pendingId}` }],
        [{ text: BUSY_BUTTON_STEER, callback_data: `v1:t:${sid}:${pendingId}` }],
        [{ text: BUSY_BUTTON_ABORT_PROMPT, callback_data: `v1:a:${sid}:${pendingId}` }],
        [{ text: BUSY_BUTTON_DISCARD, callback_data: `v1:n:${pendingId}` }],
      ] },
    };
  }

  /**
   * Plain non-command text acts as /send, but ONLY against a live session:
   * the selected one, or — beginner path — the sole live session when no
   * selection exists. Never a shell line, never interpreted beyond a typed
   * prompt for the Pi extension. When the resolved session is BUSY the
   * message is held behind a fresh generation and the human decides
   * through the busy card; nothing is enqueued behind a running turn.
   */
  #planFreeText(text) {
    const target = this.#resolveTarget(null, true);
    if (!target.ok) {
      if (target.holdPrompt === true) {
        // Several live sessions and no live selection: hold/replace the
        // broker-memory pending prompt and offer readable choices. The
        // held text is screened exactly like a dispatched prompt.
        const clipped = clip(text, MAX_TEXT_CHARS);
        if (hasSlashInitialLine(clipped)) {
          this.#log('input_refused');
          return { replies: [SLASH_LINE_NOTICE], commands: [] };
        }
        this.#pendingPrompt = { pendingId: freshPendingId(), text: clipped };
        return { replies: [this.#projectsReply()], commands: [] };
      }
      // Zero live sessions (T04): the plain-text path names the miss —
      // the message was NOT sent — with the fixed friendly guidance.
      return {
        replies: [target.noLive === true ? copy.plainNoLive : target.reply],
        commands: [],
      };
    }
    const clipped = clip(text, MAX_TEXT_CHARS);
    if (hasSlashInitialLine(clipped)) {
      this.#log('input_refused');
      return { replies: [SLASH_LINE_NOTICE], commands: [] };
    }
    // T2B1: a pending remote choice owns the answer channel — plain text is
    // NOT a custom response (V1 contract), so it enqueues nothing and gets
    // only the fixed guard reply. Other sessions remain fully routable and
    // slash-command behavior is unchanged.
    if (this.#pendingChoiceFor(target.session.trackingId) !== null) {
      return { replies: [copy.choicePendingPlain], commands: [] };
    }
    if (target.session.state === 'busy') {
      // T03b: a busy session never receives a silent direct prompt. The
      // held text is screened exactly like a dispatched prompt (above).
      const pendingId = freshPendingId();
      this.#pendingPrompt = { pendingId, text: clipped };
      return { replies: [this.#busyCardReply(target.session, pendingId)], commands: [] };
    }
    // A directly dispatched message supersedes anything still held.
    this.#pendingPrompt = null;
    return {
      replies: [],
      commands: [{
        trackingId: target.session.trackingId,
        kind: 'prompt',
        payload: { text: clipped },
        ackReply: this.#prefixed(target.session, ACK_TEXT.prompt),
        staleReply: { text: copy.sessionGone(this.#sessionHeader(target.session)) },
      }],
    };
  }

  // --- session resolution (fail closed) --------------------------------------

  #liveSessions() {
    const cutoff = this.#now() - DEFAULT_STALE_AFTER_MS;
    const sessions = this.#store
      .listTuiSessions({ staleCutoff: cutoff })
      .filter((session) => session.live === true);
    for (const session of sessions) this.#rememberIdentity(session);
    return sessions;
  }

  /**
   * Exact resolution against LIVE sessions (30s heartbeat cutoff). A
   * short id matches at most one row (the store keeps short ids unique),
   * but more than one match still fails closed. An omitted id resolves
   * through the centralized beginner path: the memory-only selection if it
   * is still live (preserved for EVERY command), otherwise the sole live
   * session when exactly one exists and `allowSoleAutoSelect` permits it
   * (ordinary plain text and /status only — advanced routed commands fail
   * closed with the selection-required notice instead), otherwise fail
   * closed without ever guessing a target or exposing short ids.
   */
  #resolveTarget(explicitShortId, allowSoleAutoSelect) {
    const live = this.#liveSessions();
    if (explicitShortId !== null) {
      const matches = live.filter((session) => session.shortId === explicitShortId);
      if (matches.length === 1) return { ok: true, session: matches[0] };
      if (matches.length > 1) {
        return { ok: false, reply: AMBIGUOUS_TARGET_NOTICE(explicitShortId) };
      }
      return { ok: false, reply: MISSING_TARGET_NOTICE(explicitShortId) };
    }
    if (live.length === 0) {
      this.#clearSelection();
      // Beginner no-live guidance ONLY for the beginner-facing paths
      // (plain text and /status, i.e. allowSoleAutoSelect). Advanced
      // routed commands keep T02's selection-required fail closed even
      // with zero live sessions (T04 correction).
      if (allowSoleAutoSelect) {
        return { ok: false, noLive: true, reply: copy.noLiveGuidance };
      }
      return { ok: false, reply: NO_SELECTION_NOTICE };
    }
    const selected = this.#selectedTrackingId === null
      ? null
      : live.find((session) => session.trackingId === this.#selectedTrackingId) ?? null;
    if (selected !== null) return { ok: true, session: selected };
    this.#clearSelection();
    // Beginner auto-selection: with exactly one live session, target it
    // directly (and remember it) instead of demanding /use — but ONLY for
    // ordinary plain text and /status, which also get the choice notice
    // with several live sessions. Advanced routed commands keep their
    // previous selection-required fail closed for EVERY live-session count.
    if (allowSoleAutoSelect) {
      if (live.length === 1) {
        const [sole] = live;
        // A store refusal fails closed: the refused selection never routes.
        if (!this.#selectTarget(sole)) {
          return { ok: false, reply: NO_SELECTION_NOTICE };
        }
        return { ok: true, session: sole };
      }
      // T03a: plain text holds this as the broker-memory pending prompt
      // (see #planFreeText); /status keeps the fixed fail-closed notice.
      return { ok: false, holdPrompt: true, reply: MULTIPLE_LIVE_SESSIONS_NOTICE };
    }
    return { ok: false, reply: NO_SELECTION_NOTICE };
  }

  /** Split an optional leading short id from the remaining payload text. */
  #splitIdAndText(args) {
    const trimmed = args.trim();
    if (trimmed.length === 0) return { shortId: null, text: '' };
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    const first = match[1];
    if (SHORT_ID_RE.test(first)) {
      return { shortId: first, text: (match[2] ?? '').trim() };
    }
    return { shortId: null, text: trimmed };
  }

  // --- reply queue + TUI event drain ------------------------------------------

  #queueReply(reply) {
    if (this.#pendingReplies.length >= MAX_PENDING_REPLIES) {
      this.#log('reply_overflow');
      return;
    }
    const normalized = typeof reply === 'string' ? { text: reply } : reply;
    if (isPlainObject(normalized)
      && typeof normalized.text === 'string'
      && normalized.text.length > 0) {
      this.#pendingReplies.push({
        text: normalized.text,
        replyMarkup: isPlainObject(normalized.replyMarkup) ? normalized.replyMarkup : null,
      });
    }
  }

  /**
   * Flush queued command acknowledgements. These are best-effort notices:
   * uncertain delivery is treated as delivered (legacy tg_text semantics),
   * a definitive failure drops the notice (a duplicate command is never
   * fabricated to compensate), and rate limiting keeps the notice queued.
   */
  async flushReplies() {
    await this.#flushCallbackAnswers();
    while (this.#pendingReplies.length > 0) {
      const [reply] = this.#pendingReplies;
      const outcome = await this.#sendChunks(reply.text, reply.replyMarkup);
      if (outcome === 'sent' || outcome === 'uncertain') {
        this.#pendingReplies.shift();
        continue;
      }
      if (outcome === 'failed') {
        this.#pendingReplies.shift();
        continue;
      }
      break; // rate limited: retry next cycle
    }
  }

  /**
   * Drain pending TUI events across all tracked sessions, oldest first.
   * Each event is fully sent (all chunks) before it is acknowledged; on
   * any non-sent outcome the drain stops so ordering is preserved and the
   * event is retried whole next cycle. A failed delivery is never turned
   * into another command.
   */
  async drainTuiEvents() {
    this.#refreshIdentities();
    for (let guard = 0; guard < MAX_EVENTS_PER_DRAIN; guard++) {
      const [event] = this.#store.listPendingBrokerTuiEvents({ limit: 1 });
      if (!event) return;
      const rendered = this.#renderEvent(event);
      if (rendered === null) {
        // Nothing factual to transport: acknowledge so it never blocks.
        this.#store.acknowledgeTuiEvents({ eventIds: [event.eventId] });
        continue;
      }
      const outcome = await this.#sendChunks(rendered.text, rendered.replyMarkup);
      if (outcome !== 'sent') {
        // Every non-sent outcome is already recorded exactly once by
        // #sendChunks at the site that knows why it failed: the throttle
        // record at the edge of the episode, and the failure records where
        // the send failed. Repeating them here would double-count a single
        // send attempt, and for a throttle it would additionally log once per
        // poll cycle for as long as the throttle lasts.
        return;
      }
      // T2B1: a remote choice request is registered ONLY after its card was
      // definitively sent, BEFORE the event is acknowledged. Uncertain,
      // failed and rate-limited deliveries stay unregistered, and the
      // unacknowledged event retries whole next cycle.
      if (isPlainObject(rendered.pendingChoice)) {
        this.#registerPendingChoice(rendered.pendingChoice);
      }
      this.#store.acknowledgeTuiEvents({ eventIds: [event.eventId] });
    }
  }

  /**
   * Best-effort answerCallbackQuery flush: runs only when the injected API
   * implements it; a failed answer is dropped without retry and never
   * replays the command it acknowledged. Each queued answer is an object
   * { callbackQueryId, text }; the toast text rides along only when a plan
   * supplied one (consumed/stale pending-prompt taps) and is empty for
   * every normal callback.
   */
  async #flushCallbackAnswers() {
    if (this.#pendingAnswers.length === 0) return;
    if (typeof this.#api.answerCallbackQuery !== 'function') {
      this.#pendingAnswers = [];
      return;
    }
    while (this.#pendingAnswers.length > 0) {
      const { callbackQueryId, text } = this.#pendingAnswers.shift();
      try {
        await this.#api.answerCallbackQuery({ callbackQueryId, text });
      } catch {
        this.#log('callback_answer_failed');
      }
    }
  }

  /**
   * One outbound limiter take with edge-triggered throttle recording: a
   * consecutive run of denials is ONE episode and is logged exactly once,
   * carrying the retryAfterMs the limiter reported. While that wait is
   * still pending the limiter is not re-attempted (and not re-logged);
   * the episode ends only when a take is allowed again, so a later denial
   * after a recovery is a new episode and stays fully visible.
   */
  #takeOutbound() {
    const now = this.#now();
    if (now < this.#outboundRetryNotBefore) {
      return { allowed: false, retryAfterMs: this.#outboundRetryNotBefore - now };
    }
    const take = this.#limiter.take('outbound', now);
    if (take.allowed) {
      this.#outboundRetryNotBefore = 0;
      return take;
    }
    if (this.#outboundRetryNotBefore === 0) {
      this.#log('rate_limited_outbound', { retryAfterMs: take.retryAfterMs });
    }
    this.#outboundRetryNotBefore = now + Math.max(0, take.retryAfterMs);
    return take;
  }

  async #sendChunks(text, replyMarkup = null) {
    const chunks = chunkMessage(text, this.#maxMessageChars);
    for (let i = 0; i < chunks.length; i++) {
      if (!this.#takeOutbound().allowed) {
        return 'rate_limited';
      }
      try {
        const isFinalChunk = i === chunks.length - 1;
        await this.#api.sendMessage({
          chatId: this.#config.telegram.allowedChatId,
          text: chunks[i],
          // The inline keyboard rides on exactly the final chunk.
          ...(isFinalChunk && replyMarkup !== null ? { replyMarkup } : {}),
        });
      } catch (error) {
        const code = error instanceof TelegramApiError ? error.code : 'unknown';
        if (OUTBOUND_UNCERTAIN.has(code)) {
          this.#log('send_uncertain');
          return 'uncertain';
        }
        this.#log('send_failed');
        return 'failed';
      }
    }
    return 'sent';
  }

  // --- event rendering ----------------------------------------------------------

  #refreshIdentities() {
    // The project-alias fallback must stay CURRENT: a rename between two
    // drains must be visible, so the cache is rebuilt once per drain cycle.
    this.#projectAliasCache.clear();
    try {
      const cutoff = this.#now() - DEFAULT_STALE_AFTER_MS;
      const sessions = this.#store.listTuiSessions({ staleCutoff: cutoff });
      for (const session of sessions) this.#rememberIdentity(session);
      if (this.#selectedTrackingId !== null) {
        const row = sessions.find((session) => session.trackingId === this.#selectedTrackingId);
        if (!row || row.live !== true) {
          // The selection went stale: clear it (memory AND durable) instead
          // of routing blind.
          this.#clearSelection();
        }
      }
    } catch {
      this.#log('identity_refresh_error');
    }
  }

  #rememberIdentity(session) {
    if (!isPlainObject(session) || typeof session.trackingId !== 'string') return;
    const shortId = typeof session.shortId === 'string' && SHORT_ID_RE.test(session.shortId)
      ? session.shortId
      : 'unknown';
    this.#identityCache.set(session.trackingId, {
      label: boundedLabel(session.label),
      alias: typeof session.alias === 'string' && session.alias.trim().length > 0
        ? session.alias
        : null,
      branch: typeof session.branch === 'string' && session.branch.length > 0
        ? session.branch
        : null,
      projectKey: typeof session.projectKey === 'string' && session.projectKey.length > 0
        ? session.projectKey
        : null,
      shortId,
    });
  }

  /**
   * The CURRENT project-level alias for a project key (T4B2), or null.
   * Backed by a bounded in-memory cache; a miss triggers ONE bounded read
   * of the recent project history (listRecentTuiProjects) to fill it. A
   * read failure degrades to null: the header falls to the next identity
   * candidate instead of throwing.
   */
  #projectAliasFor(projectKey) {
    if (typeof projectKey !== 'string' || projectKey.length === 0) return null;
    if (this.#projectAliasCache.has(projectKey)) return this.#projectAliasCache.get(projectKey);
    try {
      const recent = this.#store.listRecentTuiProjects({
        since: this.#now() - TUI_PROJECT_RETENTION_MS,
      });
      for (const project of recent) {
        if (!isPlainObject(project) || typeof project.projectKey !== 'string') continue;
        this.#projectAliasCache.set(
          project.projectKey,
          typeof project.alias === 'string' && project.alias.trim().length > 0
            ? project.alias
            : null,
        );
      }
    } catch {
      this.#log('projects_history_unavailable');
    }
    return this.#projectAliasCache.get(projectKey) ?? null;
  }

  /**
   * The T4B2 identity header of a LIVE session: per-session alias, project
   * alias fallback, label, branch and project color. Never throws; unusable
   * metadata degrades inside the copy builder to the neutral fallback.
   */
  #sessionHeader(session) {
    const source = isPlainObject(session) ? session : {};
    return copy.identityHeader({
      colorSlot: this.#colorSlotOf(source.projectKey),
      sessionAlias: typeof source.alias === 'string' ? source.alias : null,
      projectAlias: this.#projectAliasFor(source.projectKey),
      label: source.label,
      branch: source.branch,
    });
  }

  /**
   * The T4B2 identity header of a drained event. A valid T4B1 snapshot
   * (non-null project key) is used AS A WHOLE: a snapshot alias/branch
   * that was null stays null — never filled from later live state. The
   * project alias MAY be the current project-level fallback by project
   * key; the frozen session alias still wins over it. ONLY an all-null
   * legacy snapshot may fall back to the live identity cache.
   */
  #eventHeader(event) {
    const projectKey = isPlainObject(event)
      && typeof event.projectKey === 'string' && event.projectKey.length > 0
      ? event.projectKey
      : null;
    if (projectKey !== null) {
      return copy.identityHeader({
        colorSlot: this.#colorSlotOf(projectKey),
        sessionAlias: typeof event.alias === 'string' ? event.alias : null,
        projectAlias: this.#projectAliasFor(projectKey),
        label: typeof event.label === 'string' ? event.label : null,
        branch: typeof event.branch === 'string' ? event.branch : null,
      });
    }
    const identity = isPlainObject(event)
      ? this.#identityCache.get(event.trackingId)
      : undefined;
    if (identity !== undefined) {
      return copy.identityHeader({
        colorSlot: this.#colorSlotOf(identity.projectKey),
        sessionAlias: identity.alias,
        projectAlias: this.#projectAliasFor(identity.projectKey),
        label: identity.label,
        branch: identity.branch,
      });
    }
    return copy.identityHeader({});
  }

  /**
   * Session-scoped one-line acknowledgement under the session's full T4B2
   * identity header (the builder re-renders a prebuilt header verbatim).
   */
  #prefixed(session, message) {
    return copy.sessionNotice(this.#sessionHeader(session), message);
  }

  /** The exactly-one live session with this tracking id, or null. */
  #liveByTrackingId(trackingId) {
    const matches = this.#liveSessions().filter((session) => session.trackingId === trackingId);
    return matches.length === 1 ? matches[0] : null;
  }

  #shortIdOf(session) {
    return session !== null && SHORT_ID_RE.test(session.shortId) ? session.shortId : null;
  }

  /**
   * T03b general action row for a connected-session card: Status, Stop
   * (rendered ONLY while the live state is busy), Projects, Disconnect.
   * The destructive controls Stop and Disconnect carry style danger.
   */
  #sessionActionKeyboard(session) {
    const shortId = this.#shortIdOf(session);
    if (session === null || shortId === null) return null;
    const row = [{ text: copy.BUTTON_STATUS, callback_data: `v1:q:${shortId}` }];
    if (session.state === 'busy') {
      row.push({ text: copy.BUTTON_STOP, callback_data: `v1:x:${shortId}`, style: 'danger' });
    }
    row.push({ text: copy.BUTTON_PROJECTS, callback_data: 'v1:c' });
    row.push({ text: copy.BUTTON_DISCONNECT, callback_data: `v1:d:${shortId}`, style: 'danger' });
    return { inline_keyboard: [row] };
  }

  /**
   * Final-output cards may offer ONLY Projects and Disconnect — never
   * Stop after a final output — and only while the originating session is
   * still live. Disconnect is destructive and carries style danger.
   */
  #finalOutputKeyboard(session) {
    const shortId = this.#shortIdOf(session);
    if (session === null || shortId === null) return null;
    return { inline_keyboard: [[
      { text: copy.BUTTON_PROJECTS, callback_data: 'v1:c' },
      { text: copy.BUTTON_DISCONNECT, callback_data: `v1:d:${shortId}`, style: 'danger' },
    ]] };
  }

  /** Busy/interim status copy may expose ONLY the Stop button (danger). */
  #stopKeyboard(session) {
    const shortId = this.#shortIdOf(session);
    if (session === null || shortId === null) return null;
    return { inline_keyboard: [[{ text: copy.BUTTON_STOP, callback_data: `v1:x:${shortId}`, style: 'danger' }]] };
  }

  /**
   * Fixed, factual render only. Anything that is not one of the allowed
   * kinds — or whose payload is not in the exact expected shape — renders
   * as null and is acknowledged without being sent. Card keyboards ride
   * through the same single replyMarkup channel as the chooser and are
   * attached by #sendChunks to exactly one deterministic chunk.
   */
  #renderEvent(event) {
    // T4B2: the alias-aware identity header replaces the old label-only
    // prefix on the whole normal event path. A valid T4B1 snapshot is used
    // as a whole; only an all-null legacy snapshot falls back to the live
    // identity cache (see #eventHeader).
    const header = this.#eventHeader(event);
    const payload = isPlainObject(event.payload) ? event.payload : {};
    switch (event.kind) {
      case 'connected': {
        const session = this.#liveByTrackingId(event.trackingId);
        return {
          text: copy.eventConnected(header),
          replyMarkup: this.#sessionActionKeyboard(session),
        };
      }
      case 'disconnected':
        return { text: copy.eventDisconnected(header), replyMarkup: null };
      case 'final_output': {
        const text = typeof payload.text === 'string' && payload.text.length > 0
          ? payload.text
          : null;
        if (text === null) return null;
        // Built ONCE as a single string; #sendChunks splits it, so the
        // header appears exactly once and the keyboard stays on the final
        // chunk.
        return {
          text: `${copy.displayLabel(header)}\n${clip(text, MAX_TEXT_CHARS)}`,
          replyMarkup: this.#finalOutputKeyboard(this.#liveByTrackingId(event.trackingId)),
        };
      }
      case 'status': {
        const state = typeof payload.state === 'string' ? payload.state : null;
        return {
          // Beginner status shows state and model only — never cwd, pid or
          // session ids (BEGINNER_UX.md sections 2 and 11). The model stays
          // body-only: the header is identity.
          text: copy.eventStatus(header, payload),
          replyMarkup: state === 'busy'
            ? this.#stopKeyboard(this.#liveByTrackingId(event.trackingId))
            : null,
        };
      }
      case 'command_result': {
        const ok = payload.ok === true;
        return {
          text: copy.eventCommandResult(header, ok, payload.resultCode),
          replyMarkup: null,
        };
      }
      case 'choice_request': {
        const choice = this.#validateChoiceRequest(event, payload);
        if (choice === null) return null; // refused: fixed code logged, acked silently
        this.#pruneExpiredChoices();
        const existing = this.#pendingChoices.get(choice.requestId);
        if (existing !== undefined) {
          // An exact retry of a still-live registered request (same tracking
          // id AND the same current connection) is acknowledged without
          // resending; any other collision fails closed without evicting
          // or overwriting the live entry.
          if (existing.trackingId === choice.trackingId
            && existing.connectionId === choice.connectionId) {
            return null;
          }
          this.#log('choice_conflict');
          return null;
        }
        // One pending request per session; a live request is never evicted.
        if (this.#pendingChoiceFor(choice.trackingId) !== null) {
          this.#log('choice_conflict');
          return null;
        }
        if (this.#pendingChoices.size >= MAX_PENDING_CHOICES) {
          this.#log('choice_capacity');
          return null;
        }
        // Build the card ONCE and require a non-empty string: a question
        // that sanitizes fully away (whitespace-only, a bare tg id, hex
        // token, path or pid) makes the copy builder return null. Emitting
        // that would send zero chunks, report 'sent' and register an
        // INVISIBLE pending choice — the same fail-closed refusal instead.
        const card = copy.choiceCard({ header, question: payload.question, options: payload.options });
        if (typeof card !== 'string' || card.length === 0) {
          this.#log('choice_refused');
          return null;
        }
        return {
          text: card,
          replyMarkup: this.#choiceKeyboard(payload),
          pendingChoice: choice,
        };
      }
      default:
        return null;
    }
  }

  /**
   * T2B1 defensive re-validation of an already-Store-validated
   * `choice_request` payload. Fails closed (null, one fixed code, no echo)
   * for anything structurally unsafe: a bad shape, an expired deadline, a
   * credential shape in the question or any option text, or a tracking id
   * that does not resolve to exactly one currently live session with a
   * valid current connection id. Returns the plain registration subject
   * {requestId, trackingId, connectionId, optionCount, expiresAt} — never
   * option text or values.
   */
  #validateChoiceRequest(event, payload) {
    const structurallySafe = isPlainObject(payload)
      && typeof payload.requestId === 'string'
      && CHOICE_REQUEST_ID_RE.test(payload.requestId)
      && typeof payload.question === 'string' && payload.question.length > 0
      && Array.isArray(payload.options)
      && payload.options.length >= MIN_CHOICE_OPTIONS
      && payload.options.length <= MAX_CHOICE_OPTIONS
      && payload.options.every((option) => isPlainObject(option)
        && typeof option.label === 'string'
        && typeof option.description === 'string')
      && safeInt(payload.expiresAt) !== null
      && payload.expiresAt > this.#now();
    if (!structurallySafe) {
      this.#log('choice_refused');
      return null;
    }
    const credentialShape = copy.containsCredentialShape(payload.question)
      || payload.options.some((option) =>
        copy.containsCredentialShape(option.label)
        || copy.containsCredentialShape(option.description));
    if (credentialShape) {
      this.#log('choice_refused');
      return null;
    }
    const session = this.#liveByTrackingId(event.trackingId);
    if (session === null
      || typeof session.connectionId !== 'string'
      || session.connectionId.length === 0) {
      this.#log('choice_refused');
      return null;
    }
    return {
      requestId: payload.requestId,
      trackingId: event.trackingId,
      connectionId: session.connectionId,
      optionCount: payload.options.length,
      expiresAt: payload.expiresAt,
    };
  }

  /**
   * The choice-card keyboard: one option per row (`v1:w:<requestId>:<index>`)
   * plus one Cancel row (`v1:W:<requestId>`). Callback data carries ONLY the
   * opaque request id and the zero-based index — never labels, descriptions,
   * values, tracking/connection/session ids or any environment detail — and
   * every emitted callback stays far below Telegram's 64-byte cap.
   */
  #choiceKeyboard(payload) {
    const rows = payload.options.map((option, index) => ([{
      text: copy.choiceOptionButton(index, option.label),
      callback_data: `v1:w:${payload.requestId}:${index}`,
    }]));
    rows.push([{ text: copy.CHOICE_BUTTON_CANCEL, callback_data: `v1:W:${payload.requestId}` }]);
    return { inline_keyboard: rows };
  }

  /** Prune expired (expiresAt <= now) and malformed entries in place. */
  #pruneExpiredChoices() {
    const now = this.#now();
    for (const [requestId, entry] of this.#pendingChoices) {
      if (!isPlainObject(entry) || safeInt(entry.expiresAt) === null || entry.expiresAt <= now) {
        this.#pendingChoices.delete(requestId);
      }
    }
  }

  /** The live pending choice for a tracking id, or null (prunes first). */
  #pendingChoiceFor(trackingId) {
    this.#pruneExpiredChoices();
    for (const entry of this.#pendingChoices.values()) {
      if (entry.trackingId === trackingId) return entry;
    }
    return null;
  }

  /**
   * Register a definitively sent pending choice. Never evicts or overwrites
   * a live entry: the pre-send validation already refused conflicts, so any
   * residual collision here is skipped with a fixed code instead.
   */
  #registerPendingChoice(choice) {
    this.#pruneExpiredChoices();
    if (this.#pendingChoices.size >= MAX_PENDING_CHOICES
      || this.#pendingChoices.has(choice.requestId)
      || this.#pendingChoiceFor(choice.trackingId) !== null) {
      this.#log('choice_register_refused');
      return;
    }
    this.#pendingChoices.set(choice.requestId, {
      trackingId: choice.trackingId,
      connectionId: choice.connectionId,
      optionCount: choice.optionCount,
      expiresAt: choice.expiresAt,
    });
  }

  #log(code, detail = null) {
    this.#logger({ code, brokerId: this.#ownerId, ...(isPlainObject(detail) ? detail : {}) });
  }
}
