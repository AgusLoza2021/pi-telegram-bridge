// T09: local QR pairing renderer. Pure computation coverage: strict
// username/nonce validation, the exact deep-link shape, renderer bounds
// and the CLI output contract. No network, no token anywhere.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import {
  isValidBotUsername,
  isValidNonce,
  buildDeepLink,
  renderQr,
  main as qrMain,
} from '../src/qr-render.mjs';

const NONCE = '0123456789abcdef0123456789abcdef';
const USERNAME = 'DemoProjectBot';

function captureIo() {
  const stdout = [];
  const stderr = [];
  const io = {
    stdin: null,
    stdout: new Writable({
      write(chunk, _enc, cb) { stdout.push(String(chunk)); cb(); },
    }),
    stderr: new Writable({
      write(chunk, _enc, cb) { stderr.push(String(chunk)); cb(); },
    }),
  };
  return { io, stdout, stderr };
}

describe('isValidBotUsername', () => {
  test('accepts telegram-safe names ending in bot (any case)', () => {
    assert.equal(isValidBotUsername('DemoProjectBot'), true);
    assert.equal(isValidBotUsername('my_game_bot'), true);
    assert.equal(isValidBotUsername('aabot'), true);    // 5 chars = minimum length
    assert.equal(isValidBotUsername('x1_2_bot'), true); // digits/underscores inside
  });

  test('rejects malformed, short, non-bot and non-string values', () => {
    assert.equal(isValidBotUsername('abot'), false);          // too short
    assert.equal(isValidBotUsername('a'.repeat(33) + 'bot'), false); // too long
    assert.equal(isValidBotUsername('1gardenbot'), false);    // digit start
    assert.equal(isValidBotUsername('_gardenbot'), false);    // underscore start
    assert.equal(isValidBotUsername('garden bot'), false);    // whitespace
    assert.equal(isValidBotUsername('garden-bot'), false);    // hyphen
    assert.equal(isValidBotUsername('garden_bo'), false);     // does not end in bot
    assert.equal(isValidBotUsername('garden_boT '), false);   // trailing space
    assert.equal(isValidBotUsername(null), false);
    assert.equal(isValidBotUsername(42), false);
    assert.equal(isValidBotUsername(undefined), false);
  });
});

describe('isValidNonce', () => {
  test('accepts exactly 32 lowercase hex chars (128 bits)', () => {
    assert.equal(isValidNonce(NONCE), true);
    assert.equal(isValidNonce('a'.repeat(32)), true);
    assert.equal(isValidNonce('0'.repeat(32)), true);
  });

  test('rejects anything that is not exactly 32 lowercase hex chars', () => {
    assert.equal(isValidNonce('a'.repeat(31)), false);   // too short
    assert.equal(isValidNonce('a'.repeat(33)), false);   // too long
    assert.equal(isValidNonce('A'.repeat(32)), false);   // uppercase refused
    assert.equal(isValidNonce('g'.repeat(32)), false);   // not hex
    assert.equal(isValidNonce(`${NONCE}\n`), false);     // embedded newline
    assert.equal(isValidNonce('pair 0123'), false);      // legacy free text
    assert.equal(isValidNonce(null), false);
    assert.equal(isValidNonce(123), false);
  });
});

describe('buildDeepLink', () => {
  test('builds exactly https://t.me/<username>?start=<nonce>', () => {
    const link = buildDeepLink({ username: USERNAME, nonce: NONCE });
    assert.equal(link, `https://t.me/${USERNAME}?start=${NONCE}`);
  });

  test('the link structurally carries only username and nonce (no token)', () => {
    const link = buildDeepLink({ username: USERNAME, nonce: NONCE });
    assert.ok(!link.includes('token'));
    assert.ok(!link.includes('bot123'));
    assert.match(link, /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{4,31}\?start=[0-9a-f]{32}$/);
  });

  test('refuses malformed usernames and nonces', () => {
    assert.throws(() => buildDeepLink({ username: 'abot', nonce: NONCE }), TypeError);
    assert.throws(() => buildDeepLink({ username: null, nonce: NONCE }), TypeError);
    assert.throws(() => buildDeepLink({ username: USERNAME, nonce: 'nope' }), TypeError);
    assert.throws(() => buildDeepLink({ username: USERNAME, nonce: 'A'.repeat(32) }), TypeError);
    assert.throws(() => buildDeepLink({ username: USERNAME, nonce: undefined }), TypeError);
  });
});

describe('renderQr', () => {
  test('renders a local QR block for the deep link without a token', () => {
    const link = buildDeepLink({ username: USERNAME, nonce: NONCE });
    const qr = renderQr(link);
    assert.equal(typeof qr, 'string');
    assert.ok(qr.length > 0);
    assert.ok(qr.includes('\n'), 'qr block must be multi-line');
    // The renderer never receives a token, so nothing token-like can appear.
    assert.ok(!qr.includes('token'));
  });

  test('rejects empty, non-string and oversized input', () => {
    assert.throws(() => renderQr(''), TypeError);
    assert.throws(() => renderQr(null), TypeError);
    assert.throws(() => renderQr(42), TypeError);
    assert.throws(() => renderQr('x'.repeat(4097)), TypeError);
  });
});

describe('qr-render CLI (offline paths only)', () => {
  test('prints a bounded LINK line plus the QR block, never a token', async () => {
    const { io, stdout } = captureIo();
    const code = await qrMain(['--username', USERNAME, '--nonce', NONCE], io);
    assert.equal(code, 0);
    const out = stdout.join('');
    assert.match(out, /^LINK:https:\/\/t\.me\/DemoProjectBot\?start=[0-9a-f]{32}\n/);
    assert.ok(out.length > out.indexOf('\n'), 'QR block follows the link line');
    assert.ok(!out.includes('token'));
    const lines = out.split('\n').filter((l) => l.length > 0);
    assert.ok(lines[0].startsWith('LINK:'), 'first line is the bounded link');
  });

  test('bad usage fails closed with a fixed code', async () => {
    for (const argv of [
      [],
      ['--username', USERNAME],
      ['--nonce', NONCE],
      ['--username', 'abot', '--nonce', NONCE],
      ['--username', USERNAME, '--nonce', 'nope'],
      ['--username', USERNAME, '--nonce', NONCE, '--token', 'secret'],
      ['--nonce', NONCE, '--username', USERNAME],
    ]) {
      const { io, stdout } = captureIo();
      const code = await qrMain(argv, io);
      assert.equal(code, 1, `expected exit 1 for argv ${JSON.stringify(argv)}`);
      assert.equal(stdout.join(''), 'ERR:bad_usage\n');
    }
  });

  test('an extra token-like argument never changes the strict link shape', async () => {
    const { io, stdout } = captureIo();
    const code = await qrMain(['--username', USERNAME, '--nonce', NONCE, '--token', 'secret'], io);
    assert.equal(code, 1, 'unknown extra parameters are refused');
    assert.equal(stdout.join(''), 'ERR:bad_usage\n');
  });
});
