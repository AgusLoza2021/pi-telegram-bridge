// SessionHost (T02, corrected): the bridge-side owner of one or more Pi
// RPC sessions.
//
// Responsibilities and invariants:
// - Owns the child processes through injected PiRpcAdapter instances.
// - Persists the exact Pi session identity (sessionId/file/PID) plus the
//   host generation; a takeover bumps the generation so stale decisions
//   fail closed.
// - Every extension UI dialog is persisted (immutable requestId <-> ui id
//   mapping inside the request action) BEFORE anything reaches chat.
// - Decisions are applied exactly once via the store CAS; sending the UI
//   response is NOT "applied". Applied means the correlated REAL pi event
//   arrived (tool_execution_end for the exact toolCallId observed at
//   tool_execution_start — never a model-provided requestId).
// - bridge_decision is a real awaited question tool: pi emits
//   tool_execution_start before the dialog and tool_execution_end after
//   it. The host correlates dialog <-> toolCallId from those events.
// - agent_settled alone is never success; it only fails decisions that
//   were RESPONDED and were waiting for a tool end that never came.
//   Unanswered and unrelated dialogs survive a settle.
// - notify is fire-and-forget: it never creates a request.
// - The /bridge-demo flow is a host-generated single-use nonce lifecycle;
//   completion requires a strict JSON {nonce, choice} notify matching the
//   nonce AND the durable recorded human decision value, in either
//   arrival order (evidence is bound to the concrete demo dialog entry).
//   Arbitrary text never completes anything (H3).
// - Expiry cancels the REAL pending pi dialog; cancel clears the dialog,
//   aborts the run and drains the queue for that request.
// - Sensitive dialog content is never transported (no redaction that
//   could change meaning): the dialog is cancelled and blocked.
// - The IPC action queue is drained at-most-once by actionId; malformed
//   actions become terminal failed (never retried).

import { randomBytes } from 'node:crypto';

import { containsSensitive } from './policy.mjs';

const DECISION_DIALOG_METHODS = new Set(['select', 'confirm', 'input']);
// Mirrors the worker's keyboard limit: a select wider than this cannot be
// rendered without changing the meaning of the question (M1-4).
const MAX_SELECT_OPTIONS = 8;

// Tools whose execution the host verifies observationally (real
// tool_execution_end events); used to close gate requests with observed
// evidence instead of assumed success.
const GATED_TOOLS = new Set(['write', 'edit', 'bash', 'powershell']);

// Bounded free-form input decisions (dialog method 'input').
const MAX_INPUT_DECISION_CHARS = 4096;

// T04: host-side followup bounds. The consumer is DENIED by default; the
// enabling flag must be validated on BOTH worker and host (same ops
// config), and the payload is strictly typed and bounded.
const MAX_FOLLOWUP_TEXT_CHARS = 4096;
const MAX_FOLLOWUP_SESSION_CHARS = 128;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

/** Strict single-key decision shapes; extra keys are rejected (H2). */
function validateDecision(method, decision, action) {
  const keys = Object.keys(decision).sort();
  if (keys.length === 1 && keys[0] === 'cancelled') {
    if (decision.cancelled !== true) return null;
    return { cancelled: true };
  }
  if (method === 'confirm') {
    if (keys.length === 1 && keys[0] === 'confirmed' && typeof decision.confirmed === 'boolean') {
      return { confirmed: decision.confirmed };
    }
    return null;
  }
  if (method === 'select') {
    if (keys.length === 1 && keys[0] === 'value') {
      const options = Array.isArray(action?.options) ? action.options : null;
      if (
        typeof decision.value === 'string' &&
        options !== null &&
        options.includes(decision.value)
      ) {
        return { value: decision.value };
      }
    }
    return null;
  }
  if (method === 'input') {
    if (
      keys.length === 1 &&
      keys[0] === 'value' &&
      typeof decision.value === 'string' &&
      decision.value.length > 0 &&
      decision.value.length <= MAX_INPUT_DECISION_CHARS
    ) {
      return { value: decision.value };
    }
    return null;
  }
  return null;
}

export class SessionHost {
  constructor({
    store,
    ownerId,
    pid = process.pid,
    adapterFactory,
    requestTtlMs = 600000,
    decisionApplyTimeoutMs = 30000,
    claimTimeoutMs = 60000,
    followupsEnabled = false,
    now = Date.now,
  }) {
    if (typeof ownerId !== 'string' || ownerId.length === 0) {
      throw new TypeError('ownerId must be a non-empty string');
    }
    if (typeof adapterFactory !== 'function') {
      throw new TypeError('adapterFactory must be a function');
    }
    this.#store = store;
    this.#ownerId = ownerId;
    this.#pid = pid;
    this.#adapterFactory = adapterFactory;
    this.#requestTtlMs = requestTtlMs;
    this.#decisionApplyTimeoutMs = decisionApplyTimeoutMs;
    this.#claimTimeoutMs = claimTimeoutMs;
    // T04: followup consumption stays OFF unless the deployment flag was
    // set explicitly on the host too — the worker flag alone is never enough.
    this.#followupsEnabled = followupsEnabled === true;
    this.#now = now;
  }

  #store;
  #ownerId;
  #pid;
  #adapterFactory;
  #requestTtlMs;
  #decisionApplyTimeoutMs;
  #claimTimeoutMs;
  #followupsEnabled;
  #now;

  /** @type {Map<string, {adapter: any, generation: number}>} sessionId -> live session */
  #sessions = new Map();
  /**
   * requestId -> live dialog entry:
   * { sessionId, uiId, kind: 'tool_question'|'demo'|'gate',
   *   toolCallId: string|null, responded: bool, respondedAt: number|null }
   */
  #pendingDialogs = new Map();
  /** sessionId -> Set of in-flight bridge_decision toolCallIds (real start events). */
  #inFlightDecisionTools = new Map();
  /** sessionId -> { nonce: string, notifyChoice?: string } while a locally initiated demo is open. */
  #demoLifecycles = new Map();
  /** sessionId -> true while an accepted followup awaits its agent settle. */
  #followupsInFlight = new Map();
  #outboxHandlers = [];
  #hostEventHandlers = [];
  #leasing = false;

  onOutbox(handler) { this.#outboxHandlers.push(handler); }
  onHostEvent(handler) { this.#hostEventHandlers.push(handler); }

  #emitOutbox(message) { for (const h of this.#outboxHandlers) h(message); }
  #emitHostEvent(event) { for (const h of this.#hostEventHandlers) h(event); }

  /**
   * Acquire the singleton host lease, bump the generation and start one
   * pi session. Rejects when the lease is busy (fail closed).
   */
  async startSession(sessionId) {
    if (!this.#leasing) {
      const lease = this.#store.acquireHostLease({ ownerId: this.#ownerId, pid: this.#pid });
      if (!lease.ok) {
        const error = new Error('host lease is busy; another bridge host owns this database');
        error.code = 'LEASE_BUSY';
        throw error;
      }
      // A new host instance always starts a new generation: every decision
      // recorded under the old generation becomes permanently stale.
      this.#leasing = true;
      this.#store.incrementHostGeneration();
    }
    const generation = this.#store.getHostGeneration();

    const adapter = this.#adapterFactory({ sessionId });
    // T04r: if anything fails between spawn and registration, the fresh
    // adapter must be disposed so no orphan Pi child survives.
    let state;
    try {
      state = await adapter.start();
      adapter.onUiRequest((request) => this.#handleUiRequest(sessionId, request));
      adapter.onEvent((event) => this.#handleEvent(sessionId, event));
      this.#store.createSession({ sessionId, piSessionId: state.sessionId });
    } catch (error) {
      try {
        await adapter.dispose();
      } catch {
        // Dispose is best-effort; the original failure still propagates.
      }
      throw error;
    }

    this.#sessions.set(sessionId, { adapter, generation });
    return {
      sessionId,
      piSessionId: state.sessionId,
      sessionFile: state.sessionFile,
      pid: state.pid,
      hostGeneration: generation,
    };
  }

  #classifyDialog(sessionId, request) {
    const demoOpen = this.#demoLifecycles.has(sessionId);
    const inFlight = this.#inFlightDecisionTools.get(sessionId);
    const count = inFlight ? inFlight.size : 0;
    if (demoOpen && count > 0) {
      // T04r ambiguity refusal: a locally initiated demo AND a real
      // awaited question are both open. The dialog is never answered on
      // guesswork; the caller refuses it and abandons the demo.
      return { kind: 'ambiguous', toolCallId: null };
    }
    if (demoOpen) {
      return { kind: 'demo', toolCallId: null };
    }
    if (count === 1) {
      // Exactly one awaited question tool is running: certain association.
      return { kind: 'tool_question', toolCallId: [...inFlight][0] };
    }
    if (count > 1) {
      // Parallel questions: association uncertain — the dialog stays
      // blocked (never answered on guesswork) until expiry.
      return { kind: 'tool_question', toolCallId: null };
    }
    // Gate dialogs (guarded write/edit/etc. confirmations) and any other
    // extension dialog.
    return { kind: 'gate', toolCallId: null };
  }

  #handleUiRequest(sessionId, request) {
    // H3: the only notify channel that may COMPLETE something is a strict
    // JSON {nonce, choice} matching the locally generated demo nonce.
    if (request.method === 'notify') {
      this.#handleDemoNotify(sessionId, request);
      // Fire-and-forget (B2): never a request, never cancels dialogs.
      if (containsSensitive(JSON.stringify(request))) {
        // Even notifications must not transport sensitive content.
        this.#emitHostEvent({ kind: 'ui_blocked_sensitive', sessionId, uiId: request.id });
        return;
      }
      this.#store.enqueueOutbox({
        kind: 'notification',
        payload: { sessionId, method: request.method, message: typeof request.message === 'string' ? request.message : null },
      });
      this.#emitOutbox({
        sessionId,
        kind: 'notification',
        method: request.method,
        message: typeof request.message === 'string' ? request.message : null,
      });
      return;
    }

    // 1. Sensitive content never reaches chat: cancel the real dialog and
    //    drop it (no redaction that could change meaning, no persistence).
    if (containsSensitive(JSON.stringify(request))) {
      this.#safeRespondUi(sessionId, request.id, { cancelled: true });
      this.#emitHostEvent({ kind: 'ui_blocked_sensitive', sessionId, uiId: request.id });
      return;
    }
    // 2. M1-4: an unrenderable select (zero, more than the keyboard limit,
    //    or non-string entries) must never become a request: the REAL pi
    //    dialog is cancelled up front (never left hanging), a safe fixed
    //    notification is enqueued (option values never leak) and the
    //    rejection is observed as a host event. The worker validates again
    //    at its common render path for corrupted/stale state.
    if (request.method === 'select') {
      const rawOptions = Array.isArray(request.options) ? request.options : [];
      const renderable = rawOptions.length >= 1
        && rawOptions.length <= MAX_SELECT_OPTIONS
        && rawOptions.every((option) => typeof option === 'string');
      if (!renderable) {
        this.#safeRespondUi(sessionId, request.id, { cancelled: true });
        this.#store.enqueueOutbox({
          kind: 'notification',
          payload: { sessionId, method: 'notify', message: 'Dialog rejected: the select question had unsupported options. The pi dialog was cancelled.' },
        });
        this.#emitOutbox({ sessionId, kind: 'notification', message: 'Dialog rejected: the select question had unsupported options. The pi dialog was cancelled.' });
        this.#emitHostEvent({ kind: 'dialog_rejected', sessionId, uiId: request.id, reason: 'unrenderable_options' });
        return;
      }
    }
    // 3. Persist first, transport later (durable mapping uiId <-> requestId).
    const needsDecision = DECISION_DIALOG_METHODS.has(request.method);
    const action = {
      kind: needsDecision ? 'dialog' : 'notification',
      uiId: request.id,
      method: request.method,
      title: request.title ?? null,
      options: Array.isArray(request.options) ? request.options : null,
      message: typeof request.message === 'string' ? request.message : null,
    };
    const created = this.#store.createRequest({ sessionId, action, ttlMs: this.#requestTtlMs });
    if (!created.ok) {
      // Unknown session or busy session: the pi dialog is real, so it must
      // be cancelled instead of left hanging.
      this.#safeRespondUi(sessionId, request.id, { cancelled: true });
      this.#emitHostEvent({ kind: 'dialog_rejected', sessionId, uiId: request.id, reason: created.reason });
      return;
    }
    const requestId = created.request.requestId;
    if (needsDecision) {
      const { kind, toolCallId } = this.#classifyDialog(sessionId, request);
      if (kind === 'ambiguous') {
        // T04r: refuse the ambiguous dialog (it is cancelled in pi, never
        // enqueued for a decision) and abandon the demo lifecycle so the
        // real tool dialog classifies cleanly afterwards.
        this.#safeRespondUi(sessionId, request.id, { cancelled: true });
        if (this.#demoLifecycles.has(sessionId)) this.#demoLifecycles.delete(sessionId);
        this.#emitHostEvent({ kind: 'dialog_ambiguous_refused', sessionId, uiId: request.id });
        this.#emitHostEvent({ kind: 'demo_abandoned_ambiguous', sessionId });
        return;
      }
      this.#store.markWaitingDecision(requestId, { sessionId });
      const dialogEntry = {
        sessionId,
        uiId: request.id,
        kind,
        toolCallId,
        responded: false,
        respondedAt: null,
      };
      if (kind === 'demo') {
        // Bind the demo nonce to the concrete pending dialog entry so the
        // completion evidence can be attached to THIS dialog regardless
        // of the ordering between the UI response and the real notify.
        const lifecycle = this.#demoLifecycles.get(sessionId);
        dialogEntry.nonce = lifecycle ? lifecycle.nonce : null;
        if (lifecycle && typeof lifecycle.notifyChoice === 'string') {
          dialogEntry.notifyChoice = lifecycle.notifyChoice;
        }
      }
      this.#pendingDialogs.set(requestId, dialogEntry);
      this.#store.enqueueOutbox({
        kind: 'approval_request',
        payload: { requestId, sessionId, method: request.method, title: action.title, options: action.options },
      });
      this.#emitOutbox({
        sessionId,
        kind: 'approval_request',
        requestId,
        method: request.method,
        title: action.title,
        options: action.options,
      });
    } else {
      this.#store.enqueueOutbox({
        kind: 'notification',
        payload: { sessionId, method: request.method, message: action.message },
      });
      this.#emitOutbox({ sessionId, kind: 'notification', message: action.message });
    }
  }

  #handleDemoNotify(sessionId, request) {
    if (typeof request.message !== 'string' || request.message.length === 0) return;
    if (!this.#demoLifecycles.has(sessionId)) return;
    let parsed;
    try {
      parsed = JSON.parse(request.message);
    } catch {
      return; // Arbitrary text never completes anything.
    }
    if (!isPlainObject(parsed)) return;
    const lifecycle = this.#demoLifecycles.get(sessionId);
    if (parsed.nonce !== lifecycle.nonce || typeof parsed.choice !== 'string') {
      this.#emitHostEvent({ kind: 'demo_rejected', sessionId, uiId: request.id });
      return;
    }
    // Attach the nonce-matched notify evidence to the concrete demo
    // dialog entry bound to this nonce, even if the human decision has
    // not been recorded yet: completion happens whenever the SECOND
    // durable fact (store-accepted decision or real notify) arrives.
    const entries = [...this.#pendingDialogs.entries()]
      .filter(([, entry]) => entry.sessionId === sessionId && entry.kind === 'demo' && entry.nonce === parsed.nonce);
    if (entries.length === 0) {
      // Notify before the demo dialog exists: keep the evidence on the
      // lifecycle so dialog creation binds it to the entry (either order).
      lifecycle.notifyChoice = parsed.choice;
      return;
    }
    const [requestId, entry] = entries[entries.length - 1];
    entry.notifyChoice = parsed.choice;
    this.#tryCompleteDemo(requestId, entry);
  }

  /**
   * Complete a demo request only when BOTH durable facts are observed:
   * the store accepted the human decision (resuming with a recorded
   * decision value) AND the real nonce-bound notify carried exactly that
   * decision value. Never completes from the decision_applied outbox or
   * from arbitrary notify text; the nonce stays single-use and pending
   * state is removed only after the durable completion succeeded.
   */
  #tryCompleteDemo(requestId, entry) {
    if (!entry.responded || typeof entry.notifyChoice !== 'string') return;
    const request = this.#store.getRequest(requestId);
    const decision = request?.decision;
    if (!request || request.state !== 'resuming' || !isPlainObject(decision)) return;
    if (decision.value !== entry.notifyChoice) {
      // The nonce-bound notify must echo the durable human decision
      // value; anything else never completes the request.
      this.#emitHostEvent({ kind: 'demo_choice_mismatched', requestId });
      return;
    }
    const done = this.#store.completeRequest({
      requestId,
      sessionId: entry.sessionId,
      result: { applied: true, demo: true, choice: entry.notifyChoice },
    });
    if (done.ok) {
      this.#pendingDialogs.delete(requestId);
      this.#demoLifecycles.delete(entry.sessionId); // Nonce is single-use.
      this.#emitHostEvent({ kind: 'request_completed', requestId });
    }
  }

  #safeRespondUi(sessionId, uiId, response) {
    const session = this.#sessions.get(sessionId);
    if (!session?.adapter?.isRunning()) return false;
    try {
      session.adapter.respondUi(uiId, response);
      return true;
    } catch {
      return false;
    }
  }

  #completeToolQuestion(requestId, event) {
    const entry = this.#pendingDialogs.get(requestId);
    const sessionId = entry.sessionId;
    if (event.isError === true) {
      this.#store.failRequest({ requestId, sessionId, reason: 'bridge_decision_failed' });
      this.#emitHostEvent({ kind: 'request_failed', requestId, reason: 'bridge_decision_failed' });
    } else {
      const done = this.#store.completeRequest({ requestId, sessionId, result: event.result ?? null });
      if (done.ok) this.#emitHostEvent({ kind: 'request_completed', requestId });
    }
    this.#pendingDialogs.delete(requestId);
  }

  #handleEvent(sessionId, event) {
    if (!event || typeof event !== 'object') return;

    // B4: track awaited question tools from their REAL start events.
    if (event.type === 'tool_execution_start' && event.toolName === 'bridge_decision' && typeof event.toolCallId === 'string') {
      let inFlight = this.#inFlightDecisionTools.get(sessionId);
      if (!inFlight) {
        inFlight = new Set();
        this.#inFlightDecisionTools.set(sessionId, inFlight);
      }
      inFlight.add(event.toolCallId);
      return;
    }

    // B1: real end shape {toolCallId, toolName, result, isError}.
    if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
      const inFlight = this.#inFlightDecisionTools.get(sessionId);
      if (inFlight) inFlight.delete(event.toolCallId);

      if (event.toolName === 'bridge_decision') {
        // Complete the dialog correlated to this exact toolCallId.
        for (const [requestId, entry] of this.#pendingDialogs) {
          if (entry.sessionId === sessionId && entry.kind === 'tool_question' && entry.toolCallId === event.toolCallId) {
            this.#completeToolQuestion(requestId, event);
            return;
          }
        }
        // No correlated dialog: nothing to do (never invent evidence).
        return;
      }

      // Gated tool verification (write/edit/bash/powershell): observe the
      // real end event and close the matching gate request with it.
      if (GATED_TOOLS.has(event.toolName)) {
        this.#emitHostEvent({
          kind: 'gated_tool_executed',
          sessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError === true,
        });
        const respondedGates = [...this.#pendingDialogs.entries()]
          .filter(([, entry]) => entry.sessionId === sessionId && entry.kind === 'gate' && entry.responded);
        if (respondedGates.length === 1) {
          const [requestId, entry] = respondedGates[0];
          if (event.isError === true) {
            this.#store.failRequest({ requestId, sessionId: entry.sessionId, reason: 'gated_tool_failed' });
            this.#emitHostEvent({ kind: 'request_failed', requestId, reason: 'gated_tool_failed' });
          } else {
            const done = this.#store.completeRequest({ requestId, sessionId: entry.sessionId, result: { applied: true, gated: true } });
            if (done.ok) this.#emitHostEvent({ kind: 'request_completed', requestId });
          }
          this.#pendingDialogs.delete(requestId);
        }
      }
      return;
    }

    // agent_settled is NOT success: it only fails decisions that were
    // responded and whose awaited tool end never arrived. Unanswered and
    // unrelated dialogs survive a settle.
    if (event.type === 'agent_settled') {
      // T04: an accepted followup's run settled — single-shot completion
      // notification with a fixed factual summary (never chain-of-thought).
      if (this.#followupsInFlight.has(sessionId)) {
        this.#followupsInFlight.delete(sessionId);
        this.#notifyFollowup(sessionId, `Followup completed for session ${sessionId}: the agent settled.`);
      }
      for (const [requestId, entry] of this.#pendingDialogs) {
        if (entry.sessionId !== sessionId) continue;
        if (entry.kind === 'tool_question' && entry.responded && entry.toolCallId !== null) {
          this.#store.failRequest({ requestId, sessionId, reason: 'decision_not_applied' });
          this.#emitHostEvent({ kind: 'request_failed', requestId, reason: 'decision_not_applied' });
          this.#pendingDialogs.delete(requestId);
        }
      }
    }
  }

  /**
   * Human chat input. Command-shaped input is rejected in ANY line (B3):
   * pi executes slash commands immediately, so chat must never be a
   * command channel. Demo/command flows use dedicated private methods.
   */
  async sendUserPrompt(sessionId, text) {
    const message = String(text ?? '');
    for (const line of message.split(/\r?\n/)) {
      if (line.trimStart().startsWith('/')) {
        return { ok: false, reason: 'command_rejected' };
      }
    }
    return this.#sendRawPrompt(sessionId, message);
  }

  async #sendRawPrompt(sessionId, message, { timeoutMs = undefined } = {}) {
    const session = this.#sessions.get(sessionId);
    if (!session) return { ok: false, reason: 'unknown_session' };
    try {
      const response = await session.adapter.send(
        { type: 'prompt', message },
        timeoutMs === undefined ? {} : { timeoutMs },
      );
      return { ok: true, response };
    } catch (error) {
      return { ok: false, reason: error?.code ?? 'send_failed' };
    }
  }

  /**
   * Locally initiated demo lifecycle (host tooling only, never exposed as
   * raw chat): generates a single-use nonce and sends the fixed demo
   * command. Completion requires the nonce-bound strict JSON notify.
   */
  /** T04: exposes the current demo nonce for host tooling only (local
   * verification of the notify completion path; never part of any wire
   * protocol or log). */
  getDemoNonce(sessionId) {
    const lifecycle = this.#demoLifecycles.get(sessionId);
    return lifecycle ? lifecycle.nonce : null;
  }

  startDemo(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session?.adapter?.isRunning()) return { ok: false, reason: 'unknown_session' };
    if (this.#demoLifecycles.has(sessionId)) return { ok: false, reason: 'demo_already_running' };
    const inFlight = this.#inFlightDecisionTools.get(sessionId);
    if (inFlight && inFlight.size > 0) {
      // T04r: a real tool question is awaited — starting the fixed local
      // demo now would make the next dialog ambiguous. Refuse cleanly.
      return { ok: false, reason: 'session_busy_real_tool' };
    }
    const nonce = randomBytes(8).toString('hex');
    this.#demoLifecycles.set(sessionId, { nonce });
    // The RPC prompt response remains pending while the human-facing
    // select is open. Give it the full request lifetime: using the
    // adapter's short command timeout would discard the demo lifecycle
    // even though Pi is still legitimately awaiting the phone decision.
    const demoPromptTimeoutMs = this.#requestTtlMs + this.#decisionApplyTimeoutMs;
    this.#sendRawPrompt(
      sessionId,
      `/bridge-demo ${nonce}`,
      { timeoutMs: demoPromptTimeoutMs },
    ).then((result) => {
      if (!result.ok) this.#demoLifecycles.delete(sessionId);
    });
    return { ok: true };
  }

  isSessionRunning(sessionId) {
    return this.#sessions.get(sessionId)?.adapter?.isRunning() ?? false;
  }

  /**
   * Apply a human decision exactly once. The decision shape is validated
   * against the immutable dialog action BEFORE the CAS (H2): a malformed
   * decision consumes nothing and sends nothing. If the CAS fails (already
   * decided, stale generation, wrong session) NOTHING is sent to pi and
   * the rejection is observed.
   */
  submitDecision({ requestId, decision }) {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      return { ok: false, reason: 'bad_request' };
    }
    if (!isPlainObject(decision)) {
      return { ok: false, reason: 'bad_decision' };
    }
    const request = this.#store.getRequest(requestId);
    if (!request) return { ok: false, reason: 'not_found' };

    const validated = validateDecision(request.action?.method, decision, request.action);
    if (validated === null) {
      // H2: reject before the CAS; the request stays decidable.
      this.#emitHostEvent({ kind: 'decision_rejected', requestId, reason: 'bad_decision' });
      return { ok: false, reason: 'bad_decision' };
    }

    const recorded = this.#store.recordDecision({
      requestId,
      sessionId: request.sessionId,
      decision: validated,
    });
    if (!recorded.ok) {
      this.#emitHostEvent({ kind: 'decision_rejected', requestId, reason: recorded.reason });
      return recorded;
    }

    const entry = this.#pendingDialogs.get(requestId);
    if (entry) {
      // Shape the pi dialog response from the validated decision.
      const uiResponse = validated.cancelled === true
        ? { cancelled: true }
        : validated.confirmed !== undefined
          ? { confirmed: validated.confirmed }
          : { value: validated.value };
      this.#safeRespondUi(entry.sessionId, entry.uiId, uiResponse);
      entry.responded = true;
      entry.respondedAt = this.#now();

      // Demo ordering parity: if the nonce-bound notify was already
      // observed before the decision was recorded, completion happens
      // here; otherwise it happens when the notify arrives.
      if (entry.kind === 'demo') this.#tryCompleteDemo(requestId, entry);

      // A denied gate decision is applied the moment the real dialog is
      // cancelled (the extension blocks the tool); nothing else to await.
      if (entry.kind === 'gate' && validated.cancelled === true) {
        const done = this.#store.completeRequest({
          requestId,
          sessionId: entry.sessionId,
          result: { denied: true },
        });
        if (done.ok) this.#emitHostEvent({ kind: 'request_completed', requestId });
        this.#pendingDialogs.delete(requestId);
      }
    }
    this.#store.enqueueOutbox({
      kind: 'decision_applied',
      payload: { requestId, decision: validated },
    });
    return { ok: true };
  }

  /**
   * Cancel a request: CAS the state, cancel the real pending dialog,
   * abort the run, and let the queue drain ignore it.
   */
  cancelRequest({ requestId }) {
    const request = this.#store.getRequest(requestId);
    if (!request) return { ok: false, reason: 'not_found' };
    const cancelled = this.#store.cancelRequest({ requestId, sessionId: request.sessionId });
    if (!cancelled.ok) return cancelled;

    const entry = this.#pendingDialogs.get(requestId);
    if (entry) {
      this.#safeRespondUi(entry.sessionId, entry.uiId, { cancelled: true });
      const session = this.#sessions.get(entry.sessionId);
      if (session?.adapter?.isRunning()) {
        session.adapter.send({ type: 'abort' }).catch(() => {
          // Abort best-effort; the child exit path already fails requests.
        });
      }
      this.#pendingDialogs.delete(requestId);
    }
    this.#emitHostEvent({ kind: 'request_cancelled', requestId });
    return { ok: true };
  }

  /**
   * Maintenance pass: fail stale claims, expire overdue requests (with
   * real dialog cancellation), fail decisions whose apply evidence never
   * arrived, drain the IPC action queue at-most-once. Deterministic: pass
   * `now` in tests.
   */
  tick(now = this.#now()) {
    this.#store.failStaleClaimedActions({ now, claimTimeoutMs: this.#claimTimeoutMs });

    for (const requestId of this.#store.expireRequests(now)) {
      const request = this.#store.getRequest(requestId);
      if (!request) continue;
      const entry = this.#pendingDialogs.get(requestId);
      if (entry) {
        this.#safeRespondUi(entry.sessionId, entry.uiId, { cancelled: true });
        this.#pendingDialogs.delete(requestId);
      }
      const session = request.sessionId;
      if (this.#demoLifecycles.has(session)) this.#demoLifecycles.delete(session);
      this.#emitHostEvent({ kind: 'request_expired', requestId });
    }

    // Send != applied: a responded decision whose apply evidence (tool end
    // / demo notify) never arrived within the window is OBSERVED as
    // failed. Never replayed.
    for (const [requestId, entry] of [...this.#pendingDialogs]) {
      if (
        entry.responded &&
        entry.respondedAt !== null &&
        now - entry.respondedAt > this.#decisionApplyTimeoutMs
      ) {
        this.#store.failRequest({ requestId, sessionId: entry.sessionId, reason: 'decision_not_applied' });
        this.#emitHostEvent({ kind: 'request_failed', requestId, reason: 'decision_not_applied' });
        this.#pendingDialogs.delete(requestId);
        if (this.#demoLifecycles.has(entry.sessionId)) this.#demoLifecycles.delete(entry.sessionId);
      }
    }

    for (;;) {
      const claim = this.#store.claimNextAction({ ownerId: this.#ownerId, now });
      if (!claim.ok) break;
      this.#handleAction(claim.action, now);
    }
  }

  #handleAction(action, now) {
    try {
      if (action.type === 'decision' && isPlainObject(action.payload)) {
        this.submitDecision(action.payload);
      } else if (action.type === 'cancel' && isPlainObject(action.payload) && typeof action.payload.requestId === 'string') {
        this.cancelRequest({ requestId: action.payload.requestId });
      } else if (action.type === 'followup') {
        // T04r: every followup refusal is VISIBLE — a bounded fixed-code
        // notification is emitted, never a silent consume.
        if (!isPlainObject(action.payload)) {
          this.#notifyFollowupBlocked('unknown', 'malformed_followup');
        } else if (!this.#followupsEnabled) {
          const sessionId = typeof action.payload.sessionId === 'string' && action.payload.sessionId.length > 0
            ? action.payload.sessionId
            : 'unknown';
          this.#notifyFollowupBlocked(sessionId, 'followups_disabled');
        } else {
          this.#handleFollowupAction(action.payload);
        }
      } else {
        // Unknown/malformed action: terminal failure, never retried.
        throw new Error('malformed action');
      }
      this.#store.completeAction({ actionId: action.actionId, ownerId: this.#ownerId });
    } catch {
      try {
        this.#store.failAction({ actionId: action.actionId, ownerId: this.#ownerId });
      } catch {
        // Ignored: the stale-claim sweep will fail it on timeout.
      }
    }
  }

  #notifyFollowup(sessionId, message) {
    this.#store.enqueueOutbox({
      kind: 'notification',
      payload: { sessionId, method: 'notify', message },
    });
  }

  #notifyFollowupBlocked(sessionId, reason) {
    this.#notifyFollowup(sessionId, `Followup refused for session ${sessionId}: ${reason}.`);
  }

  /**
   * T04: consume one validated typed followup action. All refusals are
   * synchronous and bounded; the send itself is terminal BEFORE its result
   * is known (completeAction runs right after this returns), so an
   * uncertain model acceptance is never retried or replayed.
   */
  #handleFollowupAction(payload) {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
    const text = typeof payload.text === 'string' ? payload.text : null;
    if (
      sessionId === null || sessionId.length === 0 || sessionId.length > MAX_FOLLOWUP_SESSION_CHARS ||
      text === null || text.length === 0 || text.length > MAX_FOLLOWUP_TEXT_CHARS
    ) {
      const label = sessionId !== null && sessionId.length <= MAX_FOLLOWUP_SESSION_CHARS ? sessionId : 'unknown';
      this.#notifyFollowupBlocked(label, 'malformed_followup');
      return;
    }
    if (!this.isSessionRunning(sessionId)) {
      this.#notifyFollowupBlocked(sessionId, 'unknown_session');
      return;
    }
    // No ambiguous closed-dialog input: a session with any pending dialog
    // (or an open demo lifecycle) is never interleaved with a new prompt.
    if (
      this.#demoLifecycles.has(sessionId) ||
      [...this.#pendingDialogs.values()].some((entry) => entry.sessionId === sessionId)
    ) {
      this.#notifyFollowupBlocked(sessionId, 'session_busy');
      return;
    }
    // B3 parity: a slash command in ANY line makes the text a command
    // channel; chat must never execute pi commands.
    for (const line of text.split(/\r?\n/)) {
      if (line.trimStart().startsWith('/')) {
        this.#notifyFollowupBlocked(sessionId, 'command_rejected');
        return;
      }
    }
    const run = this.sendUserPrompt(sessionId, text);
    run.then((result) => {
      if (result && result.ok) {
        this.#followupsInFlight.set(sessionId, true);
        this.#notifyFollowup(sessionId, `Followup accepted for session ${sessionId}: the agent is running.`);
      } else {
        this.#followupsInFlight.delete(sessionId);
        const reason = result && typeof result.reason === 'string' ? result.reason : 'send_error';
        this.#notifyFollowup(sessionId, `Followup failed for session ${sessionId}: prompt not accepted (${reason}).`);
      }
    }).catch(() => {
      this.#followupsInFlight.delete(sessionId);
      this.#notifyFollowup(sessionId, `Followup failed for session ${sessionId}: prompt not accepted (send_error).`);
    });
  }

  /** Graceful shutdown: dispose adapters and release the lease. Idempotent. */
  async dispose() {
    // In-flight followups can no longer settle: fail them visibly (no
    // silent zombie), never replay them on the next boot.
    for (const sessionId of [...this.#followupsInFlight.keys()]) {
      this.#followupsInFlight.delete(sessionId);
      try {
        this.#notifyFollowup(sessionId, `Followup failed for session ${sessionId}: session shutting down.`);
      } catch {
        // Best-effort: the store may already be closing.
      }
    }
    for (const { adapter } of this.#sessions.values()) {
      try {
        await adapter.dispose();
      } catch {
        // Dispose best-effort.
      }
    }
    this.#sessions.clear();
    this.#pendingDialogs.clear();
    this.#inFlightDecisionTools.clear();
    this.#demoLifecycles.clear();
    if (this.#leasing) {
      this.#store.releaseHostLease({ ownerId: this.#ownerId });
      this.#leasing = false;
    }
  }
}
