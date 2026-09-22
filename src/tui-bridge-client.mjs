// Thin synchronous client over the bridge Store for the global Pi
// extension (selective tracked-TUI transport). It owns ONLY transport
// bookkeeping:
// - strong random tracking/connection ids via node:crypto,
// - bounded text and code-only failure reasons (no payload echoing),
// - no Telegram credentials, no network, no listeners, no shell, and no
//   Pi process ownership. The broker talks to Telegram; this module
//   never does.
//
// Everything is synchronous because node:sqlite is: the extension can
// call these from its hooks without introducing async ordering hazards.

import { randomBytes } from 'node:crypto';
import { Store } from './store.mjs';

const ID_BYTES = 16;
const MAX_TEXT_CHARS = 4000;
const MAX_EVENTS_PER_POLL = 32;
const MAX_COMMANDS_PER_POLL = 8;
const DEFAULT_STALE_AFTER_MS = 30000;

export class TuiBridgeClient {
  /**
   * @param {Store} store shared synchronous bridge store
   * @param {object} [options]
   * @param {number} [options.staleAfterMs] default staleness window (ms)
   */
  constructor(store, options = {}) {
    if (!(store instanceof Store)) {
      throw new TypeError('store must be a Store instance');
    }
    this.#store = store;
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  }

  #store;
  #staleAfterMs;

  #cutoff(staleAfterMs) {
    const window = staleAfterMs ?? this.#staleAfterMs;
    if (!Number.isSafeInteger(window) || window <= 0) {
      throw new RangeError('staleAfterMs must be a positive integer');
    }
    return Date.now() - window;
  }

  /**
   * Register this Pi TUI as connected. When trackingId/connectionId are
   * omitted, strong random ids are generated. NOTE: a caller that holds a
   * stable trackingId must also reuse its own connectionId on reconnect
   * of the SAME process; a different connection id against a live row
   * fails closed with 'session_live_elsewhere' (a dead or stale owner is
   * safely replaced instead).
   */
  connect({
    trackingId,
    connectionId,
    shortId,
    piSessionId,
    piSessionFile,
    cwd,
    label,
    pid,
    staleAfterMs,
  } = {}) {
    const resolvedTrackingId = trackingId ?? randomBytes(ID_BYTES).toString('hex');
    const resolvedConnectionId = connectionId ?? randomBytes(ID_BYTES).toString('hex');
    const result = this.#store.registerTuiSession({
      trackingId: resolvedTrackingId,
      connectionId: resolvedConnectionId,
      shortId,
      piSessionId,
      piSessionFile,
      cwd,
      label,
      pid,
      staleCutoff: this.#cutoff(staleAfterMs),
    });
    if (!result.ok) return result;
    return { ...result, trackingId: resolvedTrackingId, connectionId: resolvedConnectionId };
  }

  heartbeat({ trackingId, connectionId }) {
    return this.#store.heartbeatTuiSession({ trackingId, connectionId });
  }

  /** state: 'connected' | 'busy' | 'waiting'. */
  setState({ trackingId, connectionId, state }) {
    return this.#store.setTuiSessionState({ trackingId, connectionId, state });
  }

  /** Bounded final assistant output; never hidden reasoning. */
  publishFinalOutput({ trackingId, connectionId, text }) {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_CHARS) {
      throw new TypeError(`text must be a non-empty string of at most ${MAX_TEXT_CHARS} chars`);
    }
    return this.#store.appendTuiEvent({
      trackingId,
      kind: 'final_output',
      payload: { text },
      connectionId,
    });
  }

  /** Optional bounded plain-object status payload. */
  publishStatus({ trackingId, connectionId, payload = null }) {
    return this.#store.appendTuiEvent({
      trackingId,
      kind: 'status',
      payload,
      connectionId,
    });
  }

  /**
   * Drain pending events and claim the next inbound commands addressed to
   * this tracking id. Both sides verify current connection ownership: a
   * replaced connection drains nothing.
   */
  poll({ trackingId, connectionId, maxEvents, maxCommands }) {
    const events = this.#store.listPendingTuiEvents({
      trackingId,
      connectionId,
      limit: maxEvents ?? MAX_EVENTS_PER_POLL,
    });
    const commands = [];
    const limit = maxCommands ?? MAX_COMMANDS_PER_POLL;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 64) {
      throw new RangeError('maxCommands must be an integer in [0, 64]');
    }
    for (let i = 0; i < limit; i++) {
      const claim = this.#store.claimNextTuiCommand({ trackingId, connectionId });
      if (!claim.ok) break;
      commands.push(claim.command);
    }
    return { ok: true, events, commands };
  }

  acknowledgeEvents({ eventIds }) {
    return this.#store.acknowledgeTuiEvents({ eventIds });
  }

  /**
   * Report one claimed command's outcome and append the matching
   * 'command_result' event. The command state flip and the event append
   * are separate transactions; `eventFailed` flags the rare case where
   * the command was acknowledged but its event could not be appended.
   */
  reportCommandResult({ commandId, trackingId, connectionId, ok, text, resultCode }) {
    if (typeof ok !== 'boolean') {
      throw new TypeError('ok must be a boolean');
    }
    if (text !== undefined && (typeof text !== 'string' || text.length > MAX_TEXT_CHARS)) {
      throw new TypeError(`text must be a string of at most ${MAX_TEXT_CHARS} chars`);
    }
    const outcome = ok
      ? this.#store.completeTuiCommand({ commandId, connectionId })
      : this.#store.failTuiCommand({ commandId, connectionId, resultCode });
    if (!outcome.ok) return outcome;
    const payload = { ok };
    if (text !== undefined) payload.text = text;
    if (resultCode !== undefined) payload.resultCode = resultCode;
    const event = this.#store.appendTuiEvent({
      trackingId,
      kind: 'command_result',
      payload,
      connectionId,
    });
    if (!event.ok) {
      return { ok: true, commandAcknowledged: true, eventFailed: true, reason: event.reason };
    }
    return { ok: true, commandAcknowledged: true, eventId: event.eventId };
  }

  /**
   * Crash recovery: mark stale claimed commands failed (code-only,
   * 'claim_expired') without replaying them. Returns the failed ids.
   */
  recoverStaleCommands({ claimTimeoutMs, now } = {}) {
    return this.#store.failStaleClaimedTuiCommands({ claimTimeoutMs, now });
  }

  /** Explicit disconnect by the owning connection. */
  disconnect({ trackingId, connectionId }) {
    return this.#store.disconnectTuiSession({ trackingId, connectionId });
  }

  /** Live/stale view of every tracked session for selection UIs. */
  listSessions({ staleAfterMs } = {}) {
    return this.#store.listTuiSessions({ staleCutoff: this.#cutoff(staleAfterMs) });
  }

  getSession({ trackingId, staleAfterMs }) {
    return this.#store.getTuiSession({
      trackingId,
      staleCutoff: this.#cutoff(staleAfterMs),
    });
  }
}
