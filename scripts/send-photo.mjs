// Send ONE photo to the enrolled allowed chat (additive slice).
//
// Usage:
//   node scripts/send-photo.mjs <filePath> [--caption <text>] [--root <dir>] [--dry-run]
//   node scripts/send-photo.mjs --help
//
// Hard rules:
// - The chat id is NEVER accepted on the command line. A real send always
//   targets the enrolled allowed chat, revealed only through the project's
//   sanctioned credential module (src/runtime-credentials.mjs
//   revealCredentialsForSpawn, which reads the DPAPI blob). The token is
//   never printed, logged or embedded in any error output.
// - --dry-run validates the file and builds the exact multipart body
//   (same builder the real send uses) but performs NO network call and
//   reveals NO credentials: the chat id slot carries a fixed placeholder,
//   because a dry run must stay credential-free by construction.
// - Output is exactly one final line: `SENT` (or `DRY-RUN OK`) on success,
//   `FAILED: <code>` otherwise, with exit 0 / non-zero. No stack traces,
//   no token, no URL, no file path ever reach the output.
// - --help / -h prints the usage and exits 0, and deliberately does NOT
//   validate the rest of the command line: asking how a tool works must
//   never fail because an unrelated argument was missing or wrong.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import { validateOutboundPhoto, MediaPolicyError, MAX_PHOTO_BYTES, PHOTO_EXTENSIONS } from '../src/media-policy.mjs';
import { TelegramApi, TelegramApiError } from '../src/telegram-api.mjs';
import { revealCredentialsForSpawn, CredentialRevealError } from '../src/runtime-credentials.mjs';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_STATE_ROOT = join(MODULE_ROOT, '.local', 'state');

/**
 * Usage text. Every limit quoted here is read from the policy module that
 * actually enforces it, so the help cannot drift away from the checks.
 */
export const USAGE = [
  'Send one photo to the enrolled allowed chat.',
  '',
  'Usage:',
  '  node scripts/send-photo.mjs <filePath> [options]',
  '  node scripts/send-photo.mjs --help',
  '',
  'Options:',
  '  --caption <text>   Caption sent with the photo (plain text: no formatting,\n                     no parse_mode, ever).',
  '  --root <dir>       Directory the photo must resolve inside. Default: the\n                     current working directory. Symlink and junction escapes\n                     are refused after resolution, not before.',
  '  --dry-run          Validate the file and build the exact multipart body\n                     the real send uses, but send nothing and reveal no\n                     credentials.',
  '  -h, --help         Show this help and exit.',
  '',
  'Enforced before any request is made:',
  `  - allowed extensions: ${PHOTO_EXTENSIONS.join(' ')}`,
  `  - maximum size: ${MAX_PHOTO_BYTES / (1024 * 1024)} MB`,
  '  - the file must exist and be a regular file',
  '',
  'The chat id is never accepted on the command line. A real send always\ntargets the enrolled allowed chat, revealed through src/runtime-credentials.mjs.\nThe token is never printed, logged or embedded in any error output.',
  '',
  'Output is exactly one final line: `SENT`, `DRY-RUN OK`, or `FAILED: <code>`.',
].join('\n');

/**
 * Parse the CLI arguments. Refuses every unknown flag, so an arbitrary
 * --chat-id (or any other bypass attempt) fails closed as bad_usage.
 * @param {string[]} argv
 * @returns {{filePath: string|null, caption: string|null, root: string|null, dryRun: boolean, help: boolean}}
 */
export function parseArgs(argv) {
  const out = { filePath: null, caption: null, root: null, dryRun: false, help: false };
  // --help wins over every other token, malformed ones included: a usage
  // request must never be defeated by the rest of the command line. It is
  // scanned for before anything else is parsed, and it reads nothing, reveals
  // nothing and sends nothing, so it cannot be used to bypass a check.
  if (argv.includes('--help') || argv.includes('-h')) {
    out.help = true;
    return out;
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--caption') {
      if (i + 1 >= argv.length) throw Object.assign(new Error('bad usage'), { code: 'bad_usage' });
      out.caption = argv[++i];
    } else if (arg === '--root') {
      if (i + 1 >= argv.length) throw Object.assign(new Error('bad usage'), { code: 'bad_usage' });
      out.root = argv[++i];
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg.startsWith('--') || arg.startsWith('-')) {
      // Includes --chat-id and every other flag this slice must refuse.
      throw Object.assign(new Error('bad usage'), { code: 'bad_usage' });
    } else if (out.filePath === null) {
      out.filePath = arg;
    } else {
      throw Object.assign(new Error('bad usage'), { code: 'bad_usage' });
    }
  }
  if (out.filePath === null) throw Object.assign(new Error('bad usage'), { code: 'bad_usage' });
  return out;
}

/**
 * CLI main. Returns the process exit code; never throws.
 * @param {string[]} argv
 * @param {object} [deps] injection seams (tests): stdout, stderr,
 *   fetchImpl, revealCredentials, stateRoot
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const write = (line) => stdout.write(`${line}\n`);

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    write(`FAILED: ${error.code ?? 'bad_usage'}`);
    return 2;
  }

  if (args.help) {
    write(USAGE);
    return 0;
  }

  try {
    const photo = validateOutboundPhoto({ filePath: args.filePath, root: args.root ?? undefined });

    if (args.dryRun) {
      // Exact same multipart builder as a real send; only the chat id is
      // a fixed placeholder because a dry run reveals no credentials and
      // performs no network call.
      const form = TelegramApi.buildPhotoForm({
        chatId: 'DRY-RUN',
        bytes: photo.bytes,
        filename: photo.filename,
        caption: args.caption,
      });
      if (!(form instanceof FormData) || form.get('chat_id') === undefined) {
        throw Object.assign(new Error('dry run wiring broken'), { code: 'dry_run_broken' });
      }
      write('DRY-RUN OK');
      return 0;
    }

    // Real send: credentials come ONLY from the sanctioned reveal module,
    // which returns the enrolled allowed chat id. No chat id is ever read
    // from argv.
    const reveal = deps.revealCredentials ?? (({ stateRoot }) =>
      revealCredentialsForSpawn({ moduleRoot: MODULE_ROOT, stateRoot }));
    const credentials = await reveal({ stateRoot: deps.stateRoot ?? DEFAULT_STATE_ROOT });

    const api = new TelegramApi({
      botToken: credentials.botToken,
      fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    });
    try {
      await api.sendPhoto({
        chatId: credentials.allowedChatId,
        filePath: photo.realPath,
        caption: args.caption,
      });
    } finally {
      await api.close();
    }
    write('SENT');
    return 0;
  } catch (error) {
    const typed = error instanceof TelegramApiError
      || error instanceof MediaPolicyError
      || error instanceof CredentialRevealError;
    const code = typed && typeof error.code === 'string' && error.code.length > 0
      ? error.code
      : 'send_failed';
    write(`FAILED: ${code}`);
    return 1;
  }
}

// Module entry: only when executed directly (never on import).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
