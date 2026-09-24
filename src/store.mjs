// Durable single-use request/session state for the Pi Telegram bridge.
//
// Design invariants:
// - Every mutation is a transaction (BEGIN IMMEDIATE) on node:sqlite (WAL,
//   busy timeout) so two racing connections resolve to exactly one winner.
// - Decisions are recorded by compare-and-set: only waiting_decision ->
//   resuming, once. The host later completes only from an observed result
//   (resuming -> completed); sending bytes never counts as applied.
// - Requests bind to a session and to the host generation at creation time;
//   a generation bump invalidates old approvals (fail closed).
// - Recovery APIs only surface data; they never replay resuming actions.
// - Transport events are serialized: inbox dedups stable update ids, outbox
//   is ordered and delivery-marked (Telegram sends are at-least-once; the
//   bridge must tolerate duplicates on its side too).
// - Tracked live TUIs (tui_sessions/tui_events/tui_commands) are a separate
//   opt-in transport: connection ownership is compare-and-set, so a live
//   session is never silently stolen and replaced connections fail closed.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

export const REQUEST_STATES = Object.freeze([
  'running',
  'waiting_decision',
  'resuming',
  'completed',
  'failed',
  'expired',
  'cancelled',
]);

const ACTIVE_STATES = Object.freeze(['running', 'waiting_decision', 'resuming']);

// Tracked live Pi TUIs (selective opt-in transport). Closed sets: anything
// else fails closed before persistence. There is deliberately NO
// thinking/reasoning event kind — hidden model reasoning must never leave
// the TUI.
export const TUI_SESSION_STATES = Object.freeze(['connected', 'busy', 'waiting']);
export const TUI_COMMAND_KINDS = Object.freeze([
  'prompt', 'steer', 'followup', 'abort', 'status', 'disconnect',
  // Git approval protocol (G2): two closed typed operations, each with a
  // request phase (owner-initiated proposal) and an execute phase (one-use
  // approval dispatch). Payloads carry only the opaque proposalId — never
  // a command string, argv or any Git argument.
  'git_commit_request', 'git_commit_execute', 'git_push_request', 'git_push_execute',
]);
export const TUI_EVENT_KINDS = Object.freeze([
  'connected', 'disconnected', 'status', 'final_output', 'command_result',
  // A proposal published by the extension for the owner's one-use Telegram
  // approval. Payload: { operation: 'commit'|'push', proposalId } plus the
  // EXACT automatic commit message for a commit proposal, nothing else.
  'git_proposal',
]);

// Allowed forward transitions; everything else fails closed.
const TRANSITIONS = Object.freeze({
  running: Object.freeze(['waiting_decision', 'completed', 'failed', 'cancelled']),
  waiting_decision: Object.freeze(['resuming', 'failed', 'cancelled']),
  resuming: Object.freeze(['completed', 'failed', 'waiting_decision', 'cancelled']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  expired: Object.freeze([]),
  cancelled: Object.freeze([]),
});

function freezeDeep(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    return Object.freeze(value);
  }
  return value;
}

/**
 * Liveness probe used for lease takeover. Signal 0 never signals the
 * process — it only checks schedulability, so this can never kill an
 * unknown or reused PID. Dead (ESRCH) -> false; alive/permission-denied
 * (EPERM means it exists) -> true.
 */
function defaultIsProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/** Options like actions and decisions must be non-null plain objects
 * (Object.prototype or null prototype only). Class instances, Dates, Maps
 * and arrays are rejected: their behavior does not survive the JSON
 * round-trip through the store, so accepting them would corrupt state. */
function assertPlainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a non-null plain object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${name} must be a non-null plain object`);
  }
}

// --- Tracked TUI validation (fail closed before persistence) ------------

const TUI_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const TUI_SHORT_ID_RE = /^[a-z0-9]{3,32}$/;
const MAX_TUI_LABEL_CHARS = 64;
const MAX_TUI_PATH_CHARS = 512;
const MAX_TUI_TEXT_CHARS = 4096;
const MAX_TUI_CODE_CHARS = 64;
const MAX_TUI_EVENT_IDS = 256;

function assertTuiId(value, name) {
  if (typeof value !== 'string' || !TUI_ID_RE.test(value)) {
    throw new TypeError(`${name} must match ${TUI_ID_RE}`);
  }
}

/** Optional string field; empty/undefined/null collapse to null. */
function assertOptionalTuiString(value, name, maxChars) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maxChars} chars`);
  }
  return value;
}

function assertTuiText(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TUI_TEXT_CHARS) {
    throw new TypeError(
      `${name} must be a non-empty string of at most ${MAX_TUI_TEXT_CHARS} chars`,
    );
  }
}

/** Code-only reason/result slug: no whitespace, no payload echo. */
function assertTuiCode(value, name) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_TUI_CODE_CHARS
    || /\s/.test(value)
  ) {
    throw new TypeError(
      `${name} must be a whitespace-free string of at most ${MAX_TUI_CODE_CHARS} chars`,
    );
  }
  return value;
}

// Git approval protocol (G2): the proposalId is an opaque slug minted by
// the extension, carried verbatim between the proposal event and the
// execute command. It is never a command, path or argument — only this
// closed hex shape is accepted.
const GIT_PROPOSAL_ID_RE = /^[0-9a-f]{16,64}$/;

function assertGitProposalId(value) {
  if (typeof value !== 'string' || !GIT_PROPOSAL_ID_RE.test(value)) {
    throw new TypeError('proposalId must match /^[0-9a-f]{16,64}$/');
  }
}

function assertTuiCommandPayload(kind, payload) {
  switch (kind) {
    case 'prompt':
    case 'steer':
    case 'followup':
      assertPlainObject(payload, 'payload');
      assertTuiText(payload.text, 'payload.text');
      return;
    case 'abort':
    case 'disconnect':
      if (payload === null) return;
      assertPlainObject(payload, 'payload');
      if (payload.reason !== undefined) assertTuiCode(payload.reason, 'payload.reason');
      return;
    case 'status':
      if (payload === null) return;
      assertPlainObject(payload, 'payload');
      return;
    case 'git_commit_request':
    case 'git_push_request':
      // Closed request: no fields at all — anything else fails closed.
      if (payload !== null) {
        throw new TypeError('git request command payload must be null');
      }
      return;
    case 'git_commit_execute':
    case 'git_push_execute':
      assertPlainObject(payload, 'payload');
      if (Object.keys(payload).length !== 1) {
        throw new TypeError('git execute payload must carry exactly one field: proposalId');
      }
      assertGitProposalId(payload.proposalId);
      return;
    default:
      throw new TypeError('unknown tui command kind');
  }
}

function assertTuiEventPayload(kind, payload) {
  switch (kind) {
    case 'connected':
    case 'disconnected':
    case 'status':
      if (payload === null) return;
      assertPlainObject(payload, 'payload');
      return;
    case 'final_output':
      assertPlainObject(payload, 'payload');
      assertTuiText(payload.text, 'payload.text');
      return;
    case 'command_result':
      assertPlainObject(payload, 'payload');
      if (typeof payload.ok !== 'boolean') {
        throw new TypeError('payload.ok must be a boolean');
      }
      if (payload.text !== undefined) assertTuiText(payload.text, 'payload.text');
      if (payload.resultCode !== undefined) assertTuiCode(payload.resultCode, 'payload.resultCode');
      return;
    case 'git_proposal': {
      assertPlainObject(payload, 'payload');
      const fields = Object.keys(payload).sort().join(',');
      if (payload.operation === 'commit') {
        if (fields !== 'message,operation,proposalId') {
          throw new TypeError(
            'a commit proposal carries exactly operation, proposalId and message',
          );
        }
        assertGitProposalId(payload.proposalId);
        assertTuiText(payload.message, 'payload.message');
        return;
      }
      if (payload.operation === 'push') {
        // G3: the message is OPTIONAL on push proposals; when present it is
        // the bounded snapshot summary (branch, upstream, HEAD, fingerprint)
        // shown on the approval card — never a command or argv.
        if (fields !== 'operation,proposalId' && fields !== 'message,operation,proposalId') {
          throw new TypeError(
            "a push proposal carries exactly operation and proposalId, plus an optional message",
          );
        }
        assertGitProposalId(payload.proposalId);
        if (payload.message !== undefined) assertTuiText(payload.message, 'payload.message');
        return;
      }
      throw new TypeError("payload.operation must be 'commit' or 'push'");
    }
    default:
      throw new TypeError('unknown tui event kind');
  }
}

export class Store {
  /**
   * @param {string} dbPath file path (or ':memory:')
   * @param {object} [options]
   * @param {() => number} [options.now] injectable clock (ms epoch)
   * @param {number} [options.busyTimeoutMs] sqlite busy timeout
   * @param {number} [options.maxPayloadBytes] bound for transport payloads
   * @param {number} [options.maxActionBytes] bound for request actions
   */
  constructor(dbPath, options = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? 16384;
    this.#maxActionBytes = options.maxActionBytes ?? 8192;
    this.#isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`PRAGMA journal_mode = WAL;`);
    this.#db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000};`);
    this.#db.exec(`PRAGMA foreign_keys = ON;`);
    this.#migrate();
  }

  #now;
  #maxPayloadBytes;
  #maxActionBytes;
  #isProcessAlive;
  #txDepth = 0;
  /** @type {DatabaseSync} */
  #db;

  close() {
    this.#db.close();
  }

  #migrate() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        pi_session_id TEXT NOT NULL,
        host_generation INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        host_generation INTEGER NOT NULL,
        action_json TEXT NOT NULL,
        state TEXT NOT NULL,
        decision_json TEXT,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requests_session
        ON requests(session_id, state);
      CREATE TABLE IF NOT EXISTS outbox (
        outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        failed_at INTEGER,
        last_error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS inbox (
        inbox_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        received_at INTEGER NOT NULL
        -- Inbox is a DEDUP LEDGER, not a work queue: dedup is by primary-key
        -- presence via recordInbox. Nothing writes or reads a processed
        -- marker. Databases created earlier may still carry an unused
        -- processed_at column; CREATE TABLE IF NOT EXISTS leaves them alone.
      );
      CREATE TABLE IF NOT EXISTS actions (
        action_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        owner TEXT,
        claimed_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_actions_state
        ON actions(state, created_at);
      CREATE TABLE IF NOT EXISTS callback_tokens (
        token TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES requests(request_id),
        kind TEXT NOT NULL,
        decision_json TEXT,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
    `);
    // Databases created before the T03 outbox bookkeeping lack the new
    // columns; add them in place so existing local state keeps working.
    this.#ensureColumn('outbox', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
    this.#ensureColumn('outbox', 'failed_at', 'INTEGER');
    this.#ensureColumn('outbox', 'last_error_code', 'TEXT');
    // D1: per-render batch attribution so a context guard can scope its
    // readiness check to the EXACT render batch instead of the request's
    // whole history (an old failed render must never block a new one).
    this.#ensureColumn('outbox', 'batch_id', 'TEXT');
    // T01: durable transport for selectively connected live Pi TUIs.
    // Dedicated tables; every existing table and API is untouched.
    // tui_events and tui_commands intentionally carry no foreign key so a
    // disconnect (session row delete) never cascades away evidence the
    // broker still has to drain.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS tui_sessions (
        tracking_id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL UNIQUE,
        pi_session_id TEXT,
        pi_session_file TEXT,
        cwd TEXT,
        label TEXT,
        pid INTEGER,
        connection_id TEXT NOT NULL,
        state TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tui_sessions_state
        ON tui_sessions(state, heartbeat_at);
      CREATE TABLE IF NOT EXISTS tui_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracking_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        acknowledged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tui_events_pending
        ON tui_events(tracking_id, acknowledged_at, event_id);
      CREATE TABLE IF NOT EXISTS tui_commands (
        command_id TEXT PRIMARY KEY,
        tracking_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        owner_connection_id TEXT,
        claimed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        result_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tui_commands_pending
        ON tui_commands(tracking_id, state, created_at);
    `);
  }

  #ensureColumn(table, column, ddl) {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((c) => c.name === column)) {
      this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
    }
  }

  #transaction(fn) {
    // Re-entrant: composite units (withTransaction) call the same
    // primitives that each open their own transaction. Only the outermost
    // frame issues BEGIN/COMMIT/ROLLBACK, so a failure rolls back the whole
    // atomic unit and never leaves a partially handled update.
    if (this.#txDepth > 0) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#txDepth += 1;
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // A busy/locked BEGIN failure must not mask the original error.
      }
      throw error;
    } finally {
      this.#txDepth -= 1;
    }
  }

  /**
   * Run a composite update handling unit atomically. The Telegram worker
   * uses this so an update's receipt, claimed decision, replies and offset
   * advance commit together: a failure leaves no partially handled update
   * and the offset never advances past unhandled work.
   */
  withTransaction(fn) {
    return this.#transaction(fn);
  }

  #getMeta(key) {
    const row = this.#db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key);
    return row?.value;
  }

  #setMeta(key, value) {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // --- Host generation -------------------------------------------------

  getHostGeneration() {
    const raw = this.#getMeta('host_generation');
    return raw === undefined ? 0 : Number(raw);
  }

  setHostGeneration(generation) {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new RangeError('host generation must be a positive integer');
    }
    this.#transaction(() => {
      this.#setMeta('host_generation', String(generation));
    });
  }

  // --- Sessions ---------------------------------------------------------

  createSession({ sessionId, piSessionId }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('sessionId must be a non-empty string');
    }
    if (typeof piSessionId !== 'string' || piSessionId.length === 0) {
      throw new TypeError('piSessionId must be a non-empty string');
    }
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO sessions (session_id, pi_session_id, host_generation, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             pi_session_id = excluded.pi_session_id,
             host_generation = excluded.host_generation`,
        )
        .run(sessionId, piSessionId, this.getHostGeneration(), this.#now());
    });
  }

  // --- Requests ---------------------------------------------------------

  #rowToRequest(row) {
    if (!row) return null;
    return freezeDeep({
      requestId: row.request_id,
      sessionId: row.session_id,
      hostGeneration: row.host_generation,
      state: row.state,
      action: JSON.parse(row.action_json),
      decision: row.decision_json === null ? null : JSON.parse(row.decision_json),
      result: row.result_json === null ? null : JSON.parse(row.result_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    });
  }

  #getRequestRow(requestId) {
    return this.#db
      .prepare('SELECT * FROM requests WHERE request_id = ?')
      .get(requestId);
  }

  /**
   * Create a request. Fails closed when the session is unknown or already
   * has an active request (single active per session).
   */
  createRequest({ sessionId, action, ttlMs = 600000 }) {
    assertPlainObject(action, 'action');
    if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new RangeError('ttlMs must be a positive integer');
    }
    const actionJson = JSON.stringify(action ?? null);
    if (Buffer.byteLength(actionJson, 'utf8') > this.#maxActionBytes) {
      throw new RangeError(`action exceeds ${this.#maxActionBytes} bytes`);
    }
    const now = this.#now();
    return this.#transaction(() => {
      const session = this.#db
        .prepare('SELECT session_id FROM sessions WHERE session_id = ?')
        .get(sessionId);
      if (!session) return { ok: false, reason: 'unknown_session' };

      const active = this.#db
        .prepare(
          `SELECT COUNT(*) AS n FROM requests
           WHERE session_id = ? AND state IN ('running','waiting_decision','resuming')`,
        )
        .get(sessionId);
      if (active.n > 0) return { ok: false, reason: 'session_busy' };

      const requestId = randomBytes(16).toString('hex');
      this.#db
        .prepare(
          `INSERT INTO requests
             (request_id, session_id, host_generation, action_json, state,
              created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
        )
        .run(
          requestId,
          sessionId,
          this.getHostGeneration(),
          actionJson,
          now,
          now,
          now + ttlMs,
        );
      return { ok: true, request: this.#rowToRequest(this.#getRequestRow(requestId)) };
    });
  }

  getRequest(requestId) {
    return this.#rowToRequest(this.#getRequestRow(requestId));
  }

  /**
   * Recovery surface: lists requests awaiting a human decision. Never lists
   * resuming requests as replayable — the host observes their outcome only.
   */
  listRecoverableRequests() {
    const rows = this.#db
      .prepare(
        `SELECT * FROM requests WHERE state = 'waiting_decision' ORDER BY created_at`,
      )
      .all();
    return rows.map((row) => this.#rowToRequest(row));
  }

  #transition(requestId, { expectedFrom, to, sessionId, generation, extraColumns = {} }) {
    return this.#transaction(() => {
      const row = this.#getRequestRow(requestId);
      if (!row) return { ok: false, reason: 'not_found' };
      if (sessionId !== undefined && row.session_id !== sessionId) {
        return { ok: false, reason: 'session_mismatch' };
      }
      // 'current' resolves the authoritative host generation INSIDE the
      // transaction so a concurrent generation bump is never raced.
      const effectiveGeneration = generation === 'current'
        ? this.getHostGeneration()
        : generation;
      if (effectiveGeneration !== undefined && row.host_generation !== effectiveGeneration) {
        return { ok: false, reason: 'host_generation_mismatch' };
      }
      if (expectedFrom !== undefined && !expectedFrom.includes(row.state)) {
        return { ok: false, reason: 'invalid_state' };
      }
      if (!TRANSITIONS[row.state]?.includes(to)) {
        return { ok: false, reason: 'invalid_state' };
      }
      const sets = ['state = ?', 'updated_at = ?'];
      const values = [to, this.#now()];
      for (const [column, value] of Object.entries(extraColumns)) {
        sets.push(`${column} = ?`);
        values.push(value);
      }
      values.push(requestId);
      this.#db
        .prepare(`UPDATE requests SET ${sets.join(', ')} WHERE request_id = ?`)
        .run(...values);
      return { ok: true, request: this.#rowToRequest(this.#getRequestRow(requestId)) };
    });
  }

  markWaitingDecision(requestId, { sessionId } = {}) {
    return this.#transition(requestId, {
      expectedFrom: ['running'],
      to: 'waiting_decision',
      sessionId,
    });
  }

  /**
   * Compare-and-set decision: waiting_decision -> resuming, exactly once.
   * Both the session binding and the current host generation (read inside
   * the same transaction) must match.
   */
  recordDecision({ requestId, sessionId, decision }) {
    assertPlainObject(decision, 'decision');
    const decisionJson = JSON.stringify(decision);
    if (Buffer.byteLength(decisionJson, 'utf8') > this.#maxPayloadBytes) {
      throw new RangeError(`decision exceeds ${this.#maxPayloadBytes} bytes`);
    }
    return this.#transition(requestId, {
      expectedFrom: ['waiting_decision'],
      to: 'resuming',
      sessionId,
      generation: 'current',
      extraColumns: { decision_json: decisionJson },
    });
  }

  /**
   * Host observed the resumed result. Only resuming/running -> completed;
   * the recorded result is what makes "applied" durable, not the send.
   */
  completeRequest({ requestId, sessionId, result }) {
    const resultJson = JSON.stringify(result ?? null);
    if (Buffer.byteLength(resultJson, 'utf8') > this.#maxPayloadBytes) {
      throw new RangeError(`result exceeds ${this.#maxPayloadBytes} bytes`);
    }
    return this.#transition(requestId, {
      expectedFrom: ['resuming', 'running'],
      to: 'completed',
      sessionId,
      extraColumns: { result_json: resultJson },
    });
  }

  failRequest({ requestId, sessionId, reason }) {
    const reasonJson = JSON.stringify(reason ?? null);
    if (Buffer.byteLength(reasonJson, 'utf8') > this.#maxPayloadBytes) {
      throw new RangeError(`reason exceeds ${this.#maxPayloadBytes} bytes`);
    }
    return this.#transition(requestId, {
      expectedFrom: ['running', 'waiting_decision', 'resuming'],
      to: 'failed',
      sessionId,
      extraColumns: { result_json: reasonJson },
    });
  }

  cancelRequest({ requestId, sessionId }) {
    return this.#transition(requestId, {
      expectedFrom: ['running', 'waiting_decision'],
      to: 'cancelled',
      sessionId,
    });
  }

  /**
   * Expire overdue requests (running/waiting_decision only; resuming work
   * is never auto-expired because its outcome must be observed). Returns
   * the expired request ids.
   */
  expireRequests(now = this.#now()) {
    return this.#transaction(() => {
      const rows = this.#db
        .prepare(
          `SELECT request_id FROM requests
           WHERE state IN ('running','waiting_decision') AND expires_at <= ?`,
        )
        .all(now);
      if (rows.length > 0) {
        this.#db
          .prepare(
            `UPDATE requests SET state = 'expired', updated_at = ?
             WHERE state IN ('running','waiting_decision') AND expires_at <= ?`,
          )
          .run(now, now);
      }
      return rows.map((row) => row.request_id);
    });
  }

  // --- Transport: inbox (dedup), outbox (serialized sends), offset ------

  /** Returns true only for the first sighting of a stable inbox id. */
  recordInbox({ inboxId, kind, payload }) {
    if (typeof inboxId !== 'string' || inboxId.length === 0) {
      throw new TypeError('inboxId must be a non-empty string');
    }
    const payloadJson = JSON.stringify(payload ?? null);
    if (Buffer.byteLength(payloadJson, 'utf8') > this.#maxPayloadBytes) {
      throw new RangeError(`payload exceeds ${this.#maxPayloadBytes} bytes`);
    }
    return this.#transaction(() => {
      const info = this.#db
        .prepare(
          `INSERT OR IGNORE INTO inbox (inbox_id, kind, payload_json, received_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(inboxId, kind, payloadJson, this.#now());
      return info.changes === 1;
    });
  }

  #assertPayload(payload) {
    const payloadJson = JSON.stringify(payload ?? null);
    if (Buffer.byteLength(payloadJson, 'utf8') > this.#maxPayloadBytes) {
      throw new RangeError(`payload exceeds ${this.#maxPayloadBytes} bytes`);
    }
    return payloadJson;
  }

  enqueueOutbox({ requestId = null, kind, payload, batchId = null }) {
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new TypeError('kind must be a non-empty string');
    }
    if (batchId !== null && (typeof batchId !== 'string' || batchId.length === 0 || batchId.length > 64)) {
      throw new RangeError('batchId must be null or a non-empty string of at most 64 chars');
    }
    const payloadJson = this.#assertPayload(payload);
    let id;
    this.#transaction(() => {
      const info = this.#db
        .prepare(
          `INSERT INTO outbox (request_id, kind, payload_json, batch_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(requestId, kind, payloadJson, batchId, this.#now());
      id = Number(info.lastInsertRowid);
    });
    return id;
  }

  listPendingOutbox() {
    const rows = this.#db
      .prepare(
        `SELECT outbox_id, request_id, kind, payload_json, created_at,
                attempts, failed_at, last_error_code
         FROM outbox
         WHERE delivered_at IS NULL AND failed_at IS NULL
         ORDER BY outbox_id`,
      )
      .all();
    return rows.map((row) => ({
      outboxId: row.outbox_id,
      requestId: row.request_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
      attempts: row.attempts,
      failedAt: row.failed_at,
      lastErrorCode: row.last_error_code,
    }));
  }

  /** Bump the delivery attempt counter of a pending outbox row. */
  incrementOutboxAttempts(outboxId) {
    return this.#transaction(() => {
      const info = this.#db
        .prepare('UPDATE outbox SET attempts = attempts + 1 WHERE outbox_id = ?')
        .run(outboxId);
      if (info.changes !== 1) return { ok: false, reason: 'not_found' };
      const row = this.#db
        .prepare('SELECT attempts FROM outbox WHERE outbox_id = ?')
        .get(outboxId);
      return { ok: true, attempts: row.attempts };
    });
  }

  /**
   * Definitively fail a pending outbox row (fixed error code only; no
   * content is ever recorded). A failed row stops being retried: recovery
   * for approval keyboards goes through the explicit /pending command.
   */
  markOutboxFailed(outboxId, errorCode) {
    if (typeof errorCode !== 'string' || errorCode.length === 0 || errorCode.length > 64) {
      throw new RangeError('errorCode must be a non-empty string of at most 64 chars');
    }
    this.#transaction(() => {
      this.#db
        .prepare('UPDATE outbox SET failed_at = ?, last_error_code = ? WHERE outbox_id = ?')
        .run(this.#now(), errorCode, outboxId);
    });
  }

  markOutboxDelivered(outboxId) {
    this.#transaction(() => {
      this.#db
        .prepare('UPDATE outbox SET delivered_at = ? WHERE outbox_id = ?')
        .run(this.#now(), outboxId);
    });
  }

  /**
   * Delivery summary for one request: lets the worker refuse to dispatch
   * an approval keyboard whose context chunks failed, and lets /details
   * decide when a keyboard needs re-queueing for recovery. Counts only;
   * never returns payload content.
   */
  outboxRequestSummary(requestId) {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new TypeError('requestId must be a non-empty string');
    }
    const row = this.#db
      .prepare(
        `SELECT
           SUM(CASE WHEN kind = 'tg_text' THEN 1 ELSE 0 END) AS total_text,
           SUM(CASE WHEN kind = 'tg_text' AND failed_at IS NOT NULL THEN 1 ELSE 0 END) AS failed_text,
           SUM(CASE WHEN kind = 'tg_keyboard' THEN 1 ELSE 0 END) AS total_keyboard,
           SUM(CASE WHEN kind = 'tg_keyboard' AND failed_at IS NOT NULL THEN 1 ELSE 0 END) AS failed_keyboard
         FROM outbox WHERE request_id = ?`,
      )
      .get(requestId);
    return {
      totalText: row.total_text ?? 0,
      failedText: row.failed_text ?? 0,
      totalKeyboard: row.total_keyboard ?? 0,
      failedKeyboard: row.failed_keyboard ?? 0,
    };
  }

  /**
   * Delivery summary for ONE render batch (D1): the context-readiness
   * guard must be scoped to the exact new render, never to the request's
   * whole history — a permanently failed chunk of an OLD batch must not
   * block the keyboard of a fresh /details re-render. Counts only the
   * tg_text context rows of the batch (the keyboard row itself and other
   * kinds are excluded); returns counts, never payload content.
   */
  outboxBatchSummary(batchId) {
    if (typeof batchId !== 'string' || batchId.length === 0 || batchId.length > 64) {
      throw new RangeError('batchId must be a non-empty string of at most 64 chars');
    }
    const row = this.#db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
           SUM(CASE WHEN failed_at IS NOT NULL THEN 1 ELSE 0 END) AS failed
         FROM outbox WHERE batch_id = ? AND kind = 'tg_text'`,
      )
      .get(batchId);
    return {
      total: row.total ?? 0,
      delivered: row.delivered ?? 0,
      failed: row.failed ?? 0,
    };
  }

  getTransportOffset() {
    const raw = this.#getMeta('transport_offset');
    return raw === undefined ? 0 : Number(raw);
  }

  /** Advances the Telegram update offset; never moves backwards. */
  advanceTransportOffset(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError('offset must be a non-negative integer');
    }
    this.#transaction(() => {
      const current = this.getTransportOffset();
      if (offset > current) this.#setMeta('transport_offset', String(offset));
    });
  }

  // --- Host IPC: typed action queue (at-most-once processing) -----------

  /**
   * Enqueue a typed host action. Dedup by stable actionId makes enqueue
   * at-most-once: a retried insert of the same id is a no-op.
   * Returns true only for the first sighting.
   */
  enqueueAction({ actionId, type, payload }) {
    if (typeof actionId !== 'string' || actionId.length === 0) {
      throw new TypeError('actionId must be a non-empty string');
    }
    if (typeof type !== 'string' || type.length === 0) {
      throw new TypeError('type must be a non-empty string');
    }
    const payloadJson = this.#assertPayload(payload);
    return this.#transaction(() => {
      const info = this.#db
        .prepare(
          `INSERT OR IGNORE INTO actions (action_id, type, payload_json, state, created_at)
           VALUES (?, ?, ?, 'pending', ?)`,
        )
        .run(actionId, type, payloadJson, this.#now());
      return info.changes === 1;
    });
  }

  #rowToAction(row) {
    if (!row) return null;
    return freezeDeep({
      actionId: row.action_id,
      type: row.type,
      payload: JSON.parse(row.payload_json),
      state: row.state,
      owner: row.owner,
      claimedAt: row.claimed_at,
      createdAt: row.created_at,
    });
  }

  /**
   * Claim the oldest pending action for one owner (CAS inside a
   * transaction). Claimed actions belong to exactly one owner.
   */
  claimNextAction({ ownerId, now = this.#now() }) {
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      throw new TypeError('ownerId must be a non-empty string');
    }
    return this.#transaction(() => {
      const row = this.#db
        .prepare(
          `SELECT action_id FROM actions WHERE state = 'pending' ORDER BY created_at, action_id LIMIT 1`,
        )
        .get();
      if (!row) return { ok: false, reason: 'empty' };
      const info = this.#db
        .prepare(
          `UPDATE actions SET state = 'claimed', owner = ?, claimed_at = ?
           WHERE action_id = ? AND state = 'pending'`,
        )
        .run(ownerId, now, row.action_id);
      if (info.changes !== 1) return { ok: false, reason: 'contention' };
      const claimed = this.#db
        .prepare('SELECT * FROM actions WHERE action_id = ?')
        .get(row.action_id);
      return { ok: true, action: this.#rowToAction(claimed) };
    });
  }

  /** Complete a claimed action; only the claiming owner may, exactly once. */
  completeAction({ actionId, ownerId }) {
    return this.#transaction(() => {
      const row = this.#db
        .prepare('SELECT * FROM actions WHERE action_id = ?')
        .get(actionId);
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.state !== 'claimed') return { ok: false, reason: 'invalid_state' };
      if (row.owner !== ownerId) return { ok: false, reason: 'not_owner' };
      this.#db
        .prepare(`UPDATE actions SET state = 'done' WHERE action_id = ?`)
        .run(actionId);
      return { ok: true };
    });
  }

  /**
   * Terminal failure for a claimed action, by its owner. Used when the
   * claim turns out to be unprocessable (e.g. malformed payload): the
   * action must never be re-claimed or re-run (at-most-once, fail closed).
   */
  failAction({ actionId, ownerId }) {
    return this.#transaction(() => {
      const row = this.#db
        .prepare('SELECT * FROM actions WHERE action_id = ?')
        .get(actionId);
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.state !== 'claimed') return { ok: false, reason: 'invalid_state' };
      if (row.owner !== ownerId) return { ok: false, reason: 'not_owner' };
      this.#db
        .prepare(`UPDATE actions SET state = 'failed' WHERE action_id = ?`)
        .run(actionId);
      return { ok: true };
    });
  }

  /**
   * Fail claimed actions whose claim is older than claimTimeoutMs. Used
   * after a crash: the action is marked failed and is NEVER replayed —
   * the human must re-issue it (fail closed, at-most-once). Returns the
   * failed action ids.
   */
  failStaleClaimedActions({ now = this.#now(), claimTimeoutMs }) {
    if (!Number.isSafeInteger(claimTimeoutMs) || claimTimeoutMs <= 0) {
      throw new RangeError('claimTimeoutMs must be a positive integer');
    }
    const cutoff = now - claimTimeoutMs;
    return this.#transaction(() => {
      const rows = this.#db
        .prepare(
          `SELECT action_id FROM actions
           WHERE state = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?`,
        )
        .all(cutoff);
      if (rows.length > 0) {
        this.#db
          .prepare(
            `UPDATE actions SET state = 'failed'
             WHERE state = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?`,
          )
          .run(cutoff);
      }
      return rows.map((row) => row.action_id);
    });
  }

  // --- Transport: single-use callback tokens ----------------------------

  /**
   * Create a one-use opaque callback token bound to an existing request.
   * The token is random (never the request id, choice text, command or any
   * identity) and fits Telegram's 64 UTF-8-byte callback data limit. The
   * decision payload is stored server-side and is immutable once created.
   */
  createCallbackToken({ requestId, kind, decision = null }) {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return { ok: false, reason: 'bad_request' };
    }
    if (!['decision', 'details', 'cancel'].includes(kind)) {
      return { ok: false, reason: 'bad_kind' };
    }
    if (kind === 'decision') {
      try {
        assertPlainObject(decision, 'decision');
      } catch {
        return { ok: false, reason: 'bad_decision' };
      }
    }
    const decisionJson = kind === 'decision' ? JSON.stringify(decision) : null;
    if (decisionJson !== null && Buffer.byteLength(decisionJson, 'utf8') > this.#maxPayloadBytes) {
      throw new RangeError(`decision exceeds ${this.#maxPayloadBytes} bytes`);
    }
    return this.#transaction(() => {
      const row = this.#getRequestRow(requestId);
      if (!row) return { ok: false, reason: 'not_found' };
      const token = randomBytes(16).toString('hex');
      this.#db
        .prepare(
          `INSERT INTO callback_tokens (token, request_id, kind, decision_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(token, requestId, kind, decisionJson, this.#now());
      return { ok: true, token };
    });
  }

  /**
   * Consume a token exactly once (CAS). Returns the immutable binding so
   * the caller can validate the request state, expiry and generation
   * BEFORE enqueueing the action.
   */
  consumeCallbackToken({ token, now = this.#now() }) {
    if (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token, 'utf8') > 64) {
      return { ok: false, reason: 'unknown_token' };
    }
    return this.#transaction(() => {
      const row = this.#db
        .prepare('SELECT * FROM callback_tokens WHERE token = ?')
        .get(token);
      if (!row) return { ok: false, reason: 'unknown_token' };
      if (row.consumed_at !== null) return { ok: false, reason: 'already_consumed' };
      this.#db
        .prepare('UPDATE callback_tokens SET consumed_at = ? WHERE token = ?')
        .run(now, token);
      return {
        ok: true,
        kind: row.kind,
        requestId: row.request_id,
        decision: row.decision_json === null ? null : JSON.parse(row.decision_json),
      };
    });
  }

  // --- Worker IPC: singleton worker lease (distinct from the host) ------

  #getLeaseWithPrefix(prefix) {
    const owner = this.#getMeta(`${prefix}_owner`);
    if (owner === undefined) return null;
    return {
      owner,
      pid: Number(this.#getMeta(`${prefix}_pid`)),
      renewedAt: Number(this.#getMeta(`${prefix}_renewed_at`)),
    };
  }

  #setLeaseWithPrefix(prefix, owner, pid) {
    this.#setMeta(`${prefix}_owner`, owner);
    this.#setMeta(`${prefix}_pid`, String(pid));
    this.#setMeta(`${prefix}_renewed_at`, String(this.#now()));
  }

  /**
   * Acquire the singleton WORKER lease. Semantics are identical to the
   * host lease but the keys are distinct: a live host never blocks the
   * worker and vice versa (they cooperate through the store, not by
   * owning each other's lifecycle).
   */
  acquireWorkerLease({ ownerId, pid }) {
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      throw new TypeError('ownerId must be a non-empty string');
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new RangeError('pid must be a positive integer');
    }
    return this.#transaction(() => {
      const lease = this.#getLeaseWithPrefix('worker_lease');
      if (lease === null) {
        this.#setLeaseWithPrefix('worker_lease', ownerId, pid);
        return { ok: true, tookOver: false };
      }
      if (lease.owner === ownerId) {
        if (lease.pid !== pid && this.#isProcessAlive(lease.pid)) {
          return { ok: false, reason: 'lease_busy' };
        }
        this.#setLeaseWithPrefix('worker_lease', ownerId, pid);
        return { ok: true, tookOver: lease.pid !== pid };
      }
      if (this.#isProcessAlive(lease.pid)) {
        return { ok: false, reason: 'lease_busy' };
      }
      this.#setLeaseWithPrefix('worker_lease', ownerId, pid);
      return { ok: true, tookOver: true, previousOwner: lease.owner };
    });
  }

  renewWorkerLease({ ownerId, now = this.#now() }) {
    return this.#transaction(() => {
      const lease = this.#getLeaseWithPrefix('worker_lease');
      if (lease === null || lease.owner !== ownerId) {
        return { ok: false, reason: 'not_owner' };
      }
      this.#setMeta('worker_lease_renewed_at', String(now));
      return { ok: true };
    });
  }

  releaseWorkerLease({ ownerId }) {
    return this.#transaction(() => {
      const lease = this.#getLeaseWithPrefix('worker_lease');
      if (lease === null || lease.owner !== ownerId) {
        return { ok: false, reason: 'not_owner' };
      }
      for (const key of ['worker_lease_owner', 'worker_lease_pid', 'worker_lease_renewed_at']) {
        this.#db.prepare('DELETE FROM meta WHERE key = ?').run(key);
      }
      return { ok: true };
    });
  }

  // --- Host IPC: singleton lease with PID-liveness takeover -------------

  #getLease() {
    return this.#getLeaseWithPrefix('host_lease');
  }

  #setLease(owner, pid) {
    this.#setLeaseWithPrefix('host_lease', owner, pid);
  }

  /**
   * Acquire the singleton host lease. Takeover from another owner happens
   * ONLY when the previous owner PID is verifiably dead (signal 0 probe;
   * never signals, so PID reuse can never cause a kill).
   */
  acquireHostLease({ ownerId, pid }) {
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      throw new TypeError('ownerId must be a non-empty string');
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new RangeError('pid must be a positive integer');
    }
    return this.#transaction(() => {
      const lease = this.#getLease();
      if (lease === null) {
        this.#setLease(ownerId, pid);
        return { ok: true, tookOver: false };
      }
      if (lease.owner === ownerId) {
        // Same owner id, but a DIFFERENT pid: a second live host must not
        // sneak past the singleton lease. Only take over when the recorded
        // pid is verifiably dead (host restarted).
        if (lease.pid !== pid && this.#isProcessAlive(lease.pid)) {
          return { ok: false, reason: 'lease_busy' };
        }
        this.#setLease(ownerId, pid);
        return { ok: true, tookOver: lease.pid !== pid };
      }
      if (this.#isProcessAlive(lease.pid)) {
        return { ok: false, reason: 'lease_busy' };
      }
      this.#setLease(ownerId, pid);
      return { ok: true, tookOver: true, previousOwner: lease.owner };
    });
  }

  renewHostLease({ ownerId, now = this.#now() }) {
    return this.#transaction(() => {
      const lease = this.#getLease();
      if (lease === null || lease.owner !== ownerId) {
        return { ok: false, reason: 'not_owner' };
      }
      this.#setMeta('host_lease_renewed_at', String(now));
      return { ok: true };
    });
  }

  releaseHostLease({ ownerId }) {
    return this.#transaction(() => {
      const lease = this.#getLease();
      if (lease === null || lease.owner !== ownerId) {
        return { ok: false, reason: 'not_owner' };
      }
      for (const key of ['host_lease_owner', 'host_lease_pid', 'host_lease_renewed_at']) {
        this.#db.prepare('DELETE FROM meta WHERE key = ?').run(key);
      }
      return { ok: true };
    });
  }

  // --- Host IPC: generation bump and session listing ---------------------

  /** Atomically bump the host generation; returns the new value. */
  incrementHostGeneration() {
    return this.#transaction(() => {
      const next = this.getHostGeneration() + 1;
      this.#setMeta('host_generation', String(next));
      return next;
    });
  }

  /**
   * Recovery surface: every known session with its active request state
   * (null when the session has no in-flight request).
   */
  listSessions() {
    const rows = this.#db
      .prepare(
        `SELECT s.session_id, s.pi_session_id, s.host_generation, s.created_at,
                (SELECT r.state FROM requests r
                  WHERE r.session_id = s.session_id
                    AND r.state IN ('running','waiting_decision','resuming')
                  ORDER BY r.created_at DESC LIMIT 1) AS active_request_state
         FROM sessions s ORDER BY s.created_at`,
      )
      .all();
    return rows.map((row) => ({
      sessionId: row.session_id,
      piSessionId: row.pi_session_id,
      hostGeneration: row.host_generation,
      createdAt: row.created_at,
      activeRequestState: row.active_request_state ?? null,
    }));
  }

  // --- Tracked live TUIs (selective opt-in transport) -------------------

  /** A row is live when its heartbeat is inside the cutoff AND its pid is
   * not verifiably dead. A dead pid probe never keeps a ghost alive, but
   * pid reuse can only err towards "live" (fail closed). */
  #tuiRowLive(row, staleCutoff) {
    if (row.heartbeat_at < staleCutoff) return false;
    if (
      Number.isSafeInteger(row.pid)
      && row.pid > 0
      && !this.#isProcessAlive(row.pid)
    ) {
      return false;
    }
    return true;
  }

  #rowToTuiSession(row, staleCutoff) {
    return freezeDeep({
      trackingId: row.tracking_id,
      shortId: row.short_id,
      piSessionId: row.pi_session_id,
      piSessionFile: row.pi_session_file,
      cwd: row.cwd,
      label: row.label,
      pid: row.pid,
      connectionId: row.connection_id,
      state: row.state,
      connectedAt: row.connected_at,
      updatedAt: row.updated_at,
      heartbeatAt: row.heartbeat_at,
      live: this.#tuiRowLive(row, staleCutoff),
    });
  }

  #getTuiSessionRow(trackingId) {
    return this.#db
      .prepare('SELECT * FROM tui_sessions WHERE tracking_id = ?')
      .get(trackingId);
  }

  /** Raw event insert; callers validate kind/payload before calling. */
  #appendTuiEventRow(trackingId, kind, payloadJson, now) {
    const info = this.#db
      .prepare(
        `INSERT INTO tui_events (tracking_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(trackingId, kind, payloadJson, now);
    return Number(info.lastInsertRowid);
  }

  #assertTuiStaleCutoff(staleCutoff) {
    if (!Number.isSafeInteger(staleCutoff)) {
      throw new RangeError('staleCutoff must be an epoch-ms integer');
    }
  }

  /**
   * Explicit, fail-closed registration of a live TUI connection.
   *
   * - Fresh row owned by a DIFFERENT live connection (heartbeat inside the
   *   caller's cutoff and pid not verifiably dead) is never stolen.
   * - A stale or provably dead row is replaced: the new connection takes
   *   ownership and every later CAS by the old connection id fails.
   * - Same connection re-registering is an idempotent refresh.
   * - A caller-pinned shortId colliding with a DIFFERENT tracking id fails
   *   closed ('short_id_collision'); a derived short id retries fresh
   *   random candidates and never reassigns an existing one.
   *
   * A 'connected' event is appended atomically whenever ownership moves to
   * a new connection (insert or replace), never on idempotent refresh.
   */
  registerTuiSession({
    trackingId,
    connectionId,
    shortId,
    piSessionId,
    piSessionFile,
    cwd,
    label,
    pid,
    staleCutoff,
  }) {
    assertTuiId(trackingId, 'trackingId');
    assertTuiId(connectionId, 'connectionId');
    if (shortId !== undefined && shortId !== null) {
      if (typeof shortId !== 'string' || !TUI_SHORT_ID_RE.test(shortId)) {
        throw new TypeError(`shortId must match ${TUI_SHORT_ID_RE}`);
      }
    }
    piSessionId = assertOptionalTuiString(piSessionId, 'piSessionId', MAX_TUI_PATH_CHARS);
    piSessionFile = assertOptionalTuiString(piSessionFile, 'piSessionFile', MAX_TUI_PATH_CHARS);
    cwd = assertOptionalTuiString(cwd, 'cwd', MAX_TUI_PATH_CHARS);
    label = assertOptionalTuiString(label, 'label', MAX_TUI_LABEL_CHARS);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new RangeError('pid must be a positive integer');
    }
    this.#assertTuiStaleCutoff(staleCutoff);
    const now = this.#now();
    return this.#transaction(() => {
      const row = this.#getTuiSessionRow(trackingId);
      if (row && row.connection_id !== connectionId) {
        if (this.#tuiRowLive(row, staleCutoff)) {
          return { ok: false, reason: 'session_live_elsewhere' };
        }
        this.#db
          .prepare(
            `UPDATE tui_sessions SET
               connection_id = ?, state = 'connected',
               pi_session_id = ?, pi_session_file = ?, cwd = ?,
               label = ?, pid = ?,
               connected_at = ?, updated_at = ?, heartbeat_at = ?
             WHERE tracking_id = ?`,
          )
          .run(
            connectionId, piSessionId, piSessionFile, cwd,
            label, pid, now, now, now, trackingId,
          );
        this.#appendTuiEventRow(trackingId, 'connected', 'null', now);
        return { ok: true, replaced: true, shortId: row.short_id };
      }
      if (row) {
        // Same connection: idempotent refresh, no duplicate 'connected'.
        this.#db
          .prepare(
            `UPDATE tui_sessions SET
               pi_session_id = ?, pi_session_file = ?, cwd = ?,
               label = ?, pid = ?, state = 'connected',
               updated_at = ?, heartbeat_at = ?
             WHERE tracking_id = ? AND connection_id = ?`,
          )
          .run(piSessionId, piSessionFile, cwd, label, pid, now, now, trackingId, connectionId);
        return { ok: true, replaced: false, shortId: row.short_id };
      }
      let resolvedShortId = shortId ?? null;
      if (resolvedShortId === null) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const candidate = randomBytes(4).toString('hex');
          const clash = this.#db
            .prepare('SELECT 1 FROM tui_sessions WHERE short_id = ?')
            .get(candidate);
          if (!clash) {
            resolvedShortId = candidate;
            break;
          }
        }
        if (resolvedShortId === null) return { ok: false, reason: 'short_id_unavailable' };
      } else if (
        this.#db.prepare('SELECT 1 FROM tui_sessions WHERE short_id = ?').get(resolvedShortId)
      ) {
        return { ok: false, reason: 'short_id_collision' };
      }
      this.#db
        .prepare(
          `INSERT INTO tui_sessions
             (tracking_id, short_id, pi_session_id, pi_session_file, cwd,
              label, pid, connection_id, state, connected_at, updated_at, heartbeat_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?, ?)`,
        )
        .run(
          trackingId, resolvedShortId, piSessionId, piSessionFile, cwd,
          label, pid, connectionId, now, now, now,
        );
      this.#appendTuiEventRow(trackingId, 'connected', 'null', now);
      return { ok: true, replaced: false, shortId: resolvedShortId };
    });
  }

  /** CAS heartbeat: fails once the connection was replaced or removed. */
  heartbeatTuiSession({ trackingId, connectionId }) {
    assertTuiId(trackingId, 'trackingId');
    assertTuiId(connectionId, 'connectionId');
    return this.#transaction(() => {
      const now = this.#now();
      const info = this.#db
        .prepare(
          `UPDATE tui_sessions SET heartbeat_at = ?, updated_at = ?
           WHERE tracking_id = ? AND connection_id = ?`,
        )
        .run(now, now, trackingId, connectionId);
      return info.changes === 1 ? { ok: true } : { ok: false, reason: 'not_owner' };
    });
  }

  /** CAS busy/waiting/connected state; fails after replacement. */
  setTuiSessionState({ trackingId, connectionId, state }) {
    assertTuiId(trackingId, 'trackingId');
    assertTuiId(connectionId, 'connectionId');
    if (!TUI_SESSION_STATES.includes(state)) {
      throw new TypeError('state must be one of ' + TUI_SESSION_STATES.join(', '));
    }
    return this.#transaction(() => {
      const info = this.#db
        .prepare(
          `UPDATE tui_sessions SET state = ?, updated_at = ?
           WHERE tracking_id = ? AND connection_id = ?`,
        )
        .run(state, this.#now(), trackingId, connectionId);
      return info.changes === 1 ? { ok: true } : { ok: false, reason: 'not_owner' };
    });
  }

  /**
   * Explicit disconnect by the owning connection: deletes the session row
   * and appends a 'disconnected' event atomically. Events and commands are
   * intentionally NOT cascaded; the broker drains them before ack.
   */
  disconnectTuiSession({ trackingId, connectionId }) {
    assertTuiId(trackingId, 'trackingId');
    assertTuiId(connectionId, 'connectionId');
    const now = this.#now();
    return this.#transaction(() => {
      const row = this.#getTuiSessionRow(trackingId);
      if (!row || row.connection_id !== connectionId) {
        return { ok: false, reason: 'not_owner' };
      }
      this.#db
        .prepare('DELETE FROM tui_sessions WHERE tracking_id = ?')
        .run(trackingId);
      this.#appendTuiEventRow(trackingId, 'disconnected', 'null', now);
      return { ok: true };
    });
  }

  /** One tracked session; null when unknown. `live` reflects the cutoff. */
  getTuiSession({ trackingId, staleCutoff }) {
    assertTuiId(trackingId, 'trackingId');
    this.#assertTuiStaleCutoff(staleCutoff);
    const row = this.#getTuiSessionRow(trackingId);
    return row === undefined ? null : this.#rowToTuiSession(row, staleCutoff);
  }

  /** Every tracked session with caller-provided staleness evaluation. */
  listTuiSessions({ staleCutoff }) {
    this.#assertTuiStaleCutoff(staleCutoff);
    const rows = this.#db
      .prepare('SELECT * FROM tui_sessions ORDER BY connected_at, tracking_id')
      .all();
    return rows.map((row) => this.#rowToTuiSession(row, staleCutoff));
  }

  /**
   * Append a bounded event. Optional connectionId turns the append into a
   * CAS: a replaced connection cannot publish into the new owner's stream.
   */
  appendTuiEvent({ trackingId, kind, payload = null, connectionId }) {
    assertTuiId(trackingId, 'trackingId');
    if (connectionId !== undefined) assertTuiId(connectionId, 'connectionId');
    if (!TUI_EVENT_KINDS.includes(kind)) {
      throw new TypeError('unknown tui event kind');
    }
    assertTuiEventPayload(kind, payload ?? null);
    const payloadJson = JSON.stringify(payload ?? null);
    if (Buffer.byteLength(payloadJson, 'utf8') > this.#maxPayloadBytes) {
      throw new RangeError(`payload exceeds ${this.#maxPayloadBytes} bytes`);
    }
    return this.#transaction(() => {
      const row = this.#db
        .prepare('SELECT connection_id FROM tui_sessions WHERE tracking_id = ?')
        .get(trackingId);
      if (!row) return { ok: false, reason: 'unknown_session' };
      if (connectionId !== undefined && row.connection_id !== connectionId) {
        return { ok: false, reason: 'not_owner' };
      }
      const eventId = this.#appendTuiEventRow(trackingId, kind, payloadJson, this.#now());
      return { ok: true, eventId };
    });
  }

  /**
   * Unacknowledged events for one tracking id, oldest first, count-bound.
   * An unknown or replaced connection sees an empty list (fail closed,
   * no data leak to the old owner).
   */
  listPendingTuiEvents({ trackingId, connectionId, limit = 32 }) {
    assertTuiId(trackingId, 'trackingId');
    if (connectionId !== undefined) assertTuiId(connectionId, 'connectionId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TUI_EVENT_IDS) {
      throw new RangeError(`limit must be an integer in [1, ${MAX_TUI_EVENT_IDS}]`);
    }
    return this.#transaction(() => {
      const session = this.#db
        .prepare('SELECT connection_id FROM tui_sessions WHERE tracking_id = ?')
        .get(trackingId);
      if (!session) return [];
      if (connectionId !== undefined && session.connection_id !== connectionId) return [];
      const rows = this.#db
        .prepare(
          `SELECT event_id, tracking_id, kind, payload_json, created_at
           FROM tui_events
           WHERE tracking_id = ? AND acknowledged_at IS NULL
           ORDER BY event_id LIMIT ?`,
        )
        .all(trackingId, limit);
      return rows.map((row) => ({
        eventId: row.event_id,
        trackingId: row.tracking_id,
        kind: row.kind,
        payload: JSON.parse(row.payload_json),
        createdAt: row.created_at,
      }));
    });
  }

  /** Acknowledge drained events exactly once each. */
  acknowledgeTuiEvents({ eventIds }) {
    if (!Array.isArray(eventIds) || eventIds.length === 0 || eventIds.length > MAX_TUI_EVENT_IDS) {
      throw new RangeError(`eventIds must be an array of 1..${MAX_TUI_EVENT_IDS} ids`);
    }
    for (const id of eventIds) {
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new RangeError('eventIds must contain positive integers');
      }
    }
    return this.#transaction(() => {
      const placeholders = eventIds.map(() => '?').join(', ');
      const info = this.#db
        .prepare(
          `UPDATE tui_events SET acknowledged_at = ?
           WHERE acknowledged_at IS NULL AND event_id IN (${placeholders})`,
        )
        .run(this.#now(), ...eventIds);
      return { ok: true, acknowledged: info.changes };
    });
  }

  #rowToTuiCommand(row) {
    if (!row) return null;
    return freezeDeep({
      commandId: row.command_id,
      trackingId: row.tracking_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json),
      state: row.state,
      claimedAt: row.claimed_at,
      createdAt: row.created_at,
    });
  }

  /**
   * Enqueue an inbound command for ONE tracking id. Unknown kinds and
   * malformed/oversized payloads throw before any persistence; unknown or
   * disconnected sessions fail closed. Explicit commandId dedups as
   * 'duplicate_command' (at-most-once enqueue).
   */
  enqueueTuiCommand({ trackingId, kind, payload = null, commandId }) {
    assertTuiId(trackingId, 'trackingId');
    if (!TUI_COMMAND_KINDS.includes(kind)) {
      throw new TypeError('unknown tui command kind');
    }
    assertTuiCommandPayload(kind, payload ?? null);
    const payloadJson = JSON.stringify(payload ?? null);
    if (Buffer.byteLength(payloadJson, 'utf8') > this.#maxPayloadBytes) {
      throw new RangeError(`payload exceeds ${this.#maxPayloadBytes} bytes`);
    }
    if (commandId !== undefined && commandId !== null) {
      assertTuiId(commandId, 'commandId');
    }
    return this.#transaction(() => {
      const session = this.#db
        .prepare('SELECT 1 FROM tui_sessions WHERE tracking_id = ?')
        .get(trackingId);
      if (!session) return { ok: false, reason: 'unknown_session' };
      const id = commandId ?? randomBytes(16).toString('hex');
      const now = this.#now();
      const info = this.#db
        .prepare(
          `INSERT OR IGNORE INTO tui_commands
             (command_id, tracking_id, kind, payload_json, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(id, trackingId, kind, payloadJson, now, now);
      return info.changes === 1
        ? { ok: true, commandId: id }
        : { ok: false, reason: 'duplicate_command' };
    });
  }

  /**
   * Claim the oldest pending command for one tracking id. The claim is a
   * CAS against BOTH the pending state and the CURRENT session owner, so
   * a replaced connection can never drain commands addressed to the new
   * owner.
   *
   * Tiebreak is `rowid`, not `command_id`: tui_commands is a plain rowid
   * table, so rowid is insertion order and keeps FIFO when timestamps
   * tie. Abort→prompt and all multi-command plans require FIFO; command
   * ids are random, so ordering by them would shuffle same-millisecond
   * commands non-deterministically.
   */
  claimNextTuiCommand({ trackingId, connectionId, now = this.#now() }) {
    assertTuiId(trackingId, 'trackingId');
    assertTuiId(connectionId, 'connectionId');
    return this.#transaction(() => {
      const session = this.#db
        .prepare('SELECT connection_id FROM tui_sessions WHERE tracking_id = ?')
        .get(trackingId);
      if (!session) return { ok: false, reason: 'unknown_session' };
      if (session.connection_id !== connectionId) {
        return { ok: false, reason: 'not_owner' };
      }
      const row = this.#db
        .prepare(
          `SELECT command_id FROM tui_commands
           WHERE tracking_id = ? AND state = 'pending'
           ORDER BY created_at, rowid LIMIT 1`,
        )
        .get(trackingId);
      if (!row) return { ok: false, reason: 'empty' };
      const info = this.#db
        .prepare(
          `UPDATE tui_commands SET state = 'claimed', owner_connection_id = ?,
             claimed_at = ?, updated_at = ?
           WHERE command_id = ? AND state = 'pending'`,
        )
        .run(connectionId, now, now, row.command_id);
      if (info.changes !== 1) return { ok: false, reason: 'contention' };
      const claimed = this.#db
        .prepare('SELECT * FROM tui_commands WHERE command_id = ?')
        .get(row.command_id);
      return { ok: true, command: this.#rowToTuiCommand(claimed) };
    });
  }

  /** Complete a claimed command; only its claiming connection may. */
  completeTuiCommand({ commandId, connectionId }) {
    assertTuiId(commandId, 'commandId');
    assertTuiId(connectionId, 'connectionId');
    return this.#transaction(() => {
      const row = this.#db
        .prepare('SELECT * FROM tui_commands WHERE command_id = ?')
        .get(commandId);
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.state !== 'claimed') return { ok: false, reason: 'invalid_state' };
      if (row.owner_connection_id !== connectionId) return { ok: false, reason: 'not_owner' };
      this.#db
        .prepare(
          `UPDATE tui_commands SET state = 'completed', updated_at = ?
           WHERE command_id = ?`,
        )
        .run(this.#now(), commandId);
      return { ok: true };
    });
  }

  /**
   * Terminal failure for a claimed command, by its owner. The reason is a
   * code-only slug: command text and payloads are never recorded here.
   */
  failTuiCommand({ commandId, connectionId, resultCode }) {
    assertTuiId(commandId, 'commandId');
    assertTuiId(connectionId, 'connectionId');
    const code = assertTuiCode(resultCode, 'resultCode');
    return this.#transaction(() => {
      const row = this.#db
        .prepare('SELECT * FROM tui_commands WHERE command_id = ?')
        .get(commandId);
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.state !== 'claimed') return { ok: false, reason: 'invalid_state' };
      if (row.owner_connection_id !== connectionId) return { ok: false, reason: 'not_owner' };
      this.#db
        .prepare(
          `UPDATE tui_commands SET state = 'failed', result_code = ?, updated_at = ?
           WHERE command_id = ?`,
        )
        .run(code, this.#now(), commandId);
      return { ok: true };
    });
  }

  /**
   * Recovery after a crash: claimed commands older than the claim timeout
   * are marked failed with the fixed code 'claim_expired' and are NEVER
   * replayed (no ambiguity: the human re-issues them). Returns the failed
   * command ids.
   */
  failStaleClaimedTuiCommands({ now = this.#now(), claimTimeoutMs }) {
    if (!Number.isSafeInteger(claimTimeoutMs) || claimTimeoutMs <= 0) {
      throw new RangeError('claimTimeoutMs must be a positive integer');
    }
    const cutoff = now - claimTimeoutMs;
    return this.#transaction(() => {
      const rows = this.#db
        .prepare(
          `SELECT command_id FROM tui_commands
           WHERE state = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?`,
        )
        .all(cutoff);
      if (rows.length > 0) {
        this.#db
          .prepare(
            `UPDATE tui_commands SET state = 'failed', result_code = 'claim_expired',
               updated_at = ?
             WHERE state = 'claimed' AND claimed_at IS NOT NULL AND claimed_at <= ?`,
          )
          .run(now, cutoff);
      }
      return rows.map((row) => row.command_id);
    });
  }

  // --- Broker-side transport (T03: selective TUI broker) ----------------

  /**
   * Broker-scoped Telegram update offset. Deliberately separate from the
   * legacy worker's 'transport_offset': the two runtimes may poll
   * DIFFERENT bot tokens whose update_id sequences are independent, so a
   * shared offset key would corrupt both streams. Same durability
   * semantics as advanceTransportOffset: never moves backwards.
   */
  getBrokerTransportOffset() {
    const raw = this.#getMeta('broker_transport_offset');
    return raw === undefined ? 0 : Number(raw);
  }

  advanceBrokerTransportOffset(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError('offset must be a non-negative integer');
    }
    this.#transaction(() => {
      const current = this.getBrokerTransportOffset();
      if (offset > current) this.#setMeta('broker_transport_offset', String(offset));
    });
  }

  /**
   * Broker event drain: pending events across ALL tracked sessions,
   * oldest first, INCLUDING sessions whose row was already deleted —
   * disconnectTuiSession appends the 'disconnected' event and removes the
   * row in one atomic step, so the disconnected notice must remain
   * drainable even though listPendingTuiEvents fails closed on unknown
   * sessions. Count-bounded; payloads are exactly the bounded rows the
   * extension published (never credentials, never hidden reasoning).
   */
  listPendingBrokerTuiEvents({ limit = 32 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TUI_EVENT_IDS) {
      throw new RangeError(`limit must be an integer in [1, ${MAX_TUI_EVENT_IDS}]`);
    }
    return this.#transaction(() => {
      const rows = this.#db
        .prepare(
          `SELECT event_id, tracking_id, kind, payload_json, created_at
           FROM tui_events
           WHERE acknowledged_at IS NULL
           ORDER BY event_id LIMIT ?`,
        )
        .all(limit);
      return rows.map((row) => ({
        eventId: row.event_id,
        trackingId: row.tracking_id,
        kind: row.kind,
        payload: JSON.parse(row.payload_json),
        createdAt: row.created_at,
      }));
    });
  }
}
