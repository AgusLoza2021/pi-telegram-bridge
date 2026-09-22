// T01 security contract tests, rev 2 (defects B5, B6).
// Chunk unit is the UTF-16 code unit (Telegram's own counter): every chunk
// is at most maxLen UTF-16 units; a grapheme longer than the limit is split
// by whole code points as a fallback (never a lone surrogate).
// All secrets below are fake fixtures; no real token or numeric identity.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorize,
  redact,
  chunkMessage,
  createRateLimiter,
} from '../src/security.mjs';

const USER = '111111111';
const CHAT = '222222222';

// No lone (unpaired) surrogates anywhere in the chunks.
function assertNoBrokenSurrogates(chunks) {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const chunk of chunks) {
    assert.equal(lone.test(chunk), false, `broken surrogate in: ${JSON.stringify(chunk)}`);
  }
}

describe('authorize: exact BOTH user AND chat (B5)', () => {
  const cfg = {
    telegram: { allowedUserId: USER, allowedChatId: CHAT },
  };

  test('allows exact matching user and chat', () => {
    assert.deepEqual(authorize({ userId: USER, chatId: CHAT }, cfg), {
      allowed: true,
    });
  });

  test('accepts safe exact integer forms without truncation', () => {
    assert.equal(authorize({ userId: 111111111, chatId: CHAT }, cfg).allowed, true);
    assert.equal(authorize({ userId: USER, chatId: 222222222 }, cfg).allowed, true);
  });

  test('rejects values beyond the safe integer range (no truncation)', () => {
    assert.equal(authorize({ userId: 2 ** 53, chatId: CHAT }, cfg).allowed, false);
    assert.equal(authorize({ userId: USER, chatId: 1.11e21 }, cfg).allowed, false);
  });

  test('rejects wrong user', () => {
    assert.deepEqual(authorize({ userId: '999', chatId: CHAT }, cfg), {
      allowed: false,
      reason: 'not_authorized',
    });
  });

  test('rejects wrong chat', () => {
    assert.deepEqual(authorize({ userId: USER, chatId: '999' }, cfg), {
      allowed: false,
      reason: 'not_authorized',
    });
  });

  test('rejects right user with wrong chat (BOTH required)', () => {
    assert.equal(authorize({ userId: USER, chatId: '999' }, cfg).allowed, false);
  });

  test('rejects zero and leading-zero impersonation', () => {
    assert.equal(authorize({ userId: '0', chatId: CHAT }, cfg).allowed, false);
    assert.equal(authorize({ userId: '0111', chatId: CHAT }, cfg).allowed, false);
    assert.equal(authorize({ userId: USER, chatId: '0222222222' }, cfg).allowed, false);
    const zeroCfg = { telegram: { allowedUserId: '0', allowedChatId: '0' } };
    assert.equal(authorize({ userId: 0, chatId: 0 }, zeroCfg).allowed, false);
  });

  test('supports signed nonzero group chat ids', () => {
    const groupCfg = { telegram: { allowedUserId: USER, allowedChatId: '-100200300' } };
    assert.equal(authorize({ userId: USER, chatId: -100200300 }, groupCfg).allowed, true);
    assert.equal(authorize({ userId: USER, chatId: '100200300' }, groupCfg).allowed, false);
  });

  test('rejects missing ids', () => {
    assert.equal(authorize({ userId: USER }, cfg).allowed, false);
    assert.equal(authorize({}, cfg).allowed, false);
  });

  test('rejects when config lacks allowlist entries', () => {
    assert.equal(
      authorize({ userId: USER, chatId: CHAT }, { telegram: {} }).allowed,
      false,
    );
  });
});

describe('redact', () => {
  const token = '1234567890:FAKE_fixture_token_not_real_abcDEFghi';

  test('removes known secrets exactly', () => {
    const text = `boot ok token=${token} done`;
    const out = redact(text, [token]);
    assert.equal(out.includes(token), false);
    assert.equal(out.includes('[REDACTED]'), true);
    assert.equal(out.includes('boot ok'), true);
  });

  test('removes general bot-token shaped strings', () => {
    const out = redact('leak 9876543210:AAAAaaaBBBbbbCCCcccDDDdddEEEeeeFFFg', []);
    assert.equal(out.includes('AAAAaaaBBBbbbCCCcccDDDdddEEEeeeFFFg'), false);
  });

  test('removes bearer tokens, key/value pairs and headers', () => {
    const out = redact(
      [
        'Authorization: Bearer sk-fake123456',
        'api_key=superfakevalue99',
        'token: anotherfakevalue',
        'safe line stays',
      ].join('\n'),
      [],
    );
    assert.equal(out.includes('sk-fake123456'), false);
    assert.equal(out.includes('superfakevalue99'), false);
    assert.equal(out.includes('anotherfakevalue'), false);
    assert.equal(out.includes('safe line stays'), true);
    assert.equal(out.includes('[REDACTED]'), true);
  });

  test('keeps ordinary text unchanged', () => {
    assert.equal(redact('hello world', []), 'hello world');
  });
});

describe('chunkMessage: UTF-16-bounded, grapheme-safe chunks (B6)', () => {
  test('short message returns single chunk', () => {
    assert.deepEqual(chunkMessage('hola', 10), ['hola']);
  });

  test('every chunk respects the UTF-16 bound for astral text', () => {
    const text = '😀'.repeat(30);
    const chunks = chunkMessage(text, 10);
    assert.equal(chunks.join(''), text);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 10, `chunk too long: ${chunk.length} UTF-16 units`);
    }
  });

  test('never splits grapheme clusters when they fit', () => {
    const text = 'a'.repeat(8) + '👨‍👩‍👧‍👦' + 'b'.repeat(8);
    const chunks = chunkMessage(text, 20);
    assert.equal(chunks.join(''), text);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 20);
    }
    assertNoBrokenSurrogates(chunks);
  });

  test('absolute limit: a grapheme longer than maxLen is split by whole code points', () => {
    const family = '👨‍👩‍👧‍👦'; // 11 UTF-16 units, 7 code points
    assert.ok(family.length > 10);
    const text = `ab${family}cd`;
    const chunks = chunkMessage(text, 10);
    assert.equal(chunks.join(''), text);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 10, `chunk too long: ${chunk.length}`);
    }
    assertNoBrokenSurrogates(chunks);
    // The family emoji is not kept whole here; it must be distributed
    // without ever splitting a surrogate pair.
    assert.ok(chunks.length > 1);
  });

  test('combining-mark clusters stay together when they fit', () => {
    const text = 'x'.repeat(4) + 'e\u0301' + 'y'.repeat(4);
    const chunks = chunkMessage(text, 6);
    assert.equal(chunks.join(''), text);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 6);
    }
    // 'e' + combining acute must appear intact inside one chunk.
    assert.ok(chunks.some((c) => c.includes('e\u0301')));
  });

  test('prefers breaking at spaces and newlines without losing text', () => {
    const text = 'word '.repeat(10) + 'tail';
    const chunks = chunkMessage(text, 12);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 12);
    }
  });

  test('rejects maxLen below 2: a chunk must be able to hold a surrogate pair', () => {
    // maxLen 1 would force lone surrogates for astral input (B6 invariant).
    assert.throws(() => chunkMessage('😀', 1), RangeError);
    assert.throws(() => chunkMessage('x', 1), RangeError);
    assert.throws(() => chunkMessage('x', 0), RangeError);
    assert.throws(() => chunkMessage('x', -3), RangeError);
  });

  test('surrogate pair fits exactly at the minimum bound', () => {
    const chunks = chunkMessage('😀', 2);
    assert.deepEqual(chunks, ['😀']);
  });
});

describe('rate limiter', () => {
  test('allows up to max then blocks within window', () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60000 });
    const t0 = 1_000_000;
    assert.equal(limiter.take('u1', t0).allowed, true);
    assert.equal(limiter.take('u1', t0 + 1).allowed, true);
    const blocked = limiter.take('u1', t0 + 2);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);
  });

  test('keys are independent', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60000 });
    const t0 = 1_000_000;
    assert.equal(limiter.take('a', t0).allowed, true);
    assert.equal(limiter.take('b', t0).allowed, true);
  });

  test('unblocks after the window passes', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60000 });
    const t0 = 1_000_000;
    limiter.take('a', t0);
    assert.equal(limiter.take('a', t0 + 1).allowed, false);
    assert.equal(limiter.take('a', t0 + 60000).allowed, true);
  });
});
