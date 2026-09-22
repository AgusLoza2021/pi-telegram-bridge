// DPAPI-protected credential blob (T04).
//
// The blob is the ONLY credential persistence in this module: bot token and
// both numeric Telegram ids, encrypted with Windows DPAPI (CurrentUser
// scope) through a PowerShell 5.1 helper. There are no .env files here by
// explicit owner decision.
//
// Plaintext crosses process boundaries exclusively through anonymous pipes:
//   - protect: plaintext JSON on the helper's STDIN (captured pipe).
//   - reveal : plaintext JSON on the helper's STDOUT, only when that stdout
//     is a redirected pipe and the caller passed the explicit pipe mode.
// Plaintext is never on argv, in the environment, in logs, in errors, or on
// a terminal. Errors carry fixed codes only.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireStateRootForBlob } from './state-acl.mjs';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DPAPI_HELPER_PATH = join(MODULE_ROOT, 'scripts', 'dpapi-helper.ps1');

export class CredentialStoreError extends Error {
  constructor(code) {
    super(`credential operation failed: ${code}`);
    this.name = 'CredentialStoreError';
    this.code = code;
  }
}

const BLOB_VERSION = 1;
const ALLOWED_KEYS = Object.freeze(['botToken', 'allowedUserId', 'allowedChatId']);

// Same shapes config.mjs enforces at runtime.
const BOT_TOKEN_PATTERN = /^[0-9]{8,10}:[A-Za-z0-9_-]{30,}$/;
const USER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const CHAT_ID_PATTERN = /^-?[1-9][0-9]{0,19}$/;

export function validateCredentials(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CredentialStoreError('invalid_payload');
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.includes(key)) throw new CredentialStoreError('invalid_payload');
  }
  for (const key of ALLOWED_KEYS) {
    if (typeof raw[key] !== 'string' || raw[key].length === 0) {
      throw new CredentialStoreError('invalid_payload');
    }
  }
  if (raw.botToken.length > 256 || /\s/.test(raw.botToken) || !BOT_TOKEN_PATTERN.test(raw.botToken)) {
    throw new CredentialStoreError('invalid_payload');
  }
  if (!USER_ID_PATTERN.test(raw.allowedUserId) || !CHAT_ID_PATTERN.test(raw.allowedChatId)) {
    throw new CredentialStoreError('invalid_payload');
  }
  return { botToken: raw.botToken, allowedUserId: raw.allowedUserId, allowedChatId: raw.allowedChatId };
}

function defaultTimestampName(now) {
  const d = new Date(now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${d.getMilliseconds().toString().padStart(3, '0')}`;
}

/**
 * Real DPAPI runner: drives scripts/dpapi-helper.ps1 through PowerShell 5.1.
 * Plaintext only ever travels on the child's stdin (protect) or a captured
 * stdout pipe (reveal). Child stderr carries fixed ERR:<code> tokens only.
 */
function createPowerShellRunner({ powershellPath = 'powershell.exe', blobPath } = {}) {
  function runHelper({ mode, blobPath, input }) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        powershellPath,
        [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', DPAPI_HELPER_PATH,
          '-Mode', mode,
          ...(blobPath === undefined ? [] : ['-BlobPath', blobPath]),
          '-ExpectPipe', 'pipe',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      const stdoutChunks = [];
      let stderrText = '';
      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });
      child.on('error', () => reject(new CredentialStoreError('dpapi_unavailable')));
      child.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(stdoutChunks));
          return;
        }
        const match = /ERR:([a-z_]+)/.exec(stderrText);
        reject(new CredentialStoreError(match ? match[1] : 'dpapi_failed'));
      });
      if (input !== undefined) {
        child.stdin.on('error', () => { /* exit path rejects with a fixed code */ });
        child.stdin.end(input);
      }
    });
  }
  return {
    async protect(plaintext) {
      // No blob path on protect: the helper only streams ciphertext to
      // stdout; this module owns the file.
      return runHelper({ mode: 'protect', input: Buffer.from(plaintext, 'utf8') });
    },
    async unprotect(encoded) {
      return runHelper({ mode: 'reveal', blobPath });
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.blobPath destination blob file (base64 ciphertext)
 * @param {string} options.backupDir dated backups of previous blobs
 * @param {object} [options.runner] injectable DPAPI runner (tests)
 * @param {({ blobPath: string }) => Promise<object>} [options.rootVerifier]
 *   injectable live root gate (internal TEST seam only, mirroring the
 *   runner seam). The default is the real requireStateRootForBlob; the
 *   CLI never injects anything, so there is no CLI bypass and no
 *   production way to skip verification.
 * @param {() => number} [options.now]
 * @param {boolean} [options.stdoutIsTty] guard input for the CLI reveal path
 */
export function createCredentialStore({
  blobPath,
  backupDir,
  runner,
  rootVerifier,
  now = Date.now,
  stdoutIsTty = false,
}) {
  for (const [name, value] of [['blobPath', blobPath], ['backupDir', backupDir]]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`${name} must be a non-empty string`);
    }
  }
  const effectiveRunner = runner ?? createPowerShellRunner({ blobPath });
  const effectiveRootVerifier = rootVerifier ?? requireStateRootForBlob;

  // T04r: the standalone entry points (CLI protect/reveal included) may
  // only operate on a validated state root — one whose ACL was locked by
  // the setup/locking step, whose capability marker names the CURRENT
  // user, and whose real ACL freshly verifies. This is the anti-bypass
  // gate: a direct CLI call on an arbitrary directory is refused before
  // anything is read or written.
  async function requireValidatedRoot() {
    await effectiveRootVerifier({ blobPath });
  }

  async function protect(credentials) {
    // Live gate FIRST: no payload validation, backup or byte is touched
    // until the root, its marker SID and the real ACL verify.
    await requireValidatedRoot();
    const validated = validateCredentials(credentials);
    const payload = JSON.stringify({ version: BLOB_VERSION, ...validated });
    let encrypted;
    try {
      encrypted = await effectiveRunner.protect(payload);
    } catch (error) {
      // Runner errors are already fixed-code CredentialStoreErrors; anything
      // else is normalized so raw failure text never escapes.
      if (error instanceof CredentialStoreError) throw error;
      throw new CredentialStoreError('dpapi_failed');
    }
    if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
    // Dated backup of the previous blob BEFORE any update; the backup lives
    // under the restricted-ACL state area and inherits that protection.
    if (existsSync(blobPath)) {
      const backupPath = join(backupDir, `credentials-${defaultTimestampName(now)}.blob`);
      writeFileSync(backupPath, readFileSync(blobPath));
    }
    if (!existsSync(dirname(blobPath))) mkdirSync(dirname(blobPath), { recursive: true });
    const tmpPath = `${blobPath}.tmp-${defaultTimestampName(now)}`;
    writeFileSync(tmpPath, encrypted.toString('utf8'));
    renameSync(tmpPath, blobPath);
    return { ok: true };
  }

  async function reveal() {
    // Same live gate as protect, before the blob is even opened.
    await requireValidatedRoot();
    let encoded;
    try {
      encoded = readFileSync(blobPath, 'utf8').trim();
    } catch {
      throw new CredentialStoreError('blob_missing');
    }
    let plaintext;
    try {
      const out = await effectiveRunner.unprotect(encoded);
      plaintext = Buffer.from(out).toString('utf8');
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      throw new CredentialStoreError('dpapi_failed');
    }
    let parsed;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new CredentialStoreError('dpapi_failed');
    }
    if (parsed?.version !== BLOB_VERSION) throw new CredentialStoreError('dpapi_failed');
    return {
      ok: true,
      credentials: validateCredentials({
        botToken: parsed.botToken,
        allowedUserId: parsed.allowedUserId,
        allowedChatId: parsed.allowedChatId,
      }),
    };
  }

  return { protect, reveal };
}

/**
 * CLI guard: plaintext must never be written to an interactive terminal.
 * The reveal subcommand calls this BEFORE producing any output.
 */
export function assertTtyGuard(stdoutIsTty) {
  if (stdoutIsTty === true) {
    throw new CredentialStoreError('tty_stdout_refused');
  }
}

// CLI entry: node src/dpapi-credentials.mjs <protect|reveal> --blob <path> --backup-dir <dir>
export async function main(argv = process.argv.slice(2), io = { stdoutIsTty: process.stdout.isTTY === true }) {
  const [command] = argv;
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const blobPath = flag('blob');
  if ((command !== 'protect' && command !== 'reveal') || typeof blobPath !== 'string') {
    process.exitCode = 2;
    return;
  }
  const store = createCredentialStore({
    blobPath,
    backupDir: flag('backup-dir') ?? dirname(blobPath),
    stdoutIsTty: io.stdoutIsTty,
  });
  try {
    if (command === 'protect') {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      await store.protect(credentials);
      return;
    }
    // reveal: explicit pipe expectation + redirected stdout guard.
    assertTtyGuard(io.stdoutIsTty);
    if (typeof process.stdout.fd !== 'number' || process.stdout.isTTY === true) {
      throw new CredentialStoreError('tty_stdout_refused');
    }
    const { credentials } = await store.reveal();
    process.stdout.write(JSON.stringify(credentials));
  } catch (error) {
    // Fixed code only: no paths, no content, no stacks.
    process.stderr.write(`ERR:${error instanceof CredentialStoreError ? error.code : 'dpapi_failed'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('dpapi-credentials.mjs')) {
  await main();
}
