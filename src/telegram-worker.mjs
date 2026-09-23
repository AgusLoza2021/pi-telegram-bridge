// Telegram worker for the Pi bridge (T03).
//
// Imports ONLY the Store, config-shaped objects, security primitives and
// the transport api — never PiAdapter/SessionHost. Every human decision,
// cancel or followup crosses the durable typed action queue; the worker
// can be restarted or killed at any time without touching the Pi child.

import { createHash, randomBytes } from 'node:crypto';

import { TelegramApiError } from './telegram-api.mjs';
import { authorize, chunkMessage, createRateLimiter } from './security.mjs';

const HELP_TEXT = [
  'Pi bridge commands:',
  '/help - this help',
  '/status - session states',
  '/pending - decisions waiting for you',
  '/details <id> - request details (+ re-show buttons)',
  '/cancel <id> - cancel a request',
  '/followup <session> <text> - prompt a session (when enabled)',
].join('\n');

const FEEDBACK_QUEUED = 'Decision queued.';
const FEEDBACK_NOT_ACTIVE = 'No longer active or already used.';
const FEEDBACK_EXPIRED = 'This request expired.';
const FEEDBACK_DETAILS = 'Details sent.';
const FEEDBACK_SEE_CHAT = 'See the chat.';

const MAX_OPTIONS = 8;
const MAX_TEXT_LENGTH = 4096;
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;

// M1-4: an unsupported select (zero, more than MAX_OPTIONS, or non-string
// entries) is never rendered into buttons and never silently dropped: a
// visible bounded notice is sent instead. Option values never leak.
const UNSUPPORTED_OPTIONS_NOTICE = (requestId) =>
  `Decision request ${requestId} cannot be shown: its options cannot be rendered safely. ` +
  `Send /cancel ${requestId} to cancel it.`;

const OUTBOUND_UNCERTAIN = new Set(['network', 'timeout', 'server', 'rate_limited', 'bad_response']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function iso(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown';
}

export class TelegramWorker {
  #store;
  #api;
  #config;
  #ownerId;
  #pid;
  #followupsEnabled;
  #maxKeyboardSendAttempts;
  #maxMessageChars;
  #now;
  #logger;
  #limiter;
  /**
   * Memory-only outbound throttle state: while non-zero, the current
   * throttle episode already logged its record and retries wait until this
   * timestamp instead of re-attempting (and re-logging) the limiter.
   */
  #outboundRetryNotBefore = 0;
  #started = false;

  /**
   * @param {object} options
   * @param {import('./store.mjs').Store} options.store durable queue + state
   * @param {object} options.api transport client (duck-typed: getUpdates,
   *   sendMessage, answerCallbackQuery, getWebhookInfo, getMe, close)
   * @param {object} options.config { telegram: { allowedUserId, allowedChatId },
   *   bridge: { maxMessageChars, rateLimit } }
   * @param {string} [options.ownerId] worker lease owner
   * @param {number} [options.pid]
   * @param {boolean} [options.followupsEnabled] OFF by default; T04 turns it
   *   on with the explicit deployment flag
   * @param {number} [options.maxKeyboardSendAttempts] bounded retries for the
   *   keyboard message before the row fails (recoverable via /details)
   * @param {() => number} [options.now]
   * @param {({code: string}) => void} [options.logger] fixed-code logging
   *   only: no tokens, URLs, bodies or identities
   */
  constructor({
    store,
    api,
    config,
    ownerId = 'telegram-worker',
    pid = process.pid,
    followupsEnabled = false,
    maxKeyboardSendAttempts = 5,
    now = Date.now,
    logger = () => {},
  }) {
    if (!store || typeof store.withTransaction !== 'function') {
      throw new TypeError('store is required');
    }
    if (!api || typeof api !== 'object') {
      throw new TypeError('api is required');
    }
    if (!isPlainObject(config?.telegram) || !isPlainObject(config?.bridge)) {
      throw new TypeError('config must contain telegram and bridge objects');
    }
    this.#store = store;
    this.#api = api;
    this.#config = config;
    this.#ownerId = ownerId;
    this.#pid = pid;
    this.#followupsEnabled = followupsEnabled === true;
    this.#maxKeyboardSendAttempts = maxKeyboardSendAttempts;
    const maxMessageChars = config.bridge.maxMessageChars;
    if (!Number.isInteger(maxMessageChars) || maxMessageChars < 2 || maxMessageChars > 3800) {
      throw new RangeError('bridge.maxMessageChars must be an integer between 2 and 3800');
    }
    this.#maxMessageChars = maxMessageChars;
    this.#now = now;
    this.#logger = typeof logger === 'function' ? logger : () => {};
    this.#limiter = createRateLimiter(config.bridge.rateLimit);
  }

  // --- lifecycle ---------------------------------------------------------

  /**
   * Verify the transport and take the singleton worker lease. Refuses to
   * poll while a webhook is configured (getUpdates would 409); deleting
   * the webhook is a human decision, never automatic.
   */
  async start() {
    const info = await this.#api.getWebhookInfo();
    if (isPlainObject(info) && typeof info.url === 'string' && info.url.length > 0) {
      const error = new Error('worker start refused: a webhook is configured');
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
    const lease = this.#store.acquireWorkerLease({ ownerId: this.#ownerId, pid: this.#pid });
    if (!lease.ok) {
      const error = new Error('worker lease is held by a live process');
      error.code = 'WORKER_LEASE_BUSY';
      this.#log('worker_lease_busy');
      throw error;
    }
    this.#started = true;
    this.#log('worker_started');
  }

  /**
   * Poll loop. Stops on authorization failures, conflicts and aborts;
   * transient poll errors are logged and retried next cycle.
   */
  async run({ signal = undefined, pollGapMs = 300, cycles = Infinity } = {}) {
    await this.start();
    for (let i = 0; i < cycles && !signal?.aborted; i++) {
      const result = await this.pollOnce(signal);
      if (result.stopped) {
        this.#log(result.stopped);
        return result;
      }
      await this.drainPending();
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
        offset: this.#store.getTransportOffset(),
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
        // handleUpdate never advances the offset on its own throw paths
        // beyond receipt; a throwing bug must not wedge the loop.
        this.#log('update_error');
      }
    }
    return { processed };
  }

  /**
   * Drain the pending outbox strictly in order (oldest first, one row per
   * iteration) so a keyboard is never sent before its context.
   */
  async drainPending() {
    for (let guard = 0; guard < 1000; guard++) {
      const processed = await this.drainOnce();
      if (!processed) break;
    }
  }

  /** Process exactly one pending outbox row. Returns true when it did work. */
  async drainOnce() {
    const rows = this.#store.listPendingOutbox();
    if (rows.length === 0) return false;
    const row = rows[0];
    switch (row.kind) {
      case 'approval_request':
        this.#renderApprovalRequest(row);
        return true;
      case 'notification':
        this.#renderNotification(row);
        return true;
      case 'decision_applied':
        this.#renderDecisionApplied(row);
        return true;
      case 'tg_text':
        await this.#sendText(row);
        return true;
      case 'tg_keyboard':
        await this.#sendKeyboard(row);
        return true;
      case 'tg_callback':
        await this.#answerCallback(row);
        return true;
      default:
        // Unknown kinds fail closed: handled, never crashed, nothing sent.
        this.#store.markOutboxDelivered(row.outboxId);
        this.#log('unknown_outbox_kind');
        return true;
    }
  }

  /** Release the lease and close the transport. Never touches Pi stdin. */
  async dispose() {
    this.#started = false;
    try {
      await this.#api.close();
    } catch {
      this.#log('close_error');
    }
    this.#store.releaseWorkerLease({ ownerId: this.#ownerId });
  }

  // --- update handling (atomic unit) --------------------------------------

  /**
   * One atomic unit per update: receipt -> planning -> action/outbox rows
   -> offset advance, all inside a single store transaction. A planning
   * error drops the update safely (receipt + offset still commit) so a
   * bug can never wedge the offset or fabricate a decision.
   */
  handleUpdate(update) {
    const parsed = this.#classifyUpdate(update);
    if (parsed === null) {
      this.#log('update_rejected');
      return;
    }
    const { updateId, type, payload } = parsed;
    const inboxId = `tg:${updateId}`;
    const offset = updateId + 1;
    this.#store.withTransaction(() => {
      const first = this.#store.recordInbox({ inboxId, kind: type, payload: { type } });
      if (!first) return; // re-delivery: no repeated decision, no duplicate replies
      if (type === 'rejected_kind') {
        // Edited messages, channel posts, business events, unknown types:
        // receipt + offset advance only; the content is never interpreted.
        this.#log('update_rejected');
        this.#store.advanceTransportOffset(offset);
        return;
      }
      try {
        const plan = type === 'message'
          ? this.#planMessage(payload)
          : this.#planCallback(payload);
        for (const row of plan.replies) this.#store.enqueueOutbox(row);
        for (const action of plan.actions) this.#store.enqueueAction(action);
      } catch {
        this.#log('update_error');
      }
      this.#store.advanceTransportOffset(offset);
    });
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
    // Edited messages, channel posts, business events, unknown types:
    // consume them (persist receipt + advance) and ignore their content.
    return { updateId, type: 'rejected_kind', payload: null };
  }

  #planMessage(message) {
    if (isPlainObject(message.sender_chat)) {
      // Anonymous/channel impersonation: silent, fixed code only.
      this.#log('auth_rejected');
      return { replies: [], actions: [] };
    }
    const fromId = isPlainObject(message.from) ? message.from.id : null;
    const chatId = isPlainObject(message.chat) ? message.chat.id : null;
    const auth = authorize({ userId: fromId, chatId }, this.#config);
    if (!auth.allowed) {
      this.#log('auth_rejected');
      return { replies: [], actions: [] };
    }
    const text = typeof message.text === 'string' ? message.text : null;
    if (text === null) {
      this.#log('ignore');
      return { replies: [], actions: [] };
    }
    if (!this.#limiter.take('inbound', this.#now()).allowed) {
      // Offset still advances (receipt is durable); just no replies.
      this.#log('rate_limited_inbound');
      return { replies: [], actions: [] };
    }
    if (text.startsWith('/')) return this.#planCommand(text);
    return this.#planFreeText(text);
  }

  // --- commands -----------------------------------------------------------

  #planCommand(text) {
    const newlineAt = text.indexOf('\n');
    const firstLine = newlineAt === -1 ? text : text.slice(0, newlineAt);
    const rest = newlineAt === -1 ? '' : text.slice(newlineAt + 1);
    const match = /^\/([a-zA-Z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/.exec(firstLine);
    if (!match) {
      return { replies: [{ kind: 'tg_text', payload: { text: HELP_TEXT } }], actions: [] };
    }
    const name = match[1].toLowerCase();
    let args = match[2] ?? '';
    if (rest.length > 0) args = args.length > 0 ? `${args}\n${rest}` : rest;

    switch (name) {
      case 'start':
      case 'help':
        return { replies: [{ kind: 'tg_text', payload: { text: HELP_TEXT } }], actions: [] };
      case 'status':
        return this.#planStatus();
      case 'pending':
        return this.#planPending();
      case 'details':
        return this.#planDetails(args);
      case 'cancel':
        return this.#planCancel(args);
      case 'followup':
        return this.#planFollowup(args);
      default:
        return { replies: [{ kind: 'tg_text', payload: { text: HELP_TEXT } }], actions: [] };
    }
  }

  #planStatus() {
    const sessions = this.#store.listSessions();
    const pending = this.#store.listRecoverableRequests().length;
    const lines = ['Pi status:'];
    for (const session of sessions) {
      lines.push(`session ${session.sessionId}: ${session.activeRequestState ?? 'idle'}`);
    }
    lines.push(`Pending decisions: ${pending}`);
    return { replies: [{ kind: 'tg_text', payload: { text: lines.join('\n') } }], actions: [] };
  }

  #planPending() {
    const requests = this.#store.listRecoverableRequests();
    if (requests.length === 0) {
      return { replies: [{ kind: 'tg_text', payload: { text: 'No pending decisions.' } }], actions: [] };
    }
    const lines = ['Pending decisions:'];
    for (const request of requests) {
      const method = request.action?.method ?? 'unknown';
      const title = request.action?.title ?? '';
      let line = `${request.requestId} [session ${request.sessionId}] ${method}${title ? ` — ${title}` : ''}`;
      const summary = this.#store.outboxRequestSummary(request.requestId);
      if (summary.failedKeyboard > 0) {
        line += `\n  Buttons failed to deliver; send /details ${request.requestId} to re-show them.`;
      }
      lines.push(line);
    }
    return { replies: [{ kind: 'tg_text', payload: { text: lines.join('\n') } }], actions: [] };
  }

  #planDetails(args) {
    const id = args.trim().split(/\s+/)[0] ?? '';
    if (!REQUEST_ID_PATTERN.test(id)) {
      return { replies: [{ kind: 'tg_text', payload: { text: 'Usage: /details <id>' } }], actions: [] };
    }
    const request = this.#store.getRequest(id);
    if (request === null) {
      return { replies: [{ kind: 'tg_text', payload: { text: 'Request not found.' } }], actions: [] };
    }
    const replies = [{ requestId: id, kind: 'tg_text', payload: { text: this.#renderRequest(request) } }];
    const actions = [];
    // Recovery: re-show the full context + a fresh keyboard when the
    // request is still waiting and its keyboard was never delivered or
    // failed definitively. Fresh tokens keep single-use semantics.
    if (request.state === 'waiting_decision') {
      const summary = this.#store.outboxRequestSummary(id);
      if (summary.totalKeyboard === 0 || summary.failedKeyboard > 0) {
        this.#enqueueApprovalKeyboard(id, replies, actions);
      }
    }
    return { replies, actions };
  }

  #planCancel(args) {
    const id = args.trim().split(/\s+/)[0] ?? '';
    if (!REQUEST_ID_PATTERN.test(id)) {
      return { replies: [{ kind: 'tg_text', payload: { text: 'Usage: /cancel <id>' } }], actions: [] };
    }
    const request = this.#store.getRequest(id);
    if (request === null || !['running', 'waiting_decision'].includes(request.state)) {
      return { replies: [{ kind: 'tg_text', payload: { text: 'Request is no longer active.' } }], actions: [] };
    }
    const enqueued = this.#store.enqueueAction({
      actionId: `cancel:${id}`,
      type: 'cancel',
      payload: { requestId: id },
    });
    if (!enqueued) this.#log('action_duplicate');
    return {
      replies: [{ kind: 'tg_text', payload: { text: `Cancel queued for ${id}.` } }],
      actions: [],
    };
  }

  #planFollowup(args) {
    if (!this.#followupsEnabled) {
      // Default-DENIED: the deployment flag (T04) turns this on.
      return {
        replies: [{ kind: 'tg_text', payload: { text: 'Followups are disabled in this deployment.' } }],
        actions: [],
      };
    }
    const trimmed = args.trim();
    const spaceAt = trimmed.search(/\s/);
    const session = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
    const text = spaceAt === -1 ? '' : trimmed.slice(spaceAt + 1).trim();
    if (session.length === 0 || text.length === 0) {
      return { replies: [{ kind: 'tg_text', payload: { text: 'Usage: /followup <session> <text>' } }], actions: [] };
    }
    const known = this.#store.listSessions().some((s) => s.sessionId === session);
    if (!known) {
      return { replies: [{ kind: 'tg_text', payload: { text: 'Session not found.' } }], actions: [] };
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return { replies: [{ kind: 'tg_text', payload: { text: 'Refused: text too long.' } }], actions: [] };
    }
    if (text.split('\n').some((line) => line.startsWith('/'))) {
      // Mirror of the host rule: commands must never ride inside a prompt.
      return {
        replies: [{ kind: 'tg_text', payload: { text: 'Refused: slash commands are not allowed in followup text.' } }],
        actions: [],
      };
    }
    const enqueued = this.#store.enqueueAction({
      actionId: `followup:${sha256(`${session}\u0000${text}`)}`,
      type: 'followup',
      payload: { sessionId: session, text },
    });
    if (!enqueued) this.#log('action_duplicate');
    return {
      replies: [{ kind: 'tg_text', payload: { text: `Followup queued for ${session}.` } }],
      actions: [],
    };
  }

  // --- free text ------------------------------------------------------------

  #planFreeText(text) {
    if (text.length > MAX_TEXT_LENGTH) {
      return { replies: [{ kind: 'tg_text', payload: { text: 'Refused: text too long.' } }], actions: [] };
    }
    if (text.split('\n').some((line) => line.startsWith('/'))) {
      this.#log('input_refused');
      return {
        replies: [{
          kind: 'tg_text',
          payload: {
            text: 'Refused: slash commands are not accepted in free text. Use /followup <session> <text> to prompt a session.',
          },
        }],
        actions: [],
      };
    }
    const currentGeneration = this.#store.getHostGeneration();
    const now = this.#now();
    const awaiting = this.#store
      .listRecoverableRequests()
      .filter((request) =>
        request.action?.method === 'input'
        && request.expiresAt > now
        && request.hostGeneration === currentGeneration);
    if (awaiting.length === 0) {
      return {
        replies: [{
          kind: 'tg_text',
          payload: { text: 'No text input is currently awaited. Use /followup <session> <text> to prompt a session.' },
        }],
        actions: [],
      };
    }
    if (awaiting.length > 1) {
      // Ambiguity fails closed: never guess which session gets the text.
      return {
        replies: [{
          kind: 'tg_text',
          payload: { text: 'Multiple sessions await input; ambiguous. Use /followup <session> <text>.' },
        }],
        actions: [],
      };
    }
    const request = awaiting[0];
    const enqueued = this.#store.enqueueAction({
      actionId: `input:${request.requestId}:${sha256(text)}`,
      type: 'decision',
      payload: { requestId: request.requestId, decision: { value: text } },
    });
    if (!enqueued) this.#log('action_duplicate');
    return {
      replies: [{ kind: 'tg_text', payload: { text: `Input queued for ${request.requestId}.` } }],
      actions: [],
    };
  }

  // --- callback queries -------------------------------------------------------

  #planCallback(cq) {
    const messageId = isPlainObject(cq.message) ? cq.message : null;
    if (messageId === null || !isPlainObject(messageId.chat)) {
      // Inline mode (no message/chat): cannot attribute the chat; silent.
      this.#log('callback_missing_chat');
      return { replies: [], actions: [] };
    }
    if (isPlainObject(messageId.sender_chat)) {
      this.#log('auth_rejected');
      return { replies: [], actions: [] };
    }
    const fromId = isPlainObject(cq.from) ? cq.from.id : null;
    const auth = authorize({ userId: fromId, chatId: messageId.chat.id }, this.#config);
    if (!auth.allowed) {
      this.#log('auth_rejected');
      return { replies: [], actions: [] };
    }
    const data = typeof cq.data === 'string' ? cq.data : null;
    if (data === null || Buffer.byteLength(data, 'utf8') > 64) {
      this.#log('callback_invalid');
      return { replies: [], actions: [] };
    }
    const feedback = (text) => ({ kind: 'tg_callback', payload: { callbackQueryId: safeInt(cq.id) !== null ? String(cq.id) : String(cq.id ?? ''), text } });
    const consumed = this.#store.consumeCallbackToken({ token: data, now: this.#now() });
    if (!consumed.ok) {
      this.#log('callback_invalid');
      return {
        replies: [feedback(FEEDBACK_NOT_ACTIVE)],
        actions: [],
      };
    }
    const request = this.#store.getRequest(consumed.requestId);
    if (consumed.kind === 'details') {
      if (request === null) {
        return { replies: [feedback(FEEDBACK_NOT_ACTIVE)], actions: [] };
      }
      return {
        replies: [
          { kind: 'tg_text', payload: { text: this.#renderRequest(request) } },
          feedback(FEEDBACK_DETAILS),
        ],
        actions: [],
      };
    }
    if (consumed.kind === 'cancel') {
      return {
        replies: [
          {
            kind: 'tg_text',
            payload: { text: `To cancel request ${consumed.requestId} send: /cancel ${consumed.requestId}` },
          },
          feedback(FEEDBACK_SEE_CHAT),
        ],
        actions: [],
      };
    }
    // kind === 'decision': validate the request BEFORE claiming anything.
    if (request === null || request.state !== 'waiting_decision') {
      this.#log('callback_invalid');
      return { replies: [feedback(FEEDBACK_NOT_ACTIVE)], actions: [] };
    }
    if (request.expiresAt <= this.#now()) {
      return { replies: [feedback(FEEDBACK_EXPIRED)], actions: [] };
    }
    if (request.hostGeneration !== this.#store.getHostGeneration()) {
      this.#log('callback_invalid');
      return { replies: [feedback(FEEDBACK_EXPIRED)], actions: [] };
    }
    if (!this.#decisionMatchesDialog(request, consumed.decision)) {
      this.#log('callback_invalid');
      return { replies: [feedback(FEEDBACK_NOT_ACTIVE)], actions: [] };
    }
    const enqueued = this.#store.enqueueAction({
      actionId: `cb:${data}`,
      type: 'decision',
      payload: { requestId: consumed.requestId, decision: consumed.decision },
    });
    if (!enqueued) this.#log('action_duplicate');
    return {
      replies: [
        feedback(FEEDBACK_QUEUED),
        { kind: 'tg_text', payload: { text: `Decision for ${consumed.requestId} queued.` } },
      ],
      actions: [],
    };
  }

  /** The token binding must exactly match the dialog method/shape. */
  #decisionMatchesDialog(request, decision) {
    if (!isPlainObject(decision) || !isPlainObject(request.action)) return false;
    const method = request.action.method;
    if (method === 'confirm') {
      return Object.keys(decision).length === 1 && typeof decision.confirmed === 'boolean';
    }
    if (method === 'select') {
      return Object.keys(decision).length === 1
        && typeof decision.value === 'string'
        && Array.isArray(request.action.options)
        && request.action.options.includes(decision.value);
    }
    if (method === 'input') {
      return Object.keys(decision).length === 1
        && typeof decision.value === 'string'
        && decision.value.length >= 1
        && decision.value.length <= MAX_TEXT_LENGTH;
    }
    return false;
  }

  // --- outbound rendering ------------------------------------------------------

  #renderApprovalRequest(row) {
    const requestId = row.payload?.requestId;
    if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
      this.#store.markOutboxDelivered(row.outboxId);
      this.#log('approval_stale');
      return;
    }
    const request = this.#store.getRequest(requestId);
    if (request === null || request.state !== 'waiting_decision') {
      // Stale render job: nothing to ask, mark handled (never fabricate).
      this.#store.markOutboxDelivered(row.outboxId);
      this.#log('approval_stale');
      return;
    }
    const replies = [];
    const actions = [];
    // Option validation and batch generation live in the COMMON render
    // path so the initial render and /details re-render behave alike.
    this.#enqueueApprovalKeyboard(requestId, replies, actions);
    for (const reply of replies) this.#store.enqueueOutbox(reply);
    for (const action of actions) this.#store.enqueueAction(action);
    this.#store.markOutboxDelivered(row.outboxId);
  }

  /**
   * Common approval render path (used by the initial approval_request
   * render AND the /details re-render): builds the context chunks +
   * keyboard rows for a waiting request. Every row is attributed to the
   * request and stamped with ONE fresh batchId so the keyboard's dispatch
   * guard can verify the readiness of ITS OWN batch. Unsupported select
   * options produce a visible bounded notice instead of a keyboard —
   * never a manufactured subset, never a malformed payload, never a
   * silent drop.
   */
  #enqueueApprovalKeyboard(requestId, replies, actions) {
    const request = this.#store.getRequest(requestId);
    if (request === null || request.state !== 'waiting_decision') return false;
    const method = request.action?.method;
    if (method === 'select') {
      const options = Array.isArray(request.action.options) ? request.action.options : [];
      const renderable = options.length >= 1 && options.length <= MAX_OPTIONS && options.every((o) => typeof o === 'string');
      if (!renderable) {
        replies.push({
          requestId,
          kind: 'tg_text',
          payload: { text: UNSUPPORTED_OPTIONS_NOTICE(requestId) },
        });
        this.#log('approval_unsupported_options');
        return false;
      }
    }
    // One fresh batch per render: the keyboard is authorized by exactly
    // the context rows created alongside it, never by request history.
    const batchId = randomBytes(16).toString('hex');
    const keyboard = [];
    if (method === 'select') {
      const options = request.action.options ?? [];
      keyboard.push(options.map((option) => ({
        text: option,
        callback_data: this.#store.createCallbackToken({
          requestId,
          kind: 'decision',
          decision: { value: option },
        }).token,
      })));
    } else if (method === 'confirm') {
      keyboard.push([
        {
          text: 'Aprobar',
          callback_data: this.#store.createCallbackToken({
            requestId,
            kind: 'decision',
            decision: { confirmed: true },
          }).token,
        },
        {
          text: 'Rechazar',
          callback_data: this.#store.createCallbackToken({
            requestId,
            kind: 'decision',
            decision: { confirmed: false },
          }).token,
        },
      ]);
    }
    keyboard.push([
      { text: 'Details', callback_data: this.#store.createCallbackToken({ requestId, kind: 'details' }).token },
      { text: 'Cancel task', callback_data: this.#store.createCallbackToken({ requestId, kind: 'cancel' }).token },
    ]);
    const context = this.#renderRequest(request);
    const chunks = chunkMessage(context, this.#maxMessageChars);
    for (const chunk of chunks) {
      replies.push({ requestId, kind: 'tg_text', payload: { text: chunk, batchId }, batchId });
    }
    replies.push({
      requestId,
      kind: 'tg_keyboard',
      payload: { requestId, batchId, text: `Decision request ${requestId}`, replyMarkup: { inline_keyboard: keyboard } },
      batchId,
    });
    return true;
  }

  #renderRequest(request) {
    const action = isPlainObject(request.action) ? request.action : {};
    const lines = [
      'Pi decision request',
      `Request: ${request.requestId}`,
      `Session: ${request.sessionId}`,
      `Type: ${action.method ?? 'unknown'}`,
      `Title: ${action.title ?? 'unknown'}`,
      `Summary: ${action.summary ?? 'unknown'}`,
      `Risk: ${action.risk ?? 'unknown'}`,
      `Created: ${iso(request.createdAt)}`,
      `Expires: ${iso(request.expiresAt)}`,
    ];
    if (action.method === 'select' && Array.isArray(action.options)) {
      lines.push('Options:', ...action.options.map((option) => `- ${option}`));
    }
    if (action.method === 'confirm') {
      lines.push('Answer with Aprobar / Rechazar.');
    }
    if (action.method === 'input') {
      lines.push('Reply with a text message to answer.');
    }
    return lines.join('\n');
  }

  #renderNotification(row) {
    const payload = isPlainObject(row.payload) ? row.payload : {};
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : 'unknown';
    const message = typeof payload.message === 'string' && payload.message.length > 0
      ? payload.message
      : '(no content)';
    const chunks = chunkMessage(`Pi notification (session ${sessionId}): ${message}`, this.#maxMessageChars);
    for (const chunk of chunks) {
      this.#store.enqueueOutbox({ requestId: row.requestId, kind: 'tg_text', payload: { text: chunk } });
    }
    this.#store.markOutboxDelivered(row.outboxId);
  }

  #renderDecisionApplied(row) {
    const requestId = row.payload?.requestId;
    let text;
    const request = typeof requestId === 'string' ? this.#store.getRequest(requestId) : null;
    if (request === null) {
      text = `Decision for ${requestId ?? 'unknown'} recorded.`;
    } else if (request.state === 'completed') {
      // Durable proof only: "applied" is claimed when the host observed it.
      text = `Decision applied for ${requestId}.`;
    } else if (request.state === 'resuming') {
      text = `Decision for ${requestId} queued; applying.`;
    } else {
      text = `Decision for ${requestId} recorded (state: ${request.state}).`;
    }
    const chunks = chunkMessage(text, this.#maxMessageChars);
    for (const chunk of chunks) {
      this.#store.enqueueOutbox({ requestId: row.requestId, kind: 'tg_text', payload: { text: chunk } });
    }
    this.#store.markOutboxDelivered(row.outboxId);
  }

  // --- outbound sending -------------------------------------------------------

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

  async #sendText(row) {
    if (!this.#takeOutbound().allowed) {
      return; // stays pending; next cycle retries
    }
    try {
      await this.#api.sendMessage({
        chatId: this.#config.telegram.allowedChatId,
        text: row.payload.text,
      });
    } catch (error) {
      const code = error instanceof TelegramApiError ? error.code : 'unknown';
      if (OUTBOUND_UNCERTAIN.has(code)) {
        // Uncertain: the message may or may not have arrived. Treat as
        // delivered — a duplicate notice is acceptable, a duplicate
        // decision is not, and text rows carry no decisions.
        this.#store.markOutboxDelivered(row.outboxId);
        this.#log('send_uncertain');
        return;
      }
      this.#store.markOutboxFailed(row.outboxId, code.slice(0, 64));
      this.#log('send_failed');
      return;
    }
    this.#store.markOutboxDelivered(row.outboxId);
  }

  async #sendKeyboard(row) {
    const payload = isPlainObject(row.payload) ? row.payload : {};
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
    const batchId = typeof payload.batchId === 'string' && payload.batchId.length > 0 ? payload.batchId : null;
    // Dispatch guard (D1): scoped to the keyboard's OWN render batch. A
    // permanently failed chunk of an OLD render must never block a fresh
    // one; conversely, a failed chunk of THIS render always blocks.
    if (requestId !== null && batchId === null) {
      // Corrupted/stale keyboard without batch attribution: fail closed.
      this.#store.markOutboxFailed(row.outboxId, 'context_unverified');
      this.#log('approval_context_unverified');
      return;
    }
    if (batchId !== null) {
      const summary = this.#store.outboxBatchSummary(batchId);
      if (summary.failed > 0) {
        this.#store.markOutboxFailed(row.outboxId, 'context_lost');
        this.#log('approval_context_lost');
        return;
      }
      if (summary.delivered < summary.total) {
        // Context not fully delivered yet. Strict oldest-first ordering
        // resolves this next cycle; stay pending.
        this.#log('context_not_ready');
        return;
      }
    }
    if (row.attempts >= this.#maxKeyboardSendAttempts) {
      this.#store.markOutboxFailed(row.outboxId, 'max_attempts');
      this.#log('keyboard_max_attempts');
      return;
    }
    if (!this.#takeOutbound().allowed) {
      return; // stays pending; next cycle retries
    }
    try {
      await this.#api.sendMessage({
        chatId: this.#config.telegram.allowedChatId,
        text: payload.text ?? '',
        replyMarkup: payload.replyMarkup ?? undefined,
      });
    } catch (error) {
      const code = error instanceof TelegramApiError ? error.code : 'unknown';
      if (OUTBOUND_UNCERTAIN.has(code)) {
        // Uncertain: bounded retries, never silent loss — /pending and
        // /details can always re-show the question.
        this.#store.incrementOutboxAttempts(row.outboxId);
        this.#log('send_uncertain');
        return;
      }
      this.#store.markOutboxFailed(row.outboxId, code.slice(0, 64));
      this.#log('send_failed');
      return;
    }
    this.#store.markOutboxDelivered(row.outboxId);
  }

  async #answerCallback(row) {
    const payload = isPlainObject(row.payload) ? row.payload : {};
    const callbackQueryId = typeof payload.callbackQueryId === 'string' ? payload.callbackQueryId : '';
    if (callbackQueryId.length === 0 || callbackQueryId.length > 128) {
      this.#store.markOutboxDelivered(row.outboxId);
      this.#log('callback_invalid');
      return;
    }
    try {
      await this.#api.answerCallbackQuery({
        callbackQueryId,
        text: payload.text ?? '',
      });
    } catch (error) {
      const code = error instanceof TelegramApiError ? error.code : 'unknown';
      if (OUTBOUND_UNCERTAIN.has(code)) {
        // A repeated answer is a harmless no-op on Telegram's side.
        this.#store.markOutboxDelivered(row.outboxId);
        this.#log('send_uncertain');
        return;
      }
      this.#store.markOutboxFailed(row.outboxId, code.slice(0, 64));
      this.#log('send_failed');
      return;
    }
    this.#store.markOutboxDelivered(row.outboxId);
  }

  // --- misc ---------------------------------------------------------------

  #log(code, detail = null) {
    this.#logger({ code, workerId: this.#ownerId, ...(isPlainObject(detail) ? detail : {}) });
  }
}
