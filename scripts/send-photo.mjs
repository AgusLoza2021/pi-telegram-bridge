// Send ONE photo to the enrolled allowed chat (additive slice).
//
// Usage:
//   node scripts/send-photo.mjs <filePath> [--caption <text>] [--root <dir>] [--dry-run]
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

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import { validateOutboundPhoto, MediaPolicyError } from '../src/media-policy.mjs';
import { TelegramApi, TelegramApiError } from '../src/telegram-api.mjs';
import { revealCredentialsForSpawn, CredentialRevealError } from '../src/runtime-credentials.mjs';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_STATE_ROOT = join(MODULE_ROOT, '.local', 'state');

/**
 * Parse the CLI arguments. Refuses every unknown flag, so an arbitrary
 * --chat-id (or any other bypass attempt) fails closed as bad_usage.
 * @param {string[]} argv
 * @returns {{filePath: string, caption: string|null, root: string|null, dryRun: boolean}}
 */
export function parseArgs(argv) {
  const out = { filePath: null, caption: null, root: null, dryRun: false };
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
