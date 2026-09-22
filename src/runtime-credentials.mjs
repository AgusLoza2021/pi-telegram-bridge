// T04: credential reveal for worker spawn.
//
// The host process reveals the Telegram credentials exactly once per
// worker spawn, strictly through the DPAPI helper chain, and writes the
// plaintext ONLY to the child's stdin pipe. The plaintext never touches
// argv, environment variables, log files, the terminal, or any file.

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export class CredentialRevealError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CredentialRevealError';
    this.code = code;
  }
}

/**
 * Reveal the credential payload from the DPAPI blob by running the
 * project's own dpapi-credentials CLI (which enforces the redirected-
 * stdout-only rule via the PowerShell DPAPI helper). Resolves with the
 * parsed credentials object; rejects with a fixed code otherwise.
 *
 * @param {object} options
 * @param {string} options.moduleRoot absolute path of the module root
 * @param {string} options.stateRoot validated state root
 * @returns {Promise<{botToken: string, allowedUserId: string, allowedChatId: string}>}
 */
export function revealCredentialsForSpawn({ moduleRoot, stateRoot }) {
  const cli = join(moduleRoot, 'src', 'dpapi-credentials.mjs');
  const blobPath = join(stateRoot, 'credentials.bin');
  const backupDir = join(stateRoot, 'backups');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [
      cli, 'reveal', '--blob', blobPath, '--backup-dir', backupDir,
    ], {
      cwd: moduleRoot,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 64 * 1024,
      // stdout is a pipe here: exactly the redirected-stdout channel the
      // helper requires; stderr stays captured and is never echoed raw.
      encoding: 'utf8',
    }, (error, stdout) => {
      if (error) {
        reject(new CredentialRevealError('dpapi_failed', 'credential reveal failed'));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed
          && typeof parsed.botToken === 'string' && parsed.botToken.length > 0
          && typeof parsed.allowedUserId === 'string' && /^\d+$/.test(parsed.allowedUserId)
          && typeof parsed.allowedChatId === 'string' && /^-?\d+$/.test(parsed.allowedChatId)) {
          resolve(parsed);
        } else {
          reject(new CredentialRevealError('invalid_payload', 'credential payload rejected'));
        }
      } catch {
        reject(new CredentialRevealError('invalid_payload', 'credential payload unreadable'));
      }
    });
  });
}
