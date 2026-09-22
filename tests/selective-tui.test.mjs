// T06 selective live-TUI transport: permanent tests for the new modules.
//
// Three layers, no network, no model, no credentials, no real extension
// or task: Store + TuiBridgeClient (durable transport CAS), the
// SelectiveTelegramBroker against a fake Telegram API (exact user+chat
// authorization, routing, dedup, rendering), and the broker runtime
// config loader (selective shape + legacy compatibility, fail closed).
//
// Every artifact lives in a UNIQUE fresh directory strictly below the
// module's git-ignored .local/test-runs, mirroring the existing tests.
// Clocks are injected: moving the store clock backwards/forwards
// simulates staleness without ever sleeping.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store.mjs';
import { TuiBridgeClient } from '../src/tui-bridge-client.mjs';
import { SelectiveTelegramBroker } from '../src/selective-telegram-broker.mjs';
import { RuntimeConfigError, loadBrokerRuntimeConfig } from '../src/runtime-config.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const A = Object.freeze({ trackingId: 'a'.repeat(32), connectionId: '1'.repeat(32) });
const B = Object.freeze({ trackingId: 'b'.repeat(32), connectionId: '2'.repeat(32) });

// Selective Telegram broker runtime config (T06 shape).
const BROKER_CONFIG = Object.freeze({
  telegram: { allowedUserId: 101, allowedChatId: 202 },
  bridge: { maxMessageChars: 3800, rateLimit: { max: 1000, windowMs: 60_000 } },
});

/**
 * Duck-typed Telegram API: no network. getUpdates hands out queued
 * updates at/after the given offset exactly once; sendMessage records
 * every chunk so tests assert on transported text, never on internals.
 */
function makeFakeApi() {
  const sent = [];
  const answered = [];
  let queued = [];
  let failSends = 0;
  let failAnswers = 0;
  let webhookUrl = '';
  return {
    sent,
    answered,
    queueUpdate(update) { queued.push(update); },
    setWebhook(url) { webhookUrl = url; },
    failNextSends(count) { failSends = count; },
    failNextAnswers(count) { failAnswers = count; },
    async getUpdates({ offset } = {}) {
      const ready = queued.filter((u) => u.update_id >= (offset ?? 0));
      queued = queued.filter((u) => u.update_id < (offset ?? 0));
      return ready;
    },
    async sendMessage({ chatId, text, replyMarkup }) {
      if (failSends > 0) {
        failSends--;
        throw new Error('simulated transport failure');
      }
      const record = { chatId, text };
      if (replyMarkup !== undefined) record.replyMarkup = replyMarkup;
      sent.push(record);
      return { ok: true };
    },
    async answerCallbackQuery({ callbackQueryId } = {}) {
      if (failAnswers > 0) {
        failAnswers--;
        throw new Error('simulated answer failure');
      }
      answered.push(callbackQueryId);
      return { ok: true };
    },
    async getWebhookInfo() { return { url: webhookUrl }; },
    async getMe() { return { id: 900, is_bot: true }; },
    async close() {},
  };
}

let updateIdSeq = 0;
/** Build one authorized-by-default Telegram message update. */
function msg(text, { userId = 101, chatId = 202, senderChat = null } = {}) {
  updateIdSeq++;
  const message = {
    message_id: updateIdSeq,
    from: { id: userId, is_bot: false },
    chat: { id: chatId },
    date: 0,
    text,
  };
  if (senderChat !== null) message.sender_chat = { id: senderChat };
  return { update_id: updateIdSeq, message };
}

/**
 * Build one authorized-by-default Telegram callback-query update carrying
 * an inline-keyboard tap (T03a chooser grammar).
 */
function cb(data, {
  userId = 101, chatId = 202, senderChat = null, isBot = false, chatType = 'private',
} = {}) {
  updateIdSeq++;
  const message = {
    message_id: updateIdSeq,
    date: 0,
    chat: { id: chatId, type: chatType },
  };
  if (senderChat !== null) message.sender_chat = { id: senderChat };
  return {
    update_id: updateIdSeq,
    callback_query: {
      id: `cbq${updateIdSeq}`,
      from: { id: userId, is_bot: isBot },
      message,
      data,
    },
  };
}

describe('selective transport: Store + TuiBridgeClient (ownership CAS, heartbeat, commands)', () => {
  /** Shared injected clock; starts at real now so the client's real
   *  Date.now() staleness window agrees with stored heartbeats. */
  let t;
  let store;
  let clientA;
  let clientB;
  let dir;

  before(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'sel-tui-'));
    t = Date.now();
    store = new Store(join(dir, 'bridge.sqlite'), { now: () => t, isProcessAlive: () => true });
    clientA = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    clientB = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
  });

  after(() => {
    store.close();
  });

  test('two distinct TUI sessions connect with distinct short ids and list as live', () => {
    const connectA = clientA.connect({ ...A, shortId: 'aaa111', label: 'alpha', pid: 1111, cwd: 'C:/proj/alpha' });
    const connectB = clientB.connect({ ...B, shortId: 'bbb222', label: 'beta', pid: 2222, cwd: 'C:/proj/beta' });
    assert.equal(connectA.ok, true);
    assert.equal(connectB.ok, true);
    assert.notEqual(connectA.shortId, connectB.shortId);
    const listed = clientA.listSessions();
    assert.equal(listed.length, 2);
    assert.ok(listed.every((session) => session.live === true));
  });

  test('owner heartbeat and state updates land; a foreign connection fails closed', () => {
    t += 5_000;
    assert.equal(clientA.heartbeat(A).ok, true);
    assert.equal(clientA.setState({ ...A, state: 'busy' }).ok, true);
    assert.equal(clientA.setState({ ...A, state: 'waiting' }).ok, true);
    const row = clientA.getSession(A);
    assert.equal(row.state, 'waiting');
    assert.equal(row.heartbeatAt, t);
    assert.deepEqual(
      clientB.heartbeat({ trackingId: A.trackingId, connectionId: B.connectionId }),
      { ok: false, reason: 'not_owner' },
    );
    assert.deepEqual(
      clientB.setState({ trackingId: A.trackingId, connectionId: B.connectionId, state: 'busy' }),
      { ok: false, reason: 'not_owner' },
    );
  });

  test('final output is recorded; a targeted command is claimed only by the intended client', () => {
    const finalEvent = clientA.publishFinalOutput({ ...A, text: 'HARVEST READY' });
    assert.equal(finalEvent.ok, true);
    const enq = store.enqueueTuiCommand({
      trackingId: A.trackingId, kind: 'prompt', payload: { text: 'plant seeds' }, commandId: 'c'.repeat(32),
    });
    assert.equal(enq.ok, true);
    assert.equal(clientB.poll(B).commands.length, 0, 'a non-target client must claim nothing');
    assert.deepEqual(
      store.claimNextTuiCommand({ trackingId: A.trackingId, connectionId: B.connectionId }),
      { ok: false, reason: 'not_owner' },
    );
    const pollA = clientA.poll(A);
    assert.equal(pollA.commands.length, 1);
    assert.equal(pollA.commands[0].commandId, 'c'.repeat(32));
    assert.equal(pollA.commands[0].kind, 'prompt');
  });

  test('a claimed command reports its outcome as a command_result event', () => {
    const res = clientA.reportCommandResult({
      ...A, commandId: 'c'.repeat(32), ok: true, text: 'done',
    });
    assert.equal(res.ok, true);
    assert.equal(res.commandAcknowledged, true);
    assert.ok(typeof res.eventId === 'number');
    const pending = store.listPendingBrokerTuiEvents({ limit: 50 });
    assert.ok(pending.some((e) => e.kind === 'command_result' && e.payload?.ok === true));
  });

  test('enqueue to an unknown tracking id fails closed', () => {
    assert.deepEqual(
      store.enqueueTuiCommand({ trackingId: 'f'.repeat(32), kind: 'prompt', payload: { text: 'x' } }),
      { ok: false, reason: 'unknown_session' },
    );
  });

  test('a live row refuses a different connection (session_live_elsewhere)', () => {
    const clientC = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    assert.deepEqual(
      clientC.connect({ trackingId: B.trackingId, connectionId: '3'.repeat(32), label: 'beta2', pid: 3333 }),
      { ok: false, reason: 'session_live_elsewhere' },
    );
  });

  test('stale ownership is replaced and the old connection fails closed everywhere', () => {
    t -= 40_000;
    clientB.heartbeat(B); // writes a heartbeat behind the 30s liveness window
    const clientD = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    const r = clientD.connect({ trackingId: B.trackingId, connectionId: '4'.repeat(32), label: 'beta3', pid: 4444 });
    assert.equal(r.ok, true);
    assert.equal(r.replaced, true);
    assert.deepEqual(clientB.heartbeat(B), { ok: false, reason: 'not_owner' });
    assert.deepEqual(clientB.setState({ ...B, state: 'busy' }), { ok: false, reason: 'not_owner' });
    const enq = store.enqueueTuiCommand({ trackingId: B.trackingId, kind: 'prompt', payload: { text: 'stale test' } });
    assert.equal(enq.ok, true);
    assert.equal(clientB.poll(B).commands.length, 0, 'the replaced connection must claim nothing');
    assert.equal(clientD.poll({ trackingId: B.trackingId, connectionId: '4'.repeat(32) }).commands.length, 1);
  });

  test('disconnect removes the row, fails the old owner closed and keeps the notice drainable', () => {
    assert.equal(clientA.disconnect(A).ok, true);
    assert.equal(clientA.getSession(A), null);
    assert.deepEqual(clientA.publishFinalOutput({ ...A, text: 'after disconnect' }),
      { ok: false, reason: 'unknown_session' });
    assert.deepEqual(clientA.heartbeat(A), { ok: false, reason: 'not_owner' });
    const pending = store.listPendingBrokerTuiEvents({ limit: 100 });
    assert.ok(pending.some((e) => e.kind === 'disconnected' && e.trackingId === A.trackingId));
  });
});

describe('selective transport: no reasoning/tool event or command kind is ever accepted', () => {
  let store;
  let dir;

  before(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'sel-kinds-'));
    store = new Store(join(dir, 'bridge.sqlite'), { isProcessAlive: () => true });
  });

  after(() => {
    store.close();
  });

  test('the store rejects hidden-reasoning and tool event kinds before any persistence', () => {
    const trackingId = 'e'.repeat(32);
    assert.throws(
      () => store.appendTuiEvent({ trackingId, kind: 'reasoning', payload: null }),
      TypeError,
    );
    assert.throws(
      () => store.appendTuiEvent({ trackingId, kind: 'tool_result', payload: { args: 'x' } }),
      TypeError,
    );
    assert.throws(
      () => store.enqueueTuiCommand({ trackingId, kind: 'reasoning', payload: null }),
      TypeError,
    );
  });
});

describe('SelectiveTelegramBroker: authorization, routing, dedup and rendering (fake API)', () => {
  let t;
  let store;
  let clientA;
  let clientB;
  let dir;

  before(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'sel-broker-'));
    t = Date.now();
    store = new Store(join(dir, 'bridge.sqlite'), { now: () => t, isProcessAlive: () => true });
    clientA = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    clientB = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    assert.equal(clientA.connect({ ...A, shortId: 'aaa111', label: 'alpha', pid: 1111, cwd: 'C:/proj/alpha' }).ok, true);
    assert.equal(clientB.connect({ ...B, shortId: 'bbb222', label: 'beta', pid: 2222, cwd: 'C:/proj/beta' }).ok, true);
  });

  after(() => {
    store.close();
  });

  function newBroker(api) {
    return new SelectiveTelegramBroker({ store, api, config: BROKER_CONFIG, now: () => t });
  }

  /** One update through the broker + flush of the queued replies. */
  async function deliver(broker, api, update) {
    broker.handleUpdate(update);
    await broker.flushReplies();
    return update.update_id;
  }

  /** Drop transport leftovers so every test starts from a quiet store. */
  function clearTransport() {
    const pending = store.listPendingBrokerTuiEvents({ limit: 256 });
    if (pending.length > 0) {
      store.acknowledgeTuiEvents({ eventIds: pending.map((e) => e.eventId) });
    }
    while (store.claimNextTuiCommand({ trackingId: A.trackingId, connectionId: A.connectionId }).ok) {}
    while (store.claimNextTuiCommand({ trackingId: B.trackingId, connectionId: B.connectionId }).ok) {}
  }

  test('only the EXACT configured user id AND chat id are served; everything else is consumed silently', async () => {
    clearTransport();
    const api = makeFakeApi();
    const broker = newBroker(api);
    const ids = [];
    for (const update of [
      msg('wrong user', { userId: 999 }),
      msg('wrong chat', { chatId: 999 }),
      msg('channel impersonation', { senderChat: 202 }),
    ]) {
      const id = await deliver(broker, api, update);
      ids.push(id);
      assert.equal(store.getBrokerTransportOffset(), id + 1,
        'receipt must stay durable even for rejected updates');
    }
    assert.equal(api.sent.length, 0, 'unauthorized updates must never be answered');
    assert.equal(clientA.poll(A).commands.length, 0);
    assert.equal(clientB.poll(B).commands.length, 0);
  });

  test('/sessions lists only live TUIs with short id, label, state and cwd', async () => {
    clearTransport();
    const api = makeFakeApi();
    const broker = newBroker(api);
    await deliver(broker, api, msg('/sessions'));
    assert.equal(api.sent.length, 1);
    const text = api.sent[0].text;
    assert.match(text, /Live TUI sessions:/);
    assert.match(text, /tg:aaa111 · alpha · connected · C:\/proj\/alpha/);
    assert.match(text, /tg:bbb222 · beta · connected · C:\/proj\/beta/);
  });

  test('/use selects a live session, refuses malformed ids and misses unknown ids', async () => {
    clearTransport();
    const api = makeFakeApi();
    const broker = newBroker(api);
    await deliver(broker, api, msg('/use aaa111'));
    assert.equal(api.sent[0].text, 'Pi · alpha — Selected.');
    await deliver(broker, api, msg('/use NOPE'));
    assert.match(api.sent[1].text, /Usage: \/use <shortId>/);
    await deliver(broker, api, msg('/use zzz999'));
    assert.match(api.sent[2].text, /No live session with short id "zzz999"/);
  });

  test('plain text routes to the selected live session as a typed prompt; several live sessions without a selection hold a pending prompt', async () => {
    clearTransport();
    const api = makeFakeApi();
    const broker = newBroker(api);
    await deliver(broker, api, msg('hello before any selection'));
    assert.match(api.sent[0].text, /message is saved/,
      'several live sessions and no selection must hold the message and ask which Pi');
    assert.doesNotMatch(api.sent[0].text, /aaa111|bbb222/,
      'the choice notice must not expose short ids');
    assert.ok(Array.isArray(api.sent[0].replyMarkup?.inline_keyboard),
      'the hold reply must offer a readable chooser keyboard');
    assert.equal(clientA.poll(A).commands.length, 0);
    assert.equal(clientB.poll(B).commands.length, 0);
    await deliver(broker, api, msg('/use aaa111'));
    await deliver(broker, api, msg('plant the seeds'));
    assert.match(api.sent[2].text, /Pi · alpha — Prompt queued\./);
    const commands = clientA.poll(A).commands;
    assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, 'prompt');
    assert.equal(commands[0].payload.text, 'plant the seeds');
  });

  test('/send routes by explicit short id without a selection and refuses slash-initial text', async () => {
    clearTransport();
    const api = makeFakeApi();
    const broker = newBroker(api);
    await deliver(broker, api, msg('/send bbb222 dig the hole'));
    assert.match(api.sent[0].text, /Pi · beta — Prompt queued\./);
    const commands = clientB.poll(B).commands;
    assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, 'prompt');
    assert.equal(commands[0].payload.text, 'dig the hole');
    await deliver(broker, api, msg('/send aaa111 /run rm -rf'));
    assert.match(api.sent[1].text, /Refused: lines starting with "\/" are not allowed/);
    assert.equal(clientA.poll(A).commands.length, 0, 'refused text must never enqueue a command');
  });

  test('a redelivered update (same update_id) never enqueues duplicate commands', async () => {
    clearTransport();
    const api = makeFakeApi();
    const broker = newBroker(api);
    await deliver(broker, api, msg('/use aaa111'));
    const redelivered = msg('dedup probe text');
    const fixedId = redelivered.update_id;
    broker.handleUpdate({ ...redelivered, update_id: fixedId });
    await broker.flushReplies();
    broker.handleUpdate({ ...redelivered, update_id: fixedId });
    await broker.flushReplies();
    assert.equal(store.getBrokerTransportOffset(), fixedId + 1);
    const commands = clientA.poll(A).commands.filter((c) => c.payload.text === 'dedup probe text');
    assert.equal(commands.length, 1, 'inbox dedup must make the re-delivery a no-op');
  });

  test('stale/unknown session targets fail closed with fixed guidance', async () => {
    clearTransport();
    const api = makeFakeApi();
    const broker = newBroker(api);
    await deliver(broker, api, msg('/send nope99 hello'));
    assert.match(api.sent[0].text, /No live session with short id "nope99"/);
    await deliver(broker, api, msg('/use aaa111'));
    t += 31_000; // alpha's heartbeat ages out of the 30s window; beta stays live
    clientB.heartbeat(B);
    await deliver(broker, api, msg('plain text after the selection went stale'));
    assert.match(api.sent[2].text, /Pi · beta — Prompt queued\./,
      'a stale selection with exactly one live replacement auto-selects it');
    assert.equal(clientA.poll(A).commands.length, 0, 'a stale session must never receive routed text');
    const commands = clientB.poll(B).commands;
    assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, 'prompt');
    assert.equal(commands[0].payload.text, 'plain text after the selection went stale');
    await deliver(broker, api, msg('/sessions'));
    assert.doesNotMatch(api.sent[3].text, /aaa111/, 'the stale session must vanish from /sessions');
    assert.match(api.sent[3].text, /tg:bbb222/);
  });

  test('drain transports ONLY final output, status and command results, then acknowledges everything', async () => {
    clearTransport();
    clientA.heartbeat(A); // re-live alpha at the current (advanced) clock
    const api = makeFakeApi();
    const broker = newBroker(api);
    assert.equal(clientA.publishFinalOutput({ ...A, text: 'HARVEST READY' }).ok, true);
    assert.equal(clientA.publishStatus({
      ...A,
      payload: {
        state: 'busy', model: 'test-model', cwd: 'C:/proj/alpha', pid: 42, piSessionId: 'sess9',
        tool_args: 'must not render', secret: 'must not render',
      },
    }).ok, true);
    const enq = store.enqueueTuiCommand({ trackingId: A.trackingId, kind: 'prompt', payload: { text: 'x' } });
    assert.equal(enq.ok, true);
    assert.equal(clientA.poll(A).commands.length, 1);
    assert.equal(clientA.reportCommandResult({ ...A, commandId: enq.commandId, ok: true, text: 'done' }).ok, true);

    await broker.drainTuiEvents();
    const all = api.sent.map((m) => m.text).join('\n---\n');
    // T04: normal event path renders `Pi · <label>`, never [label · shortId],
    // and beginner status shows state and model ONLY.
    assert.match(all, /Pi · alpha\nHARVEST READY/);
    assert.match(all, /Pi · alpha status/);
    assert.match(all, /state: busy/);
    assert.match(all, /model: test-model/);
    assert.doesNotMatch(all, /\[alpha · aaa111\]/);
    assert.doesNotMatch(all, /C:\/proj\/alpha/);
    assert.doesNotMatch(all, /pid=|sess9/);
    assert.doesNotMatch(all, /tool_args/);
    assert.doesNotMatch(all, /must not render/);
    assert.match(all, /Pi · alpha — command finished\./);
    assert.equal(store.listPendingBrokerTuiEvents({ limit: 100 }).length, 0,
      'every transported event must be acknowledged after all its chunks were sent');
  });

  test('a failed command result renders its code, never the raw error text', async () => {
    clearTransport();
    const api = makeFakeApi();
    const broker = newBroker(api);
    const enq = store.enqueueTuiCommand({ trackingId: B.trackingId, kind: 'prompt', payload: { text: 'boom run' } });
    assert.equal(enq.ok, true);
    assert.equal(clientB.poll(B).commands.length, 1);
    const res = clientB.reportCommandResult({
      ...B, commandId: enq.commandId, ok: false, resultCode: 'input_refused',
    });
    assert.equal(res.ok, true);
    await broker.drainTuiEvents();
    assert.ok(api.sent.some((m) => m.text === 'Pi · beta — command failed (input_refused).'));
  });

  test('a failed delivery leaves the event unacknowledged and fabricates no retry command', async () => {
    clearTransport();
    const api = makeFakeApi();
    const broker = newBroker(api);
    assert.equal(clientA.publishFinalOutput({ ...A, text: 'MUST SURVIVE' }).ok, true);
    api.failNextSends(1);
    await broker.drainTuiEvents();
    const pending = store.listPendingBrokerTuiEvents({ limit: 100 });
    assert.equal(pending.length, 1, 'an unconfirmed delivery must stay unacknowledged');
    assert.equal(pending[0].kind, 'final_output');
    assert.equal(clientA.poll(A).commands.length, 0, 'a delivery failure is never converted into a command');
    await broker.drainTuiEvents(); // transport healthy again: retried whole
    assert.ok(api.sent.some((m) => m.text.includes('MUST SURVIVE')));
    assert.equal(store.listPendingBrokerTuiEvents({ limit: 100 }).length, 0);
  });

  test('broker start refuses while a webhook is configured (deleting it is a human decision)', async () => {
    const api = makeFakeApi();
    api.setWebhook('https://example.org/hook');
    const broker = newBroker(api);
    await assert.rejects(broker.start(), (error) => error.code === 'WEBHOOK_PRESENT');
  });

  test('reasoning/tool event kinds are not accepted by the transport the broker drains', () => {
    clearTransport();
    assert.throws(
      () => store.appendTuiEvent({ trackingId: A.trackingId, kind: 'reasoning', payload: null }),
      TypeError,
    );
    assert.throws(
      () => store.appendTuiEvent({ trackingId: A.trackingId, kind: 'tool_result', payload: { args: 'x' } }),
      TypeError,
    );
    assert.equal(store.listPendingBrokerTuiEvents({ limit: 100 }).length, 0);
  });

  test('same-millisecond commands claim in insertion order, not by random command id (FIFO tiebreak)', () => {
    // Fresh store with a FROZEN clock: both commands share created_at, so
    // the claim order must come from insertion order alone.
    const fifoDir = mkdtempSync(join(TEST_RUNS, 'sel-fifo-'));
    const frozen = 1_700_000_000_000;
    const fifoStore = new Store(join(fifoDir, 'bridge.sqlite'), { now: () => frozen, isProcessAlive: () => true });
    const fifoClient = new TuiBridgeClient(fifoStore, { staleAfterMs: 30_000 });
    try {
      assert.equal(
        fifoClient.connect({ ...A, shortId: 'aaa111', label: 'alpha', pid: 1111, cwd: 'C:/proj/alpha' }).ok,
        true,
      );
      // Deliberately reverse-lexical ids: 'f...' inserted first, '0...'
      // second. Under the old `ORDER BY command_id` tiebreak the claim
      // would have returned '0...' first; insertion order demands 'f...'.
      assert.equal(
        fifoStore.enqueueTuiCommand({
          trackingId: A.trackingId, kind: 'prompt', payload: { text: 'first' }, commandId: 'f'.repeat(32),
        }).ok,
        true,
      );
      assert.equal(
        fifoStore.enqueueTuiCommand({
          trackingId: A.trackingId, kind: 'prompt', payload: { text: 'second' }, commandId: '0'.repeat(32),
        }).ok,
        true,
      );
      const first = fifoStore.claimNextTuiCommand({ trackingId: A.trackingId, connectionId: A.connectionId });
      assert.equal(first.ok, true);
      assert.equal(first.command.commandId, 'f'.repeat(32),
        'the first inserted command must be claimed first when created_at ties');
      const second = fifoClient.poll({ ...A }).commands;
      assert.equal(second.length, 1,
        'exactly the second command must remain after the first claim');
      assert.equal(second[0].commandId, '0'.repeat(32),
        'the second inserted command must be claimed next when created_at ties');
    } finally {
      fifoStore.close();
    }
  });
});

describe('SelectiveTelegramBroker: beginner auto-selection of the sole live session (T02)', () => {
  /** Fresh store + clients per test: every auto-selection scenario starts
   *  from a quiet transport with its own injected clock. */
  function makeFixture() {
    const dir = mkdtempSync(join(TEST_RUNS, 'sel-auto-'));
    let t = Date.now();
    const now = () => t;
    const store = new Store(join(dir, 'bridge.sqlite'), { now, isProcessAlive: () => true });
    const clientA = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    const clientB = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    return {
      store,
      clientA,
      clientB,
      now,
      advance(ms) { t += ms; },
      connectA() {
        assert.equal(clientA.connect({ ...A, shortId: 'aaa111', label: 'alpha', pid: 1111, cwd: 'C:/proj/alpha' }).ok, true);
      },
      connectB() {
        assert.equal(clientB.connect({ ...B, shortId: 'bbb222', label: 'beta', pid: 2222, cwd: 'C:/proj/beta' }).ok, true);
      },
      close() { store.close(); },
    };
  }

  function newBroker(fx, api) {
    return new SelectiveTelegramBroker({ store: fx.store, api, config: BROKER_CONFIG, now: fx.now });
  }

  async function deliver(broker, api, update) {
    broker.handleUpdate(update);
    await broker.flushReplies();
  }

  test('exactly one live session: plain text auto-dispatches to it without /use or /send', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('water the tomatoes'));
      assert.match(api.sent[0].text, /Pi · alpha — Prompt queued\./,
        'the auto-selection acknowledgement must carry the readable label');
      const first = fx.clientA.poll(A).commands;
      assert.equal(first.length, 1);
      assert.equal(first[0].kind, 'prompt');
      assert.equal(first[0].payload.text, 'water the tomatoes');
      await deliver(broker, api, msg('and the carrots'));
      assert.match(api.sent[1].text, /Pi · alpha — Prompt queued\./,
        'the auto-selection must stick for the following messages');
      const second = fx.clientA.poll(A).commands;
      assert.equal(second.length, 1);
      assert.equal(second[0].payload.text, 'and the carrots');
    } finally { fx.close(); }
  });

  test('exactly one live session: /status auto-targets it without an explicit short id', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/status'));
      assert.match(api.sent[0].text, /Pi · alpha — Status requested\./);
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'status');
    } finally { fx.close(); }
  });

  test('a live selection is preserved even when several sessions are live', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/use aaa111'));
      // Poll after each dispatch: the store poll CONSUMES commands, so
      // leaving both prompts queued makes the claim order ambiguous. The
      // T03 behavior is unchanged — both prompts dispatch to the still-live
      // selection, in order.
      await deliver(broker, api, msg('first prompt'));
      const first = fx.clientA.poll(A).commands;
      assert.equal(first.length, 1, 'the first prompt must reach the still-live selection');
      assert.equal(first[0].payload.text, 'first prompt');
      await deliver(broker, api, msg('second prompt'));
      const second = fx.clientA.poll(A).commands;
      assert.equal(second.length, 1, 'the second prompt must reach the still-live selection');
      assert.equal(second[0].payload.text, 'second prompt');
      assert.equal(fx.clientB.poll(B).commands.length, 0, 'an unselected live session must receive nothing');
    } finally { fx.close(); }
  });

  test('a stale selection auto-selects the sole replacement live session and sticks to it', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/use aaa111'));
      fx.advance(31_000); // alpha ages out of the 30s window; beta stays live
      fx.clientB.heartbeat(B);
      await deliver(broker, api, msg('hello after the switch'));
      assert.match(api.sent[1].text, /Pi · beta — Prompt queued\./,
        'the stale selection must auto-select the sole live replacement');
      assert.equal(fx.clientA.poll(A).commands.length, 0, 'the stale session must receive nothing');
      const commands = fx.clientB.poll(B).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].payload.text, 'hello after the switch');
      await deliver(broker, api, msg('still talking to beta'));
      const again = fx.clientB.poll(B).commands;
      assert.equal(again.length, 1, 'the auto-selected replacement must stick without /use');
      assert.equal(again[0].payload.text, 'still talking to beta');
    } finally { fx.close(); }
  });

  test('zero live sessions: plain text and /status fail closed with beginner guidance and enqueue nothing', async () => {
    const fx = makeFixture();
    try {
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('is anyone there?'));
      assert.match(api.sent[0].text,
        /There's no Pi connected right now, so your message was not sent\./,
        'plain text with zero live sessions uses the exact not-sent wording');
      assert.match(api.sent[0].text, /type \/tg/, 'the beginner guidance must point at /tg');
      await deliver(broker, api, msg('/status'));
      assert.match(api.sent[1].text, /There's no Pi connected right now\./);
      // A session that disappears entirely after being selected fails the same way.
      fx.connectA();
      fx.advance(31_000);
      await deliver(broker, api, msg('anyone left?'));
      assert.match(api.sent[2].text,
        /There's no Pi connected right now, so your message was not sent\./);
      assert.equal(fx.clientA.poll(A).commands.length, 0, 'a stale session must never receive routed text');
    } finally { fx.close(); }
  });

  test('several live sessions and no selection: /status stays fail closed; plain text holds a pending prompt without exposing short ids', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('which pi is this for?'));
      assert.match(api.sent[0].text, /message is saved/);
      assert.doesNotMatch(api.sent[0].text, /aaa111|bbb222/,
        'the hold notice must never expose short ids');
      assert.ok(Array.isArray(api.sent[0].replyMarkup?.inline_keyboard),
        'the hold reply must offer a readable chooser keyboard');
      await deliver(broker, api, msg('/status'));
      assert.match(api.sent[1].text, /More than one Pi session is connected/,
        '/status keeps its fixed fail-closed notice');
      assert.doesNotMatch(api.sent[1].text, /aaa111|bbb222/);
      assert.equal(api.sent[1].replyMarkup, undefined,
        '/status stays a text-only notice with no keyboard');
      assert.equal(fx.clientA.poll(A).commands.length, 0, 'no command may be guessed for session A');
      assert.equal(fx.clientB.poll(B).commands.length, 0, 'no command may be guessed for session B');
    } finally { fx.close(); }
  });

  test('advanced routed commands without an explicit id keep the selection-required fail closed even with one live session', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      // First tokens are deliberately NOT short-id-shaped: natural words
      // with punctuation ('what,'/'dig,') so no token matches SHORT_ID_RE,
      // each command resolves without an explicit id and must hit the
      // selection-required fail closed.
      const advanced = [
        ['/send go home now', 'go home now'],
        ['/steer go left', 'go left'],
        ['/followup what, next', 'what, next'],
        ['/abort', null],
        ['/disconnect', null],
      ];
      for (const [i, [command]] of advanced.entries()) {
        await deliver(broker, api, msg(command));
        assert.match(api.sent[i].text, /Send \/use <shortId>/,
          `${command} without an explicit id must demand a selection, never auto-select`);
        assert.doesNotMatch(api.sent[i].text, /aaa111/,
          'the selection-required notice must not expose the live session short id');
      }
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'no advanced command may be enqueued while no session is selected');
      // The beginner policy is per-command, not process-wide: plain text
      // still auto-selects the sole live session right after.
      await deliver(broker, api, msg('beginner text still auto-selects'));
      assert.match(api.sent[advanced.length].text, /Pi · alpha — Prompt queued\./);
      // Poll between dispatches, like the sibling selection test: the
      // production Store intentionally orders same-millisecond commands by
      // random command_id, which is not a deterministic tiebreak, so FIFO
      // order across two dispatches cannot be asserted reliably here.
      let beginner = fx.clientA.poll(A).commands;
      assert.equal(beginner.length, 1,
        'exactly the beginner prompt must be enqueued');
      assert.equal(beginner[0].payload.text, 'beginner text still auto-selects');
      // The advanced explicit-id fallback stays fully available.
      await deliver(broker, api, msg('/send aaa111 dig the hole'));
      assert.match(api.sent[advanced.length + 1].text, /Pi · alpha — Prompt queued\./);
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1,
        'exactly the explicit-id /send must be enqueued');
      assert.equal(commands[0].payload.text, 'dig the hole');
    } finally { fx.close(); }
  });

  test('advanced /use fallback keeps working alongside auto-selection', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/use bbb222'));
      assert.equal(api.sent[0].text, 'Pi · beta — Selected.');
      await deliver(broker, api, msg('to beta explicitly'));
      const bCommands = fx.clientB.poll(B).commands;
      assert.equal(bCommands.length, 1);
      assert.equal(bCommands[0].payload.text, 'to beta explicitly');
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      await deliver(broker, api, msg('/use NOPE'));
      assert.match(api.sent[2].text, /Usage: \/use <shortId>/);
      await deliver(broker, api, msg('/use zzz999'));
      assert.match(api.sent[3].text, /No live session with short id "zzz999"/);
    } finally { fx.close(); }
  });
});

describe('SelectiveTelegramBroker: chooser keyboards + broker-memory pending prompt (T03a)', () => {
  /** Fresh store + clients per test, mirroring the T02 auto-selection fixture. */
  function makeFixture() {
    const dir = mkdtempSync(join(TEST_RUNS, 'sel-chooser-'));
    let t = Date.now();
    const now = () => t;
    const store = new Store(join(dir, 'bridge.sqlite'), { now, isProcessAlive: () => true });
    const clientA = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    const clientB = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    return {
      store,
      clientA,
      clientB,
      now,
      advance(ms) { t += ms; },
      connectA() {
        assert.equal(clientA.connect({ ...A, shortId: 'aaa111', label: 'alpha', pid: 1111, cwd: 'C:/proj/alpha' }).ok, true);
      },
      connectB() {
        assert.equal(clientB.connect({ ...B, shortId: 'bbb222', label: 'beta', pid: 2222, cwd: 'C:/proj/beta' }).ok, true);
      },
      close() { store.close(); },
    };
  }

  function newBroker(fx, api, bridgeOverrides = {}) {
    return new SelectiveTelegramBroker({
      store: fx.store,
      api,
      config: { ...BROKER_CONFIG, bridge: { ...BROKER_CONFIG.bridge, ...bridgeOverrides } },
      now: fx.now,
    });
  }

  async function deliver(broker, api, update) {
    broker.handleUpdate(update);
    await broker.flushReplies();
    return update;
  }

  /** Flatten the inline keyboard of one sent message into button objects. */
  function buttonsOf(sentMessage) {
    return sentMessage.replyMarkup.inline_keyboard.flat();
  }

  /** Buttons of the most recently sent message. */
  function lastButtons(api) {
    return buttonsOf(api.sent[api.sent.length - 1]);
  }

  /** The pending generation id offered by the latest p-buttons. */
  function lastPendingId(api) {
    const button = lastButtons(api).find((b) => b.callback_data.startsWith('v1:p:'));
    return button.callback_data.split(':')[3];
  }

  test('callback authorization: exact user+chat, private chat, no sender_chat, non-bot sender', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      for (const update of [
        cb('v1:r', { userId: 999 }),
        cb('v1:r', { chatId: 999 }),
        cb('v1:r', { chatType: 'group' }),
        cb('v1:r', { senderChat: 202 }),
        cb('v1:r', { isBot: true }),
      ]) {
        await deliver(broker, api, update);
      }
      assert.equal(api.sent.length, 0, 'unauthorized callbacks must never be answered with a reply');
      assert.equal(api.answered.length, 0, 'unauthorized callbacks must not even reach answerCallbackQuery');
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      assert.equal(fx.clientB.poll(B).commands.length, 0);
      // A non-string data payload from an otherwise authorized tap is
      // malformed: consumed silently, answered best-effort, never dispatched.
      await deliver(broker, api, cb(null));
      assert.equal(api.sent.length, 0);
      assert.equal(api.answered.length, 1);
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      // The authorized control still renders the chooser.
      await deliver(broker, api, cb('v1:r'));
      assert.equal(api.sent.length, 1);
      assert.ok(lastButtons(api).length >= 1);
    } finally { fx.close(); }
  });

  test('chooser buttons show readable labels only; short ids stay inside bounded callback_data', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('a message that must be saved'));
      const reply = api.sent[api.sent.length - 1];
      assert.match(reply.text, /message is saved/);
      assert.doesNotMatch(reply.text, /aaa111|bbb222/,
        'no short id may ever appear in beginner-visible text');
      const buttons = buttonsOf(reply);
      assert.deepEqual(buttons.map((b) => b.text), ['Pi · alpha', 'Pi · beta', 'Refresh']);
      for (const button of buttons) {
        assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64,
          `callback_data must stay within 64 UTF-8 bytes: ${button.callback_data}`);
        assert.match(button.callback_data, /^(v1:r|v1:p:[a-z0-9]{3,32}:[0-9a-f]{16})$/);
        assert.ok(!button.callback_data.includes('alpha') && !button.callback_data.includes('beta'),
          'callback_data must never carry a readable label');
      }
    } finally { fx.close(); }
  });

  test('a second plain text replaces the pending generation; the matching choice dispatches exactly once', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('first version'));
      const stalePid = lastPendingId(api);
      await deliver(broker, api, msg('second version'));
      const currentPid = lastPendingId(api);
      assert.notEqual(stalePid, currentPid, 'a replaced pending prompt must get a fresh generation id');
      // The stale generation never dispatches.
      await deliver(broker, api, cb(`v1:p:aaa111:${stalePid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      assert.equal(fx.clientB.poll(B).commands.length, 0);
      // The current generation dispatches exactly the latest held text.
      await deliver(broker, api, cb(`v1:p:bbb222:${currentPid}`));
      const commands = fx.clientB.poll(B).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'prompt');
      assert.equal(commands[0].payload.text, 'second version');
      assert.equal(api.sent[api.sent.length - 1].text, 'Sent to Pi · beta.');
    } finally { fx.close(); }
  });

  test('a duplicate tap on a consumed generation never dispatches twice', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('only once'));
      const pid = lastPendingId(api);
      await deliver(broker, api, cb(`v1:p:aaa111:${pid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 1);
      // The second tap arrives as its own update (no inbox dedup), but the
      // pending generation is already consumed. The first poll above
      // CONSUMED the command, so the next poll must be empty.
      await deliver(broker, api, cb(`v1:p:aaa111:${pid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'the duplicate tap must not enqueue a second command');
      // The re-render is the safest current chooser: no pending left, s-buttons.
      const buttons = lastButtons(api);
      assert.deepEqual(buttons.map((b) => b.text), ['Pi · alpha', 'Pi · beta', 'Refresh']);
      assert.ok(buttons.filter((b) => b.callback_data.startsWith('v1:s:')).length === 2);
    } finally { fx.close(); }
  });

  test('a dead session target never dispatches and preserves the pending prompt', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('still waiting'));
      const pid = lastPendingId(api);
      fx.advance(31_000); // alpha ages out of the 30s window; beta stays live
      fx.clientB.heartbeat(B);
      await deliver(broker, api, cb(`v1:p:aaa111:${pid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      assert.equal(fx.clientB.poll(B).commands.length, 0);
      // The chooser re-renders with only the live session and the SAME
      // pending generation preserved.
      const buttons = lastButtons(api);
      assert.deepEqual(buttons.map((b) => b.text), ['Pi · beta', 'Refresh']);
      const parts = buttons[0].callback_data.split(':');
      assert.equal(parts[2], 'bbb222');
      assert.equal(parts[3], pid, 'the pending generation must survive a dead-target tap');
      // And the preserved generation still dispatches.
      await deliver(broker, api, cb(`v1:p:bbb222:${pid}`));
      const commands = fx.clientB.poll(B).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].payload.text, 'still waiting');
    } finally { fx.close(); }
  });

  test('malformed and oversized callback data are silently consumed without dispatching', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('held while probing'));
      for (const data of [
        'v1',
        // T03b note: 'v1:x:aaa111' became a VALID op in T03b, so the probe
        // uses an unknown action letter instead — still malformed, still
        // silently consumed without dispatching.
        'v1:X:aaa111',
        'v1:s:',
        'v1:s:AA',
        'v1:p:aaa111:NOTHEX16',
        `v1:p:aaa111:${'a'.repeat(16)}x`,
        'v1:r extra',
        'a'.repeat(65),
      ]) {
        await deliver(broker, api, cb(data));
      }
      assert.equal(api.sent.length, 1, 'malformed callbacks must produce no reply');
      assert.equal(api.answered.length, 8, 'authorized callbacks are still answered best-effort');
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      assert.equal(fx.clientB.poll(B).commands.length, 0);
    } finally { fx.close(); }
  });

  test('a keyboard from before a restart (lost broker memory) never dispatches', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('held before the restart'));
      const pid = lastPendingId(api);
      // A fresh broker process: the pending prompt was memory-only and died.
      const restartedApi = makeFakeApi();
      const restarted = newBroker(fx, restartedApi);
      await deliver(restarted, restartedApi, cb(`v1:p:aaa111:${pid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'a pre-restart keyboard must fail closed, never dispatch');
      assert.equal(fx.clientB.poll(B).commands.length, 0);
      // The safest re-render with no pending: plain s-buttons.
      const buttons = lastButtons(restartedApi);
      assert.deepEqual(buttons.map((b) => b.text), ['Pi · alpha', 'Pi · beta', 'Refresh']);
      assert.ok(buttons.every((b) => !b.callback_data.startsWith('v1:p:')));
    } finally { fx.close(); }
  });

  test('refresh re-renders with the current pending generation; without pending it offers plain selection', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:r'));
      assert.deepEqual(lastButtons(api).map((b) => b.text), ['Pi · alpha', 'Pi · beta', 'Refresh']);
      assert.ok(lastButtons(api).every((b) => !b.callback_data.startsWith('v1:p:')),
        'without a pending prompt the buttons must only select');
      await deliver(broker, api, msg('held for the refresh probe'));
      const pid = lastPendingId(api);
      await deliver(broker, api, cb('v1:r'));
      assert.equal(lastPendingId(api), pid,
        'refresh must preserve the pending prompt and re-render its generation');
      // The preserved generation still dispatches after the refresh.
      await deliver(broker, api, cb(`v1:p:aaa111:${pid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 1);
      await deliver(broker, api, cb('v1:r'));
      assert.ok(lastButtons(api).every((b) => !b.callback_data.startsWith('v1:p:')),
        'after the pending was consumed, refresh offers plain selection again');
    } finally { fx.close(); }
  });

  test('the select callback chooses a live session without dispatching and routes later plain text', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:r'));
      await deliver(broker, api, cb('v1:s:aaa111'));
      assert.equal(
        api.sent[api.sent.length - 1].text,
        'Connected to Pi · alpha. Just type a message and it goes to that Pi.',
        'a successful select confirms MSG-T3 again, naming the chosen Pi');
      assert.equal(fx.clientA.poll(A).commands.length, 0, 'a select callback must enqueue nothing');
      assert.equal(fx.clientB.poll(B).commands.length, 0);
      await deliver(broker, api, msg('routed now'));
      assert.match(api.sent[api.sent.length - 1].text, /Pi · alpha — Prompt queued\./);
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].payload.text, 'routed now');
    } finally { fx.close(); }
  });

  test('advanced slash commands keep working while a prompt is pending', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('hold me'));
      const pid = lastPendingId(api);
      await deliver(broker, api, msg('/status'));
      assert.match(api.sent[1].text, /More than one Pi session is connected/,
        '/status without a selection keeps its fail-closed notice');
      await deliver(broker, api, msg('/send bbb222 explicit send'));
      assert.match(api.sent[2].text, /Pi · beta — Prompt queued\./,
        'an explicit-id /send must dispatch immediately');
      // The held prompt survives and still dispatches through its keyboard.
      await deliver(broker, api, cb('v1:r'));
      assert.equal(lastPendingId(api), pid);
      await deliver(broker, api, cb(`v1:p:aaa111:${pid}`));
      const aCommands = fx.clientA.poll(A).commands;
      assert.equal(aCommands.length, 1, 'the held prompt must dispatch exactly once');
      assert.equal(aCommands[0].payload.text, 'hold me');
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      const bCommands = fx.clientB.poll(B).commands;
      assert.equal(bCommands.length, 1);
      assert.equal(bCommands[0].payload.text, 'explicit send');
      assert.equal(api.sent[api.sent.length - 1].text, 'Sent to Pi · alpha.');
    } finally { fx.close(); }
  });

  test('a chunked reply carries the inline keyboard on exactly the final chunk', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api, { maxMessageChars: 20 });
      await deliver(broker, api, msg('hold this for me please'));
      const chunks = api.sent;
      assert.ok(chunks.length >= 2, 'the chooser notice must actually be chunked');
      for (let i = 0; i < chunks.length - 1; i++) {
        assert.equal(chunks[i].replyMarkup, undefined,
          'only the final chunk may carry the inline keyboard');
      }
      assert.equal(typeof chunks[chunks.length - 1].replyMarkup, 'object');
      assert.deepEqual(lastButtons(api).map((b) => b.text), ['Pi · alpha', 'Pi · beta', 'Refresh']);
      assert.equal(chunks.map((c) => c.text).join(''),
        'Your message is saved. Choose which Pi should get it:',
        'the chunked join must restore the full notice');
    } finally { fx.close(); }
  });

  test('answers go out after the offset commit and a failed answer never replays a command', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('held for the answer probe'));
      const pid = lastPendingId(api);
      const tap = cb(`v1:p:aaa111:${pid}`);
      await deliver(broker, api, tap);
      assert.deepEqual(api.answered, [tap.callback_query.id],
        'the authorized tap must be answered exactly once');
      assert.equal(fx.store.getBrokerTransportOffset(), tap.update_id + 1,
        'the answer is queued only after the offset commit');
      assert.equal(fx.clientA.poll(A).commands.length, 1);
      // A failed answer is dropped silently; it never replays the command.
      api.failNextAnswers(1);
      const refreshTap = cb('v1:r');
      await deliver(broker, api, refreshTap);
      assert.equal(api.answered.length, 1, 'the failed answer must not be retried');
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'a failed answer must never replay the dispatched command');
      // An API without answerCallbackQuery must not break the flow.
      const bareApi = makeFakeApi();
      delete bareApi.answerCallbackQuery;
      const bareBroker = newBroker(fx, bareApi);
      await deliver(bareBroker, bareApi, cb('v1:r'));
      assert.ok(Array.isArray(bareApi.sent));
    } finally { fx.close(); }
  });
});

describe('SelectiveTelegramBroker: busy cards, action keyboards and extended callback grammar (T03b)', () => {
  /** Fresh store + clients per test, mirroring the T03a chooser fixture. */
  function makeFixture() {
    const dir = mkdtempSync(join(TEST_RUNS, 'sel-busy-'));
    let t = Date.now();
    const now = () => t;
    const store = new Store(join(dir, 'bridge.sqlite'), { now, isProcessAlive: () => true });
    const clientA = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    const clientB = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    return {
      store,
      clientA,
      clientB,
      now,
      advance(ms) { t += ms; },
      connectA() {
        assert.equal(clientA.connect({ ...A, shortId: 'aaa111', label: 'alpha', pid: 1111, cwd: 'C:/proj/alpha' }).ok, true);
      },
      connectB() {
        assert.equal(clientB.connect({ ...B, shortId: 'bbb222', label: 'beta', pid: 2222, cwd: 'C:/proj/beta' }).ok, true);
      },
      busyA() {
        assert.equal(clientA.setState({ ...A, state: 'busy' }).ok, true);
      },
      close() { store.close(); },
    };
  }

  function newBroker(fx, api) {
    return new SelectiveTelegramBroker({ store: fx.store, api, config: BROKER_CONFIG, now: fx.now });
  }

  async function deliver(broker, api, update) {
    broker.handleUpdate(update);
    await broker.flushReplies();
  }

  function buttonsOf(sentMessage) {
    return sentMessage.replyMarkup.inline_keyboard.flat();
  }

  function lastButtons(api) {
    return buttonsOf(api.sent[api.sent.length - 1]);
  }

  /** The pending generation id offered by the latest busy card (v1:f button). */
  function busyPid(api) {
    const button = lastButtons(api).find((b) => b.callback_data.startsWith('v1:f:'));
    return button.callback_data.split(':')[3];
  }

  /** Drop transport leftovers so every test starts from a quiet store. */
  function clearTransport(fx) {
    const pending = fx.store.listPendingBrokerTuiEvents({ limit: 256 });
    if (pending.length > 0) {
      fx.store.acknowledgeTuiEvents({ eventIds: pending.map((e) => e.eventId) });
    }
    while (fx.store.claimNextTuiCommand({ trackingId: A.trackingId, connectionId: A.connectionId }).ok) {}
    while (fx.store.claimNextTuiCommand({ trackingId: B.trackingId, connectionId: B.connectionId }).ok) {}
  }

  const BUSY_LABELS = [
    'Add my message for after this task',
    'Redirect the current task',
    'Stop the task and use my message',
    'Leave it alone',
  ];

  function assertBusyCardButtons(api, shortId, pid) {
    const buttons = lastButtons(api);
    assert.deepEqual(buttons.map((b) => b.text), BUSY_LABELS,
      'the busy card must offer exactly the four readable choices');
    assert.deepEqual(
      buttons.map((b) => b.callback_data),
      [
        `v1:f:${shortId}:${pid}`,
        `v1:t:${shortId}:${pid}`,
        `v1:a:${shortId}:${pid}`,
        `v1:n:${pid}`,
      ],
      'f/t/a carry sid+pid, n carries only the generation id',
    );
    for (const button of buttons) {
      assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64,
        `callback_data must stay within 64 UTF-8 bytes: ${button.callback_data}`);
    }
  }

  test('plain text to a busy session holds the message and renders the four-button busy card without leaking the prompt or short ids', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      fx.busyA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('water the tomatoes at dawn'));
      const reply = api.sent[api.sent.length - 1];
      assert.match(reply.text, /still working on the current task/);
      assert.doesNotMatch(reply.text, /water the tomatoes/,
        'the held prompt text must never be echoed into the card');
      assert.doesNotMatch(reply.text, /aaa111/,
        'the busy card text must never expose short ids');
      const pid = busyPid(api);
      assert.match(pid, /^[0-9a-f]{16}$/);
      assertBusyCardButtons(api, 'aaa111', pid);
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'a busy session must not receive a silent direct prompt');
    } finally { fx.close(); }
  });

  test('v1:f dispatches exactly one follow-up with the held text and consumes the generation', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      fx.busyA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('plant the seeds later'));
      const pid = busyPid(api);
      await deliver(broker, api, cb(`v1:f:aaa111:${pid}`));
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'followup');
      assert.equal(commands[0].payload.text, 'plant the seeds later');
      const ack = api.sent[api.sent.length - 1].text;
      assert.equal(ack, 'Got it — Pi · alpha will see your message right after the current task.');
      assert.doesNotMatch(ack, /aaa111/, 'card acks stay label-only');
      // A second tap on the consumed generation never dispatches twice.
      await deliver(broker, api, cb(`v1:f:aaa111:${pid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'the consumed generation must be gone');
      // The safest re-render: no pending left, plain selection buttons.
      assert.deepEqual(lastButtons(api).map((b) => b.text), ['Pi · alpha', 'Refresh']);
      assert.ok(lastButtons(api).every((b) => !b.callback_data.startsWith('v1:f:')));
    } finally { fx.close(); }
  });

  test('v1:t dispatches exactly one steer with the held text', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      fx.busyA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('no, dig over here instead'));
      const pid = busyPid(api);
      await deliver(broker, api, cb(`v1:t:aaa111:${pid}`));
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'steer');
      assert.equal(commands[0].payload.text, 'no, dig over here instead');
      assert.equal(api.sent[api.sent.length - 1].text,
        "Done — Pi · alpha got your message and will adjust what it's doing.");
    } finally { fx.close(); }
  });

  test('v1:a dispatches abort then prompt in that exact order and consumes the generation once', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      fx.busyA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('stop and start over with this'));
      const pid = busyPid(api);
      await deliver(broker, api, cb(`v1:a:aaa111:${pid}`));
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 2);
      assert.equal(commands[0].kind, 'abort');
      assert.equal(commands[0].payload, null);
      assert.equal(commands[1].kind, 'prompt');
      assert.equal(commands[1].payload.text, 'stop and start over with this');
      const ackTexts = api.sent.slice(-2).map((m) => m.text);
      assert.deepEqual(ackTexts,
        ['Stopping the current task...', 'Stopped. Your message is on its way to Pi · alpha.'],
        'the abort acknowledgement must precede the prompt acknowledgement');
      // A second tap dispatches nothing more.
      await deliver(broker, api, cb(`v1:a:aaa111:${pid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 0);
    } finally { fx.close(); }
  });

  test('v1:n discards the held prompt, enqueues nothing and stale n taps fail closed', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      fx.busyA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('actually forget it'));
      const pid = busyPid(api);
      await deliver(broker, api, cb(`v1:n:${pid}`));
      assert.equal(api.sent[api.sent.length - 1].text,
        'Okay — the current task keeps running. Your saved message was discarded.');
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'leaving the task alone must enqueue nothing');
      // The generation is consumed: a stale f tap on the old pid never dispatches.
      await deliver(broker, api, cb(`v1:f:aaa111:${pid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      // A stale n tap (wrong pid) also never dispatches or misfires.
      await deliver(broker, api, cb('v1:n:0123456789abcdef'));
      assert.equal(fx.clientA.poll(A).commands.length, 0);
    } finally { fx.close(); }
  });

  test('old-generation and restart-old busy taps fail closed and never dispatch', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      fx.busyA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('first held version'));
      const stalePid = busyPid(api);
      await deliver(broker, api, msg('second held version'));
      const currentPid = busyPid(api);
      assert.notEqual(stalePid, currentPid);
      await deliver(broker, api, cb(`v1:f:aaa111:${stalePid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'the replaced generation must never dispatch');
      // A restarted broker lost the memory-only pending prompt: the old
      // keyboard fails closed.
      const restartedApi = makeFakeApi();
      const restarted = newBroker(fx, restartedApi);
      await deliver(restarted, restartedApi, cb(`v1:a:aaa111:${currentPid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'a pre-restart busy keyboard must fail closed');
      assert.deepEqual(lastButtons(restartedApi).map((b) => b.text), ['Pi · alpha', 'Refresh']);
      // The live broker still honors the current generation.
      await deliver(broker, api, cb(`v1:t:aaa111:${currentPid}`));
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].payload.text, 'second held version');
    } finally { fx.close(); }
  });

  test('a dead busy target preserves the held prompt for a live retry and never dispatches', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      fx.connectB();
      fx.busyA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      // Explicitly select the busy alpha: with two live sessions and no
      // selection the plain text would open the multi-session chooser
      // (p-buttons), which has no busy generation to hold.
      await deliver(broker, api, msg('/use aaa111'));
      await deliver(broker, api, msg('still waiting for a target'));
      const pid = busyPid(api);
      fx.advance(31_000); // alpha ages out of the 30s window; beta stays live
      fx.clientB.heartbeat(B);
      await deliver(broker, api, cb(`v1:f:aaa111:${pid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      assert.equal(fx.clientB.poll(B).commands.length, 0,
        'a dead target must never dispatch anywhere');
      // The held prompt is preserved: the re-rendered chooser carries the
      // SAME generation as p-buttons for the live session.
      const buttons = lastButtons(api);
      assert.deepEqual(buttons.map((b) => b.text), ['Pi · beta', 'Refresh']);
      const pButton = buttons.find((b) => b.callback_data.startsWith('v1:p:'));
      assert.equal(pButton.callback_data, `v1:p:bbb222:${pid}`);
      // And the preserved generation dispatches against the live target.
      await deliver(broker, api, cb(`v1:f:bbb222:${pid}`));
      const commands = fx.clientB.poll(B).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'followup');
      assert.equal(commands[0].payload.text, 'still waiting for a target');
    } finally { fx.close(); }
  });

  test('plain text to an idle session still dispatches directly (no busy card)', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('straight to the idle pi'));
      assert.match(api.sent[0].text, /Prompt queued/, 'idle sessions keep the direct path');
      assert.equal(api.sent[0].replyMarkup, undefined, 'no busy card for an idle session');
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'prompt');
      assert.equal(commands[0].payload.text, 'straight to the idle pi');
    } finally { fx.close(); }
  });

  test('advanced slash commands bypass the busy card untouched', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      fx.busyA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/steer aaa111 do this instead'));
      assert.match(api.sent[0].text, /Pi · alpha — Steer queued\./,
        'advanced slash commands keep their T03a routed behavior while busy');
      await deliver(broker, api, msg('/followup aaa111 queue this after'));
      assert.match(api.sent[1].text, /Pi · alpha — Follow-up queued\./);
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 2);
      assert.equal(commands[0].kind, 'steer');
      assert.equal(commands[0].payload.text, 'do this instead');
      assert.equal(commands[1].kind, 'followup');
      assert.equal(commands[1].payload.text, 'queue this after');
    } finally { fx.close(); }
  });

  test('q/x/c/d/D/C callbacks behave with readable keyboards and no dispatch on cancel', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      // q: exactly one status command, readable label-only ack.
      await deliver(broker, api, cb('v1:q:aaa111'));
      let commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'status');
      assert.equal(api.sent[api.sent.length - 1].text, 'Status requested for Pi · alpha.');
      // x: exactly one abort command; the ack is the truthful QUEUED
      // wording — the abort is enqueued, not yet completed.
      await deliver(broker, api, cb('v1:x:aaa111'));
      commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'abort');
      assert.equal(api.sent[api.sent.length - 1].text, 'Stopping the current task...');
      // c: a fresh chooser, no dispatch.
      await deliver(broker, api, cb('v1:c'));
      assert.deepEqual(lastButtons(api).map((b) => b.text), ['Pi · alpha', 'Refresh']);
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      // d: a readable confirmation card with Unlink (D) and Cancel (C).
      await deliver(broker, api, cb('v1:d:aaa111'));
      const confirmText = api.sent[api.sent.length - 1].text;
      assert.match(confirmText, /Unlink Pi · alpha\?/);
      assert.doesNotMatch(confirmText, /aaa111/);
      const confirmButtons = lastButtons(api);
      assert.deepEqual(confirmButtons.map((b) => b.text), ['Unlink', 'Cancel']);
      assert.deepEqual(confirmButtons.map((b) => b.callback_data), ['v1:D:aaa111', 'v1:C']);
      // C: acknowledge the cancellation, enqueue nothing.
      await deliver(broker, api, cb('v1:C'));
      assert.equal(api.sent[api.sent.length - 1].text, 'Okay — nothing was changed.');
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      // D: exactly one disconnect command.
      await deliver(broker, api, cb('v1:D:aaa111'));
      commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'disconnect');
      assert.equal(api.sent[api.sent.length - 1].text, 'Unlinking Pi · alpha.');
    } finally { fx.close(); }
  });

  test('dead short ids for q/x/d/D fail closed without dispatching', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      fx.advance(31_000); // alpha ages out; beta stays live
      fx.clientB.heartbeat(B);
      for (const data of ['v1:q:aaa111', 'v1:x:aaa111', 'v1:d:aaa111', 'v1:D:aaa111']) {
        await deliver(broker, api, cb(data));
      }
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      assert.equal(fx.clientB.poll(B).commands.length, 0,
        'dead-target action callbacks must enqueue nothing');
      // The safest re-render lists only the live session.
      assert.deepEqual(lastButtons(api).map((b) => b.text), ['Pi · beta', 'Refresh']);
    } finally { fx.close(); }
  });

  test('the connected event card carries the action row; Stop renders only while busy', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      // Idle connected session: Status, Change Pi, Disconnect — no Stop.
      assert.equal(fx.store.appendTuiEvent({ trackingId: A.trackingId, kind: 'connected', payload: null }).ok, true);
      await broker.drainTuiEvents();
      assert.match(api.sent[api.sent.length - 1].text, /Pi · alpha is connected\./);
      assert.deepEqual(lastButtons(api).map((b) => b.text),
        ['Status', 'Change Pi', 'Disconnect']);
      for (const button of lastButtons(api)) {
        assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64);
        assert.ok(!button.callback_data.startsWith('v1:x:'),
          'Stop must be absent while the state is not busy');
      }
      // Busy session: the same row gains Stop between Status and Change Pi.
      fx.busyA();
      assert.equal(fx.store.appendTuiEvent({ trackingId: A.trackingId, kind: 'connected', payload: null }).ok, true);
      await broker.drainTuiEvents();
      const busyRow = lastButtons(api);
      assert.deepEqual(busyRow.map((b) => b.text),
        ['Status', 'Stop the task', 'Change Pi', 'Disconnect']);
      assert.equal(busyRow.find((b) => b.text === 'Stop the task').callback_data, 'v1:x:aaa111');
    } finally { fx.close(); }
  });

  test('final-output events carry only Change Pi and Disconnect while live — never Stop', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      fx.busyA(); // busy on purpose: Stop must STILL be absent after final output
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      assert.equal(fx.clientA.publishFinalOutput({ ...A, text: 'HARVEST READY' }).ok, true);
      await broker.drainTuiEvents();
      assert.match(api.sent[api.sent.length - 1].text, /HARVEST READY/);
      const buttons = lastButtons(api);
      assert.deepEqual(buttons.map((b) => b.text), ['Change Pi', 'Disconnect']);
      assert.deepEqual(buttons.map((b) => b.callback_data), ['v1:c', 'v1:d:aaa111']);
      assert.ok(buttons.every((b) => !b.callback_data.startsWith('v1:x:')),
        'a final output must never offer Stop');
      assert.equal(fx.store.listPendingBrokerTuiEvents({ limit: 10 }).length, 0,
        'the event is acknowledged after its text plus keyboard send succeeded');
    } finally { fx.close(); }
  });

  test('busy status copy exposes only the Stop button; non-busy status has no keyboard', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      fx.busyA();
      assert.equal(fx.clientA.publishStatus({ ...A, payload: { state: 'busy' } }).ok, true);
      await broker.drainTuiEvents();
      assert.match(api.sent[api.sent.length - 1].text, /state: busy/);
      assert.deepEqual(lastButtons(api).map((b) => b.text), ['Stop the task']);
      assert.equal(lastButtons(api)[0].callback_data, 'v1:x:aaa111');
      // Waiting status: no keyboard at all.
      assert.equal(fx.clientA.setState({ ...A, state: 'waiting' }).ok, true);
      assert.equal(fx.clientA.publishStatus({ ...A, payload: { state: 'waiting' } }).ok, true);
      await broker.drainTuiEvents();
      const waiting = api.sent[api.sent.length - 1];
      assert.match(waiting.text, /state: waiting/);
      assert.equal(waiting.replyMarkup, undefined,
        'non-busy status copy must not offer Stop');
    } finally { fx.close(); }
  });

  test('event ack retry semantics survive keyboards: a failed send stays pending and re-renders', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      fx.busyA();
      // connectA appended a 'connected' event; drop it so the pending count
      // below reflects exactly the final-output event under test.
      clearTransport(fx);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      assert.equal(fx.clientA.publishFinalOutput({ ...A, text: 'MUST SURVIVE' }).ok, true);
      api.failNextSends(1);
      await broker.drainTuiEvents();
      let pending = fx.store.listPendingBrokerTuiEvents({ limit: 10 });
      assert.equal(pending.length, 1,
        'an uncertain send must leave the event pending (keyboard included)');
      assert.equal(api.sent.length, 0,
        'the failed send appended nothing (fake API drops failed sends)');
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'a delivery failure is never converted into a command');
      await broker.drainTuiEvents(); // transport healthy again: retried whole
      const retry = api.sent[api.sent.length - 1];
      assert.match(retry.text, /MUST SURVIVE/);
      assert.equal(api.sent.length, 1,
        'the successful retry appends the event exactly once');
      assert.deepEqual(buttonsOf(retry).map((b) => b.text), ['Change Pi', 'Disconnect'],
        'the retried event re-renders its action keyboard');
      pending = fx.store.listPendingBrokerTuiEvents({ limit: 10 });
      assert.equal(pending.length, 0, 'acknowledged only after the full send succeeded');
    } finally { fx.close(); }
  });

  test('malformed T03b callback shapes are silently consumed without dispatching', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      fx.busyA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('held while probing'));
      const pid = busyPid(api);
      const sentBefore = api.sent.length;
      const answeredBefore = api.answered.length;
      for (const data of [
        'v1:f:aaa111',            // missing pid
        'v1:t:aaa111:NOTHEX16!!', // bad pid
        `v1:a:aaa111:${pid}x`,    // oversized pid
        'v1:n:aaa111',            // sid where the pid belongs
        'v1:q',                   // missing sid
        'v1:x:AAA',               // bad sid shape
        'v1:d:aaa111:extra',      // extra segment
        'v1:D:aaa111:extra',      // extra segment
        'v1:C:x',                 // cancel takes no argument
      ]) {
        await deliver(broker, api, cb(data));
      }
      assert.equal(api.sent.length, sentBefore,
        'malformed callbacks must produce no reply');
      assert.equal(api.answered.length, answeredBefore + 9,
        'authorized-but-malformed callbacks are still answered best-effort, exactly once each');
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      // The held prompt survived the probing untouched.
      await deliver(broker, api, cb(`v1:f:aaa111:${pid}`));
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].payload.text, 'held while probing');
    } finally { fx.close(); }
  });
});

describe('SelectiveTelegramBroker: beginner commands, stale naming and no-jargon presentation (T04)', () => {
  // Fixture helpers are shared with the T03b describe above; reuse them by
  // constructing a minimal local fixture with the same shape.
  function makeBeginnerFixture() {
    const dir = mkdtempSync(join(TEST_RUNS, 'sel-beginner-'));
    let t = Date.now();
    const now = () => t;
    const store = new Store(join(dir, 'bridge.sqlite'), { now, isProcessAlive: () => true });
    const clientA = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    const clientB = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    return {
      store,
      clientA,
      clientB,
      now,
      advance(ms) { t += ms; },
      connectA() {
        assert.equal(clientA.connect({ ...A, shortId: 'aaa111', label: 'alpha', pid: 1111, cwd: 'C:/proj/alpha' }).ok, true);
      },
      connectB() {
        assert.equal(clientB.connect({ ...B, shortId: 'bbb222', label: 'beta', pid: 2222, cwd: 'C:/proj/beta' }).ok, true);
      },
      busyA() {
        assert.equal(clientA.setState({ ...A, state: 'busy' }).ok, true);
      },
      close() { store.close(); },
    };
  }

  function newBeginnerBroker(fx, api) {
    return new SelectiveTelegramBroker({
      store: fx.store,
      api,
      config: { ...BROKER_CONFIG },
      now: fx.now,
    });
  }

  async function deliver(broker, api, update) {
    broker.handleUpdate(update);
    await broker.flushReplies();
  }

  /** Flatten the inline keyboard of one sent message into button objects. */
  function buttonsOf(sentMessage) {
    return sentMessage.replyMarkup.inline_keyboard.flat();
  }

  /** Buttons of the most recently sent message. */
  function lastButtons(api) {
    return buttonsOf(api.sent[api.sent.length - 1]);
  }

  /** The pending generation id offered by the latest p-buttons. */
  function lastPendingId(api) {
    const button = lastButtons(api).find((b) => b.callback_data.startsWith('v1:p:'));
    return button.callback_data.split(':')[3];
  }

  /** Drop transport leftovers so every test starts from a quiet store. */
  function clearTransport(fx) {
    const pending = fx.store.listPendingBrokerTuiEvents({ limit: 256 });
    if (pending.length > 0) {
      fx.store.acknowledgeTuiEvents({ eventIds: pending.map((e) => e.eventId) });
    }
    while (fx.store.claimNextTuiCommand({ trackingId: A.trackingId, connectionId: A.connectionId }).ok) {}
    while (fx.store.claimNextTuiCommand({ trackingId: B.trackingId, connectionId: B.connectionId }).ok) {}
  }

  /** Collect every text + button pair the broker has sent so far. */
  function visibleText(api) {
    return api.sent.map((m) => m.text).join('\n---\n');
  }

  function visibleButtons(api) {
    const rows = [];
    for (const sent of api.sent) {
      for (const row of sent.replyMarkup?.inline_keyboard ?? []) {
        rows.push(...row.map((b) => b.text));
      }
    }
    return rows;
  }

  const JARGON = ['dpapi', 'broker', 'scheduled task', 'acl', 'argv', 'sqlite', 'long poll', 'pid'];

  test('/start with no live sessions: MSG-T2 guidance, no buttons, no state change', async () => {
    const fx = makeBeginnerFixture();
    try {
      const api = makeFakeApi();
      const broker = newBeginnerBroker(fx, api);
      await deliver(broker, api, msg('/start'));
      assert.equal(api.sent[0].text,
        "You're linked, but no Pi window is connected right now. Open Pi on your PC and type /tg.");
      assert.equal(api.sent[0].replyMarkup, undefined, 'no chooser keyboard without live sessions');
      // Plain text afterwards still fails closed as no-live.
      await deliver(broker, api, msg('anyone there?'));
      assert.match(api.sent[1].text, /was not sent/);
    } finally { fx.close(); }
  });

  test('/start with one live session: auto-selects it, sends MSG-T3 and the action row', async () => {
    const fx = makeBeginnerFixture();
    try {
      fx.connectA();
      const api = makeFakeApi();
      const broker = newBeginnerBroker(fx, api);
      await deliver(broker, api, msg('/start'));
      assert.equal(api.sent[0].text,
        'Connected to Pi · alpha. Just type a message and it goes to that Pi.');
      assert.deepEqual(lastButtons(api).map((b) => b.text),
        ['Status', 'Change Pi', 'Disconnect']);
      // Auto-selection sticks: plain text routes without any /use.
      await deliver(broker, api, msg('straight through'));
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].payload.text, 'straight through');
      assert.match(api.sent[api.sent.length - 1].text, /Pi · alpha — Prompt queued\./);
    } finally { fx.close(); }
  });

  test('/start with several live sessions: MSG-T4 question plus readable chooser, never short ids', async () => {
    const fx = makeBeginnerFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBeginnerBroker(fx, api);
      await deliver(broker, api, msg('/start'));
      assert.equal(api.sent[0].text, 'Which Pi should I talk to?');
      assert.deepEqual(lastButtons(api).map((b) => b.text),
        ['Pi · alpha', 'Pi · beta', 'Refresh']);
      for (const button of lastButtons(api)) {
        assert.ok(!button.callback_data.includes('alpha') && !button.callback_data.includes('beta'));
      }
      assert.doesNotMatch(api.sent[0].text, /aaa111|bbb222/);
    } finally { fx.close(); }
  });

  test('/help opens with the three beginner sentences then lists every advanced command', async () => {
    const fx = makeBeginnerFixture();
    try {
      const api = makeFakeApi();
      const broker = newBeginnerBroker(fx, api);
      await deliver(broker, api, msg('/help'));
      const lines = api.sent[0].text.split('\n');
      assert.equal(lines[0], 'You can talk to Pi by just typing a message here.');
      assert.equal(lines[1], 'To link a Pi window, open Pi on your PC and type /tg.');
      assert.equal(lines[2], 'This private chat only accepts you — the enrolled owner.');
      assert.ok(lines.includes('Advanced commands:'));
      for (const command of ['/sessions', '/use', '/status', '/send', '/steer', '/followup', '/abort', '/disconnect']) {
        assert.ok(api.sent[0].text.includes(command), `advanced help must keep ${command}`);
      }
    } finally { fx.close(); }
  });

  test('unknown slash commands get the friendly /help pointer instead of a rejection', async () => {
    const fx = makeBeginnerFixture();
    try {
      const api = makeFakeApi();
      const broker = newBeginnerBroker(fx, api);
      await deliver(broker, api, msg('/frobnicate everything'));
      assert.equal(api.sent[0].text,
        "I didn't understand that. Send /help to see what I can do.");
      await deliver(broker, api, msg('/'));
      assert.equal(api.sent[1].text,
        "I didn't understand that. Send /help to see what I can do.");
    } finally { fx.close(); }
  });

  test('zero-live plain text says the message was NOT sent and points at /tg', async () => {
    const fx = makeBeginnerFixture();
    try {
      const api = makeFakeApi();
      const broker = newBeginnerBroker(fx, api);
      await deliver(broker, api, msg('dig the garden'));
      assert.match(api.sent[0].text, /was not sent/);
      assert.match(api.sent[0].text, /type \/tg/);
      assert.doesNotMatch(api.sent[0].text, /queued|sent to/i,
        'the no-live reply must never imply the message went through');
    } finally { fx.close(); }
  });

  test('a stale chooser tap names the closed Pi, then offers fresh readable choices', async () => {
    const fx = makeBeginnerFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBeginnerBroker(fx, api);
      await deliver(broker, api, msg('hold me'));
      const pid = lastPendingId(api);
      fx.advance(31_000); // alpha ages out; beta stays live
      fx.clientB.heartbeat(B);
      await deliver(broker, api, cb(`v1:p:aaa111:${pid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      const reply = api.sent[api.sent.length - 1];
      assert.match(reply.text, /Pi · alpha just closed or disconnected\./,
        'the stale reply must name the closed Pi when it is known');
      assert.doesNotMatch(reply.text, /aaa111/);
      assert.deepEqual(lastButtons(api).map((b) => b.text), ['Pi · beta', 'Refresh']);
    } finally { fx.close(); }
  });

  test('a dead sid callback with an unknown label still fails closed into a fresh chooser', async () => {
    const fx = makeBeginnerFixture();
    try {
      fx.connectA();
      const api = makeFakeApi();
      const broker = newBeginnerBroker(fx, api);
      await deliver(broker, api, cb('v1:s:zzz999'));
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      const reply = api.sent[api.sent.length - 1];
      assert.doesNotMatch(reply.text, /just closed or disconnected/,
        'an unknown Pi must not be named');
      assert.deepEqual(lastButtons(api).map((b) => b.text), ['Pi · alpha', 'Refresh']);
    } finally { fx.close(); }
  });

  test('the normal event path renders Pi · <label> everywhere and never the bracket identity', async () => {
    const fx = makeBeginnerFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      fx.busyA();
      const api = makeFakeApi();
      const broker = newBeginnerBroker(fx, api);
      assert.equal(fx.store.appendTuiEvent({ trackingId: A.trackingId, kind: 'connected', payload: null }).ok, true);
      assert.equal(fx.clientA.publishStatus({ ...A, payload: { state: 'busy', model: 'm', cwd: 'C:/proj/alpha', pid: 42, piSessionId: 'sess9' } }).ok, true);
      assert.equal(fx.clientA.publishFinalOutput({ ...A, text: 'HARVEST READY' }).ok, true);
      await broker.drainTuiEvents();
      const all = visibleText(api);
      assert.match(all, /Pi · alpha is connected\./);
      assert.match(all, /Pi · alpha status/);
      assert.match(all, /Pi · alpha\nHARVEST READY/);
      assert.doesNotMatch(all, /\[alpha · aaa111\]/);
      assert.doesNotMatch(all, /aaa111|C:\/proj|pid|sess9/);
      assert.match(visibleButtons(api).join(','), /Status|Change Pi/,
        'action cards keep their T03b keyboards');
    } finally { fx.close(); }
  });

  test('no normal-path text or button ever carries short ids or jargon (BEGINNER_UX.md section 2)', async () => {
    const fx = makeBeginnerFixture();
    try {
      fx.connectA();
      fx.connectB();
      fx.busyA();
      const api = makeFakeApi();
      const broker = newBeginnerBroker(fx, api);
      await deliver(broker, api, msg('/start'));
      await deliver(broker, api, msg('water the tomatoes'));
      await deliver(broker, api, msg('/help'));
      await deliver(broker, api, cb('v1:q:bbb222'));
      await deliver(broker, api, cb('v1:c'));
      assert.equal(fx.store.appendTuiEvent({ trackingId: A.trackingId, kind: 'connected', payload: null }).ok, true);
      await broker.drainTuiEvents();
      const all = `${visibleText(api)}\n${visibleButtons(api).join('\n')}`;
      assert.doesNotMatch(all, /aaa111|bbb222/,
        'short ids must never surface on the normal path');
      // The advanced help block is explicitly labeled; everything before
      // the first label is the beginner-only surface and must stay
      // jargon-free. "broker" is allowed only after the label.
      const firstAdvanced = all.indexOf('Advanced commands:');
      assert.ok(firstAdvanced >= 0, 'the advanced block must be explicitly labeled');
      const beginnerSurface = all.slice(0, firstAdvanced);
      for (const word of JARGON) {
        assert.doesNotMatch(beginnerSurface, new RegExp(word.replace(' ', '\\s+'), 'i'),
          `jargon "${word}" must never surface on the beginner surface`);
      }
      for (const match of all.matchAll(/broker/gi)) {
        assert.ok(match.index > firstAdvanced,
          '"broker" may appear only inside the labeled advanced block');
      }
    } finally { fx.close(); }
  });

  test('advanced routed commands keep T02 semantics across zero and multiple live sessions (T04 correction)', async () => {
    const fx = makeBeginnerFixture();
    try {
      const api = makeFakeApi();
      const broker = newBeginnerBroker(fx, api);
      // ZERO live sessions: the five advanced routed commands keep the
      // selection-required fail closed — never the beginner no-live
      // guidance. Missing required text still wins FIRST, before target
      // resolution, regardless of the live-session count. The first text
      // token carries punctuation ('dig,') so no token matches SHORT_ID_RE.
      const zeroLiveCases = [
        ['/send dig, now', /Send \/use <shortId>/],
        ['/steer stay, low', /Send \/use <shortId>/],
        ['/followup later, please', /Send \/use <shortId>/],
        ['/abort', /Send \/use <shortId>/],
        ['/disconnect', /Send \/use <shortId>/],
        ['/send', /Usage: \/send \[shortId\] <text>/],
        ['/steer', /Usage: \/steer \[shortId\] <text>/],
        ['/followup', /Usage: \/followup \[shortId\] <text>/],
      ];
      for (const [i, [command, expected]] of zeroLiveCases.entries()) {
        await deliver(broker, api, msg(command));
        assert.match(api.sent[i].text, expected,
          `${command} with zero live sessions must keep its T02 response`);
        assert.doesNotMatch(api.sent[i].text, /There's no Pi connected right now/,
          `${command} must never receive the beginner no-live guidance`);
      }
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      assert.equal(fx.clientB.poll(B).commands.length, 0);

      // MULTIPLE live sessions, no selection: identical fail closed.
      fx.connectA();
      fx.connectB();
      const multiCases = [
        ['/send dig, now', /Send \/use <shortId>/],
        ['/steer stay, low', /Send \/use <shortId>/],
        ['/followup later, please', /Send \/use <shortId>/],
        ['/abort', /Send \/use <shortId>/],
        ['/disconnect', /Send \/use <shortId>/],
      ];
      const multiBase = api.sent.length;
      for (const [i, [command, expected]] of multiCases.entries()) {
        await deliver(broker, api, msg(command));
        assert.match(api.sent[multiBase + i].text, expected,
          `${command} with several live sessions must keep its T02 response`);
        assert.doesNotMatch(api.sent[multiBase + i].text, /aaa111|bbb222/);
      }
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      assert.equal(fx.clientB.poll(B).commands.length, 0,
        'no advanced command may dispatch without a selection or explicit id');

      // Explicit-id commands keep the existing unknown-target response and
      // NEVER auto-select; a live explicit id routes to that exact Pi.
      const explicitBase = api.sent.length;
      await deliver(broker, api, msg('/send zzz999 hi'));
      assert.match(api.sent[explicitBase].text, /No live session with short id "zzz999"/);
      await deliver(broker, api, msg('/abort bbb222'));
      assert.equal(api.sent[explicitBase + 1].text, 'Pi · beta — Abort queued.');
      const bCommands = fx.clientB.poll(B).commands;
      assert.equal(bCommands.length, 1);
      assert.equal(bCommands[0].kind, 'abort');
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'an explicit-id command must never leak onto another live session');
    } finally { fx.close(); }
  });
});

describe('broker runtime config: selective shape, legacy compatibility, fail closed', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'sel-cfg-'));
  });

  function tempConfig(content) {
    const path = join(dir, `runtime-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
    return path;
  }

  const SELECTIVE = {
    version: 1,
    instanceId: 'a'.repeat(32),
    bridge: { mode: 'selective' },
  };
  const LEGACY = {
    version: 1,
    instanceId: 'b'.repeat(32),
    pi: { cliPath: 'C:/pi/cli.js', workspace: 'C:/repo' },
    bridge: { followupsEnabled: false },
  };

  test('accepts the selective shape and requires no pi object', () => {
    const config = loadBrokerRuntimeConfig(tempConfig(SELECTIVE));
    assert.equal(config.mode, 'selective');
    assert.equal(config.version, 1);
    assert.equal(config.instanceId, 'a'.repeat(32));
    assert.deepEqual(config.bridge, { mode: 'selective' });
    assert.ok(!('pi' in config), 'the broker must not require pi discovery');
  });

  test('keeps the legacy headless shape readable for compatibility', () => {
    const config = loadBrokerRuntimeConfig(tempConfig(LEGACY));
    assert.equal(config.mode, 'legacy-headless');
    assert.deepEqual(config.pi, { cliPath: 'C:/pi/cli.js', workspace: 'C:/repo' });
    assert.deepEqual(config.bridge, { followupsEnabled: false });
  });

  test('invalid keys, shapes and identities fail closed with fixed codes', () => {
    // Selective shape violations.
    assert.throws(() => loadBrokerRuntimeConfig(tempConfig({ ...SELECTIVE, surprise: 1 })),
      (e) => e instanceof RuntimeConfigError && e.code === 'bad_config');
    assert.throws(() => loadBrokerRuntimeConfig(tempConfig({ ...SELECTIVE, bridge: { mode: 'headless' } })),
      (e) => e.code === 'bad_config');
    assert.throws(() => loadBrokerRuntimeConfig(tempConfig({ ...SELECTIVE, bridge: { mode: 'selective', extra: true } })),
      (e) => e.code === 'bad_config');
    assert.throws(() => loadBrokerRuntimeConfig(tempConfig({ version: 1, instanceId: 'a'.repeat(32) })),
      (e) => e.code === 'bad_config', 'the bridge section is mandatory in the selective shape');
    // Legacy shape violations (identical strictness to the headless host).
    assert.throws(() => loadBrokerRuntimeConfig(tempConfig({ ...LEGACY, bridge: { followupsEnabled: 'yes' } })),
      (e) => e.code === 'bad_config');
    assert.throws(() => loadBrokerRuntimeConfig(tempConfig({ ...LEGACY, instanceId: 'short' })),
      (e) => e.code === 'bad_config');
    assert.throws(() => loadBrokerRuntimeConfig(tempConfig({
      version: 1, instanceId: 'b'.repeat(32), bridge: { followupsEnabled: false },
    })), (e) => e.code === 'bad_config', 'a legacy config without pi stays rejected');
    // Missing file.
    assert.throws(
      () => loadBrokerRuntimeConfig(join(dir, `missing-${Date.now()}.json`)),
      (e) => e instanceof RuntimeConfigError && e.code === 'no_config',
    );
  });
});
