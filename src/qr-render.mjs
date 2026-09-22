// T09: local QR pairing renderer — the ONLY consumer of the qrcode-terminal
// package in this module. Owner-run interactive setup only.
//
// Invariants:
// - Pure local computation: this module never performs network I/O, never
//   writes files and never accepts a bot token as input. The QR/deep link
//   payload is structurally built from a validated bot username and a
//   validated 32-hex/128-bit nonce ONLY — there is no token parameter and
//   no online QR API anywhere in this code path.
// - Strict validation: anything that does not exactly match the expected
//   shapes is rejected (fail closed) before any QR is rendered.

import qrcodeTerminal from 'qrcode-terminal';

// Telegram-safe bot username: 5..32 chars, starts with a letter, only
// latin letters/digits/underscores, and ends in "bot" (case-insensitive).
const BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
// Pairing nonce: exactly 128 bits of entropy as 32 lowercase hex chars.
const NONCE_RE = /^[0-9a-f]{32}$/;

/** Strict Telegram bot-username validation (must end in "bot", any case). */
export function isValidBotUsername(username) {
  return typeof username === 'string'
    && BOT_USERNAME_RE.test(username)
    && /bot$/.test(username.toLowerCase());
}

/** Strict 32-hex / 128-bit nonce validation (lowercase hex only). */
export function isValidNonce(nonce) {
  return typeof nonce === 'string' && NONCE_RE.test(nonce);
}

/**
 * Build the exact deep link https://t.me/<username>?start=<nonce>.
 * Throws on any malformed input: the link can never carry anything but
 * the validated username and nonce (no token, no extra parameters).
 */
export function buildDeepLink({ username, nonce }) {
  if (!isValidBotUsername(username)) {
    throw new TypeError('invalid bot username');
  }
  if (!isValidNonce(nonce)) {
    throw new TypeError('invalid pairing nonce');
  }
  return `https://t.me/${username}?start=${nonce}`;
}

/**
 * Render a bounded QR block for the given text locally (qrcode-terminal,
 * small form by default). Throws on empty/oversized input. No printing
 * side effects: the string is returned to the caller.
 */
export function renderQr(text, { small = true } = {}) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 4096) {
    throw new TypeError('invalid QR input');
  }
  let out = '';
  qrcodeTerminal.generate(text, { small }, (qr) => { out = qr; });
  if (typeof out !== 'string' || out.length === 0) {
    throw new Error('qr render failed');
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI entrypoint used by scripts/setup.ps1 (owner-run interactive setup).
//   node src/qr-render.mjs --username <botUsername> --nonce <32hex>
// Prints one bounded LINK line plus the QR block to stdout. There is no
// stdin, no token input, no network and no file output — ever.
// Exit codes: 0 ok, 1 bad usage or render failure (fixed code on stdout).
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2), io = process) {
  // Strict argument shape: EXACTLY one --username and one --nonce, in that
  // order. Any extra or unknown argument (a stray --token, say) is refused
  // outright instead of being ignored: the QR input is structurally only
  // username + nonce, nothing else can ever ride along.
  if (argv.length !== 4
    || argv[0] !== '--username'
    || argv[2] !== '--nonce') {
    io.stdout.write('ERR:bad_usage\n');
    return 1;
  }
  let link;
  try {
    link = buildDeepLink({ username: argv[1], nonce: argv[3] });
  } catch {
    io.stdout.write('ERR:bad_usage\n');
    return 1;
  }
  let qr;
  try {
    qr = renderQr(link);
  } catch {
    io.stdout.write('ERR:render_failed\n');
    return 1;
  }
  io.stdout.write(`LINK:${link}\n`);
  io.stdout.write(qr.endsWith('\n') ? qr : `${qr}\n`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (isMain) {
  main().then((code) => { process.exitCode = code; });
}
