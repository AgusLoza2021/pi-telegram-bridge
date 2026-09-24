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
//   process, no network, no Telegram access, no tool registration: the
//   broker process is the only side that talks to Telegram.
// - G3 narrow exception: closed typed remote `git_commit_*`/`git_push_*`
//   commands run LOCAL Git through pi.exec('git', fixedOrValidatedArgs,
//   {cwd, timeout}) only — snapshot-bound, one-use, owner-approved,
//   never force, hooks honored (they may execute local programs or alter
//   the resulting commit), raw Git stderr never leaves this module.
// - Forwarded data is deliberately narrow: connection state transitions
//   (agent_start/agent_settled, ui_prompt_start/ui_prompt_end) and, on
//   assistant message_end, FINALIZED text blocks only. Thinking/reasoning
//   blocks, tool calls, tool results, context and token deltas never leave
//   the TUI (the store rejects any reasoning event kind outright).
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

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Store } from '../src/store.mjs';
import { TuiBridgeClient } from '../src/tui-bridge-client.mjs';
import { displayLabel } from '../src/beginner-copy.mjs';

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

// Heartbeat well inside the store's 30s default staleness window; the poll
// interval keeps remote commands feeling responsive without busy-looping.
const HEARTBEAT_INTERVAL_MS = 10_000;
const POLL_INTERVAL_MS = 500;

// Rejected prompt-like text: leading whitespace then a slash. This covers
// extension commands, skills and prompt templates alike.
const SLASH_PREFIX_RE = /^\s*\//;

// --- G3: remote Git commit/push (snapshot-bound, fail closed) ---------------
//
// Boundaries (owner-approved): commits include ONLY what is already
// staged (no `git add`, no `-a`); the message is FIXED; local Git hooks
// are honored (they may execute local programs or alter the resulting
// commit); pushes target ONLY the current branch's configured upstream
// with an explicit refspec and NEVER force. Every Git invocation goes
// through pi.exec('git', fixedOrValidatedArgs, { cwd, timeout }) — no
// command string, path, remote or refspec ever arrives from Telegram.
//
// Uncertain outcomes (timeout, kill, exec failure) are reported as
// `git_unknown`, never replayed, and never reported as definite success
// or failure: the owner must inspect the repository and reissue.
//
// Successes carry typed result codes (`git_commit_proposal_ready`,
// `git_push_proposal_ready`, `git_commit_completed`, `git_push_completed`)
// so the Telegram copy names the exact operation instead of a generic
// "command finished" line.
//
// G3 correction: a process exit of 0 is NOT trusted on its own — the
// pi.exec/child-process wrapper can map external signal termination to
// `code: 0` with `killed: false`. Every mutating invocation is followed
// by a bounded READ-ONLY verification with fixed argv, and success is
// reported only when the repository state proves the exact approved
// mutation: for a commit, HEAD is a direct child of the approved head on
// the same branch with the fixed subject; for a push, the configured
// upstream tracking ref resolves to the approved HEAD. A definite
// non-zero exit with post-check-proven absence of mutation is a definite
// failure; everything else is `git_unknown`.

/** The one automatic commit message; shown exactly on the approval card. */
const FIXED_COMMIT_MESSAGE = 'chore: update project files';

/** Bounded Git timeouts: snapshots are quick; hooks may legitimately take longer. */
const GIT_SNAPSHOT_TIMEOUT_MS = 10_000;
const GIT_MUTATING_TIMEOUT_MS = 120_000;

/** Pending proposals are short-lived: execution after this window fails closed. */
const DEFAULT_GIT_PROPOSAL_TTL_MS = 10 * 60_000;

const GIT_COMMAND_KINDS: ReadonlySet<string> = new Set([
  'git_commit_request',
  'git_push_request',
  'git_commit_execute',
  'git_push_execute',
]);

/**
 * Safe ref tokens for validated argv pieces (branch, remote, upstream).
 * Rejects option-like values, range dots, whitespace, control characters
 * and .lock suffixes so a hostile Git state can never become an argument.
 */
const GIT_REF_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function safeRefToken(raw: string): string | null {
  if (!GIT_REF_TOKEN_RE.test(raw) || raw.includes('..') || raw.endsWith('.lock')
    || raw.endsWith('/')) {
    return null;
  }
  return raw;
}

/** Git commit/object ids: SHA-1 (40) or SHA-256 (64) lowercase hex. */
function isGitSha(raw: string): boolean {
  return /^[0-9a-f]{40}$/.test(raw) || /^[0-9a-f]{64}$/.test(raw);
}

function sha256Fingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/** The exact snapshot a commit proposal is bound to. */
interface CommitSnapshot {
  operation: 'commit';
  repoRoot: string;
  branch: string;
  headSha: string;
  summary: string;
  fingerprint: string;
}

/** The exact snapshot a push proposal is bound to. */
interface PushSnapshot {
  operation: 'push';
  repoRoot: string;
  branch: string;
  headSha: string;
  remote: string;
  upstreamBranch: string;
  ahead: number;
  fingerprint: string;
}

type GitSnapshot = CommitSnapshot | PushSnapshot
  | { operation: 'commit' | 'push'; error: string };

/** One in-memory, one-use, connection-bound pending proposal. */
interface PendingGitProposal {
  operation: 'commit' | 'push';
  proposalId: string;
  createdAt: number;
  fingerprint: string;
}

type GitExecResult = { code: number; stdout: string; stderr: string; killed: boolean };
type GitRunOutcome = { ok: true; stdout: string }
  | { ok: false; definite: boolean };

function commitProposalMessage(snapshot: CommitSnapshot): string {
  return [
    FIXED_COMMIT_MESSAGE,
    '',
    `Branch: ${snapshot.branch}`,
    `Staged: ${snapshot.summary}`,
    `Fingerprint: ${snapshot.fingerprint}`,
  ].join('\n');
}

function pushProposalMessage(snapshot: PushSnapshot): string {
  return [
    `Branch: ${snapshot.branch} → ${snapshot.remote}/${snapshot.upstreamBranch}`,
    `Ahead: ${snapshot.ahead} ${snapshot.ahead === 1 ? 'commit' : 'commits'}`,
    `HEAD: ${snapshot.headSha}`,
    `Fingerprint: ${snapshot.fingerprint}`,
  ].join('\n');
}

/** Stable proposal id: opaque, hex, and never an argument to Git. */
function newProposalId(): string {
  return randomBytes(16).toString('hex');
}

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
  /** True while a Git snapshot/execution is in flight; polls never overlap it. */
  gitBusy: boolean;
  /** Bounded in-memory one-use proposal; lives and dies with this connection. */
  gitProposal: PendingGitProposal | null;
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

export class SelectiveTuiBridgeExtension {
  readonly #stateDirectory: string;
  readonly #gitProposalTtlMs: number;
  #pi: ExtensionAPI | null = null;
  #connection: BridgeConnection | null = null;
  #store: Store | null = null;
  /** Latest live session context; the ONLY context abort/status may use. */
  #latestCtx: ExtensionContext | null = null;

  constructor(
    stateDirectory: string,
    options: { gitProposalTtlMs?: number } = {},
  ) {
    this.#stateDirectory = stateDirectory;
    this.#gitProposalTtlMs = typeof options.gitProposalTtlMs === 'number'
      && Number.isFinite(options.gitProposalTtlMs) && options.gitProposalTtlMs > 0
      ? options.gitProposalTtlMs
      : DEFAULT_GIT_PROPOSAL_TTL_MS;
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
      const result = client.connect({
        piSessionId: identity.piSessionId,
        piSessionFile: identity.piSessionFile,
        cwd: identity.cwd,
        label,
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
        gitBusy: false,
        gitProposal: null,
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
        gitBusy: false,
        gitProposal: null,
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
      const result = c.client.heartbeat({
        trackingId: c.trackingId,
        connectionId: c.connectionId,
      });
      if (!result || result.ok !== true) this.#dropConnection();
    } catch {
      // Transient store errors: retry on the next tick, never crash.
    }
  }

  #pollTick(): void {
    void this.pollOnce().catch(() => {
      // A poll cycle must never crash Pi; the next tick retries.
    });
  }

  /**
   * One poll cycle: claim remote commands and handle them. Git commands
   * are handled strictly one at a time — while one is in flight no further
   * poll may claim or dispatch anything, so async polling can never
   * overlap a Git command or double-report. Public so tests and
   * diagnostics can drive a cycle deterministically.
   */
  async pollOnce(): Promise<void> {
    const c = this.#connection;
    if (!c || c.gitBusy) return;
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
      if (this.#connection !== c) return; // torn down mid-batch: stop now
      if (GIT_COMMAND_KINDS.has(command.kind)) {
        c.gitBusy = true;
        try {
          await this.#handleRemoteCommand(c, command);
        } finally {
          c.gitBusy = false;
        }
      } else {
        this.#handleRemoteCommand(c, command);
      }
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
        case 'git_commit_request':
        case 'git_push_request':
        case 'git_commit_execute':
        case 'git_push_execute':
          return this.#handleGitCommand(c, command, report);
        default:
          report(false, undefined, 'unknown_command');
      }
    } catch {
      report(false, undefined, 'internal_error');
    }
  }

  #derivedState(c: BridgeConnection): 'connected' | 'busy' | 'waiting' {
    if (c.uiPromptActive) return 'waiting';
    if (c.agentActive) return 'busy';
    return 'connected';
  }

  // --- G3: snapshot-bound Git commit/push --------------------------------

  /**
   * The single Git entry point: pi.exec('git', args, {cwd, timeout}) with
   * only fixed or locally validated argv. Nothing else may spawn.
   */
  async #runGit(
    c: BridgeConnection,
    args: string[],
    timeoutMs: number,
  ): Promise<GitRunOutcome> {
    const exec = (this.#pi as { exec?: unknown } | null)?.exec;
    if (typeof exec !== 'function') return { ok: false, definite: true };
    try {
      const raw = await (exec as (
        command: string,
        args: string[],
        options: { cwd: string; timeout: number },
      ) => Promise<unknown>)('git', args, { cwd: c.cwd as string, timeout: timeoutMs });
      const result = raw as Partial<GitExecResult> | null | undefined;
      if (!result || typeof result.stdout !== 'string') return { ok: false, definite: false };
      if (result.killed === true) return { ok: false, definite: false };
      if (typeof result.code !== 'number') return { ok: false, definite: false };
      if (result.code !== 0) return { ok: false, definite: true };
      return { ok: true, stdout: result.stdout };
    } catch {
      // An exec that never returned a result is UNCERTAIN, never a failure.
      return { ok: false, definite: false };
    }
  }

  /**
   * Bounded read-only proof that HEAD is a direct child of the approved
   * head on the same branch with the fixed subject. Fixed argv only; a
   * failing lookup means the proof FAILS (never a guess).
   */
  async #verifyCommit(c: BridgeConnection, snapshot: CommitSnapshot): Promise<boolean> {
    if (!isGitSha(snapshot.headSha)) return false;
    const parent = await this.#runGit(c, ['rev-parse', 'HEAD^'], GIT_SNAPSHOT_TIMEOUT_MS);
    if (!parent.ok || parent.stdout.trim() !== snapshot.headSha) return false;
    const branch = await this.#runGit(c, ['rev-parse', '--abbrev-ref', 'HEAD'], GIT_SNAPSHOT_TIMEOUT_MS);
    if (!branch.ok || branch.stdout.trim() !== snapshot.branch) return false;
    const subject = await this.#runGit(c, ['log', '-1', '--pretty=%s', 'HEAD'], GIT_SNAPSHOT_TIMEOUT_MS);
    if (!subject.ok || subject.stdout.trim() !== FIXED_COMMIT_MESSAGE) return false;
    return true;
  }

  /**
   * Bounded read-only proof that the configured upstream tracking ref now
   * resolves to the approved HEAD. Fixed/validated argv only.
   */
  async #verifyPush(c: BridgeConnection, snapshot: PushSnapshot): Promise<boolean> {
    const remote = safeRefToken(snapshot.remote);
    const upstream = safeRefToken(snapshot.upstreamBranch);
    if (remote === null || upstream === null || !isGitSha(snapshot.headSha)) {
      return false;
    }
    const ref = await this.#runGit(
      c,
      ['rev-parse', `refs/remotes/${remote}/${upstream}`],
      GIT_SNAPSHOT_TIMEOUT_MS,
    );
    return ref.ok && ref.stdout.trim() === snapshot.headSha;
  }

  /**
   * Read-only snapshot of the commit surface: repository root, current
   * non-detached branch, HEAD, and a deterministic capture of the FULL
   * staged index via `git ls-files --stage -z` (modes, blob object ids and
   * paths, NUL-delimited). The listing is what the fingerprint hashes: a
   * text diff cannot bind binary staged blobs (distinct binaries both
   * render "Binary files differ"), and diff output could invoke configured
   * external diff/textconv helpers — so diff calls are only for the
   * nothing-staged check and the bounded human summary, and always carry
   * --no-ext-diff --no-textconv. Fails closed on every surprise.
   */
  async #snapshotCommit(c: BridgeConnection): Promise<GitSnapshot> {
    const root = await this.#runGit(c, ['rev-parse', '--show-toplevel'], GIT_SNAPSHOT_TIMEOUT_MS);
    if (!root.ok) return { operation: 'commit', error: 'not_a_repository' };
    const repoRoot = root.stdout.trim();
    const branchRes = await this.#runGit(c, ['rev-parse', '--abbrev-ref', 'HEAD'], GIT_SNAPSHOT_TIMEOUT_MS);
    if (!branchRes.ok) return { operation: 'commit', error: 'git_unavailable' };
    const branch = branchRes.stdout.trim();
    if (branch === 'HEAD' || safeRefToken(branch) === null) {
      return { operation: 'commit', error: 'detached_head' };
    }
    const head = await this.#runGit(c, ['rev-parse', 'HEAD'], GIT_SNAPSHOT_TIMEOUT_MS);
    if (!head.ok) return { operation: 'commit', error: 'git_unavailable' };
    const headSha = head.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(headSha) && !/^[0-9a-f]{64}$/.test(headSha)) {
      return { operation: 'commit', error: 'git_unavailable' };
    }
    const listing = await this.#runGit(c, ['ls-files', '--stage', '-z'], GIT_SNAPSHOT_TIMEOUT_MS);
    if (!listing.ok) return { operation: 'commit', error: 'git_unavailable' };
    if (listing.stdout.length === 0) return { operation: 'commit', error: 'nothing_staged' };
    const patch = await this.#runGit(
      c,
      ['diff', '--cached', '--no-ext-diff', '--no-textconv'],
      GIT_SNAPSHOT_TIMEOUT_MS,
    );
    if (!patch.ok) return { operation: 'commit', error: 'git_unavailable' };
    if (patch.stdout.trim().length === 0) {
      return { operation: 'commit', error: 'nothing_staged' };
    }
    const stat = await this.#runGit(
      c,
      ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--shortstat'],
      GIT_SNAPSHOT_TIMEOUT_MS,
    );
    if (!stat.ok) return { operation: 'commit', error: 'git_unavailable' };
    const summary = stat.stdout.trim() || 'changes staged';
    // The fingerprint binds the complete captured staged-index listing —
    // blob object ids, modes and paths — NOT the text diff, so binary
    // mutations (invisible in diff output) still cause approval drift.
    const fingerprint = sha256Fingerprint(`${repoRoot}\n${branch}\n${headSha}\n${listing.stdout}`);
    return { operation: 'commit', repoRoot, branch, headSha, summary, fingerprint };
  }

  /**
   * Read-only snapshot of the push surface: repository root, current
   * non-detached branch, HEAD, and the branch's CONFIGURED upstream split
   * into a validated remote + branch pair. Fails closed on every surprise.
   */
  async #snapshotPush(c: BridgeConnection): Promise<GitSnapshot> {
    const root = await this.#runGit(c, ['rev-parse', '--show-toplevel'], GIT_SNAPSHOT_TIMEOUT_MS);
    if (!root.ok) return { operation: 'push', error: 'not_a_repository' };
    const repoRoot = root.stdout.trim();
    const branchRes = await this.#runGit(c, ['rev-parse', '--abbrev-ref', 'HEAD'], GIT_SNAPSHOT_TIMEOUT_MS);
    if (!branchRes.ok) return { operation: 'push', error: 'git_unavailable' };
    const branch = branchRes.stdout.trim();
    if (branch === 'HEAD' || safeRefToken(branch) === null) {
      return { operation: 'push', error: 'detached_head' };
    }
    const head = await this.#runGit(c, ['rev-parse', 'HEAD'], GIT_SNAPSHOT_TIMEOUT_MS);
    if (!head.ok) return { operation: 'push', error: 'git_unavailable' };
    const headSha = head.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(headSha) && !/^[0-9a-f]{64}$/.test(headSha)) {
      return { operation: 'push', error: 'git_unavailable' };
    }
    const upstreamRes = await this.#runGit(
      c,
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      GIT_SNAPSHOT_TIMEOUT_MS,
    );
    if (!upstreamRes.ok) return { operation: 'push', error: 'no_upstream' };
    const upstream = upstreamRes.stdout.trim();
    const slash = upstream.indexOf('/');
    if (slash <= 0 || safeRefToken(upstream) === null) {
      return { operation: 'push', error: 'no_upstream' };
    }
    const remote = upstream.slice(0, slash);
    const upstreamBranch = upstream.slice(slash + 1);
    if (safeRefToken(remote) === null || safeRefToken(upstreamBranch) === null) {
      return { operation: 'push', error: 'no_upstream' };
    }
    const aheadRes = await this.#runGit(c, ['rev-list', '@{u}..HEAD', '--count'], GIT_SNAPSHOT_TIMEOUT_MS);
    if (!aheadRes.ok) return { operation: 'push', error: 'git_unavailable' };
    const ahead = Number.parseInt(aheadRes.stdout.trim(), 10);
    if (!Number.isSafeInteger(ahead) || ahead < 0) {
      return { operation: 'push', error: 'git_unavailable' };
    }
    const fingerprint = sha256Fingerprint(`${repoRoot}\n${branch}\n${upstream}\n${headSha}`);
    return {
      operation: 'push', repoRoot, branch, headSha, remote, upstreamBranch, ahead, fingerprint,
    };
  }

  /**
   * The whole remote Git lifecycle. `report` (from #handleRemoteCommand)
   * guarantees EXACTLY one terminal result per claimed command on every
   * path. The proposal is consumed BEFORE anything else so an execute is
   * strictly one-use; the snapshot is re-computed and compared right
   * before any mutating call; hooks run normally (no --no-verify, no
   * hooksPath override, no -c); push argv is remote + exact refspec and
   * can never contain a force flag; raw Git stderr never leaves this
   * module — Telegram only ever sees a whitelisted result code.
   */
  async #handleGitCommand(
    c: BridgeConnection,
    command: { commandId: string; kind: string; payload: unknown },
    report: (ok: boolean, text?: string, resultCode?: string) => void,
  ): Promise<void> {
    try {
      if (!c.cwd) {
        report(false, undefined, 'no_cwd');
        return;
      }
      // Busy guard: a Git snapshot or commit during an agent turn is
      // refused before anything runs or is proposed.
      if (this.#isBusy(this.#latestCtx)) {
        report(false, undefined, 'pi_busy');
        return;
      }
      if (command.kind === 'git_commit_request' || command.kind === 'git_push_request') {
        const wantPush = command.kind === 'git_push_request';
        const snapshot = wantPush
          ? await this.#snapshotPush(c)
          : await this.#snapshotCommit(c);
        if ('error' in snapshot) {
          report(false, undefined, snapshot.error);
          return;
        }
        const proposalId = newProposalId();
        const message = wantPush
          ? pushProposalMessage(snapshot as PushSnapshot)
          : commitProposalMessage(snapshot as CommitSnapshot);
        // Bounded state: the latest proposal replaces any earlier one; it
        // lives on the connection and dies with it.
        c.gitProposal = { operation: snapshot.operation, proposalId, createdAt: Date.now(), fingerprint: snapshot.fingerprint };
        try {
          c.client.publishGitProposal({
            trackingId: c.trackingId,
            connectionId: c.connectionId,
            operation: snapshot.operation,
            proposalId,
            message,
          });
        } catch {
          c.gitProposal = null;
          report(false, undefined, 'proposal_failed');
          return;
        }
        // Typed success code: the Telegram copy is operation-specific
        // ("Commit/Push approval ready"), never a generic result line.
        report(true, undefined, wantPush ? 'git_push_proposal_ready' : 'git_commit_proposal_ready');
        return;
      }
      // --- execute phase: one-use, snapshot-revalidated ---
      const wantPush = command.kind === 'git_push_execute';
      const payload = command.payload as { proposalId?: unknown } | null;
      const proposalId = typeof payload?.proposalId === 'string' ? payload.proposalId : null;
      const proposal = c.gitProposal;
      c.gitProposal = null; // consume first: strictly one-use
      if (!proposal || proposalId === null || proposal.proposalId !== proposalId
        || proposal.operation !== (wantPush ? 'push' : 'commit')) {
        report(false, undefined, 'stale_proposal');
        return;
      }
      if (Date.now() - proposal.createdAt > this.#gitProposalTtlMs) {
        report(false, undefined, 'stale_proposal');
        return;
      }
      const fresh = wantPush ? await this.#snapshotPush(c) : await this.#snapshotCommit(c);
      if ('error' in fresh) {
        // Availability failures stay git_unavailable (state could not be
        // read; the owner should check and request again). Only a real
        // snapshot-vs-approval mismatch is drift. Failing closed either way.
        report(false, undefined, fresh.error);
        return;
      }
      if (fresh.fingerprint !== proposal.fingerprint) {
        report(false, undefined, 'git_drift');
        return;
      }
      // Push argv is tag-scope-proof: --no-follow-tags defeats a hostile
      // configured push.followTags, the explicit HEAD refspec pushes only
      // the approved branch tip, and --atomic makes the ref update
      // all-or-nothing (Git >= 2.4 client and server, the assumed contract
      // floor). Force is never used.
      const outcome = wantPush
        ? await this.#runGit(
          c,
          [
            'push', '--no-follow-tags', '--atomic', (fresh as PushSnapshot).remote,
            `HEAD:refs/heads/${(fresh as PushSnapshot).upstreamBranch}`,
          ],
          GIT_MUTATING_TIMEOUT_MS,
        )
        : await this.#runGit(c, ['commit', '-m', FIXED_COMMIT_MESSAGE], GIT_MUTATING_TIMEOUT_MS);
      const verify = () => (wantPush
        ? this.#verifyPush(c, fresh as PushSnapshot)
        : this.#verifyCommit(c, fresh as CommitSnapshot));
      if (outcome.ok) {
        // Exit 0 alone proves nothing (the wrapper may map a signal kill
        // to code 0): the repository must prove the approved mutation.
        if (await verify()) {
          report(true, undefined, wantPush ? 'git_push_completed' : 'git_commit_completed');
          return;
        }
        report(false, undefined, 'git_unknown');
        return;
      }
      if (outcome.definite) {
        // Definite non-zero exit: a failure UNLESS the post-check proves
        // the repository mutated anyway (e.g. a hook committed and then
        // something failed) — that mutation is unclassifiable.
        if (await verify()) {
          report(false, undefined, 'git_unknown');
          return;
        }
        report(false, undefined, 'git_failed');
        return;
      }
      // Killed, timed out or no result: UNCERTAIN, never replayed.
      report(false, undefined, 'git_unknown');
    } catch {
      // A catch here can follow a real mutation whose verification threw:
      // the outcome is UNCERTAIN and needs manual inspection, never a
      // definite label. git_unknown is the closed-copy contract.
      report(false, undefined, 'git_unknown');
    }
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
    this.#connection = null;
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
