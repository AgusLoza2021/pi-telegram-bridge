// T04: enrollment helpers — owner-run setup only.
//
// These functions exist so the interactive setup (scripts/setup.ps1) can
// (a) verify a candidate bot and refuse to touch one that already has a
// webhook configured, and (b) find the operator's own user id by waiting
// for the operator to send an exact pairing nonce from a PRIVATE chat.
// The first sender is never trusted: a wrong nonce yields nothing, and
// group-chat messages are ignored even when the text matches exactly.
//
// These helpers are interactive setup tooling. They are never called by
// the runtime and are not used by tests against the real network.

import { TelegramApi, TelegramApiError } from './telegram-api.mjs';
import { isValidBotUsername, isValidNonce } from './qr-render.mjs';

const PRIVATE = 'private';

function quietApi(token, fetchImpl, sleep) {
  return new TelegramApi({
    botToken: token,
    fetchImpl,
    maxRetries: 0,
    baseDelayMs: 0,
    maxDelayMs: 0,
    jitterRatio: 0,
    sleep: sleep ?? (async () => {}),
  });
}

/**
 * Verify the bot identity and refuse takeover of an existing webhook.
 * Returns {ok:true, username} with the VALIDATED bot username from getMe
 * (required by the QR pairing flow), or {ok:false, code} with code in
 * 'webhook_present' | 'unauthorized' | 'forbidden' | 'bad_response' |
 * 'network'. Errors never echo the token or network details.
 */
export async function checkBot({ token, fetchImpl, maxAttempts = 1, sleep }) {
  const api = quietApi(token, fetchImpl, sleep);
  try {
    const me = await api.getMe();
    if (!me || typeof me !== 'object' || me.is_bot !== true) {
      return { ok: false, code: 'bad_response' };
    }
    // The username must itself pass the strict bot-username rules: the QR
    // deep link is built from exactly this value later on.
    if (!isValidBotUsername(me.username)) {
      return { ok: false, code: 'bad_response' };
    }
    const info = await api.getWebhookInfo();
    if (info && typeof info === 'object' && typeof info.url === 'string' && info.url.length > 0) {
      // Never delete a webhook we did not create.
      return { ok: false, code: 'webhook_present' };
    }
    return { ok: true, username: me.username };
  } catch (error) {
    return { ok: false, code: mapEnrollError(error) };
  }
}

/**
 * Wait for the operator to send the exact nonce from a private chat and
 * return the candidate user ids (sorted, deduplicated). A message that
 * does not match the nonce exactly never yields a candidate, and group
 * chats are ignored entirely. The candidates are a SUGGESTION for the
 * local operator to confirm interactively — nothing is written anywhere.
 *
 * Returns {ok:true, candidates: string[]} or
 * {ok:false, code:'pairing_timeout'|'unauthorized'|'forbidden'|'network'}.
 */
export async function findPairingCandidates({
  token,
  nonce,
  fetchImpl,
  durationMs = 90_000,
  pollGapMs = 1500,
  now = Date.now,
  sleep,
}) {
  if (typeof nonce !== 'string' || nonce.trim().length === 0) {
    return { ok: false, code: 'network' };
  }
  const api = quietApi(token, fetchImpl, sleep);
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + durationMs;
  const candidates = new Set();
  let offset = 0;
  for (;;) {
    try {
      const updates = await api.getUpdates({ offset });
      if (Array.isArray(updates)) {
        for (const update of updates) {
          if (update && typeof update === 'object' && Number.isSafeInteger(update.update_id)) {
            offset = Math.max(offset, update.update_id + 1);
          }
          const message = update && typeof update === 'object' ? update.message : null;
          if (!message || typeof message !== 'object') continue;
          // Private chat only: a nonce pasted into a group must not enroll.
          if (!message.chat || message.chat.type !== PRIVATE) continue;
          if (typeof message.text !== 'string' || message.text.trim() !== nonce) continue;
          const id = message.from && typeof message.from === 'object' ? message.from.id : null;
          if (Number.isSafeInteger(id) && id > 0) candidates.add(String(id));
        }
      }
    } catch (error) {
      if (error instanceof TelegramApiError
        && (error.code === 'unauthorized' || error.code === 'forbidden')) {
        return { ok: false, code: error.code };
      }
      // Network-class failures: keep polling until the deadline (the
      // operator may be offline for a moment); they are never fatal here.
    }
    if (candidates.size > 0) {
      return { ok: true, candidates: [...candidates].sort() };
    }
    if (now() >= deadline) {
      return { ok: false, code: 'pairing_timeout' };
    }
    await wait(pollGapMs);
  }
}

function mapEnrollError(error) {
  if (error instanceof TelegramApiError) {
    if (error.code === 'unauthorized' || error.code === 'forbidden') return error.code;
  }
  return 'network';
}

/**
 * T09 dedicated pairing: wait for the operator to send EXACTLY
 * `/start <nonce>` from a PRIVATE chat and return the single derived
 * {userId, chatId} pair taken from that same update.
 *
 * Fail-closed rules:
 * - The nonce must be a valid 32-hex/128-bit value (nothing else is ever
 *   accepted, so no malformed input can reach the network loop).
 * - The message text must match `/start <nonce>` exactly (after trim);
 *   a wrong or plain nonce never yields a pair, and group/other chats
 *   are ignored even when the text matches.
 * - user/chat ids must be safe positive integers; anything else is
 *   refused, not coerced.
 * - Duplicate redelivery of the same update (same update_id) is
 *   deduplicated; repeated matches from the SAME user+chat collapse to
 *   one pair, while matches from DIFFERENT senders fail closed with
 *   'pairing_conflict' (the first sender is never trusted).
 * - 401/403 fail immediately ('unauthorized'/'forbidden'); network-class
 *   failures keep polling until the deadline and surface as 'network'
 *   at timeout (so they are never mistaken for a clean timeout); an
 *   otherwise silent deadline yields 'pairing_timeout'.
 *
 * Never writes anything anywhere; the result is a suggestion the local
 * operator sees on their own console before any commit.
 */
export async function pairViaPrivateStart({
  token,
  nonce,
  fetchImpl,
  durationMs = 60_000,
  pollGapMs = 1500,
  now = Date.now,
  sleep,
}) {
  if (!isValidNonce(nonce)) {
    return { ok: false, code: 'bad_nonce' };
  }
  const expectedText = `/start ${nonce}`;
  const api = quietApi(token, fetchImpl, sleep);
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + durationMs;
  const seenUpdateIds = new Set();
  const matches = new Map();
  let hadNetworkError = false;
  // Offset stays 0 on purpose: pairing runs BEFORE any credentials are
  // enrolled, so there is no durable offset to advance. Redelivered
  // updates are deduplicated through seenUpdateIds instead.
  for (;;) {
    try {
      const updates = await api.getUpdates({ offset: 0 });
      hadNetworkError = false;
      if (Array.isArray(updates)) {
        for (const update of updates) {
          if (!update || typeof update !== 'object' || !Number.isSafeInteger(update.update_id)) continue;
          if (seenUpdateIds.has(update.update_id)) continue;
          seenUpdateIds.add(update.update_id);
          const message = update.message;
          if (!message || typeof message !== 'object') continue;
          // Private chat only: a nonce sent to a group must not enroll.
          if (!message.chat || message.chat.type !== PRIVATE) continue;
          if (typeof message.text !== 'string' || message.text.trim() !== expectedText) continue;
          const userId = message.from && typeof message.from === 'object' ? message.from.id : null;
          const chatId = message.chat.id;
          // Safe-integer checks: refuse unsafe, negative or fractional ids.
          if (!Number.isSafeInteger(userId) || userId <= 0) continue;
          if (!Number.isSafeInteger(chatId) || chatId <= 0) continue;
          matches.set(`${userId}:${chatId}`, { userId, chatId });
        }
      }
    } catch (error) {
      if (error instanceof TelegramApiError
        && (error.code === 'unauthorized' || error.code === 'forbidden')) {
        return { ok: false, code: error.code };
      }
      // Network-class failures: keep polling until the deadline, then
      // report them as their own fail-closed code below.
      hadNetworkError = true;
    }
    if (matches.size === 1) {
      const [only] = matches.values();
      return { ok: true, userId: only.userId, chatId: only.chatId };
    }
    if (matches.size > 1) {
      // Two different senders/chats matched the same nonce: fail closed.
      return { ok: false, code: 'pairing_conflict' };
    }
    if (now() >= deadline) {
      return { ok: false, code: hadNetworkError ? 'network' : 'pairing_timeout' };
    }
    await wait(pollGapMs);
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoints used by scripts/setup.ps1 (owner-run interactive setup).
// The bot token always arrives on stdin (a pipe from the DPAPI helper or
// a console read), never on argv and never in the environment.
//   node src/enroll.mjs check-bot            (token on stdin)
//   node src/enroll.mjs pair --nonce <text> [--duration-ms <ms>]   (token on stdin)
//   node src/enroll.mjs pair-start --nonce <32hex> [--duration-ms <ms>]  (token on stdin)
//
// Output shapes (bounded, one line, parseable by setup.ps1; the token and
// raw updates are NEVER printed):
//   check-bot   -> OK:<username>        | ERR:<code>
//   pair        -> CANDIDATES:<ids>     | ERR:<code>     (legacy flow)
//   pair-start  -> PAIRED:<userId>:<chatId> | ERR:<code>

function flag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readTokenLine(io) {
  return new Promise((resolve, reject) => {
    let raw = '';
    io.stdin.setEncoding('utf8');
    io.stdin.on('data', (chunk) => { raw += chunk; });
    io.stdin.on('end', () => resolve(raw.split(/\r?\n/, 1)[0].trim()));
    io.stdin.on('error', () => reject(new Error('stdin')));
  });
}

/** Exit codes: 0 ok, 1 refused (ERR:<code> on stdout for PS to capture). */
export async function main(argv = process.argv.slice(2), io = process) {
  const [command] = argv;
  if (command !== 'check-bot' && command !== 'pair' && command !== 'pair-start') {
    io.stdout.write('ERR:bad_usage\n');
    return 1;
  }
  const token = await readTokenLine(io);
  if (token.length === 0) {
    io.stdout.write('ERR:unauthorized\n');
    return 1;
  }
  if (command === 'check-bot') {
    const result = await checkBot({ token });
    io.stdout.write(result.ok ? `OK:${result.username}\n` : `ERR:${result.code}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === 'pair-start') {
    const startNonce = flag(argv, 'nonce');
    const startDurationRaw = flag(argv, 'duration-ms');
    if (!isValidNonce(startNonce)) {
      io.stdout.write('ERR:bad_usage\n');
      return 1;
    }
    let startDurationMs = 60_000;
    if (startDurationRaw !== undefined) {
      const parsed = Number(startDurationRaw);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        io.stdout.write('ERR:bad_usage\n');
        return 1;
      }
      startDurationMs = parsed;
    }
    const result = await pairViaPrivateStart({ token, nonce: startNonce, durationMs: startDurationMs });
    if (result.ok) {
      io.stdout.write(`PAIRED:${result.userId}:${result.chatId}\n`);
      return 0;
    }
    io.stdout.write(`ERR:${result.code}\n`);
    return 1;
  }
  const nonce = flag(argv, 'nonce');
  const durationMs = Number(flag(argv, 'duration-ms') ?? 90000);
  if (typeof nonce !== 'string' || nonce.trim().length === 0) {
    io.stdout.write('ERR:bad_usage\n');
    return 1;
  }
  const result = await findPairingCandidates({ token, nonce, durationMs });
  if (result.ok && result.candidates.length > 0) {
    io.stdout.write(`CANDIDATES:${result.candidates.join(',')}\n`);
    return 0;
  }
  io.stdout.write(`ERR:${result.ok ? 'pairing_timeout' : result.code}\n`);
  return 1;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  main().then((code) => { process.exitCode = code; });
}
