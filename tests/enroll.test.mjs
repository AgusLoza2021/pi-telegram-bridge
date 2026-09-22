// T04/T09: enrollment helpers (owner-run setup only — never automated against
// the real API). Pairing requires an exact operator nonce from a PRIVATE
// chat; the first sender is never trusted automatically. Candidates are
// returned for explicit local confirmation only. T09 adds the dedicated
// `/start <nonce>` private-chat pairing used by the QR flow, which derives
// one {userId, chatId} from the same update and fails closed on anything
// else.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkBot, findPairingCandidates, pairViaPrivateStart } from '../src/enroll.mjs';

const TOKEN = '123456789:TEST_synthetic_token_AAAAAAAAAAAAAAAAAAAAA';
const NONCE = 'feed-face-1234';
const HEX_NONCE = '0123456789abcdef0123456789abcdef';
const BOT_USERNAME = 'DemoProjectBot';

function fetchJson(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url).replace(/bot[^/]+/, 'bot:REDACTED'), init });
    const next = responses.shift();
    if (!next) throw new TypeError('no scripted response');
    return next;
  };
  return { fetchImpl, calls };
}

function jsonResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

describe('checkBot', () => {
  test('ok when getMe is sane and no webhook is configured; returns the username', async () => {
    const { fetchImpl } = fetchJson([
      jsonResponse({ ok: true, result: { id: 123, is_bot: true, username: BOT_USERNAME } }), // getMe
      jsonResponse({ ok: true, result: { url: '' } }), // getWebhookInfo
    ]);
    const result = await checkBot({ token: TOKEN, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.username, BOT_USERNAME);
  });

  test('refuses a getMe without a valid bot username (QR link needs it)', async () => {
    const { fetchImpl } = fetchJson([
      jsonResponse({ ok: true, result: { id: 123, is_bot: true } }), // no username
    ]);
    const result = await checkBot({ token: TOKEN, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'bad_response');
  });

  test('refuses a getMe username that is not a telegram-safe bot name', async () => {
    // 'garden_bo' has a valid username shape but does NOT end in "bot":
    // the validator rejects it before the webhook call, so one scripted
    // response is enough and bad_response is observed deterministically.
    const { fetchImpl } = fetchJson([
      jsonResponse({ ok: true, result: { id: 123, is_bot: true, username: 'garden_bo' } }),
    ]);
    const result = await checkBot({ token: TOKEN, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'bad_response');
  });

  test('refuses an existing webhook instead of deleting it', async () => {
    const { fetchImpl } = fetchJson([
      jsonResponse({ ok: true, result: { id: 123, is_bot: true, username: BOT_USERNAME } }),
      jsonResponse({ ok: true, result: { url: 'https://example.com/hook' } }),
    ]);
    const result = await checkBot({ token: TOKEN, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'webhook_present');
  });

  test('unauthorized bot maps to a fixed code without echoing the token', async () => {
    const { fetchImpl } = fetchJson([
      { ok: false, status: 401, text: async () => '{"ok":false}' },
    ]);
    const result = await checkBot({ token: TOKEN, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unauthorized');
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });

  test('network failure maps to a safe retryable code', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED (private detail)'); };
    const result = await checkBot({ token: TOKEN, fetchImpl, maxAttempts: 1, sleep: async () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'network');
    assert.ok(!JSON.stringify(result).includes('ECONNREFUSED'));
  });
});

describe('findPairingCandidates', () => {
  const fromUser = (id) => ({ id, is_bot: false, first_name: 'X' });

  test('returns the matching private-chat sender as the only candidate', async () => {
    let offset = 0;
    const { fetchImpl } = fetchJson([
      jsonResponse({ ok: true, result: [{ update_id: 1, message: { message_id: 1, from: fromUser(111), chat: { id: 111, type: 'private' }, text: `pair ${NONCE}` } }] }),
    ]);
    const result = await findPairingCandidates({
      token: TOKEN,
      nonce: `pair ${NONCE}`,
      fetchImpl,
      durationMs: 1000,
      pollGapMs: 10,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.candidates, ['111']);
    assert.ok(offset === 0);
  });

  test('a wrong nonce never yields a candidate (first sender is not trusted)', async () => {
    const { fetchImpl } = fetchJson([
      jsonResponse({ ok: true, result: [{ update_id: 2, message: { message_id: 2, from: fromUser(222), chat: { id: 222, type: 'private' }, text: 'pair wrong-nonce' } }] }),
      jsonResponse({ ok: true, result: [] }),
    ]);
    const result = await findPairingCandidates({
      token: TOKEN,
      nonce: `pair ${NONCE}`,
      fetchImpl,
      durationMs: 60,
      pollGapMs: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'pairing_timeout');
    assert.ok(!('candidates' in result) || (Array.isArray(result.candidates) && result.candidates.length === 0));
  });

  test('group-chat messages with the exact nonce are ignored', async () => {
    const { fetchImpl } = fetchJson([
      jsonResponse({ ok: true, result: [{ update_id: 3, message: { message_id: 3, from: fromUser(333), chat: { id: -444, type: 'group' }, text: `pair ${NONCE}` } }] }),
      jsonResponse({ ok: true, result: [] }),
    ]);
    const result = await findPairingCandidates({
      token: TOKEN,
      nonce: `pair ${NONCE}`,
      fetchImpl,
      durationMs: 60,
      pollGapMs: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'pairing_timeout');
    assert.ok(!('candidates' in result) || (Array.isArray(result.candidates) && result.candidates.length === 0));
  });

  test('multiple matching private senders are deduplicated and sorted', async () => {
    const { fetchImpl } = fetchJson([
      jsonResponse({
        ok: true,
        result: [
          { update_id: 4, message: { message_id: 4, from: fromUser(555), chat: { id: 555, type: 'private' }, text: `pair ${NONCE}` } },
          { update_id: 5, message: { message_id: 5, from: fromUser(444), chat: { id: 444, type: 'private' }, text: `pair ${NONCE}` } },
          { update_id: 6, message: { message_id: 6, from: fromUser(444), chat: { id: 444, type: 'private' }, text: `pair ${NONCE}` } },
        ],
      }),
      jsonResponse({ ok: true, result: [] }),
    ]);
    const result = await findPairingCandidates({
      token: TOKEN,
      nonce: `pair ${NONCE}`,
      fetchImpl,
      durationMs: 1000,
      pollGapMs: 10,
    });
    assert.deepEqual(result.candidates, ['444', '555']);
  });

  test('times out with a fixed code when nothing matches', async () => {
    const { fetchImpl } = fetchJson([]);
    // Scripted fetch runs dry -> each poll attempt maps to a network error;
    // the pair loop must keep polling until the duration elapses.
    const fetchImplAlwaysEmpty = async () => jsonResponse({ ok: true, result: [] });
    const result = await findPairingCandidates({
      token: TOKEN,
      nonce: `pair ${NONCE}`,
      fetchImpl: fetchImplAlwaysEmpty,
      durationMs: 30,
      pollGapMs: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'pairing_timeout');
  });
});

describe('pairViaPrivateStart (T09 QR pairing)', () => {
  const fromUser = (id) => ({ id, is_bot: false, first_name: 'X' });
  const startUpdate = (userId, text, updateId = 10) => ({
    update_id: updateId,
    message: {
      message_id: 1,
      from: fromUser(userId),
      chat: { id: userId, type: 'private' },
      text,
    },
  });
  // First poll returns the scripted updates, every later poll returns a
  // fresh empty result: the fake fetch never runs dry, so a timeout can
  // only come from the deterministic deadline (never from artificial
  // network exhaustion, which production maps to the 'network' code).
  const fetchFirstThenEmpty = (updates) => {
    let first = true;
    return async () => {
      if (first) {
        first = false;
        return jsonResponse({ ok: true, result: updates });
      }
      return jsonResponse({ ok: true, result: [] });
    };
  };

  test('derives userId and chatId from the exact "/start <nonce>" private message', async () => {
    const { fetchImpl } = fetchJson([
      jsonResponse({ ok: true, result: [startUpdate(777, `/start ${HEX_NONCE}`)] }),
    ]);
    const result = await pairViaPrivateStart({
      token: TOKEN,
      nonce: HEX_NONCE,
      fetchImpl,
      durationMs: 1000,
      pollGapMs: 10,
    });
    assert.equal(result.ok, true);
    assert.equal(result.userId, 777);
    assert.equal(result.chatId, 777);
    assert.ok(!('candidates' in result), 'legacy shape is not leaked');
  });

  test('a plain or wrong nonce never pairs (exact "/start <nonce>" only)', async () => {
    for (const text of [HEX_NONCE, `pair ${HEX_NONCE}`, `/start ${'f'.repeat(32)}`, `/start ${HEX_NONCE} x`]) {
      const fetchImpl = fetchFirstThenEmpty([startUpdate(888, text)]);
      const result = await pairViaPrivateStart({
        token: TOKEN,
        nonce: HEX_NONCE,
        fetchImpl,
        durationMs: 40,
        pollGapMs: 10,
      });
      assert.equal(result.ok, false, `text ${JSON.stringify(text)} must not pair`);
      assert.equal(result.code, 'pairing_timeout');
      assert.equal(result.userId, undefined);
      assert.equal(result.chatId, undefined);
    }
  });

  test('group-chat messages with the exact text are refused', async () => {
    const fetchImpl = fetchFirstThenEmpty([
      {
        update_id: 11,
        message: {
          message_id: 2,
          from: fromUser(999),
          chat: { id: -444, type: 'group' },
          text: `/start ${HEX_NONCE}`,
        },
      },
    ]);
    const result = await pairViaPrivateStart({
      token: TOKEN,
      nonce: HEX_NONCE,
      fetchImpl,
      durationMs: 40,
      pollGapMs: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'pairing_timeout');
  });

  test('unsafe user/chat ids are refused, not coerced', async () => {
    const cases = [
      startUpdate(9007199254740993, `/start ${HEX_NONCE}`),            // > MAX_SAFE_INTEGER
      startUpdate(-5, `/start ${HEX_NONCE}`),                          // negative user id
      { update_id: 12, message: { message_id: 3, from: fromUser(111), chat: { id: 111.5, type: 'private' }, text: `/start ${HEX_NONCE}` } },
      { update_id: 13, message: { message_id: 4, from: { is_bot: false }, chat: { id: 111, type: 'private' }, text: `/start ${HEX_NONCE}` } }, // no from.id
    ];
    for (const update of cases) {
      const fetchImpl = fetchFirstThenEmpty([update]);
      const result = await pairViaPrivateStart({
        token: TOKEN,
        nonce: HEX_NONCE,
        fetchImpl,
        durationMs: 40,
        pollGapMs: 10,
      });
      assert.equal(result.ok, false, `update ${update.update_id} must be refused`);
      assert.equal(result.code, 'pairing_timeout');
    }
  });

  test('duplicate redelivery of the same update collapses to one pair', async () => {
    const update = startUpdate(777, `/start ${HEX_NONCE}`);
    const { fetchImpl } = fetchJson([
      jsonResponse({ ok: true, result: [update, { ...update }] }),
    ]);
    const result = await pairViaPrivateStart({
      token: TOKEN,
      nonce: HEX_NONCE,
      fetchImpl,
      durationMs: 1000,
      pollGapMs: 10,
    });
    assert.equal(result.ok, true);
    assert.equal(result.userId, 777);
    assert.equal(result.chatId, 777);
  });

  test('repeated messages from the same sender still yield one pair', async () => {
    const { fetchImpl } = fetchJson([
      jsonResponse({
        ok: true,
        result: [
          { update_id: 20, message: { message_id: 5, from: fromUser(777), chat: { id: 777, type: 'private' }, text: `/start ${HEX_NONCE}` } },
          { update_id: 21, message: { message_id: 6, from: fromUser(777), chat: { id: 777, type: 'private' }, text: `/start ${HEX_NONCE}` } },
        ],
      }),
    ]);
    const result = await pairViaPrivateStart({
      token: TOKEN,
      nonce: HEX_NONCE,
      fetchImpl,
      durationMs: 1000,
      pollGapMs: 10,
    });
    assert.equal(result.ok, true);
    assert.equal(result.userId, 777);
  });

  test('two different senders matching the same nonce fail closed', async () => {
    const fetchImpl = fetchFirstThenEmpty([
      startUpdate(777, `/start ${HEX_NONCE}`, 30),
      startUpdate(888, `/start ${HEX_NONCE}`, 31),
    ]);
    const result = await pairViaPrivateStart({
      token: TOKEN,
      nonce: HEX_NONCE,
      fetchImpl,
      durationMs: 1000,
      pollGapMs: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'pairing_conflict');
  });

  test('unauthorized tokens fail closed immediately', async () => {
    const { fetchImpl } = fetchJson([
      { ok: false, status: 401, text: async () => '{"ok":false}' },
    ]);
    const result = await pairViaPrivateStart({
      token: TOKEN,
      nonce: HEX_NONCE,
      fetchImpl,
      durationMs: 1000,
      pollGapMs: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unauthorized');
    assert.ok(!JSON.stringify(result).includes(TOKEN));
  });

  test('persistent network failures surface as the network code at deadline', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED (private detail)'); };
    const result = await pairViaPrivateStart({
      token: TOKEN,
      nonce: HEX_NONCE,
      fetchImpl,
      durationMs: 30,
      pollGapMs: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'network');
    assert.ok(!JSON.stringify(result).includes('ECONNREFUSED'));
  });

  test('a malformed nonce is refused before any network call', async () => {
    let called = 0;
    const fetchImpl = async () => { called += 1; return jsonResponse({ ok: true, result: [] }); };
    const result = await pairViaPrivateStart({
      token: TOKEN,
      nonce: 'pair feed-face',
      fetchImpl,
      durationMs: 1000,
      pollGapMs: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'bad_nonce');
    assert.equal(called, 0);
  });
});
