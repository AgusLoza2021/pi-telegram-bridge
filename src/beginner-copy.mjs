// Beginner-visible English V1 copy — the single source (T04).
//
// Every string a non-technical Telegram user can see on the normal path is
// built here from docs/BEGINNER_UX.md (sections 2, 5-11). Advanced notices
// (USAGE, /sessions output, explicit-id errors) stay in the broker: they are
// the opt-in advanced layer and are recognizable by their /-commands and
// short ids.
//
// Rules enforced by this module (see BEGINNER_UX.md section 2):
// - Session names are always readable labels rendered as `Pi · <label>`;
//   the builder never produces a double prefix and never leaks short ids,
//   tracking ids, cwd, pid or jargon.
// - Every visible string is a fixed literal or a pure builder over a
//   sanitized label — no raw exception, provider or internal state text.

/** Telegram inline-button text limit; every rendered label fits one button. */
export const MAX_BUTTON_TEXT_CHARS = 64;

/** A label that already carries a readable prefix is reused, never doubled. */
const PREFIXED_LABEL_RE = /^pi\s*(?:·|-|:|—)\s*/i;
const BARE_PI_RE = /^pi$/i;
/** Words that must never survive into beginner-visible text (BEGINNER_UX.md §2). */
const JARGON_RE = /\b(?:dpapi|broker|sqlite|argv|acl|pid|long poll|scheduled task)\b/gi;

/**
 * Strip everything a beginner label must never carry: short ids, tracking
 * ids (long hex tokens), pid mentions, filesystem paths and jargon words.
 * Pure input hygiene — callers pass broker labels, but a hostile or buggy
 * label still cannot smuggle internals into beginner-visible text.
 */
function sanitizeLabelPart(raw) {
  let text = typeof raw === 'string' ? raw : '';
  text = text.replace(/tg:[A-Za-z0-9_-]+/g, ' ');
  text = text.replace(/\b[0-9a-f]{16,}\b/gi, ' ');
  text = text.replace(/\bpid\s*[=:#]?\s*\d+\b/gi, ' ');
  text = text.replace(/[A-Za-z]:[\\/][^\s]*/g, ' ');
  text = text.replace(/(^|[\s·(])[\\/][^\s]*/g, ' ');
  text = text.replace(JARGON_RE, ' ');
  return text
    .replace(/\s+/g, ' ')
    // Stripping fragments can orphan the `·` separators that surrounded
    // them; collapse runs of standalone separators into one and drop any
    // separator left leading or trailing so the label stays readable.
    .replace(/(?:\s*·\s*){2,}/g, ' · ')
    .replace(/^[·\s]+/, '')
    .replace(/[\s·]+$/, '')
    .trim();
}

function clip(text, maxChars) {
  return typeof text === 'string' ? (text.length > maxChars ? text.slice(0, maxChars) : text) : '';
}

/**
 * Bounded readable display label: `Pi · <label>`. Collapses sanitization
 * whitespace, falls back to plain `Pi`, never doubles an existing prefix
 * and always fits one Telegram button.
 */
export function displayLabel(raw) {
  const text = sanitizeLabelPart(raw);
  if (text.length === 0) return 'Pi';
  if (BARE_PI_RE.test(text)) return 'Pi';
  if (PREFIXED_LABEL_RE.test(text)) return clip(text, MAX_BUTTON_TEXT_CHARS);
  return clip(`Pi · ${text}`, MAX_BUTTON_TEXT_CHARS);
}

// --- /start home (BEGINNER_UX.md section 6) ---------------------------------

/** MSG-T2 — linked PC, zero live Pi windows. */
export const homeNoLive =
  "You're linked, but no Pi window is connected right now. Open Pi on your PC and type /tg.";

/** MSG-T3 — exactly one live Pi, auto-selected. */
export const homeOne = (rawLabel) =>
  `Connected to ${displayLabel(rawLabel)}. Just type a message and it goes to that Pi.`;

/** MSG-T4 — several live Pi windows, none selected. */
export const homeMultiple = 'Which Pi should I talk to?';

// --- plain text routing (BEGINNER_UX.md section 7) ---------------------------

/** MSG-P3 without the plain-text sentence — shared "nothing connected" guidance. */
export const noLiveGuidance =
  "There's no Pi connected right now. Open Pi on your PC and type /tg — then your messages will reach it.";

/** MSG-P3 — plain text with zero live Pi windows: it says the message was NOT sent. */
export const plainNoLive =
  "There's no Pi connected right now, so your message was not sent. "
  + 'Open Pi on your PC and type /tg, then send it again once Pi is linked.';

/** MSG-P1 — the prompt is held until one Pi is chosen. */
export const pendingSaved = 'Your message is saved. Choose which Pi should get it:';

/** MSG-P2 — the held prompt was dispatched exactly once. */
export const pendingSent = (rawLabel) => `Sent to ${displayLabel(rawLabel)}.`;

/** MSG-T5 — the named Pi closed or disconnected (used only when it is known). */
export const sessionGone = (rawLabel) =>
  `${displayLabel(rawLabel)} just closed or disconnected. Pick another:`;

// --- chooser / busy cards (BEGINNER_UX.md sections 7-8) ----------------------

/** Busy card: the named Pi is mid-task and the human decides. */
export const busyCard = (rawLabel) =>
  `${displayLabel(rawLabel)} is still working on the current task. What should I do with your message?`;

/** MSG-B1 — follow-up choice accepted. */
export const busyFollowup = (rawLabel) =>
  `Got it — ${displayLabel(rawLabel)} will see your message right after the current task.`;

/** MSG-B2 — steer choice accepted. */
export const busySteer = (rawLabel) =>
  `Done — ${displayLabel(rawLabel)} got your message and will adjust what it's doing.`;

/** First acknowledgement of the stop-and-send choice (abort enqueued). */
export const busyAborting = 'Stopping the current task...';

/** MSG-B3 — stop-and-send: the held prompt is on its way. */
export const busyAbortSent = (rawLabel) =>
  `Stopped. Your message is on its way to ${displayLabel(rawLabel)}.`;

/** MSG-O2 — the Stop button resolved. */
export const stopAck = (rawLabel) => `Stopped. ${displayLabel(rawLabel)} is idle now.`;

/** MSG-B4 variant for the Leave-it-alone button (no session on the callback). */
export const busyDiscard =
  'Okay — the current task keeps running. Your saved message was discarded.';

// --- action cards (BEGINNER_UX.md sections 8-9) ------------------------------

export const BUTTON_STATUS = 'Status';
export const BUTTON_STOP = 'Stop the task';
export const BUTTON_CHANGE_PI = 'Change Pi';
export const BUTTON_DISCONNECT = 'Disconnect';
export const DISCONNECT_BUTTON = 'Unlink';
export const CANCEL_BUTTON = 'Cancel';
export const CANCEL_NOTICE = 'Okay — nothing was changed.';

/** MSG-O1 — the remote disconnect confirmation card. */
export const disconnectAsk = (rawLabel) =>
  `Unlink ${displayLabel(rawLabel)}? You can relink it any time from the PC.`;

/** After an Unlink tap: the disconnect command was accepted. */
export const unlinkingAck = (rawLabel) => `Unlinking ${displayLabel(rawLabel)}.`;

/** Status-button acknowledgement. */
export const statusAck = (rawLabel) => `Status requested for ${displayLabel(rawLabel)}.`;

/**
 * Callback acknowledgements by operation: 'followup', 'steer', 'abort',
 * 'prompt', 'prompt_after_abort', 'stop', 'status' and 'disconnect'.
 */
export function cbAck(op, rawLabel) {
  switch (op) {
    case 'followup': return busyFollowup(rawLabel);
    case 'steer': return busySteer(rawLabel);
    case 'abort': return busyAborting;
    case 'prompt_after_abort': return busyAbortSent(rawLabel);
    case 'prompt': return pendingSent(rawLabel);
    case 'stop': return stopAck(rawLabel);
    case 'status': return statusAck(rawLabel);
    case 'disconnect': return unlinkingAck(rawLabel);
    default: return CANCEL_NOTICE;
  }
}

/** Session-scoped one-line acknowledgement: `Pi · <label> — <message>.` */
export const sessionNotice = (rawLabel, message) => `${displayLabel(rawLabel)} — ${message}`;

// --- event presentation (BEGINNER_UX.md sections 9 and 2) --------------------

/** Connected-event card headline. */
export const eventConnected = (rawLabel) => `${displayLabel(rawLabel)} is connected.`;

/** Disconnected-event headline. */
export const eventDisconnected = (rawLabel) => `${displayLabel(rawLabel)} disconnected.`;

/** Beginner status line: state and model only — never cwd, pid or session ids. */
export function statusLine(payload) {
  const parts = [];
  const state = typeof payload?.state === 'string' && payload.state.length > 0
    ? clip(payload.state, 16)
    : null;
  if (state !== null) parts.push(`state: ${state}`);
  const model = typeof payload?.model === 'string' && payload.model.length > 0
    ? clip(payload.model, 128)
    : null;
  if (model !== null) parts.push(`model: ${model}`);
  return parts.length > 0 ? parts.join(' · ') : 'no status details';
}

/** Beginner status card. */
export const eventStatus = (rawLabel, payload) =>
  `${displayLabel(rawLabel)} status\n${statusLine(payload)}`;

/** Beginner command-result card. The code is the whitelisted result code. */
export function eventCommandResult(rawLabel, ok, resultCode) {
  if (ok === true) return `${displayLabel(rawLabel)} — command finished.`;
  const code = typeof resultCode === 'string' && resultCode.length > 0
    ? clip(resultCode, 64)
    : 'failed';
  return `${displayLabel(rawLabel)} — command failed (${code}).`;
}

// --- /help and friendly errors (BEGINNER_UX.md section 11) -------------------

const BEGINNER_HELP_SENTENCES = [
  'You can talk to Pi by just typing a message here.',
  'To link a Pi window, open Pi on your PC and type /tg.',
  'This private chat only accepts you — the enrolled owner.',
];

/**
 * Advanced command help, labeled explicitly. Every existing slash command
 * stays listed unchanged; short ids appear only in this advanced layer.
 */
export const ADVANCED_HELP_LINES = [
  'Advanced commands:',
  '/help - this help',
  '/sessions - live connected TUIs',
  '/use <shortId> - select the active TUI for this broker',
  '/status [shortId] - request session status',
  '/send [shortId] <text> - prompt an idle TUI',
  '/steer [shortId] <text> - steer the running turn',
  '/followup [shortId] <text> - queue a follow-up',
  '/abort [shortId] - abort the running turn',
  '/disconnect [shortId] - disconnect the TUI',
  'Plain text goes to the selected TUI as a prompt.',
];

/** The full /help reply: three beginner sentences, then the labeled Advanced block. */
export const HELP_TEXT = [...BEGINNER_HELP_SENTENCES, '', ...ADVANCED_HELP_LINES].join('\n');

/** MSG-E4 — an unrecognized slash command. */
export const unknownCommand = "I didn't understand that. Send /help to see what I can do.";
