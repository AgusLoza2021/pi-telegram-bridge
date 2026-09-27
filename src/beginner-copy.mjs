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

/**
 * T4B2 identity-header budget in Unicode code points: a header is identity
 * only and must stay compact at the top of any session-scoped message.
 */
export const MAX_IDENTITY_HEADER_CODE_POINTS = 64;

/**
 * Exactly the eight project-square glyphs (🟦🟪🟧🟩🟨🟫⬛⬜): the ONLY
 * glyphs that grant prebuilt identity-header passthrough. State circles
 * (🟢🟡⚪🔴⚫) are presentation, never identity, and must never gain this
 * privilege.
 */
const PROJECT_SQUARE_CLASS = '[\\u{1F7E6}-\\u{1F7EB}\\u{2B1B}\\u{2B1C}]';
const BARE_PI_RE = /^pi$/i;
/** Words that must never survive into beginner-visible text (BEGINNER_UX.md §2). */
const JARGON_RE = /\b(?:dpapi|broker|sqlite|argv|acl|pid|long poll|scheduled task)\b/gi;

/**
 * Leading state-circle markers are presentation, never identity: they are
 * stripped from the start of any label so a spoofed `<circle> Pi · name`
 * can never ride the prebuilt-header passthrough.
 */
const LEADING_STATE_CIRCLES_RE = /^[🟢🟡⚪🔴⚫]+(?:\s+|$)/u;

/** The exact bad-metadata fallback header: `<square> Pi`. */
const PREBUILT_FALLBACK_HEADER_RE = new RegExp(`^${PROJECT_SQUARE_CLASS}\\s*pi$`, 'iu');
/**
 * A prebuilt identity header (optional project square, then `Pi ·`) or a
 * legacy prefixed label without one. Also the normalization rule for
 * identityHeader name candidates: stripping it repeatedly reduces a
 * prefixed or nested candidate to its bare name.
 */
const PREBUILT_PREFIXED_RE = new RegExp(
  `^(?:${PROJECT_SQUARE_CLASS}\\s)?pi\\s*(?:·|-|:|—)\\s*`,
  'iu',
);

/**
 * Strip everything a beginner label must never carry: short ids, tracking
 * ids (long hex tokens), pid mentions, filesystem paths and jargon words.
 * Pure input hygiene — callers pass broker labels, but a hostile or buggy
 * label still cannot smuggle internals into beginner-visible text.
 */
function sanitizeLabelPart(raw) {
  let text = typeof raw === 'string' ? raw : '';
  // A leading state circle is presentation, never identity (F5).
  text = text.replace(LEADING_STATE_CIRCLES_RE, ' ');
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

/** Clip by Unicode code points so a surrogate pair is never split. */
function clipCodePoints(text, maxCodePoints) {
  if (typeof text !== 'string' || text.length <= maxCodePoints) return clip(text, maxCodePoints);
  let units = 0;
  let out = '';
  for (const ch of text) {
    units += ch.length;
    if (units > maxCodePoints) break;
    out += ch;
  }
  return out;
}

/** Clip to at most max REAL Unicode code points; a pair is one code point. */
function clipToCodePoints(text, maxCodePoints) {
  if (typeof text !== 'string' || maxCodePoints <= 0) return '';
  let count = 0;
  let out = '';
  for (const ch of text) {
    if (count >= maxCodePoints) break;
    out += ch;
    count++;
  }
  return out;
}

/** Strip unpaired surrogates so a hostile name can never produce one. */
function stripLoneSurrogates(text) {
  return typeof text === 'string'
    ? text.replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '',
    )
    : text;
}

/**
 * Reduce one identityHeader name candidate to its bare, sanitized name:
 * sanitization first, then repeated stripping of any leading identity
 * prefix (optionally project-square-led), so a candidate like `Pi · alpha`,
 * `Pi - alpha` or `<square> Pi · alpha` normalizes to `alpha` and the built
 * header carries exactly ONE identity prefix — never `Pi · Pi ·` and never
 * nested squares. Stripping still runs after full path/id/jargon hygiene.
 */
function normalizeIdentityCandidate(raw) {
  let text = sanitizeLabelPart(stripLoneSurrogates(raw));
  let previous = '';
  while (previous !== text) {
    previous = text;
    text = text.replace(PREBUILT_PREFIXED_RE, '').trim();
  }
  return text;
}

/**
 * Bounded readable display label: `Pi · <label>`. Collapses sanitization
 * whitespace, falls back to plain `Pi`, never doubles an existing prefix
 * and always fits one Telegram button. A valid prebuilt identity header
 * (T4B2, with or without its leading project square) passes through
 * unchanged, so session-scoped copy can re-render a full header without
 * ever producing `Pi · Pi`.
 */
export function displayLabel(raw) {
  const text = sanitizeLabelPart(stripLoneSurrogates(raw));
  if (text.length === 0) return 'Pi';
  if (PREBUILT_FALLBACK_HEADER_RE.test(text)) return text;
  if (BARE_PI_RE.test(text)) return 'Pi';
  if (PREBUILT_PREFIXED_RE.test(text)) {
    // A prebuilt identity header re-renders under the header's own 64
    // CODE POINT contract — never a UTF-16 slice, which could split a
    // surrogate pair (F1).
    return clipToCodePoints(text, MAX_IDENTITY_HEADER_CODE_POINTS);
  }
  return clipToCodePoints(`Pi · ${text}`, MAX_BUTTON_TEXT_CHARS);
}

/**
 * T4B2 session-scoped identity header:
 * `<project square> Pi · <session alias | project alias | label>[ · <branch>]`.
 *
 * Pure identity: never a state or liveness word, never cwd, pid, short or
 * tracking ids, tokens, raw errors or a model name (those are not inputs).
 * Every name candidate goes through the same sanitization as a button
 * label; the FIRST candidate that survives (non-empty, not bare `Pi`)
 * wins — session alias, then project alias, then label. The whole header
 * is clipped to 64 Unicode code points without splitting a surrogate pair,
 * and the branch appears only when its ENTIRE sanitized form fits inside
 * the budget — otherwise it is omitted, never half-shown. Bad or missing
 * metadata degrades to the neutral `⬜ Pi`.
 */
export function identityHeader({
  colorSlot = null, sessionAlias = null, projectAlias = null, label = null, branch = null,
} = {}) {
  const square = projectColor(colorSlot);
  const prefix = `${square} Pi · `;
  const budget = MAX_IDENTITY_HEADER_CODE_POINTS - [...prefix].length;
  let name = '';
  for (const candidate of [sessionAlias, projectAlias, label]) {
    const sanitized = clipToCodePoints(normalizeIdentityCandidate(candidate), budget);
    if (sanitized.length > 0 && !BARE_PI_RE.test(sanitized)) {
      name = sanitized;
      break;
    }
  }
  if (name.length === 0) return `${PROJECT_COLOR_FALLBACK} Pi`;
  let branchText = '';
  if (typeof branch === 'string') {
    const sanitizedBranch =
      stripLoneSurrogates(sanitizeLabelPart(branch).replace(/\s+/g, '-'));
    if (sanitizedBranch.length > 0) {
      const suffix = ` · ${sanitizedBranch}`;
      // Both sides count REAL code points (F2): a UTF-16 name.length would
      // over-count an astral name and drop a branch that actually fits.
      if ([...name].length + [...suffix].length <= budget) branchText = suffix;
    }
  }
  return `${prefix}${name}${branchText}`;
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

/**
 * T5B2 — the ONE fixed callback toast for a consumed or stale
 * pending-prompt button (v1:p): answered as answerCallbackQuery text, never
 * a chat message. Pinned exactly once by tests and quoted verbatim by
 * docs/BEGINNER_UX.md §7/§10 — change all three together. Bounded inside
 * Telegram's 200-character answerCallbackQuery text cap; carries no ids,
 * paths or error details.
 */
export const staleCallbackToast = 'That button is out of date. Open Projects and try again.';

/** MSG-T5 — the named Pi closed or disconnected (used only when it is known). */
export const sessionGone = (rawLabel) =>
  `${displayLabel(rawLabel)} just closed or disconnected. Pick another:`;

// --- Projects dashboard (T3) -------------------------------------------------/

/** Projects card button: opens or refreshes the Projects dashboard. */
export const BUTTON_PROJECTS = 'Projects';

/** Dashboard section headers (rendered as disabled, inert rows). */
export const PROJECT_SECTION_ACTIVE = 'Active now';
export const PROJECT_SECTION_RECENT = 'Recent';

/** Dashboard title (MSG-T4 replaced by the dashboard on the multi-session path). */
export const projectsTitle = 'Your Pi projects';

/**
 * Stable per-project palette by color slot 0..7 (mirrors the store's
 * `colorSlot` derivation: first 8 hex chars of the project key mod 8).
 * Color is never the only signal: every row also carries a state marker
 * and state text.
 */
export const PROJECT_COLOR_SLOTS = [
  '🟦', // slot 0
  '🟪', // slot 1
  '🟧', // slot 2
  '🟩', // slot 3
  '🟨', // slot 4
  '🟫', // slot 5
  '⬛', // slot 6
  '⬜', // slot 7
];

/** Neutral fallback for a missing or malformed color slot. */
export const PROJECT_COLOR_FALLBACK = '⬜';

export function projectColor(colorSlot) {
  return Number.isInteger(colorSlot)
    && colorSlot >= 0
    && colorSlot < PROJECT_COLOR_SLOTS.length
    ? PROJECT_COLOR_SLOTS[colorSlot]
    : PROJECT_COLOR_FALLBACK;
}

/**
 * Live state presentation: a marker plus state text, so the color glyph is
 * never the only signal. Unknown or missing states fall back to offline.
 */
export function liveStateMarker(state) {
  switch (state) {
    case 'connected': return '🟢';
    case 'busy':
    case 'waiting': return '🟡';
    default: return '⚪';
  }
}

export function liveStateText(state) {
  switch (state) {
    case 'connected': return 'Available';
    case 'busy': return 'Working';
    case 'waiting': return 'Waiting';
    default: return 'Offline';
  }
}

/**
 * One dashboard row label:
 * `[✓ ]<state marker> <project color> <name>[ (<branch>)] · <state text>`.
 * Budgeted to one Telegram button: the state word and the selected prefix
 * always survive; the branch is truncated, then dropped entirely, before the
 * name is trimmed. Clipping splits code points, never surrogate pairs, and
 * sanitized against cwd/id/pid leakage, with neutral fallbacks for missing
 * or malformed pieces — never throws.
 */
export function projectRowLabel({
  selected = false, colorSlot = null, state = null, offline = false, name, branch = null,
} = {}) {
  const marker = offline ? '⚪' : liveStateMarker(state);
  const stateText = offline ? 'Offline' : liveStateText(state);
  const prefix = selected === true ? '✓ ' : '';
  const color = projectColor(colorSlot);
  // Fixed skeleton: prefix + "<marker> <color> " + name + " · " + stateText.
  const fixedUnits = prefix.length + marker.length + 1 + color.length + 1 + 3 + stateText.length;
  const nameBudget = Math.max(1, MAX_BUTTON_TEXT_CHARS - fixedUnits);
  const dashboardName = clipCodePoints(stripLoneSurrogates(sanitizeLabelPart(name)), nameBudget) || 'Pi';
  // The branch only appears when it fits entirely between the name and state.
  let branchText = '';
  if (typeof branch === 'string') {
    const branchLabel = clipCodePoints(stripLoneSurrogates(sanitizeLabelPart(branch).replace(/\s+/g, '-')), nameBudget);
    const room = MAX_BUTTON_TEXT_CHARS - fixedUnits - dashboardName.length - 3; // ' (x)'
    if (branchLabel.length > 0 && branchLabel.length <= room) branchText = ` (${branchLabel})`;
  }
  return `${prefix}${marker} ${color} ${dashboardName}${branchText} · ${stateText}`;
}

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

/**
 * First acknowledgement of the stop-and-send choice (abort enqueued).
 * Session-scoped: it names the session/header instead of staying anonymous.
 */
export const busyAborting = (rawLabel) =>
  sessionNotice(rawLabel, 'Stopping the current task...');

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
    case 'abort': return busyAborting(rawLabel);
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

// --- per-session /alias (T4C2) ----------------------------------------------

/** Fixed guidance when /alias has no live selected session: never a guess. */
export const aliasNoSelection =
  'No Pi window is selected. Send /projects, pick one, then try /alias <name> again.';

/** Fixed rejection for an invalid alias: never an echo of the rejected input. */
export const aliasInvalid =
  "That name can't be used. Use up to 64 normal characters and try again.";

/** Fixed failure when the store refuses or throws: no error details, ever. */
export const aliasFailed =
  'The alias could not be saved right now. Try again in a moment.';

/** Concise acknowledgements prepended to the immediately re-rendered dashboard. */
export const aliasSaved = 'Alias saved.';
export const aliasCleared = 'Alias cleared.';

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
  '/projects - show your projects and pick one',
  '/sessions - live connected TUIs',
  '/use <shortId> - select the active TUI for this broker',
  '/alias <name> - rename the selected Pi window; /alias clear resets it',
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
