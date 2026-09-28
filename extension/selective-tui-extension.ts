// selective-tui-extension.ts (T05): opt-in interactive Pi extension for
// the Telegram bridge's tracked live-TUI transport.
//
// Register with: pi -e extension/selective-tui-extension.ts
//
// Beginner command: /tg (with /tg off), documented in docs/BEGINNER_UX.md
// section 4. It opens a local confirmation dialog, derives a readable label
// from the project folder and drives the exact same connection
// implementation as the advanced /telegram-* commands. /tg never treats
// its arguments as a label and never connects without an explicit local
// confirmation.
//
// Scope and boundaries (fail closed by design):
// - Opt-in only: a fresh Pi process starts DISCONNECTED. The user runs
//   /telegram-connect in the interactive TUI; nothing connects on its own.
// - Uses ONLY the synchronous bridge Store + TuiBridgeClient against the
//   module-default <module>/.local/state/bridge.sqlite. No shell, no API
//   process, no network, no Telegram access: the broker process is the
//   only side that talks to Telegram. The extension registers exactly ONE
//   deliberate custom tool, telegram_ask_user_choice, which publishes an
//   ordinary 2–4 option choice question through the same store transport
//   so the linked Telegram owner can answer it from their phone; the tool
//   itself adds no shell, network or Telegram access. It never answers
//   provider-owned consent envelopes, native ui_prompt dialogs or any
//   other local-only prompt.
// - Forwarded data is deliberately narrow: connection state transitions
//   (agent_start/agent_settled, ui_prompt_start/ui_prompt_end) and, on
//   assistant message_end, FINALIZED text blocks only. Thinking/reasoning
//   blocks, tool calls, tool results, context and token deltas never leave
//   the TUI (the store rejects any reasoning event kind outright). The
//   OPTIONAL sanitized git branch is local metadata derived only by
//   bounded filesystem reads (readGitBranch); it never blocks linking.
// - Opt-in survives /reload, /new, /resume and /fork ONLY inside the same
//   OS process, via a globalThis flag (never persisted to disk, so a
//   process restart always boots disconnected). On session replacement the
//   old tracked row is released and the replacement session reconnects
//   with the same process-owned tracking/connection identity. Opt-in is
//   cleared on quit and on explicit disconnect (local command or remote).
// - Inbound command handling revalidates ownership before acting and
//   reports EXACTLY ONE terminal result per claimed command. Prompt-like
//   text beginning with '/' (after leading whitespace) is rejected so
//   remote input can never trigger local extension commands, skills or
//   prompt templates.
// - Poll/heartbeat failures are swallowed (bounded, code-only): a broken
//   or replaced connection degrades to "disconnected", it never crashes
//   Pi and never echoes store payloads into the TUI.

import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Store } from '../src/store.mjs';
import { TuiBridgeClient } from '../src/tui-bridge-client.mjs';
import {
  choiceQuestionText,
  containsCredentialShape,
  displayLabel,
} from '../src/beginner-copy.mjs';

// Footer status key (ctx.ui.setStatus) so the user always sees the live
// short id of the tracked session while connected.
const STATUS_KEY = 'pi-telegram';

// Process-wide opt-in flag. globalThis (not module scope) is required
// because /reload and session replacement create NEW extension instances:
// the flag must outlive any single instance but never the process.
const OPT_IN_KEY = '__piTelegramBridgeOptIn__';

// Bounds mirroring the store's fail-closed validation.
const MAX_LABEL_CHARS = 64;
const MAX_IDENTITY_CHARS = 512;
const MAX_FINAL_TEXT_CHARS = 4000;
const MAX_BRANCH_CHARS = 128;

// Heartbeat well inside the store's 30s default staleness window; the poll
// interval keeps remote commands feeling responsive without busy-looping.
const HEARTBEAT_INTERVAL_MS = 10_000;
const POLL_INTERVAL_MS = 500;

// Rejected prompt-like text: leading whitespace then a slash. This covers
// extension commands, skills and prompt templates alike.
const SLASH_PREFIX_RE = /^\s*\//;

// --- Remote ordinary choice tool (T3B) --------------------------------------
//
// Bounds mirror the store's T1 choice contract and the schema below
// EXACTLY. Pi validates tool arguments against the schema before calling;
// execute() repeats every security-critical bound defensively because the
// model-facing schema is trust boundary input, not a guarantee.
const CHOICE_TOOL_NAME = 'telegram_ask_user_choice';
const MAX_CHOICE_QUESTION_CHARS = 500;
const MAX_CHOICE_LABEL_CHARS = 64;
const MAX_CHOICE_DESCRIPTION_CHARS = 300;
const MAX_CHOICE_VALUE_CHARS = 512;
const MIN_CHOICE_OPTIONS = 2;
const MAX_CHOICE_OPTIONS = 4;
// Default hard deadline: exactly 30 minutes (production; never externally
// configurable — tests may inject a different duration for observation).
const CHOICE_REQUEST_TTL_MS = 30 * 60 * 1000;
const CHOICE_REQUEST_ID_RE = /^[0-9a-f]{16}$/;

/** A remote ordinary choice waiting for the owner's Telegram answer. */
interface PendingChoiceRequest {
  requestId: string;
  question: string;
  /** Local-only option payloads; never published to the store. */
  values: string[];
  expiresAt: number;
  /** Single-shot completion; a second settle is a no-op. */
  settled: boolean;
  resolve: (result: ChoiceToolResult) => void;
}

/** Fixed JSON shape the choice tool resolves with. */
interface ChoiceToolResult {
  status: 'selected' | 'cancelled' | 'timed_out' | 'aborted' | 'interrupted';
  index?: number;
  value?: string;
}

/** Fixed local refusal shape; `reason` is a bounded machine code. */
interface RefusedChoiceResult {
  status: 'refused';
  reason: string;
}

type ChoiceToolPayload = ChoiceToolResult | RefusedChoiceResult;

const CHOICE_PARAMETERS = Type.Object(
  {
    question: Type.String({
      minLength: 1,
      maxLength: MAX_CHOICE_QUESTION_CHARS,
      description:
        'Short question shown on the phone. Plain text; it is sent to Telegram as-is.',
    }),
    options: Type.Array(
      Type.Object(
        {
          label: Type.String({
            minLength: 1,
            maxLength: MAX_CHOICE_LABEL_CHARS,
            description: 'Button text, e.g. "Deploy now".',
          }),
          description: Type.String({
            minLength: 1,
            maxLength: MAX_CHOICE_DESCRIPTION_CHARS,
            description: 'One-line explanation of what choosing this option does.',
          }),
          value: Type.String({
            minLength: 1,
            maxLength: MAX_CHOICE_VALUE_CHARS,
            description:
              'Machine value returned to you when this option is chosen; never sent to Telegram.',
          }),
        },
        { additionalProperties: false },
      ),
      {
        minItems: MIN_CHOICE_OPTIONS,
        maxItems: MAX_CHOICE_OPTIONS,
        description: 'Between 2 and 4 options.',
      },
    ),
  },
  { additionalProperties: false },
);

const CHOICE_TOOL_DESCRIPTION =
  'Ask the linked Telegram owner to pick one of 2-4 options from their phone ' +
  'and block until they answer (or the 30 minute deadline passes). Use this ' +
  'instead of deciding an ordinary workflow question on your own when the ' +
  'owner is away from the keyboard. Never use it for provider-owned consent ' +
  'or permission envelopes, Gentle AI review consent envelopes, security ' +
  'confirmations, destructive maintenance, project trust decisions, secrets, ' +
  'or anything a native editor dialog or free-text/custom response should ' +
  'handle.';

const CHOICE_TOOL_PROMPT_SNIPPET =
  'telegram_ask_user_choice lets you put an ordinary 2-4 option decision to ' +
  'the linked Telegram owner and wait for their tap; the answer comes back ' +
  'as the exact option value you supplied.';

const CHOICE_TOOL_PROMPT_GUIDELINES = [
  `${CHOICE_TOOL_NAME} is for ORDINARY workflow choices only — for example "deploy now or wait?". Never call it for consent envelopes, permission or security prompts, destructive maintenance, project trust decisions, secrets, editor input, or anything needing a free-text or custom response: those stay with their native local-only mechanisms.`,
  `Call ${CHOICE_TOOL_NAME} alone: never in parallel with other tools, and only when a plain question with 2-4 fixed options is exactly what you need.`,
];

// --- Beginner /tg copy (docs/BEGINNER_UX.md section 4) ----------------------
// Local TUI surface only; Telegram-side beginner copy stays centralized in
// src/beginner-copy.mjs. `Pi · <label>` presentation goes through that
// module's displayLabel so the bare label is never double-prefixed.

const MSG_TG_USAGE = 'Use /tg to link this Pi, or /tg off to unlink it.';
const MSG_TG_NOT_TUI = 'telegram bridge: /tg requires interactive TUI mode';
const MSG_TG_ALREADY_UNLINKED = "This Pi isn't linked to Telegram. Type /tg to link it.";
const MSG_C1_CONFIRM =
  "Link this Pi window to Telegram? You'll be able to send it messages from your phone and it will reply there.";
const MSG_C4_BUSY =
  'Note: this Pi is in the middle of a task. Its result will arrive on Telegram when it finishes.';
// MSG-C2 without the @<botname> placeholder: resolving the bot name would
// require reading the DPAPI blob, which this side must never do.
const MSG_C2_LINKED = (bareLabel: string) =>
  `Linked. Send a message from your phone — this Pi (${displayLabel(bareLabel)}) will answer. Type /tg off to unlink.`;
const MSG_C2_PHONE_UNAVAILABLE =
  "Linked, but the phone connection on this PC isn't running right now. In the Pi Telegram folder run \".\\telegram on\", then send your message again. This Pi will stay linked.";
const MSG_C3_STATUS = (bareLabel: string, state: string) =>
  `This Pi is linked as '${displayLabel(bareLabel)}' (currently ${state}). Type /tg off to unlink.`;
const MSG_C3_STATUS_PHONE_UNAVAILABLE = (bareLabel: string) =>
  `This Pi is linked as '${displayLabel(bareLabel)}', but the phone connection on this PC isn't running right now. Run ".\\telegram on" in the Pi Telegram folder, then try again.`;
const MSG_C5_UNLINK_ASK = 'Unlink this Pi from Telegram?';
const MSG_C7_BUSY =
  'Warning: a task is still running here. Its result will NOT be sent to Telegram anymore.';
const MSG_C6_UNLINKED = 'Unlinked. This window no longer talks to Telegram.';
const MSG_C8_SETUP =
  "Your PC isn't linked to Telegram yet. Double-click Setup Pi Telegram on your PC first, then come back here.";

const CONNECT_OPTION = 'Connect';
const CANCEL_OPTION = 'Cancel';
const UNLINK_OPTION = 'Unlink';
const UNLINK_ANYWAY_OPTION = 'Unlink anyway';
const FALLBACK_LABEL = 'Pi';

/** Enrolled DPAPI blob filename; presence-only check, never read here. */
const CREDENTIALS_BLOB = 'credentials.bin';
const RUNTIME_CONFIG_FILE = 'runtime.json';
const BROKER_META_FILE = 'broker-meta.json';
const BROKER_HEARTBEAT_FRESH_MS = 30_000;

/** Local structural mirror of the TUI autocomplete item (no new runtime dep). */
interface CommandArgumentCompletion {
  value: string;
  label?: string;
}

interface TelegramOptIn {
  trackingId: string;
  connectionId: string;
  label: string;
}

interface BridgeConnection {
  store: Store;
  client: TuiBridgeClient;
  trackingId: string;
  connectionId: string;
  label: string;
  shortId: string;
  cwd: string | null;
  piSessionId: string | null;
  piSessionFile: string | null;
  agentActive: boolean;
  uiPromptActive: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
}

// Ids are always produced by TuiBridgeClient (32 hex chars); validate the
// shape before trusting anything read back from globalThis.
const BRIDGE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function boundedText(raw: unknown, maxChars: number): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0) return null;
  return raw.length > maxChars ? raw.slice(0, maxChars) : raw;
}

function boundedLabel(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return 'pi';
  return text.length > MAX_LABEL_CHARS ? text.slice(0, MAX_LABEL_CHARS) : text;
}

/**
 * Finalized assistant text blocks only. Everything else in the content
 * array (thinking, tool calls) is ignored by construction, not filtered
 * after the fact.
 */
function extractFinalText(message: unknown): string | null {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') {
    return content.length > 0 ? content : null;
  }
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      block
      && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  if (parts.length === 0) return null;
  return parts.join('\n\n');
}

/**
 * Beginner auto label (BEGINNER_UX.md section 5): the folder name of the
 * working directory, bare (the `Pi · ` prefix is presentation, added by
 * displayLabel/broker rendering, never stored). Control characters and
 * path separators are removed, whitespace collapsed, bounded to the
 * store's 64-char label limit; falls back to the process cwd folder and
 * finally to `Pi`.
 */
function autoLabelFromCwd(rawCwd: unknown): string {
  let source: string | null = typeof rawCwd === 'string' && rawCwd.length > 0 ? rawCwd : null;
  if (!source) {
    try {
      source = process.cwd();
    } catch {
      source = null;
    }
  }
  if (typeof source !== 'string' || source.length === 0) return FALLBACK_LABEL;
  const segments = source.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return FALLBACK_LABEL;
  const cleaned = segments[segments.length - 1]
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return FALLBACK_LABEL;
  return cleaned.length > MAX_LABEL_CHARS ? cleaned.slice(0, MAX_LABEL_CHARS).trim() : cleaned;
}

/**
 * Beginner auto-label allocator (BEGINNER_UX.md section 5): never returns a
 * label that duplicates an existing live session's label. Given the
 * sanitized base `x`:
 * - `x` unused -> `x`;
 * - otherwise the LOWEST free `x (n)` for n >= 2, considering existing
 *   `x`, `x (2)`, `x (3)` and gaps; unrelated labels are ignored;
 * - the final label fits the store's 64-char limit INCLUDING the suffix:
 *   the base is clipped as `n` grows so the suffix always has room.
 *
 * Pure over the caller-provided live-session snapshot. The chosen label is
 * stored with the connection and opt-in, so it stays stable for the
 * connection's lifetime even if the colliding windows disappear later.
 * /tg-only: advanced custom labels bypass this allocator by design.
 */
function allocateAutoLabel(
  candidate: string,
  liveSessions: Array<{ label?: unknown; live?: unknown } | null | undefined>,
): string {
  const used = new Set<string>();
  for (const session of liveSessions) {
    if (session && session.live === true && typeof session.label === 'string') {
      used.add(session.label);
    }
  }
  if (!used.has(candidate)) return candidate;
  for (let ordinal = 2; ; ordinal++) {
    const suffix = ` (${ordinal})`;
    const room = MAX_LABEL_CHARS - suffix.length;
    const base = candidate.length > room ? candidate.slice(0, room).trim() : candidate;
    const proposal = `${base}${suffix}`;
    if (!used.has(proposal)) return proposal;
  }
}

// --- Git branch detection (T2 metadata pipeline) ---------------------------
//
// Filesystem-only, fail-closed: the branch is OPTIONAL metadata and a
// detection failure must never block linking or crash Pi. Only node:fs,
// node:path and node:os are used — no child process, no git CLI, no
// network — and malformed content or paths are never echoed anywhere:
// every filesystem/parse failure collapses to `null`.

// Branch charset mirroring the store's 128-char contract. The allowlist
// alone rejects whitespace, control characters and backslashes.
const GIT_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const GIT_REF_PREFIX = 'ref: refs/heads/';
const GIT_DETACHED_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
// Traversal/read bounds: at most 64 parent levels, and only bounded reads
// (lstat + size cap) of .git pointers and HEAD files, never unbounded.
const MAX_GIT_WALK_LEVELS = 64;
const MAX_GIT_FILE_BYTES = 4096;
// UNC/network/device paths (\\server\share, //server/share, \\?\, \\.\)
// are rejected BEFORE any stat/read: this helper must never touch the
// network or a device namespace.
const UNC_OR_DEVICE_PATH_RE = /^(?:\\\\|\/\/)/;
// On Windows an absolute gitdir target must be a local drive-letter path.
const WIN_LOCAL_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

/**
 * Sanitize one candidate branch name. Rejects (never repairs) anything
 * outside the safe charset/bounds, including path-shaped escapes:
 * leading/trailing slash, '//', any '..' path segment, '@{' and blanks.
 */
function sanitizeGitBranch(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const branch = raw.trim();
  if (branch.length === 0 || branch.length > MAX_BRANCH_CHARS) return null;
  if (!GIT_BRANCH_RE.test(branch)) return null;
  if (branch.startsWith('/') || branch.endsWith('/') || branch.includes('//')) return null;
  if (branch.split('/').includes('..')) return null;
  if (branch.includes('@{')) return null;
  return branch;
}

/** Read and parse one HEAD file; only bounded reads after an lstat check.
 * Symlinked/junction HEAD files are rejected (fail closed), never followed. */
function readGitHeadFile(headPath: string): string | null {
  try {
    const stat = lstatSync(headPath);
    if (stat.isSymbolicLink()) return null;
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_GIT_FILE_BYTES) return null;
    const firstLine = readFileSync(headPath, 'utf8').split('\n', 1)[0] ?? '';
    const line = firstLine.trim();
    if (line.startsWith(GIT_REF_PREFIX)) {
      return sanitizeGitBranch(line.slice(GIT_REF_PREFIX.length));
    }
    if (GIT_DETACHED_RE.test(line)) return 'detached';
    return null;
  } catch {
    return null;
  }
}

/** Structural mirror of the fs.Stats fields this helper relies on. */
interface GitEntryStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}

/** Windows-tolerant directory equality (case- and trailing-slash-safe). */
function sameGitWalkDir(a: string, b: string): boolean {
  const left = a.replace(/[\\/]+$/, '');
  const right = b.replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** True when dir is its own parent: '/', 'C:\'. (A UNC root can never
 * reach here: UNC cwd paths are rejected before any traversal.) */
function isFilesystemRoot(dir: string): boolean {
  return dirname(dir) === dir;
}

/**
 * Inspect <dir>/.git. Returns the sanitized branch, the fixed string
 * 'detached', null when a .git exists but is unusable (walk stops), or
 * undefined when no .git exists at this level (walk continues).
 */
function inspectDotGit(dir: string): string | null | undefined {
  const dotGit = join(dir, '.git');
  let stat: GitEntryStat;
  try {
    stat = lstatSync(dotGit);
  } catch {
    return undefined; // not present at this level
  }
  if (stat.isSymbolicLink()) return null; // never follow links/junctions
  if (stat.isDirectory()) {
    return readGitHeadFile(join(dotGit, 'HEAD'));
  }
  if (stat.isFile()) {
    if (stat.size === 0 || stat.size > MAX_GIT_FILE_BYTES) return null;
    const content = readFileSync(dotGit, 'utf8');
    if (!content.startsWith('gitdir:')) return null;
    const target = content.slice('gitdir:'.length).trim();
    if (target.length === 0) return null;
    if (isAbsolute(target)) {
      // UNC/network/device absolute targets are rejected; on Windows only
      // local drive-letter absolute targets are accepted.
      if (!WIN_LOCAL_ABSOLUTE_RE.test(target)) return null;
      return readGitHeadFile(join(target, 'HEAD'));
    }
    return readGitHeadFile(join(dir, target, 'HEAD'));
  }
  return null; // any other node type: fail closed
}

/** Internal test-only options; production callers pass only the cwd. */
interface ReadGitBranchOptions {
  /** Overrides os.homedir() for hermetic boundary tests. */
  homeDir?: string | null;
}

/**
 * Detect the git branch for a working directory by walking UPWARD from
 * the resolved cwd looking for `.git`, using only built-in node:fs/path.
 * The cwd itself must EXIST and BE A DIRECTORY — anything else fails
 * closed to null without any ancestor walk.
 *
 * Boundary rules (home/root inheritance): for any STRICT ancestor of the
 * cwd, a `.git` located exactly at the user's home directory or at the
 * filesystem root is never inspected — dotfiles repos there (e.g. a user
 * profile or drive root) must not label unrelated projects. A cwd that
 * IS the home/root may still use its own repo.
 *
 * Supported .git forms:
 * - normal repo: `.git` directory with a HEAD file;
 * - worktree/submodule: `.git` file whose content begins exactly with
 *   `gitdir:` — the target is resolved as-is (local drive-letter
 *   absolute on Windows; UNC/device rejected) or against the directory
 *   containing `.git`, then its HEAD is parsed. Pointer chains and
 *   symlinks/junctions are deliberately NOT followed (fail closed).
 * Returns the sanitized branch, the fixed string 'detached' for a hex
 * HEAD, or null for anything malformed, hostile, unreadable or absent.
 */
export function readGitBranch(cwd: unknown, options: ReadGitBranchOptions = {}): string | null {
  if (
    typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_IDENTITY_CHARS
    || UNC_OR_DEVICE_PATH_RE.test(cwd)
  ) {
    return null;
  }
  let home: string | null;
  if (options.homeDir !== undefined) {
    home = typeof options.homeDir === 'string' && options.homeDir.length > 0
      ? options.homeDir
      : null;
  } else {
    try {
      home = homedir();
    } catch {
      home = null;
    }
  }
  try {
    const start = resolve(cwd);
    // The cwd must exist and be a directory before any ancestor walk.
    if (!statSync(start).isDirectory()) return null;
    let dir = start;
    for (let level = 0; level < MAX_GIT_WALK_LEVELS; level++) {
      // Home/root dotfiles repos never inherit into a descendant cwd.
      const protectedBoundary = dir !== start
        && ((home !== null && sameGitWalkDir(dir, home)) || isFilesystemRoot(dir));
      if (!protectedBoundary) {
        const found = inspectDotGit(dir);
        if (found !== undefined) return found;
      }
      const parent = dirname(dir);
      if (parent === dir) return null; // filesystem root reached
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function modelLabel(ctx: ExtensionContext | null): string | null {
  try {
    const model = (ctx as { model?: { provider?: unknown; id?: unknown } } | null)?.model;
    if (model && typeof model.id === 'string' && model.id.length > 0) {
      return typeof model.provider === 'string'
        ? `${model.provider}/${model.id}`
        : model.id;
    }
  } catch {
    // Model identity is best-effort status decoration only.
  }
  return null;
}

/** Bridge-module default: <module>/.local/state, resolved from this file. */
function defaultStateDirectory(): string {
  // <module>/extension -> <module>/.local/state
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '.local', 'state');
}

/** Optional seams for deterministic testing; production uses the defaults. */
interface T3BChoiceInjections {
  now?: () => number;
  choiceTimeoutMs?: number;
  requestIdFactory?: () => string;
  scheduleChoiceTimeout?: (callback: () => void, ms: number) => unknown;
  clearChoiceTimeout?: (handle: unknown) => void;
}

export class SelectiveTuiBridgeExtension {
  readonly #stateDirectory: string;
  #pi: ExtensionAPI | null = null;
  #connection: BridgeConnection | null = null;
  #store: Store | null = null;
  /** Latest live session context; the ONLY context abort/status may use. */
  #latestCtx: ExtensionContext | null = null;

  // --- remote choice tool state (memory-only, never persisted) ------------
  #now: () => number;
  #choiceTimeoutMs: number;
  #newRequestId: () => string;
  #scheduleChoiceTimeout: (callback: () => void, ms: number) => unknown;
  #clearChoiceTimeout: (handle: unknown) => void;
  #pendingChoice: PendingChoiceRequest | null = null;
  #choiceTimerHandle: unknown = null;

  constructor(stateDirectory: string, choiceInjections: T3BChoiceInjections = {}) {
    this.#stateDirectory = stateDirectory;
    this.#now = choiceInjections.now ?? (() => Date.now());
    this.#choiceTimeoutMs = choiceInjections.choiceTimeoutMs ?? CHOICE_REQUEST_TTL_MS;
    this.#newRequestId = choiceInjections.requestIdFactory
      // 16 lowercase hex chars: exactly the store's request-id contract.
      ?? (() => randomBytes(8).toString('hex'));
    this.#scheduleChoiceTimeout = choiceInjections.scheduleChoiceTimeout
      ?? ((callback, ms) => {
        const handle = setTimeout(callback, ms);
        // A pending choice must never keep the Pi process alive by itself.
        (handle as { unref?: () => void }).unref?.();
        return handle;
      });
    this.#clearChoiceTimeout = choiceInjections.clearChoiceTimeout
      ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  register(pi: ExtensionAPI): void {
    this.#pi = pi;

    // --- Local commands -------------------------------------------------

    pi.registerCommand('telegram-connect', {
      description: 'Opt this interactive TUI into the Telegram bridge transport',
      handler: async (args, ctx) => {
        this.#latestCtx = ctx;
        if (ctx.mode !== 'tui') {
          this.#notify(ctx, 'telegram bridge: /telegram-connect requires interactive TUI mode', 'error');
          return;
        }
        if (this.#connection) {
          this.#notify(ctx, `telegram bridge: already connected as tg:${this.#connection.shortId}`, 'info');
          return;
        }
        const label = boundedLabel(args);
        const result = this.#connectFresh(ctx, label);
        if (!result.ok) {
          this.#notify(ctx, `telegram bridge: connect failed (${result.reason})`, 'error');
          return;
        }
        this.#notify(ctx, `telegram bridge connected: tg:${result.shortId}`, 'info');
      },
    });

    pi.registerCommand('telegram-disconnect', {
      description: 'Disconnect this TUI from the Telegram bridge and clear opt-in',
      handler: async (_args, ctx) => {
        this.#latestCtx = ctx;
        if (!this.#connection) {
          this.#notify(ctx, 'telegram bridge: not connected', 'info');
          return;
        }
        this.#unlinkConnected();
        this.#notify(ctx, 'telegram bridge disconnected', 'info');
      },
    });

    pi.registerCommand('telegram-status', {
      description: 'Show the Telegram bridge connection state of this TUI',
      handler: async (_args, ctx) => {
        this.#latestCtx = ctx;
        const c = this.#connection;
        if (!c) {
          this.#notify(ctx, 'telegram bridge: not connected', 'info');
          return;
        }
        const parts = [
          `tg:${c.shortId}`,
          `state=${this.#derivedState(c)}`,
          `pid=${process.pid}`,
          `label=${c.label}`,
        ];
        if (c.cwd) parts.push(`cwd=${c.cwd}`);
        parts.push(`session=${c.piSessionId ?? 'none'}`);
        this.#notify(ctx, `telegram bridge: ${parts.join(' ')}`, 'info');
      },
    });

    // --- Beginner command: /tg -------------------------------------------

    pi.registerCommand('tg', {
      description: 'Link this Pi to Telegram (beginner command)',
      getArgumentCompletions: (prefix): CommandArgumentCompletion[] | null => {
        const items: CommandArgumentCompletion[] = [{ value: 'off', label: 'off' }];
        const filtered = typeof prefix === 'string' && prefix.length > 0
          ? items.filter((item) => item.value.startsWith(prefix))
          : items;
        return filtered.length > 0 ? filtered : null;
      },
      handler: async (args, ctx) => {
        this.#latestCtx = ctx;
        // Fail closed outside the interactive TUI: no dialog is possible
        // there, so no connection may be made either.
        if (ctx.mode !== 'tui') {
          this.#notify(ctx, MSG_TG_NOT_TUI, 'error');
          return;
        }
        const arg = typeof args === 'string' ? args.trim() : '';
        if (this.#connection) {
          if (arg === 'off') {
            await this.#confirmUnlink(ctx);
            return;
          }
          if (arg.length > 0) {
            // /tg never treats its arguments as a custom label.
            this.#notify(ctx, MSG_TG_USAGE, 'info');
            return;
          }
          // Idempotent status: no re-confirmation, current label and state.
          this.#notify(
            ctx,
            this.#brokerAvailable()
              ? MSG_C3_STATUS(this.#connection.label, this.#derivedState(this.#connection))
              : MSG_C3_STATUS_PHONE_UNAVAILABLE(this.#connection.label),
            'info',
          );
          return;
        }
        if (arg === 'off') {
          // Already unlinked: friendly status, no store mutation at all.
          this.#notify(ctx, MSG_TG_ALREADY_UNLINKED, 'info');
          return;
        }
        if (arg.length > 0) {
          this.#notify(ctx, MSG_TG_USAGE, 'info');
          return;
        }
        // Setup guard: presence check of the enrolled blob only. The
        // extension never reads or decrypts credentials and never leaks
        // the path into the copy.
        if (!this.#credentialsPresent()) {
          this.#notify(ctx, MSG_C8_SETUP, 'warning');
          return;
        }
        const busy = this.#isBusy(ctx);
        const title = busy ? `${MSG_C1_CONFIRM}\n${MSG_C4_BUSY}` : MSG_C1_CONFIRM;
        const choice = await this.#select(ctx, title, [CONNECT_OPTION, CANCEL_OPTION]);
        if (choice !== CONNECT_OPTION) return; // Cancel/timeout: no-op.
        // Auto label via the live-session allocator (never duplicates an
        // existing live label), derived only after an explicit confirmation.
        let label: string;
        try {
          const store = this.#ensureStore();
          const probe = new TuiBridgeClient(store);
          label = allocateAutoLabel(autoLabelFromCwd(ctx?.cwd), probe.listSessions());
        } catch (error) {
          this.#notify(ctx, `telegram bridge: connect failed (${this.#errorCode(error)})`, 'error');
          return;
        }
        const result = this.#connectFresh(ctx, label);
        if (!result.ok) {
          this.#notify(ctx, `telegram bridge: connect failed (${result.reason})`, 'error');
          return;
        }
        this.#notify(
          ctx,
          this.#brokerAvailable() ? MSG_C2_LINKED(label) : MSG_C2_PHONE_UNAVAILABLE,
          'info',
        );
      },
    });

    // --- Session lifecycle ----------------------------------------------

    pi.on('session_start', async (_event, ctx) => {
      this.#latestCtx = ctx;
      if (ctx.mode !== 'tui') return;
      // Opt-in lives on globalThis: reload/new/resume/fork in this process
      // reconnect here; a new process finds no opt-in and stays detached.
      this.#reconnectFromOptIn(ctx);
    });

    pi.on('session_shutdown', async (event) => {
      const reason = (event as { reason?: string } | undefined)?.reason;
      if (reason === 'quit') {
        this.#disposeConnection({ disconnectRemote: true });
        this.#clearOptIn();
        return;
      }
      // reload/new/resume/fork: release the old tracked row (that IS the
      // "old one disconnects") but keep the opt-in so the replacement
      // session reconnects from its own session_start.
      this.#disposeConnection({ disconnectRemote: true });
    });

    // --- State transitions -----------------------------------------------

    pi.on('agent_start', async (_event, ctx) => {
      this.#latestCtx = ctx;
      const c = this.#connection;
      if (!c) return;
      c.agentActive = true;
      this.#pushState(c);
    });

    pi.on('agent_settled', async (_event, ctx) => {
      this.#latestCtx = ctx;
      const c = this.#connection;
      if (!c) return;
      c.agentActive = false;
      this.#pushState(c);
    });

    pi.on('ui_prompt_start', async (_event, ctx) => {
      this.#latestCtx = ctx;
      const c = this.#connection;
      if (!c) return;
      c.uiPromptActive = true;
      this.#pushState(c);
    });

    pi.on('ui_prompt_end', async (_event, ctx) => {
      this.#latestCtx = ctx;
      const c = this.#connection;
      if (!c) return;
      c.uiPromptActive = false;
      this.#pushState(c);
    });

    // --- Output forwarding ------------------------------------------------

    pi.on('message_end', async (event, ctx) => {
      this.#latestCtx = ctx;
      const c = this.#connection;
      if (!c) return;
      const message = (event as { message?: { role?: unknown } }).message;
      if (!message || message.role !== 'assistant') return;
      const full = extractFinalText(message);
      if (!full) return;
      const text = full.length > MAX_FINAL_TEXT_CHARS
        ? full.slice(0, MAX_FINAL_TEXT_CHARS)
        : full;
      try {
        // CAS by connection id: a replaced connection can never publish
        // into the new owner's event stream. Failures are swallowed.
        c.client.publishFinalOutput({
          trackingId: c.trackingId,
          connectionId: c.connectionId,
          text,
        });
      } catch {
        // Never crash Pi on forwarding; never echo the payload anywhere.
      }
    });

    // --- Remote ordinary choice tool (T3B) ------------------------------

    pi.registerTool({
      name: CHOICE_TOOL_NAME,
      label: 'Ask the Telegram owner (choice)',
      description: CHOICE_TOOL_DESCRIPTION,
      promptSnippet: CHOICE_TOOL_PROMPT_SNIPPET,
      promptGuidelines: CHOICE_TOOL_PROMPT_GUIDELINES,
      parameters: CHOICE_PARAMETERS,
      executionMode: 'sequential',
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) => {
        this.#latestCtx = ctx;
        return await this.#runRemoteChoice(params, signal);
      },
    });
  }

  // --- Connection plumbing ------------------------------------------------

  /**
   * The single fresh-connection implementation shared by /tg (beginner)
   * and /telegram-connect (advanced). Never auto-called: every caller is
   * an explicit user action in this process.
   */
  #connectFresh(
    ctx: ExtensionContext,
    label: string,
  ): { ok: true; shortId: string } | { ok: false; reason: string } {
    try {
      const store = this.#ensureStore();
      const client = new TuiBridgeClient(store);
      const identity = this.#sessionIdentity(ctx);
      const branch = readGitBranch(identity.cwd);
      const result = client.connect({
        piSessionId: identity.piSessionId,
        piSessionFile: identity.piSessionFile,
        cwd: identity.cwd,
        label,
        branch,
        pid: process.pid,
      });
      if (!result.ok) return { ok: false, reason: result.reason };
      this.#connection = {
        store,
        client,
        trackingId: result.trackingId,
        connectionId: result.connectionId,
        label,
        shortId: result.shortId,
        cwd: identity.cwd,
        piSessionId: identity.piSessionId,
        piSessionFile: identity.piSessionFile,
        agentActive: false,
        uiPromptActive: false,
        heartbeatTimer: null,
        pollTimer: null,
      };
      this.#writeOptIn({
        trackingId: result.trackingId,
        connectionId: result.connectionId,
        label,
      });
      this.#startTimers();
      this.#setFooter(result.shortId);
      return { ok: true, shortId: result.shortId };
    } catch (error) {
      return { ok: false, reason: this.#errorCode(error) };
    }
  }

  /**
   * Explicit unlink: remote disconnect plus opt-in clear. Shared by /tg
   * off (beginner), /telegram-disconnect (advanced) and the remote
   * disconnect command.
   */
  #unlinkConnected(): void {
    this.#disposeConnection({ disconnectRemote: true });
    this.#clearOptIn();
  }

  /** Presence-only check of the enrolled blob; never reads its content. */
  #credentialsPresent(): boolean {
    try {
      return existsSync(join(this.#stateDirectory, CREDENTIALS_BLOB));
    } catch {
      // Fail closed: friendly setup guidance, never a connection attempt.
      return false;
    }
  }

  /**
   * Nonsecret broker health probe used only to keep /tg copy truthful.
   * Missing, malformed, stale, foreign or dead metadata degrades to the
   * beginner-safe unavailable message. It never starts a process, opens the
   * network, reads credentials or exposes ids/paths in UI copy.
   */
  #brokerAvailable(): boolean {
    try {
      const runtime = JSON.parse(
        readFileSync(join(this.#stateDirectory, RUNTIME_CONFIG_FILE), 'utf8'),
      ) as { instanceId?: unknown };
      const meta = JSON.parse(
        readFileSync(join(this.#stateDirectory, BROKER_META_FILE), 'utf8'),
      ) as {
        instanceId?: unknown;
        pid?: unknown;
        heartbeatAt?: unknown;
        shutdownAt?: unknown;
      };
      if (typeof runtime.instanceId !== 'string' || !/^[0-9a-f]{32}$/.test(runtime.instanceId)) {
        return false;
      }
      if (meta.instanceId !== runtime.instanceId) return false;
      if (typeof meta.pid !== 'number' || !Number.isSafeInteger(meta.pid) || meta.pid <= 0) {
        return false;
      }
      if (typeof meta.heartbeatAt !== 'number' || !Number.isSafeInteger(meta.heartbeatAt)) {
        return false;
      }
      if (meta.shutdownAt !== undefined && meta.shutdownAt !== null) return false;
      const ageMs = Date.now() - Number(meta.heartbeatAt);
      if (ageMs < 0 || ageMs > BROKER_HEARTBEAT_FRESH_MS) return false;
      try {
        process.kill(Number(meta.pid), 0);
        return true;
      } catch (error) {
        return (error as { code?: unknown } | undefined)?.code === 'EPERM';
      }
    } catch {
      return false;
    }
  }

  /** Busy = a run is in flight; missing isIdle degrades to not busy. */
  #isBusy(ctx: ExtensionContext): boolean {
    return typeof ctx?.isIdle === 'function' ? !ctx.isIdle() : false;
  }

  /** Dialog helper: a failed/absent select degrades to Cancel (no-op). */
  async #select(
    ctx: ExtensionContext,
    title: string,
    options: string[],
  ): Promise<string | undefined> {
    try {
      return await ctx.ui?.select?.(title, options);
    } catch {
      return undefined;
    }
  }

  /**
   * /tg off confirmation (MSG-C5, MSG-C7 busy variant). Cancel is a
   * no-op; Unlink reuses the exact existing disconnect implementation.
   */
  async #confirmUnlink(ctx: ExtensionContext): Promise<void> {
    const busy = this.#isBusy(ctx);
    const title = busy ? `${MSG_C5_UNLINK_ASK}\n${MSG_C7_BUSY}` : MSG_C5_UNLINK_ASK;
    const options = busy
      ? [UNLINK_ANYWAY_OPTION, CANCEL_OPTION]
      : [UNLINK_OPTION, CANCEL_OPTION];
    const choice = await this.#select(ctx, title, options);
    if (choice !== UNLINK_OPTION && choice !== UNLINK_ANYWAY_OPTION) return;
    this.#unlinkConnected();
    this.#notify(ctx, MSG_C6_UNLINKED, 'info');
  }

  #ensureStore(): Store {
    if (!this.#store) {
      mkdirSync(this.#stateDirectory, { recursive: true });
      this.#store = new Store(join(this.#stateDirectory, 'bridge.sqlite'));
    }
    return this.#store;
  }

  #sessionIdentity(ctx: ExtensionContext): {
    cwd: string | null;
    piSessionId: string | null;
    piSessionFile: string | null;
  } {
    let piSessionId: string | null = null;
    let piSessionFile: string | null = null;
    try {
      const sm = (ctx as { sessionManager?: unknown }).sessionManager as
        | { getSessionId?: () => unknown; getSessionFile?: () => unknown }
        | undefined;
      piSessionId = boundedText(sm?.getSessionId?.(), MAX_IDENTITY_CHARS);
      piSessionFile = boundedText(sm?.getSessionFile?.(), MAX_IDENTITY_CHARS);
    } catch {
      // Identity fields are optional metadata; never block connect on them.
    }
    const cwd = boundedText((ctx as { cwd?: unknown }).cwd, MAX_IDENTITY_CHARS);
    return { cwd, piSessionId, piSessionFile };
  }

  #reconnectFromOptIn(ctx: ExtensionContext): void {
    if (this.#connection) return;
    const optIn = this.#readOptIn();
    if (!optIn) return;
    try {
      const store = this.#ensureStore();
      const client = new TuiBridgeClient(store);
      const identity = this.#sessionIdentity(ctx);
      const branch = readGitBranch(identity.cwd);
      // Same trackingId + same connectionId: the old row was released in
      // session_shutdown, so this either inserts fresh or (if the release
      // failed) is an idempotent same-connection refresh — never a steal.
      const result = client.connect({
        trackingId: optIn.trackingId,
        connectionId: optIn.connectionId,
        piSessionId: identity.piSessionId,
        piSessionFile: identity.piSessionFile,
        cwd: identity.cwd,
        label: optIn.label,
        branch,
        pid: process.pid,
      });
      if (!result.ok) return; // fail closed; opt-in retained for retry
      this.#connection = {
        store,
        client,
        trackingId: result.trackingId,
        connectionId: result.connectionId,
        label: optIn.label,
        shortId: result.shortId,
        cwd: identity.cwd,
        piSessionId: identity.piSessionId,
        piSessionFile: identity.piSessionFile,
        agentActive: false,
        uiPromptActive: false,
        heartbeatTimer: null,
        pollTimer: null,
      };
      this.#startTimers();
      this.#setFooter(result.shortId);
    } catch {
      // Stay disconnected silently; the user can inspect /telegram-status.
    }
  }

  #startTimers(): void {
    const c = this.#connection;
    if (!c || c.heartbeatTimer || c.pollTimer) return;
    // Timers start ONLY after a successful connect, and are unref'd so
    // they never keep the process alive on their own.
    c.heartbeatTimer = setInterval(() => this.#heartbeatTick(), HEARTBEAT_INTERVAL_MS);
    c.heartbeatTimer.unref?.();
    c.pollTimer = setInterval(() => this.#pollTick(), POLL_INTERVAL_MS);
    c.pollTimer.unref?.();
  }

  #heartbeatTick(): void {
    const c = this.#connection;
    if (!c) return;
    try {
      // Re-detect the branch every tick (a checkout may have moved). A
      // null detection preserves the last known metadata instead of
      // erasing it (the store COALESCEs); nothing is cached locally.
      const branch = readGitBranch(c.cwd);
      const result = c.client.heartbeat({
        trackingId: c.trackingId,
        connectionId: c.connectionId,
        branch,
      });
      if (!result || result.ok !== true) this.#dropConnection();
    } catch {
      // Transient store errors: retry on the next tick, never crash.
    }
  }

  #pollTick(): void {
    const c = this.#connection;
    if (!c) return;
    let commands: Array<{ commandId: string; kind: string; payload: unknown }> = [];
    try {
      const result = c.client.poll({
        trackingId: c.trackingId,
        connectionId: c.connectionId,
        maxEvents: 1,
      });
      commands = (result?.commands ?? []) as typeof commands;
      // Events in this stream belong to the broker; this side never
      // acknowledges them.
    } catch {
      // Bounded failure: skip this tick, never crash, never expose payloads.
      return;
    }
    for (const command of commands) {
      this.#handleRemoteCommand(c, command);
    }
  }

  /**
   * Ownership revalidation before acting on a claimed command. Cheap
   * identity read: the claim CAS already bound the command to this
   * connection, this guard catches a connection dropped mid-batch.
   */
  #revalidate(c: BridgeConnection): boolean {
    if (this.#connection !== c) return false;
    if (!this.#readOptIn()) return false;
    try {
      const session = c.client.getSession({ trackingId: c.trackingId });
      if (!session || session.connectionId !== c.connectionId) {
        this.#dropConnection();
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  #handleRemoteCommand(
    c: BridgeConnection,
    command: { commandId: string; kind: string; payload: unknown },
  ): void {
    // Remote choice settlements are SILENT by design (T3B): the command row
    // itself is the record and the tool result is the user-visible answer.
    // They must never produce a command_result event and never fall into
    // the ordinary report machinery below.
    if (command.kind === 'choice_response') {
      this.#handleChoiceResponse(c, command);
      return;
    }
    // Exactly-one terminal report per claimed command, whatever happens.
    let reported = false;
    const report = (ok: boolean, text?: string, resultCode?: string) => {
      if (reported) return;
      reported = true;
      try {
        c.client.reportCommandResult({
          commandId: command.commandId,
          trackingId: c.trackingId,
          connectionId: c.connectionId,
          ok,
          text,
          resultCode,
        });
      } catch {
        // A lost report degrades to claim-expiry on the broker side.
      }
    };
    try {
      if (!this.#revalidate(c)) {
        report(false, undefined, 'not_connected');
        return;
      }
      switch (command.kind) {
        case 'prompt':
        case 'steer':
        case 'followup': {
          const payload = command.payload as { text?: unknown } | null;
          const text = boundedText(payload?.text, MAX_FINAL_TEXT_CHARS);
          if (text === null) {
            report(false, undefined, 'invalid_text');
            return;
          }
          if (SLASH_PREFIX_RE.test(text)) {
            report(false, undefined, 'rejected_slash_prefix');
            return;
          }
          const ctx = this.#latestCtx;
          const idle = typeof ctx?.isIdle === 'function' ? ctx.isIdle() : true;
          if (command.kind === 'prompt' && !idle) {
            report(false, undefined, 'not_idle');
            return;
          }
          try {
            if (idle) {
              this.#pi!.sendUserMessage(text);
            } else {
              this.#pi!.sendUserMessage(text, {
                deliverAs: command.kind === 'followup' ? 'followUp' : 'steer',
              });
            }
          } catch {
            report(false, undefined, 'send_failed');
            return;
          }
          report(true, `${command.kind} delivered`);
          return;
        }
        case 'abort': {
          const ctx = this.#latestCtx;
          if (!ctx || typeof ctx.abort !== 'function') {
            report(false, undefined, 'no_live_context');
            return;
          }
          try {
            ctx.abort();
          } catch {
            report(false, undefined, 'no_live_context');
            return;
          }
          report(true, 'abort requested');
          return;
        }
        case 'status': {
          try {
            c.client.publishStatus({
              trackingId: c.trackingId,
              connectionId: c.connectionId,
              payload: this.#statusPayload(c),
            });
          } catch {
            report(false, undefined, 'status_failed');
            return;
          }
          report(true, 'status published');
          return;
        }
        case 'disconnect': {
          // Report while the connection can still write, then tear down.
          report(true, 'disconnected');
          this.#unlinkConnected();
          return;
        }
        default:
          report(false, undefined, 'unknown_command');
      }
    } catch {
      report(false, undefined, 'internal_error');
    }
  }

  #derivedState(c: BridgeConnection): 'connected' | 'busy' | 'waiting' {
    // A pending remote choice IS waiting for the human: it outranks both
    // the busy run and the native ui_prompt indication.
    if (this.#pendingChoice || c.uiPromptActive) return 'waiting';
    if (c.agentActive) return 'busy';
    return 'connected';
  }

  #pushState(c: BridgeConnection): void {
    try {
      c.client.setState({
        trackingId: c.trackingId,
        connectionId: c.connectionId,
        state: this.#derivedState(c),
      });
    } catch {
      // State is best-effort; ownership loss is handled by the heartbeat.
    }
  }

  #statusPayload(c: BridgeConnection): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      pid: process.pid,
      shortId: c.shortId,
      label: c.label,
      state: this.#derivedState(c),
      agentActive: c.agentActive,
      uiPromptActive: c.uiPromptActive,
    };
    if (c.cwd) payload.cwd = c.cwd;
    if (c.piSessionId) payload.piSessionId = c.piSessionId;
    const model = modelLabel(this.#latestCtx);
    if (model) payload.model = model;
    return payload;
  }

  #dropConnection(): void {
    // Ownership was lost (replaced or removed elsewhere): release local
    // resources but KEEP the opt-in so a future session_start retries.
    this.#disposeConnection({ disconnectRemote: false });
  }

  /** Idempotent teardown of timers, client-side row and the Store handle. */
  #disposeConnection({ disconnectRemote }: { disconnectRemote: boolean }): void {
    const c = this.#connection;
    if (!c) return;
    // Null the connection FIRST so the interrupted settle cannot push a
    // state update into a row that is being torn down, then settle the
    // pending choice synchronously BEFORE timers/store close: the blocked
    // tool must always receive a terminal result, never hang forever.
    this.#connection = null;
    this.#settlePendingChoice({ status: 'interrupted' });
    for (const timer of [c.heartbeatTimer, c.pollTimer]) {
      if (timer) clearInterval(timer);
    }
    if (disconnectRemote) {
      try {
        c.client.disconnect({ trackingId: c.trackingId, connectionId: c.connectionId });
      } catch {
        // The row ages out via the staleness window instead.
      }
    }
    try {
      c.store.close();
    } catch {
      // Closing twice or a busy handle must never crash Pi.
    }
    this.#store = null;
    try {
      this.#latestCtx?.ui?.setStatus?.(STATUS_KEY, undefined);
    } catch {
      // Stale context after replacement: footer cleanup is best-effort.
    }
  }

  // --- Opt-in flag (process-wide, never persisted) ------------------------

  #readOptIn(): TelegramOptIn | null {
    const raw = (globalThis as Record<string, unknown>)[OPT_IN_KEY];
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as Record<string, unknown>;
    const trackingId = candidate.trackingId;
    const connectionId = candidate.connectionId;
    const label = candidate.label;
    if (
      typeof trackingId !== 'string' || !BRIDGE_ID_RE.test(trackingId)
      || typeof connectionId !== 'string' || !BRIDGE_ID_RE.test(connectionId)
      || typeof label !== 'string' || label.length === 0 || label.length > MAX_LABEL_CHARS
    ) {
      // Malformed flag: treat as absent rather than trusting it.
      return null;
    }
    return { trackingId, connectionId, label };
  }

  #writeOptIn(optIn: TelegramOptIn): void {
    (globalThis as Record<string, unknown>)[OPT_IN_KEY] = { ...optIn };
  }

  #clearOptIn(): void {
    delete (globalThis as Record<string, unknown>)[OPT_IN_KEY];
  }

  // --- Local TUI helpers ----------------------------------------------------

  #notify(ctx: ExtensionContext, message: string, level: 'info' | 'error'): void {
    try {
      ctx.ui?.notify?.(message, level);
    } catch {
      // Notifications must never break the command that issued them.
    }
  }

  #setFooter(shortId: string): void {
    try {
      this.#latestCtx?.ui?.setStatus?.(STATUS_KEY, `tg:${shortId}`);
    } catch {
      // Footer is cosmetic; ignore stale or non-TUI contexts.
    }
  }

  // --- Remote ordinary choice tool (T3B) ----------------------------------

  /** Fixed JSON tool result: text and details carry the exact same object. */
  #choiceResult(result: ChoiceToolPayload): {
    content: Array<{ type: 'text'; text: string }>;
    details: ChoiceToolPayload;
  } {
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      details: result,
    };
  }

  /**
   * Execute the remote ordinary choice tool. Refusals are fixed local JSON
   * (never throws to the model, never leaks paths or payloads); publishing
   * strips option values; the tool then blocks until the owner answers on
   * Telegram, cancels, the 30 minute deadline passes, the call is aborted,
   * or the connection dies.
   */
  async #runRemoteChoice(
    rawParams: unknown,
    signal: AbortSignal | undefined,
  ): Promise<ReturnType<SelectiveTuiBridgeExtension['#choiceResult']>> {
    const refused = (reason: string) =>
      this.#choiceResult({ status: 'refused', reason });

    // An already-aborted call never publishes anything.
    if (signal?.aborted) return this.#choiceResult({ status: 'aborted' });

    const c = this.#connection;
    if (!c) return refused('not_linked');

    // One pending choice per instance: a second concurrent call is refused.
    if (this.#pendingChoice) return refused('busy');

    // The broker must be alive before we promise the owner an answer.
    if (!this.#brokerAvailable()) return refused('broker_unavailable');

    // Defensive re-validation: the model-facing schema is trust-boundary
    // input, not a guarantee. Every security-critical bound is repeated.
    const params = rawParams as Record<string, unknown> | null;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return refused('invalid_input');
    }
    const allowedKeys = ['question', 'options'];
    const keys = Object.keys(params);
    if (keys.length !== allowedKeys.length || keys.some((k) => !allowedKeys.includes(k))) {
      return refused('invalid_input');
    }
    const question = params.question;
    const rawOptions = params.options;
    if (
      typeof question !== 'string'
      || question.length < 1
      || question.length > MAX_CHOICE_QUESTION_CHARS
      || !Array.isArray(rawOptions)
      || rawOptions.length < MIN_CHOICE_OPTIONS
      || rawOptions.length > MAX_CHOICE_OPTIONS
    ) {
      return refused('invalid_input');
    }
    const options: Array<{ label: string; description: string; value: string }> = [];
    for (const raw of rawOptions) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return refused('invalid_input');
      }
      const entry = raw as Record<string, unknown>;
      const entryKeys = Object.keys(entry).sort();
      if (
        entryKeys.length !== 3
        || entryKeys[0] !== 'description'
        || entryKeys[1] !== 'label'
        || entryKeys[2] !== 'value'
        || typeof entry.label !== 'string'
        || entry.label.length < 1
        || entry.label.length > MAX_CHOICE_LABEL_CHARS
        || typeof entry.description !== 'string'
        || entry.description.length < 1
        || entry.description.length > MAX_CHOICE_DESCRIPTION_CHARS
        || typeof entry.value !== 'string'
        || entry.value.length < 1
        || entry.value.length > MAX_CHOICE_VALUE_CHARS
      ) {
        return refused('invalid_input');
      }
      options.push({ label: entry.label, description: entry.description, value: entry.value });
    }

    // Credential-shaped text never travels: question and the PUBLISHED
    // fields are scanned; the local-only value deliberately is not, so a
    // secret can be used as a machine value without ever leaving the TUI.
    if (
      containsCredentialShape(question)
      || options.some(
        (o) => containsCredentialShape(o.label) || containsCredentialShape(o.description),
      )
    ) {
      return refused('refused_credentials');
    }

    // Telegram-visible text is sanitized; a question that sanitizes to
    // nothing cannot be asked meaningfully.
    const sanitizedQuestion = choiceQuestionText(question);
    if (sanitizedQuestion.length === 0) return refused('refused_empty_question');

    const requestId = this.#newRequestId();
    const expiresAt = this.#now() + this.#choiceTimeoutMs;
    try {
      const published = c.client.publishChoiceRequest({
        trackingId: c.trackingId,
        connectionId: c.connectionId,
        requestId,
        question: sanitizedQuestion,
        // Only label+description travel; values stay in this process.
        options: options.map((o) => ({ label: o.label, description: o.description })),
        expiresAt,
      });
      if (!published || published.ok !== true) return refused('publish_failed');
    } catch {
      return refused('publish_failed');
    }

    // Publish succeeded: install the pending choice and arm the deadline.
    let resolvePending!: (result: ChoiceToolResult) => void;
    const pendingPromise = new Promise<ChoiceToolResult>((res) => {
      resolvePending = res;
    });
    this.#pendingChoice = {
      requestId,
      question: sanitizedQuestion,
      values: options.map((o) => o.value),
      expiresAt,
      settled: false,
      resolve: resolvePending,
    };
    this.#choiceTimerHandle = this.#scheduleChoiceTimeout(() => {
      this.#settlePendingChoice({ status: 'timed_out' });
    }, this.#choiceTimeoutMs);
    this.#pushState(c);

    const onAbort = () => {
      this.#settlePendingChoice({ status: 'aborted' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await pendingPromise;
      return this.#choiceResult(result);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Single-shot local settle: clears the deadline timer exactly once and
   * resolves the blocked tool. A second call (late timer, double event) is
   * a no-op; the first result always wins.
   */
  #settlePendingChoice(result: ChoiceToolResult): void {
    const pending = this.#pendingChoice;
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.#pendingChoice = null;
    if (this.#choiceTimerHandle !== null) {
      const handle = this.#choiceTimerHandle;
      this.#choiceTimerHandle = null;
      this.#clearChoiceTimeout(handle);
    }
    pending.resolve(result);
    const c = this.#connection;
    if (c) this.#pushState(c);
  }

  /** Deadline fired: the choice simply times out. */
  #expirePendingChoice(): void {
    this.#settlePendingChoice({ status: 'timed_out' });
  }

  /**
   * Silent dispatcher for claimed `choice_response` commands. Revalidates
   * the exact payload shape, binds it to the pending request on the SAME
   * connection, settles the command row via settleChoiceResponse BEFORE
   * resolving the tool, and NEVER appends a command_result event. Any
   * mismatch, staleness or settle failure is a bounded silent code — a
   * refusal must never settle the real pending choice and a settle failure
   * must never fabricate an answer or fall through to chat reporting.
   */
  #handleChoiceResponse(
    c: BridgeConnection,
    command: { commandId: string; kind: string; payload: unknown },
  ): void {
    const failSilently = (resultCode: string) => {
      try {
        c.client.settleChoiceResponse({
          commandId: command.commandId,
          connectionId: c.connectionId,
          ok: false,
          resultCode,
        });
      } catch {
        // A lost silent settle degrades to claim-expiry on the broker side.
      }
    };

    // 1. Exact payload shape (defense-in-depth: raw rows bypass the store's
    //    enqueue validation, so execute-side revalidation is mandatory).
    const payload = command.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      failSilently('choice_invalid');
      return;
    }
    const keys = Object.keys(payload).sort();
    const requestId = payload.requestId;
    const hasIndex = keys.includes('index');
    const hasCancelled = keys.includes('cancelled');
    if (
      keys.length !== 2
      || typeof requestId !== 'string'
      || !CHOICE_REQUEST_ID_RE.test(requestId)
      || !(hasIndex || hasCancelled)
      || (hasIndex && hasCancelled)
    ) {
      failSilently('choice_invalid');
      return;
    }
    if (hasCancelled && payload.cancelled !== true) {
      failSilently('choice_invalid');
      return;
    }
    const index = hasIndex ? payload.index : undefined;
    if (hasIndex && (typeof index !== 'number' || !Number.isSafeInteger(index))) {
      failSilently('choice_invalid');
      return;
    }

    // 2. Binding: same connection, still pending, same request, not expired.
    const pending = this.#pendingChoice;
    if (
      this.#connection !== c
      || !pending
      || pending.settled
      || pending.requestId !== requestId
    ) {
      failSilently('choice_stale');
      return;
    }
    if (this.#now() > pending.expiresAt) {
      failSilently('choice_stale');
      return;
    }
    if (hasIndex && (index < 0 || index >= pending.values.length)) {
      failSilently('choice_invalid');
      return;
    }

    // 3. Settle the command row FIRST; a failed/lost settle must never
    //    fabricate an answer, so the tool stays pending in that case.
    try {
      const settled = c.client.settleChoiceResponse({
        commandId: command.commandId,
        connectionId: c.connectionId,
        ok: true,
      });
      if (!settled || settled.ok !== true) return; // silently stay pending
    } catch {
      return; // silently stay pending
    }

    // 4. Resolve the blocked tool with the EXACT local answer.
    this.#settlePendingChoice(
      hasCancelled
        ? { status: 'cancelled' }
        : { status: 'selected', index: index as number, value: pending.values[index as number] },
    );
  }

  #errorCode(error: unknown): string {
    if (error instanceof TypeError || error instanceof RangeError) return 'invalid_state';
    return 'store_error';
  }
}

/**
 * Factory for the opt-in selective TUI extension.
 *
 * @param options.stateDirectory Overrides the bridge state directory
 *   (defaults to this bridge module's <module>/.local/state for the default
 *   export; a custom directory must contain bridge.sqlite or will have it
 *   created).
 */
export function createSelectiveTuiExtension(
  options: { stateDirectory?: string } = {},
): SelectiveTuiBridgeExtension {
  const stateDirectory = options.stateDirectory ?? defaultStateDirectory();
  return new SelectiveTuiBridgeExtension(stateDirectory);
}

export default function selectiveTuiExtension(pi: ExtensionAPI): void {
  createSelectiveTuiExtension().register(pi);
}
