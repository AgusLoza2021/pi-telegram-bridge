// PiRpcAdapter: owns the pipes to one `pi --mode rpc` child process.
//
// Invariants (T02):
// - Spawn by argv array with shell:false; the host owns the pipes.
// - Strict LF JSONL framing both ways (see rpc-framing.mjs); readline is
//   not protocol-compliant.
// - Commands are correlated by id and bounded by timeouts; a timeout
//   fails only that request.
// - Child EOF/exit fails every pending request. There is NO auto-restart
//   and NO auto-resume of approvals: a new host must be started explicitly.
// - Errors are safe: they carry a code and a bounded detail, and never
//   echo the argv or transcript content.

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomBytes } from 'node:crypto';
import { LfJsonReader, encodeRpcLine } from './rpc-framing.mjs';

const STDERR_HEAD_LIMIT = 64 * 1024;

// The bridge only ever needs this closed set; everything else is rejected
// before a byte reaches the child.
const SUPPORTED_COMMANDS = new Set([
  'prompt',
  'steer',
  'follow_up',
  'abort',
  'get_state',
  'get_last_assistant_text',
  'get_commands',
  'clear_queue',
]);

export class AdapterError extends Error {
  constructor(message, { code = 'adapter_error', detail = null } = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.detail = detail;
  }
}

export class PiRpcAdapter {
  /**
   * @param {object} options
   * @param {string[]} options.argv full argv, e.g. [nodeExec, cliPath, '--mode', 'rpc']
   * @param {string} options.cwd canonical workspace directory
   * @param {number} [options.requestTimeoutMs]
   * @param {number} [options.maxLineBytes] bound for one stdout record
   * @param {object} [options.env] extra child env (never credentials)
   */
  constructor({ argv, cwd, requestTimeoutMs = 30000, maxLineBytes = undefined, env = undefined }) {
    if (!Array.isArray(argv) || argv.length < 2 || argv.some((part) => typeof part !== 'string' || part.length === 0)) {
      throw new TypeError('argv must be a non-empty array of strings');
    }
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new TypeError('cwd must be a non-empty string');
    }
    this.#argv = argv;
    this.#cwd = cwd;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxLineBytes = maxLineBytes;
    this.#env = env;
  }

  #argv;
  #cwd;
  #requestTimeoutMs;
  #maxLineBytes;
  #env;

  /** @type {import('node:child_process').ChildProcess | null} */
  #child = null;
  #closed = true;
  #exitInfo = null;
  #decoder = new StringDecoder('utf8');
  #reader = null;
  #stderrHead = '';
  #nextId = 0;
  /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
  #pending = new Map();
  #eventHandlers = [];
  #uiHandlers = [];
  #exitWaiters = [];
  #startInFlight = null;

  start() {
    if (this.#startInFlight) return this.#startInFlight;
    this.#startInFlight = this.#spawnAndIdentify();
    return this.#startInFlight;
  }

  #spawnAndIdentify() {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.#argv[0], this.#argv.slice(1), {
          cwd: this.#cwd,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          ...(this.#env ? { env: this.#env } : {}),
        });
      } catch (error) {
        reject(new AdapterError('failed to spawn pi process', { code: 'spawn_error', detail: error.code }));
        return;
      }
      this.#child = child;
      this.#closed = false;

      child.on('error', (error) => {
        // Safe error: only the OS error code, never the argv.
        this.#failAllPending(new AdapterError('pi process error', { code: 'spawn_error', detail: error.code }));
        this.#markClosed({ code: null, signal: null, spawnError: error.code });
        reject(new AdapterError('failed to spawn pi process', { code: 'spawn_error', detail: error.code }));
      });

      this.#reader = new LfJsonReader({
        maxLineBytes: this.#maxLineBytes,
        onLine: (value) => this.#dispatchRecord(value),
        onError: () => {
          // Malformed child output is dropped and bounded; the child keeps
          // running. Raw content never flows into error messages here.
        },
      });

      child.stdout.on('data', (chunk) => {
        // Byte-level decoding: StringDecoder preserves multibyte UTF-8
        // sequences split across pipe chunk boundaries.
        this.#reader.push(this.#decoder.write(chunk));
      });
      child.stdout.on('end', () => {
        this.#reader.end();
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        if (this.#stderrHead.length < STDERR_HEAD_LIMIT) {
          this.#stderrHead += chunk.slice(0, STDERR_HEAD_LIMIT - this.#stderrHead.length);
        }
      });

      child.on('close', (code, signal) => {
        this.#failAllPending(
          new AdapterError('pi process exited', { code: 'child_exit', detail: { code, signal } }),
        );
        this.#markClosed({ code, signal });
      });

      this.send({ type: 'get_state' })
        .then((response) => {
          if (!response?.success) {
            // Startup failed: shut down OUR OWN child cleanly (never a
            // foreign PID) so nothing is left orphaned.
            this.#disposeOwnChild();
            reject(new AdapterError('get_state failed on startup', { code: 'startup_failed' }));
            return;
          }
          resolve({
            sessionId: response.data?.sessionId ?? null,
            sessionFile: response.data?.sessionFile ?? null,
            pid: child.pid,
          });
        })
        .catch((error) => {
          // Timeout or early exit during startup: kill our own child too.
          this.#disposeOwnChild();
          reject(error);
        });
    });
  }

  #markClosed(info) {
    if (this.#closed && this.#exitInfo) return;
    this.#closed = true;
    this.#exitInfo = this.#exitInfo ?? { ...info, stderrHead: this.#stderrHead };
    for (const waiter of this.#exitWaiters) waiter(this.#exitInfo);
    this.#exitWaiters = [];
  }

  /** Kill the child WE spawned; never touches any foreign PID. */
  #disposeOwnChild({ timeoutMs = 2000 } = {}) {
    const child = this.#child;
    if (!child || this.#closed) return;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.once('close', () => clearTimeout(timer));
  }

  #failAllPending(error) {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  #dispatchRecord(record) {
    if (!record || typeof record !== 'object') return;
    if (record.type === 'response') {
      const id = typeof record.id === 'string' ? record.id : null;
      if (id !== null && this.#pending.has(id)) {
        const entry = this.#pending.get(id);
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        entry.resolve(record);
      }
      return;
    }
    if (record.type === 'extension_ui_request') {
      for (const handler of this.#uiHandlers) handler(record);
      return;
    }
    for (const handler of this.#eventHandlers) handler(record);
  }

  isRunning() {
    return !this.#closed;
  }

  /** Identity probe: child pid + the session identity pi reports. */
  async getState() {
    const response = await this.send({ type: 'get_state' });
    if (!response?.success) {
      throw new AdapterError('get_state failed', { code: 'get_state_failed' });
    }
    return {
      sessionId: response.data?.sessionId ?? null,
      sessionFile: response.data?.sessionFile ?? null,
      pid: this.#child?.pid ?? null,
    };
  }

  waitForExit() {
    if (this.#exitInfo) return Promise.resolve(this.#exitInfo);
    return new Promise((resolve) => this.#exitWaiters.push(resolve));
  }

  /**
   * Send one supported command; resolves with the correlated response.
   * Rejects on unsupported types (before writing), timeout, or child exit.
   */
  send(command, { timeoutMs = undefined } = {}) {
    if (!command || typeof command !== 'object' || typeof command.type !== 'string') {
      return Promise.reject(new AdapterError('command must be an object with a type', { code: 'bad_command' }));
    }
    if (!SUPPORTED_COMMANDS.has(command.type)) {
      return Promise.reject(new AdapterError(`unsupported command type: ${command.type}`, { code: 'unsupported_command' }));
    }
    if (this.#closed || !this.#child?.stdin?.writable) {
      return Promise.reject(new AdapterError('adapter is closed', { code: 'closed' }));
    }
    const id = `rpc-${++this.#nextId}-${randomBytes(4).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AdapterError('request timed out', { code: 'timeout', detail: { commandType: command.type } }));
      }, timeoutMs ?? this.#requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(encodeRpcLine({ id, ...command }) + '\n');
    });
  }

  /**
   * Answer one extension UI dialog. `response` is one of:
   * { value }, { confirmed }, { cancelled: true }.
   */
  respondUi(id, response) {
    if (this.#closed || !this.#child?.stdin?.writable) {
      throw new AdapterError('adapter is closed', { code: 'closed' });
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw new AdapterError('ui id must be a non-empty string', { code: 'bad_command' });
    }
    if (!response || typeof response !== 'object') {
      throw new AdapterError('ui response must be an object', { code: 'bad_command' });
    }
    const payload = { type: 'extension_ui_response', id };
    if (response.cancelled === true) payload.cancelled = true;
    else if (typeof response.confirmed === 'boolean') payload.confirmed = response.confirmed;
    else if ('value' in response) payload.value = response.value;
    else throw new AdapterError('ui response needs value, confirmed or cancelled', { code: 'bad_command' });
    this.#child.stdin.write(encodeRpcLine(payload) + '\n');
  }

  onEvent(handler) {
    this.#eventHandlers.push(handler);
  }

  onUiRequest(handler) {
    this.#uiHandlers.push(handler);
  }

  /** Bounded head of stderr, for diagnostics at the host level. */
  getStderrHead() {
    return this.#stderrHead;
  }

  /** Terminate the child; never throws when already closed. */
  async dispose({ timeoutMs = 5000 } = {}) {
    if (this.#closed) return;
    const child = this.#child;
    child.kill();
    const exited = await Promise.race([
      this.waitForExit(),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      await this.waitForExit();
    }
  }
}

// --- Production launch factory (H1) -------------------------------------

// Environment whitelist for the spawned pi child: the bridge host may hold
// Telegram/LLM/cloud credentials in its own environment; the pi child never
// needs them (it uses the user's configured model auth), so EVERYTHING
// outside this list is stripped.
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'COMPUTERNAME',
  'USERNAME',
];

/**
 * Build the fixed, restrictive launch configuration for one pi RPC child.
 * Flags are pi 0.85.1 CLI options (see pi docs usage.md): extension
 * discovery, skills, prompt templates and context files are disabled; the
 * tool allowlist exposes only what the bridge policy expects; project-local
 * trust prompts are bypassed with --no-approve. argv stays a plain array
 * (spawn never sees a shell). Returns { argv, cwd, env }.
 */
export function buildProductionLaunch({
  sessionId,
  nodePath = process.execPath,
  cliPath,
  workspaceRoot,
  extensionPath,
  sessionDir,
  env = process.env,
}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('sessionId must be a non-empty string');
  }
  for (const [name, value] of [['cliPath', cliPath], ['workspaceRoot', workspaceRoot], ['extensionPath', extensionPath], ['sessionDir', sessionDir]]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`${name} must be a non-empty string`);
    }
  }
  const childEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  // Belt and suspenders with --offline: PI_OFFLINE=1 is the documented env
  // equivalent and is SET here (not inherited), so the scrub can never
  // remove it.
  childEnv.PI_OFFLINE = '1';
  return {
    argv: [
      nodePath,
      cliPath,
      '--mode', 'rpc',
      // Verified against the installed pi CLI --help (0.85.1): disables all
      // startup network operations. The zero-LLM smoke/managed profile must
      // never touch the network at startup.
      '--offline',
      '--no-extensions',
      '-e', extensionPath,
      '--tools', 'read,write,edit,bridge_decision',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-approve',
      '--session-dir', sessionDir,
      '--name', sessionId,
    ],
    cwd: workspaceRoot,
    env: childEnv,
  };
}
