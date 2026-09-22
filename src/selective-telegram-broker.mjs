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
// - Inline keyboards exist ONLY for the T03a/T03b bounded cards: the
//   session chooser (v1:r, v1:s:<sid>, v1:p:<sid>:<pid>), the busy
//   decision card (v1:f/t/a:<sid>:<pid>, v1:n:<pid>) and the action
//   keyboards (v1:q/x/d/D:<sid>, v1:c, v1:C). Data never carries labels,
//   prompt text, cwd, tokens or secrets; short ids stay inside
//   callback_data, never in beginner-visible card text. Authorized
//   callbacks get a best-effort answerCallbackQuery queued only AFTER the
//   transaction and offset commit (and only when the API implements it);
//   a failed answer never replays a command. Unauthorized or malformed
//   callbacks are dropped without replies.
// - Text payloads are bounded and any line whose first non-whitespace
//   character is '/' is rejected: remote input can never ride into local
//   extension commands, skills or prompt templates. '!', CMD and PowerShell
//   strings get no interpretation here — every accepted text is forwarded
//   verbatim as a typed prompt/steer/follow-up for the Pi extension.
// - Drained TUI events render ONLY: connected/disconnected notices,
//   requested factual status, finalized assistant output and fixed
//   command-result acknowledgements. Never thinking/reasoning, tool
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

import { TelegramApiError } from './telegram-api.mjs';
import { authorize, chunkMessage, createRateLimiter } from './security.mjs';
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
const CALLBACK_MAX_DATA_BYTES = 64;
const REFRESH_BUTTON_TEXT = 'Refresh';
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
 * Strict T03a/T03b callback grammar. Anything else — unknown version,
 * unknown action, bad shape — is null. Data carries only the version, the
 * action, the opaque session short id and the pending generation id: never
 * labels, prompt text, cwd or secrets.
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
  return null;
}

// Same uncertainty family the legacy worker treats as "may have arrived":
// the message may or may not exist on Telegram's side.
const OUTBOUND_UNCERTAIN = new Set(['network', 'timeout', 'server', 'rate_limited', 'bad_response']);

const USAGE = {
  use: 'Usage: /use <shortId> — see /sessions.',
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
   */
  constructor({
    store,
    api,
    config,
    ownerId = 'telegram-broker',
    now = Date.now,
    logger = () => {},
  }) {
    if (!store || typeof store.withTransaction !== 'function') {
      throw new TypeError('store is required');
    }
    if (typeof store.getBrokerTransportOffset !== 'function'
      || typeof store.advanceBrokerTransportOffset !== 'function'
      || typeof store.recordInbox !== 'function'
      || typeof store.listTuiSessions !== 'function'
      || typeof store.enqueueTuiCommand !== 'function'
      || typeof store.listPendingBrokerTuiEvents !== 'function'
      || typeof store.acknowledgeTuiEvents !== 'function') {
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
  }

  #store;
  #api;
  #config;
  #ownerId;
  #maxMessageChars;
  #now;
  #logger;
  #limiter;
  /** Memory-only selected tracking id; never persisted anywhere. */
  #selectedTrackingId = null;
  /** trackingId -> { label, shortId }; identity for prefixing drained events. */
  #identityCache = new Map();
  /** Bounded in-memory replies ({text, replyMarkup}) waiting to be flushed. */
  #pendingReplies = [];
  /** Broker-memory pending prompt {pendingId, text}; a restart loses it fail-closed. */
  #pendingPrompt = null;
  /** Bounded callback ids waiting for a best-effort answerCallbackQuery. */
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
    this.#log('broker_started');
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
        this.handleUpdate(update);
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
   */
  handleUpdate(update) {
    const parsed = this.#classifyUpdate(update);
    if (parsed === null) {
      this.#log('update_rejected');
      return;
    }
    const { updateId, type, payload } = parsed;
    const inboxId = `tgbroker:${updateId}`;
    const offset = updateId + 1;
    let callbackAnswerId = null;
    this.#store.withTransaction(() => {
      const first = this.#store.recordInbox({ inboxId, kind: type, payload: { type } });
      if (!first) return; // re-delivery: no repeated planning, no duplicate commands
      if (type === 'callback_query') {
        const plan = this.#planCallback(payload);
        if (plan !== null) {
          callbackAnswerId = plan.answerId;
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
          const plan = this.#planMessage(payload);
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
    if (callbackAnswerId !== null) {
      // Best-effort feedback, queued only AFTER the transaction (receipt,
      // commands and offset) committed inside the store.
      if (this.#pendingAnswers.length < MAX_PENDING_REPLIES) {
        this.#pendingAnswers.push(callbackAnswerId);
      } else {
        this.#log('reply_overflow');
      }
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
   * no-live guidance) and never dispatches anything.
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
          reply: this.#chooserReply(this.#pendingPrompt !== null),
          command: null,
        };
      case 'select': {
        const live = this.#liveSessions();
        const matches = live.filter((session) => session.shortId === parsed.shortId);
        if (matches.length !== 1) {
          // Dead, stale or ambiguous target: say the named Pi closed when it
          // is known, then re-render the safest current chooser.
          return {
            answerId,
            reply: this.#staleChooserReply(parsed.shortId, this.#pendingPrompt !== null),
            command: null,
          };
        }
        this.#selectedTrackingId = matches[0].trackingId;
        // MSG-T3 again, now naming the chosen session (BEGINNER_UX.md §6).
        return {
          answerId,
          reply: { text: copy.homeOne(matches[0].label) },
          command: null,
        };
      }
      case 'prompt': {
        const pending = this.#pendingPrompt;
        if (pending === null || pending.pendingId !== parsed.pendingId) {
          // A second tap, a replaced generation or a keyboard from before a
          // restart: the generation is consumed, never dispatched.
          this.#log('callback_pending_generation_stale');
          return {
            answerId,
            reply: this.#chooserReply(this.#pendingPrompt !== null),
            command: null,
          };
        }
        const live = this.#liveSessions();
        const matches = live.filter((session) => session.shortId === parsed.shortId);
        if (matches.length !== 1) {
          // Dead or ambiguous session: name it when known, keep the pending
          // prompt alive and re-render the current p-choices.
          this.#log('callback_target_not_live');
          return { answerId, reply: this.#staleChooserReply(parsed.shortId, true), command: null };
        }
        const [session] = matches;
        this.#selectedTrackingId = session.trackingId;
        this.#pendingPrompt = null;
        return {
          answerId,
          reply: null,
          command: {
            trackingId: session.trackingId,
            kind: 'prompt',
            payload: { text: clip(pending.text, MAX_TEXT_CHARS) },
            ackReply: { text: copy.pendingSent(session.label) },
            staleReply: { text: copy.sessionGone(session.label) },
          },
        };
      }
      case 'chooser':
        // v1:c — a fresh session chooser, identical safety to v1:r.
        return {
          answerId,
          reply: this.#chooserReply(this.#pendingPrompt !== null),
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
            reply: this.#staleChooserReply(parsed.shortId, this.#pendingPrompt !== null),
            command: null,
          };
        }
        const [session] = matches;
        return {
          answerId,
          reply: {
            text: copy.disconnectAsk(session.label),
            replyMarkup: { inline_keyboard: [[
              { text: copy.DISCONNECT_BUTTON, callback_data: `v1:D:${session.shortId}` },
              { text: copy.CANCEL_BUTTON, callback_data: 'v1:C' },
            ]] },
          },
          command: null,
        };
      }
      case 'disconnect_confirm':
        return this.#planSidCommand(parsed, 'disconnect', answerId);
      default:
        return { answerId, reply: null, command: null };
    }
  }

  /** The exactly-one live session with this short id, or null. */
  #liveByShortId(shortId) {
    const matches = this.#liveSessions().filter((session) => session.shortId === shortId);
    return matches.length === 1 ? matches[0] : null;
  }

  /** Shared fail-closed paths for the T03b busy callbacks. */
  #busyActionStaleGeneration(answerId) {
    // Missing or replaced generation: never dispatch; re-render the safest
    // current chooser (which carries the CURRENT generation when held).
    this.#log('callback_pending_generation_stale');
    return { answerId, reply: this.#chooserReply(this.#pendingPrompt !== null), command: null };
  }

  #busyActionTargetNotLive(answerId, shortId) {
    // Dead or ambiguous session: name the closed Pi when it is known, keep
    // the held prompt preserved for a retry against a live target, and
    // dispatch nothing.
    this.#log('callback_target_not_live');
    return { answerId, reply: this.#staleChooserReply(shortId, true), command: null };
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
    this.#selectedTrackingId = session.trackingId;
    return {
      answerId,
      reply: null,
      command: null,
      commands: [{
        trackingId: session.trackingId,
        kind,
        payload: { text: clip(pending.text, MAX_TEXT_CHARS) },
        ackReply: { text: copy.cbAck(kind, session.label) },
        staleReply: { text: copy.sessionGone(session.label) },
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
      return this.#busyActionTargetNotLive(answerId);
    }
    const [session] = matches;
    this.#selectedTrackingId = session.trackingId;
    return {
      answerId,
      reply: null,
      command: null,
      commands: [
        {
          trackingId: session.trackingId,
          kind: 'abort',
          payload: null,
          ackReply: { text: copy.cbAck('abort') },
          staleReply: { text: copy.sessionGone(session.label) },
        },
        {
          trackingId: session.trackingId,
          kind: 'prompt',
          payload: { text: clip(pending.text, MAX_TEXT_CHARS) },
          ackReply: { text: copy.cbAck('prompt_after_abort', session.label) },
          staleReply: { text: copy.sessionGone(session.label) },
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
    this.#selectedTrackingId = session.trackingId;
    return {
      answerId,
      reply: null,
      command: {
        trackingId: session.trackingId,
        kind,
        payload: null,
        ackReply: { text: copy.cbAck(kind, session.label) },
        staleReply: { text: copy.sessionGone(session.label) },
      },
    };
  }

  /** The last-known label for a short id, or null when it was never seen. */
  #lastKnownLabel(shortId) {
    for (const identity of this.#identityCache.values()) {
      if (identity.shortId === shortId) return identity.label;
    }
    return null;
  }

  /**
   * The stale/dead-target reply (T04): when the named Pi is known (it was
   * seen live earlier), say it just closed or disconnected, then show the
   * fresh readable choices — or the no-live guidance when none are left.
   * Never exposes the short id itself.
   */
  #staleChooserReply(shortId, withPending) {
    const chooser = this.#chooserReply(withPending);
    const label = this.#lastKnownLabel(shortId);
    if (label === null) return chooser;
    return {
      text: `${copy.sessionGone(label)}\n${chooser.text}`,
      replyMarkup: chooser.replyMarkup,
    };
  }

  /**
   * The safest current chooser: the no-live beginner guidance, or one
   * readable `Pi · <label>` button per live session plus Refresh. With a
   * pending prompt the buttons dispatch the CURRENT pending generation
   * (v1:p); without one they only select (v1:s). Short ids stay inside
   * callback_data, never in visible text.
   */
  #chooserReply(withPending) {
    const live = this.#liveSessions();
    if (live.length === 0) return { text: copy.homeNoLive };
    const pendingId = withPending && this.#pendingPrompt !== null
      ? this.#pendingPrompt.pendingId
      : null;
    const rows = live.slice(0, MAX_LISTED_SESSIONS).map((session) => [{
      text: copy.displayLabel(session.label),
      callback_data: pendingId !== null
        ? `v1:p:${session.shortId}:${pendingId}`
        : `v1:s:${session.shortId}`,
    }]);
    rows.push([{ text: REFRESH_BUTTON_TEXT, callback_data: 'v1:r' }]);
    return {
      text: pendingId !== null ? copy.pendingSaved : copy.homeMultiple,
      replyMarkup: { inline_keyboard: rows },
    };
  }

  #planMessage(message) {
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
    if (text === null) {
      this.#log('ignore');
      return { replies: [], commands: [] };
    }
    if (!this.#limiter.take('inbound', this.#now()).allowed) {
      // Offset still advances (receipt is durable); just no replies.
      this.#log('rate_limited_inbound');
      return { replies: [], commands: [] };
    }
    if (text.startsWith('/')) return this.#planCommand(text);
    return this.#planFreeText(text);
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
      case 'sessions':
        return this.#planSessions();
      case 'use':
        return this.#planUse(args);
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
   * action row, several present the readable chooser. No command is ever
   * enqueued from /start itself.
   */
  #planStart() {
    const live = this.#liveSessions();
    if (live.length === 0) {
      this.#selectedTrackingId = null;
      return { replies: [{ text: copy.homeNoLive }], commands: [] };
    }
    if (live.length === 1) {
      const [sole] = live;
      // Auto-select, mirroring the beginner plain-text rule.
      this.#selectedTrackingId = sole.trackingId;
      return {
        replies: [{
          text: copy.homeOne(sole.label),
          replyMarkup: this.#sessionActionKeyboard(sole),
        }],
        commands: [],
      };
    }
    return { replies: [this.#chooserReply(true)], commands: [] };
  }

  #planSessions() {
    const live = this.#liveSessions();
    if (live.length === 0) {
      return { replies: [NO_LIVE_SESSIONS_ADVANCED_NOTICE], commands: [] };
    }
    const lines = ['Live TUI sessions:'];
    for (const session of live.slice(0, MAX_LISTED_SESSIONS)) {
      const cwd = typeof session.cwd === 'string' && session.cwd.length > 0 ? session.cwd : '-';
      lines.push(`tg:${session.shortId} · ${boundedLabel(session.label)} · ${session.state} · ${cwd}`);
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
    this.#selectedTrackingId = target.session.trackingId;
    return { replies: [this.#prefixed(target.session, 'Selected.')], commands: [] };
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
    const staleReply = { text: copy.sessionGone(target.session.label) };
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
      text: copy.busyCard(session.label),
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
        return { replies: [this.#chooserReply(true)], commands: [] };
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
        staleReply: { text: copy.sessionGone(target.session.label) },
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
      this.#selectedTrackingId = null;
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
    this.#selectedTrackingId = null;
    // Beginner auto-selection: with exactly one live session, target it
    // directly (and remember it) instead of demanding /use — but ONLY for
    // ordinary plain text and /status, which also get the choice notice
    // with several live sessions. Advanced routed commands keep their
    // previous selection-required fail closed for EVERY live-session count.
    if (allowSoleAutoSelect) {
      if (live.length === 1) {
        const [sole] = live;
        this.#selectedTrackingId = sole.trackingId;
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
        this.#log(outcome === 'uncertain' ? 'send_uncertain'
          : outcome === 'rate_limited' ? 'rate_limited_outbound' : 'send_failed');
        return;
      }
      this.#store.acknowledgeTuiEvents({ eventIds: [event.eventId] });
    }
  }

  /**
   * Best-effort answerCallbackQuery flush: runs only when the injected API
   * implements it; a failed answer is dropped without retry and never
   * replays the command it acknowledged.
   */
  async #flushCallbackAnswers() {
    if (this.#pendingAnswers.length === 0) return;
    if (typeof this.#api.answerCallbackQuery !== 'function') {
      this.#pendingAnswers = [];
      return;
    }
    while (this.#pendingAnswers.length > 0) {
      const callbackQueryId = this.#pendingAnswers.shift();
      try {
        await this.#api.answerCallbackQuery({ callbackQueryId });
      } catch {
        this.#log('callback_answer_failed');
      }
    }
  }

  async #sendChunks(text, replyMarkup = null) {
    const chunks = chunkMessage(text, this.#maxMessageChars);
    for (let i = 0; i < chunks.length; i++) {
      if (!this.#limiter.take('outbound', this.#now()).allowed) {
        this.#log('rate_limited_outbound');
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
    try {
      const cutoff = this.#now() - DEFAULT_STALE_AFTER_MS;
      const sessions = this.#store.listTuiSessions({ staleCutoff: cutoff });
      for (const session of sessions) this.#rememberIdentity(session);
      if (this.#selectedTrackingId !== null) {
        const row = sessions.find((session) => session.trackingId === this.#selectedTrackingId);
        if (!row || row.live !== true) {
          // The selection went stale: clear it instead of routing blind.
          this.#selectedTrackingId = null;
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
      shortId,
    });
  }

  /**
   * The readable display label of a cached identity, or null when the
   * session was never seen. Beginner copy renders `Pi · <label>`; the
   * short id never reaches the text layer.
   */
  #labelFor(trackingId) {
    const identity = this.#identityCache.get(trackingId);
    return identity ? identity.label : null;
  }

  #prefixed(session, message) {
    return copy.sessionNotice(session.label, message);
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
   * (rendered ONLY while the live state is busy), Change Pi, Disconnect.
   */
  #sessionActionKeyboard(session) {
    const shortId = this.#shortIdOf(session);
    if (session === null || shortId === null) return null;
    const row = [{ text: copy.BUTTON_STATUS, callback_data: `v1:q:${shortId}` }];
    if (session.state === 'busy') {
      row.push({ text: copy.BUTTON_STOP, callback_data: `v1:x:${shortId}` });
    }
    row.push({ text: copy.BUTTON_CHANGE_PI, callback_data: 'v1:c' });
    row.push({ text: copy.BUTTON_DISCONNECT, callback_data: `v1:d:${shortId}` });
    return { inline_keyboard: [row] };
  }

  /**
   * Final-output cards may offer ONLY Change Pi and Disconnect — never
   * Stop after a final output — and only while the originating session is
   * still live.
   */
  #finalOutputKeyboard(session) {
    const shortId = this.#shortIdOf(session);
    if (session === null || shortId === null) return null;
    return { inline_keyboard: [[
      { text: copy.BUTTON_CHANGE_PI, callback_data: 'v1:c' },
      { text: copy.BUTTON_DISCONNECT, callback_data: `v1:d:${shortId}` },
    ]] };
  }

  /** Busy/interim status copy may expose ONLY the Stop button. */
  #stopKeyboard(session) {
    const shortId = this.#shortIdOf(session);
    if (session === null || shortId === null) return null;
    return { inline_keyboard: [[{ text: copy.BUTTON_STOP, callback_data: `v1:x:${shortId}` }]] };
  }

  /**
   * Fixed, factual render only. Anything that is not one of the allowed
   * kinds — or whose payload is not in the exact expected shape — renders
   * as null and is acknowledged without being sent. Card keyboards ride
   * through the same single replyMarkup channel as the chooser and are
   * attached by #sendChunks to exactly one deterministic chunk.
   */
  #renderEvent(event) {
    // T04: the label-only `Pi · <label>` identity replaces the old
    // [label · shortId] prefix on the whole normal event path.
    const label = this.#labelFor(event.trackingId) ?? '';
    const payload = isPlainObject(event.payload) ? event.payload : {};
    switch (event.kind) {
      case 'connected': {
        const session = this.#liveByTrackingId(event.trackingId);
        return {
          text: copy.eventConnected(label),
          replyMarkup: this.#sessionActionKeyboard(session),
        };
      }
      case 'disconnected':
        return { text: copy.eventDisconnected(label), replyMarkup: null };
      case 'final_output': {
        const text = typeof payload.text === 'string' && payload.text.length > 0
          ? payload.text
          : null;
        if (text === null) return null;
        return {
          text: `${copy.displayLabel(label)}\n${clip(text, MAX_TEXT_CHARS)}`,
          replyMarkup: this.#finalOutputKeyboard(this.#liveByTrackingId(event.trackingId)),
        };
      }
      case 'status': {
        const state = typeof payload.state === 'string' ? payload.state : null;
        return {
          // Beginner status shows state and model only — never cwd, pid or
          // session ids (BEGINNER_UX.md sections 2 and 11).
          text: copy.eventStatus(label, payload),
          replyMarkup: state === 'busy'
            ? this.#stopKeyboard(this.#liveByTrackingId(event.trackingId))
            : null,
        };
      }
      case 'command_result': {
        const ok = payload.ok === true;
        return {
          text: copy.eventCommandResult(label, ok, payload.resultCode),
          replyMarkup: null,
        };
      }
      default:
        return null;
    }
  }

  #log(code) {
    this.#logger({ code, brokerId: this.#ownerId });
  }
}
