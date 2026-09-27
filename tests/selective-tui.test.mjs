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
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../src/store.mjs';
import { TuiBridgeClient } from '../src/tui-bridge-client.mjs';
import { SelectiveTelegramBroker } from '../src/selective-telegram-broker.mjs';
import {
  MAX_BUTTON_TEXT_CHARS,
  PROJECT_COLOR_SLOTS,
  PROJECT_COLOR_FALLBACK,
  projectColor,
  liveStateMarker,
  liveStateText,
  projectRowLabel,
} from '../src/beginner-copy.mjs';
import { RuntimeConfigError, loadBrokerRuntimeConfig } from '../src/runtime-config.mjs';
import * as copyModule from '../src/beginner-copy.mjs';

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

  test('/sessions lists live TUIs as short id, safe identity header and state — never cwd', async () => {
    clearTransport();
    const api = makeFakeApi();
    const broker = newBroker(api);
    await deliver(broker, api, msg('/sessions'));
    assert.equal(api.sent.length, 1);
    const text = api.sent[0].text;
    assert.match(text, /Live TUI sessions:/);
    assert.match(text, /tg:aaa111 · .+ Pi · alpha · state: connected/);
    assert.match(text, /tg:bbb222 · .+ Pi · beta · state: connected/);
    assert.doesNotMatch(text, /C:[\\/]/, 'cwd must never be sent to Telegram');
    assert.doesNotMatch(text, /proj/, 'no cwd path fragment may be sent');
    assert.doesNotMatch(text, /1111|2222/, 'pids must never be sent');
  });

  test('/use selects a live session, refuses malformed ids and misses unknown ids', async () => {
    clearTransport();
    const api = makeFakeApi();
    const broker = newBroker(api);
    await deliver(broker, api, msg('/use aaa111'));
    assert.equal(api.sent[0].text, '🟫 Pi · alpha — Selected.');
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
    assert.ok(api.sent.some((m) => m.text === '🟪 Pi · beta — command failed (input_refused).'));
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
      assert.equal(api.sent[0].text, '🟪 Pi · beta — Selected.');
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
    const button = lastButtons(api).find((b) => (b.callback_data ?? '').startsWith('v1:p:'));
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
      assert.equal(buttons[0].text, 'Active now');
      assert.deepEqual(buttons[0], { text: 'Active now', disabled: {} },
        'the header must be the native disabled action button with no callback_data');
      assert.match(buttons[1].text, /🟢/);
      assert.match(buttons[1].text, /alpha · Available/);
      assert.match(buttons[2].text, /🟢/);
      assert.match(buttons[2].text, /beta · Available/);
      assert.equal(buttons[3].text, 'Refresh');
      for (const button of buttons) {
        if (button.text === 'Active now') continue; // header asserted above
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
      assert.equal(api.sent[api.sent.length - 1].text, 'Sent to 🟪 Pi · beta.');
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
      // The re-render is the safest current dashboard: no pending left, s-buttons.
      const buttons = lastButtons(api);
      assert.equal(buttons[0].text, 'Active now');
      assert.match(buttons[1].text, /alpha · Available/);
      assert.match(buttons[2].text, /beta · Available/);
      assert.equal(buttons[3].text, 'Refresh');
      assert.ok(buttons.filter((b) => (b.callback_data ?? '').startsWith('v1:s:')).length === 2);
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
      // The dashboard re-renders with only the live session and the SAME
      // pending generation preserved.
      const pButton = lastButtons(api).find((b) => (b.callback_data ?? '').startsWith('v1:p:'));
      assert.ok(pButton !== undefined, 'the re-render must carry p-buttons again');
      assert.match(pButton.text, /beta/);
      const parts = pButton.callback_data.split(':');
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
      assert.equal(buttons[0].text, 'Active now');
      assert.match(buttons[1].text, /alpha · Available/);
      assert.match(buttons[2].text, /beta · Available/);
      assert.equal(buttons[3].text, 'Refresh');
      assert.ok(buttons.every((b) => !(b.callback_data ?? '').startsWith('v1:p:')));
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
      assert.equal(lastButtons(api)[0].text, 'Active now');
      assert.ok(lastButtons(api).every((b) => !(b.callback_data ?? '').startsWith('v1:p:')),
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
      assert.ok(lastButtons(api).every((b) => !(b.callback_data ?? '').startsWith('v1:p:')),
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
      const rendered = api.sent[api.sent.length - 1];
      assert.equal(rendered.text, 'Your Pi projects',
        'a successful select re-renders the Projects dashboard');
      const renderedButtons = buttonsOf(rendered);
      const alphaButton = renderedButtons.find((b) => b.text.includes('alpha'));
      assert.ok(alphaButton.text.startsWith('✓'),
        'the selected row must carry the ✓ prefix');
      assert.equal(alphaButton.style, 'primary');
      assert.equal(renderedButtons.find((b) => b.text.includes('beta')).style, 'success');
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
      assert.equal(api.sent[api.sent.length - 1].text, 'Sent to 🟫 Pi · alpha.');
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
      assert.equal(lastButtons(api)[0].text, 'Active now');
      assert.equal(lastButtons(api).length, 4, 'header + two live rows + Refresh');
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
    const button = lastButtons(api).find((b) => (b.callback_data ?? '').startsWith('v1:f:'));
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
      assert.equal(ack, 'Got it — 🟫 Pi · alpha will see your message right after the current task.');
      assert.doesNotMatch(ack, /aaa111/, 'card acks stay label-only');
      // A second tap on the consumed generation never dispatches twice.
      await deliver(broker, api, cb(`v1:f:aaa111:${pid}`));
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'the consumed generation must be gone');
      // The safest re-render: no pending left, the dashboard's plain
      // selection rows with the ✓/primary selection on the target.
      assert.deepEqual(lastButtons(api).map((b) => b.text),
        ['Active now', '✓ 🟡 🟫 alpha · Working', 'Refresh']);
      assert.ok(lastButtons(api).every((b) => !(b.callback_data ?? '').startsWith('v1:f:')));
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
        "Done — 🟫 Pi · alpha got your message and will adjust what it's doing.");
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
        ['🟫 Pi · alpha — Stopping the current task...', 'Stopped. Your message is on its way to 🟫 Pi · alpha.'],
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
      assert.deepEqual(lastButtons(restartedApi).map((b) => b.text),
        ['Active now', '🟡 🟫 alpha · Working', 'Refresh']);
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
      // The held prompt is preserved: the re-rendered dashboard carries the
      // SAME generation as p-buttons for the live session.
      const buttons = lastButtons(api);
      assert.deepEqual(buttons.map((b) => b.text),
        ['Active now', '🟢 🟪 beta · Available', 'Recent', '⚪ 🟫 alpha · Offline', 'Refresh']);
      const pButton = buttons.find((b) => (b.callback_data ?? '').startsWith('v1:p:'));
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
      assert.equal(api.sent[api.sent.length - 1].text, 'Status requested for 🟫 Pi · alpha.');
      // x: exactly one abort command; the ack is the truthful QUEUED
      // wording — the abort is enqueued, not yet completed.
      await deliver(broker, api, cb('v1:x:aaa111'));
      commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'abort');
      assert.equal(api.sent[api.sent.length - 1].text, '🟫 Pi · alpha — Stopping the current task...');
      // c: the Projects dashboard, no dispatch.
      await deliver(broker, api, cb('v1:c'));
      assert.equal(lastButtons(api)[0].text, 'Active now');
      assert.match(lastButtons(api)[1].text, /alpha · Available/);
      assert.equal(lastButtons(api)[2].text, 'Refresh');
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      // d: a readable confirmation card with Unlink (D) and Cancel (C).
      await deliver(broker, api, cb('v1:d:aaa111'));
      const confirmText = api.sent[api.sent.length - 1].text;
      assert.match(confirmText, /Unlink 🟫 Pi · alpha\?/u);
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
      assert.equal(api.sent[api.sent.length - 1].text, 'Unlinking 🟫 Pi · alpha.');
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
      // The safest re-render lists only the live session under Active now.
      assert.equal(lastButtons(api)[0].text, 'Active now');
      assert.match(lastButtons(api)[1].text, /beta · Available/);
    } finally { fx.close(); }
  });

  test('the connected event card carries the action row; Stop renders only while busy', async () => {
    const fx = makeFixture();
    try {
      clearTransport(fx);
      fx.connectA();
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      // Idle connected session: Status, Projects, Disconnect — no Stop.
      assert.equal(fx.store.appendTuiEvent({ trackingId: A.trackingId, kind: 'connected', payload: null }).ok, true);
      await broker.drainTuiEvents();
      assert.match(api.sent[api.sent.length - 1].text, /Pi · alpha is connected\./);
      assert.deepEqual(lastButtons(api).map((b) => b.text),
        ['Status', 'Projects', 'Disconnect']);
      for (const button of lastButtons(api)) {
        assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64);
        assert.ok(!button.callback_data.startsWith('v1:x:'),
          'Stop must be absent while the state is not busy');
      }
      // Busy session: the same row gains Stop between Status and Projects.
      fx.busyA();
      assert.equal(fx.store.appendTuiEvent({ trackingId: A.trackingId, kind: 'connected', payload: null }).ok, true);
      await broker.drainTuiEvents();
      const busyRow = lastButtons(api);
      assert.deepEqual(busyRow.map((b) => b.text),
        ['Status', 'Stop the task', 'Projects', 'Disconnect']);
      assert.equal(busyRow.find((b) => b.text === 'Stop the task').callback_data, 'v1:x:aaa111');
    } finally { fx.close(); }
  });

  test('final-output events carry only Projects and Disconnect while live — never Stop', async () => {
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
      assert.deepEqual(buttons.map((b) => b.text), ['Projects', 'Disconnect']);
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
      assert.deepEqual(buttonsOf(retry).map((b) => b.text), ['Projects', 'Disconnect'],
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
    const button = lastButtons(api).find((b) => (b.callback_data ?? '').startsWith('v1:p:'));
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
        'Connected to 🟫 Pi · alpha. Just type a message and it goes to that Pi.');
      assert.deepEqual(lastButtons(api).map((b) => b.text),
        ['Status', 'Projects', 'Disconnect']);
      // Auto-selection sticks: plain text routes without any /use.
      await deliver(broker, api, msg('straight through'));
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].payload.text, 'straight through');
      assert.match(api.sent[api.sent.length - 1].text, /Pi · alpha — Prompt queued\./);
    } finally { fx.close(); }
  });

  test('/start with several live sessions: opens the Projects dashboard, never short ids', async () => {
    const fx = makeBeginnerFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newBeginnerBroker(fx, api);
      await deliver(broker, api, msg('/start'));
      assert.equal(api.sent[0].text, 'Your Pi projects');
      const buttons = lastButtons(api);
      assert.equal(buttons[0].text, 'Active now');
      assert.match(buttons[1].text, /alpha · Available/);
      assert.match(buttons[2].text, /beta · Available/);
      assert.equal(buttons[3].text, 'Refresh');
      for (const button of buttons) {
        const callbackData = button.callback_data ?? '';
        assert.ok(!callbackData.includes('alpha') && !callbackData.includes('beta'));
      }
      assert.doesNotMatch(api.sent[0].text, /aaa111|bbb222/);
      assert.equal(fx.clientA.poll(A).commands.length, 0, '/start must enqueue nothing');
      assert.equal(fx.clientB.poll(B).commands.length, 0);
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
      for (const command of ['/projects', '/sessions', '/use', '/status', '/send', '/steer', '/followup', '/abort', '/disconnect']) {
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
      assert.equal(lastButtons(api)[0].text, 'Active now');
      assert.match(lastButtons(api)[1].text, /beta · Available/);
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
      assert.equal(lastButtons(api)[0].text, 'Active now');
      assert.match(lastButtons(api)[1].text, /alpha · Available/);
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
      assert.match(visibleButtons(api).join(','), /Status|Projects/,
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
      assert.equal(api.sent[explicitBase + 1].text, '🟪 Pi · beta — Abort queued.');
      const bCommands = fx.clientB.poll(B).commands;
      assert.equal(bCommands.length, 1);
      assert.equal(bCommands[0].kind, 'abort');
      assert.equal(fx.clientA.poll(A).commands.length, 0,
        'an explicit-id command must never leak onto another live session');
    } finally { fx.close(); }
  });
});

describe('SelectiveTelegramBroker: /sessions safe listing', () => {
  const E = Object.freeze({ trackingId: 'e'.repeat(32), connectionId: '5'.repeat(32) });
  const ALPHA = Object.freeze({ shortId: 'aaa111', label: 'alpha', cwd: 'C:/proj/alpha' });
  const BETA = Object.freeze({ shortId: 'bbb222', label: 'beta', cwd: 'C:/proj/beta' });

  /** Fresh store + per-session clients with branch/state support. */
  function makeFixture() {
    const dir = mkdtempSync(join(TEST_RUNS, 'sel-sessions-'));
    let t = Date.now();
    const now = () => t;
    const store = new Store(join(dir, 'bridge.sqlite'), { now, isProcessAlive: () => true });
    const sessions = [];
    return {
      store,
      now,
      connect(id, { shortId, label, cwd, branch = null, state = null }) {
        const client = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
        assert.equal(client.connect({ ...id, shortId, label, cwd, branch, pid: 4242 + sessions.length }).ok, true);
        if (state !== null) {
          assert.equal(client.setState({ ...id, state }).ok, true);
        }
        sessions.push({ id, client });
        return client;
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

  /** The one /sessions row for a short id, or ''. */
  function lineFor(text, shortId) {
    return text.split('\n').find((line) => line.startsWith(`tg:${shortId} `)) ?? '';
  }

  test('the row keeps tg:<shortId> and the safe identity header carries the branch when present, nothing extra when missing', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, { ...ALPHA, branch: 'feature/x', state: 'busy' });
      fx.connect(B, BETA);
      const api = makeFakeApi();
      await deliver(newBroker(fx, api), api, msg('/sessions'));
      const text = api.sent[0].text;
      assert.match(lineFor(text, 'aaa111'),
        /tg:aaa111 · .+ Pi · alpha · feature\/x · state: busy/);
      assert.match(lineFor(text, 'bbb222'),
        /tg:bbb222 · .+ Pi · beta · state: connected/);
      assert.ok(!text.includes('C:/proj'), 'cwd must never be sent');
    } finally { fx.close(); }
  });

  test('alias precedence: session alias, then project alias, then label; same-project windows stay distinct', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, { ...ALPHA, state: 'waiting' });
      fx.connect(E, { shortId: 'eee555', label: 'alpha two', cwd: 'C:/proj/alpha' });
      fx.connect(B, BETA);
      const projectKey = fx.store
        .getTuiSession({ trackingId: A.trackingId, staleCutoff: fx.now() - 30_000 })
        .projectKey;
      const betaKey = fx.store
        .getTuiSession({ trackingId: B.trackingId, staleCutoff: fx.now() - 30_000 })
        .projectKey;
      assert.notEqual(projectKey, betaKey, 'alpha and beta must be distinct projects');
      assert.equal(fx.store.setTuiProjectAlias({ projectKey, alias: 'proj name' }).ok, true);
      assert.equal(fx.store.setTuiProjectAlias({ projectKey: betaKey, alias: 'beta proj' }).ok, true);
      assert.equal(fx.store.setTuiSessionAlias({ trackingId: A.trackingId, alias: 'mine' }).ok, true);
      assert.equal(fx.store.setTuiSessionAlias({ trackingId: E.trackingId, alias: 'second' }).ok, true);
      const api = makeFakeApi();
      await deliver(newBroker(fx, api), api, msg('/sessions'));
      const text = api.sent[0].text;
      assert.match(lineFor(text, 'aaa111'), /tg:aaa111 · .+ Pi · mine · state: waiting/,
        'the session alias must win over the project alias');
      assert.match(lineFor(text, 'eee555'), /tg:eee555 · .+ Pi · second · state: connected/,
        'a same-project sibling shows its own distinct window alias');
      assert.match(lineFor(text, 'bbb222'), /tg:bbb222 · .+ Pi · beta proj · state: connected/,
        'a window without a session alias falls back to its own project alias');
    } finally { fx.close(); }
  });

  test('hostile label, cwd, pid and id material never leak; the state word survives', async () => {
    const fx = makeFixture();
    try {
      const hostileLabel = `alpha tg:zzz999 ${'a'.repeat(16)} C:/secret/path pid 42`;
      fx.connect(A, { shortId: 'aaa111', label: hostileLabel, cwd: 'C:/secret/real-cwd' });
      const api = makeFakeApi();
      await deliver(newBroker(fx, api), api, msg('/sessions'));
      const text = api.sent[0].text;
      assert.match(lineFor(text, 'aaa111'), /^tg:aaa111 · .+ Pi · .+ · state: connected$/);
      assert.ok(!text.includes('C:/secret'), 'cwd must never appear');
      assert.ok(!text.includes('tg:zzz999'), 'a hostile short-id-looking token must never appear');
      assert.ok(!text.includes('a'.repeat(16)), 'tracking-id material must never appear');
      assert.ok(!text.includes('pid 42'), 'pid material must never appear');
      assert.ok(!text.includes('4242'), 'real pids must never appear');
    } finally { fx.close(); }
  });

  test('a session connected without cwd still renders a complete safe line', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, { shortId: 'aaa111', label: 'alpha', cwd: undefined });
      const api = makeFakeApi();
      await deliver(newBroker(fx, api), api, msg('/sessions'));
      const text = api.sent[0].text;
      assert.match(lineFor(text, 'aaa111'), /tg:aaa111 · .+ Pi · alpha · state: connected/);
      assert.ok(!text.includes('undefined'), 'a missing cwd must never render as undefined');
      assert.ok(!text.includes(' - '), 'no placeholder column is rendered anymore');
    } finally { fx.close(); }
  });

  test('zero live sessions keeps the advanced no-live notice unchanged', async () => {
    const fx = makeFixture();
    try {
      const api = makeFakeApi();
      await deliver(newBroker(fx, api), api, msg('/sessions'));
      assert.equal(api.sent.length, 1);
      assert.equal(api.sent[0].replyMarkup, undefined);
      assert.match(api.sent[0].text, /No Pi session is connected/);
      assert.match(api.sent[0].text, /\/sessions/);
      assert.doesNotMatch(api.sent[0].text, /Live TUI sessions:/);
    } finally { fx.close(); }
  });

  test('more than 32 live sessions still cap the list with the same summary line', async () => {
    const fx = makeFixture();
    try {
      for (let i = 0; i < 33; i++) {
        const id = {
          trackingId: i.toString(16).padStart(32, '0'),
          connectionId: (i + 1).toString(16).padStart(32, '0'),
        };
        fx.connect(id, { shortId: `s${i.toString().padStart(5, '0')}`, label: `win${i}`, cwd: `C:/proj/${i}` });
      }
      const api = makeFakeApi();
      await deliver(newBroker(fx, api), api, msg('/sessions'));
      const lines = api.sent[0].text.split('\n');
      assert.equal(lines[0], 'Live TUI sessions:');
      const rows = lines.filter((line) => line.startsWith('tg:'));
      assert.equal(rows.length, 32, 'exactly 32 session rows are listed');
      assert.equal(lines[lines.length - 1], '…and 1 more.', 'the overflow summary is unchanged');
      assert.ok(rows.every((line) => !line.includes('C:/proj')), 'capped rows are still cwd-free');
    } finally { fx.close(); }
  });
});

describe('SelectiveTelegramBroker: Projects dashboard (T3)', () => {
  const C = Object.freeze({ trackingId: 'c'.repeat(32), connectionId: '3'.repeat(32) });
  const D = Object.freeze({ trackingId: 'd'.repeat(32), connectionId: '4'.repeat(32) });

  const ALPHA = Object.freeze({ shortId: 'aaa111', label: 'alpha', cwd: 'C:/proj/alpha' });
  const BETA = Object.freeze({ shortId: 'bbb222', label: 'beta', cwd: 'C:/proj/beta' });
  const GAMMA = Object.freeze({ shortId: 'ccc333', label: 'gamma', cwd: 'C:/proj/gamma' });
  const DELTA = Object.freeze({ shortId: 'ddd444', label: 'delta', cwd: 'C:/proj/delta' });

  /** Fresh store + per-session clients, with project history helpers. */
  function makeFixture() {
    const dir = mkdtempSync(join(TEST_RUNS, 'sel-projects-'));
    let t = Date.now();
    const now = () => t;
    const store = new Store(join(dir, 'bridge.sqlite'), { now, isProcessAlive: () => true });
    const sessions = [];
    return {
      store,
      now,
      advance(ms) { t += ms; },
      connect(id, { shortId, label, cwd, branch = null, state = null }) {
        const client = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
        assert.equal(client.connect({ ...id, shortId, label, cwd, branch, pid: 4000 + sessions.length }).ok, true);
        if (state !== null) {
          assert.equal(client.setState({ ...id, state }).ok, true);
        }
        sessions.push({ id, client });
        return client;
      },
      disconnect(id) {
        const entry = sessions.find((s) => s.id.trackingId === id.trackingId);
        assert.ok(entry, 'the session to disconnect must exist');
        assert.equal(entry.client.disconnect({ ...id }).ok, true);
      },
      /** Poll every fixture session; returns every claimed command. */
      pollAllCommands() {
        const commands = [];
        for (const { id, client } of sessions) {
          commands.push(...client.poll(id).commands);
        }
        return commands;
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

  /** One button per row on the dashboard: take the first button of each row. */
  function rowButtons(api) {
    const markup = api.sent[api.sent.length - 1].replyMarkup;
    return (markup?.inline_keyboard ?? []).map((row) => row[0]);
  }

  function lastPendingId(api) {
    const markup = api.sent[api.sent.length - 1].replyMarkup;
    const button = (markup?.inline_keyboard ?? []).flat().find((b) => (b.callback_data ?? '').startsWith('v1:p:'));
    return button.callback_data.split(':')[3];
  }

  const colorOf = (text) => text.match(new RegExp(`[${PROJECT_COLOR_SLOTS.join('')}]`, 'gu'))?.[0];

  // --- copy-layer contracts -------------------------------------------------

  test('the palette maps color slots 0..7 and falls back neutrally on malformed slots', () => {
    assert.deepEqual([...PROJECT_COLOR_SLOTS], ['🟦', '🟪', '🟧', '🟩', '🟨', '🟫', '⬛', '⬜']);
    for (let slot = 0; slot < PROJECT_COLOR_SLOTS.length; slot++) {
      assert.equal(projectColor(slot), PROJECT_COLOR_SLOTS[slot]);
    }
    for (const bad of [-1, 8, 99, 1.5, NaN, null, undefined, '2']) {
      assert.equal(projectColor(bad), PROJECT_COLOR_FALLBACK);
    }
  });

  test('state markers and text are dynamic and color is never the only signal', () => {
    assert.equal(liveStateMarker('connected'), '🟢');
    assert.equal(liveStateText('connected'), 'Available');
    assert.equal(liveStateMarker('busy'), '🟡');
    assert.equal(liveStateText('busy'), 'Working');
    assert.equal(liveStateMarker('waiting'), '🟡');
    assert.equal(liveStateText('waiting'), 'Waiting');
    assert.equal(liveStateMarker('disconnected'), '⚪');
    assert.equal(liveStateText('disconnected'), 'Offline');
    assert.equal(liveStateMarker(undefined), '⚪');
    assert.equal(liveStateText(undefined), 'Offline');
  });

  test('row labels are bounded to 64 chars, sanitized, and prefer the alias', () => {
    const bounded = projectRowLabel({
      colorSlot: 0, state: 'connected', name: 'x'.repeat(200), branch: 'feature/one',
    });
    assert.ok(bounded.length <= MAX_BUTTON_TEXT_CHARS, `row label must fit one button: ${bounded.length}`);
    assert.match(bounded, /🟢/);
    assert.match(bounded, /Available/);
    assert.doesNotMatch(bounded, /feature/,
      'the branch must be dropped before the name and state word are trimmed');
    const withBranch = projectRowLabel({ colorSlot: 1, state: 'connected', name: 'alpha', branch: 'feature/one' });
    assert.match(withBranch, /feature\/one/);
    assert.ok(projectRowLabel({ colorSlot: 1, state: 'connected', name: 'alpha', branch: null }).includes('alpha'));
    const selected = projectRowLabel({ selected: true, colorSlot: 3, state: 'connected', name: 'alpha' });
    assert.ok(selected.startsWith('✓ '), 'the selected row must be prefixed with ✓');
    const sanitized = projectRowLabel({
      colorSlot: 0, state: 'connected',
      name: `alpha tg:zzz999 ${'a'.repeat(32)} C:/secret/path pid 42`,
      branch: null,
    });
    assert.doesNotMatch(sanitized, /tg:|C:\/secret|pid|aaaaaaaa/);
    const offline = projectRowLabel({ colorSlot: null, state: null, offline: true, name: '' });
    assert.match(offline, /⚪/);
    assert.match(offline, /Offline/);
  });

  test('row labels always retain the state word under hostile alias+branch in every state', () => {
    // Code-point-safe lone-surrogate probe (Telegram must never see a split pair).
    const NO_LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const hostile = { name: 'x'.repeat(200), branch: `feature/${'y'.repeat(60)}` };
    const cases = [
      [{ state: 'connected' }, 'Available'],
      [{ state: 'busy' }, 'Working'],
      [{ state: 'waiting' }, 'Waiting'],
      [{ state: 'disconnected' }, 'Offline'],
      [{ offline: true }, 'Offline'],
      [{ }, 'Offline'],
    ];
    for (const [overrides, word] of cases) {
      const label = projectRowLabel({ selected: true, colorSlot: 2, ...hostile, ...overrides });
      assert.ok(label.length <= MAX_BUTTON_TEXT_CHARS, `over bound for ${word}: ${label.length}`);
      assert.ok(label.includes(`· ${word}`), `the state word must survive for ${word}: ${label}`);
      assert.ok(label.startsWith('✓ '), `the selected prefix must survive for ${word}: ${label}`);
      assert.match(label, /🟧/, `the color slot must survive for ${word}: ${label}`);
      assert.doesNotMatch(label, NO_LONE_SURROGATE, `lone surrogate for ${word}: ${label}`);
    }
    // A branch only appears when it fits entirely; the name is budgeted first.
    const dropped = projectRowLabel({ colorSlot: 0, state: 'connected', name: 'n'.repeat(64), branch: 'y'.repeat(60) });
    assert.ok(dropped.length <= 64 && dropped.includes('· Available'),
      `state word lost: ${dropped}`);
    assert.doesNotMatch(dropped, /yyy/, 'a branch without room must be dropped entirely');
    // Clipping must split code points, never surrogate pairs: with a naive
    // UTF-16 slice the 46th unit would land inside the first emoji.
    const clipped = projectRowLabel({
      colorSlot: 0, state: 'connected',
      name: 'a'.repeat(45) + '😀'.repeat(5) + 'b'.repeat(20),
      branch: null,
    });
    assert.ok(clipped.length <= MAX_BUTTON_TEXT_CHARS);
    assert.doesNotMatch(clipped, NO_LONE_SURROGATE, `lone surrogate: ${clipped}`);
    assert.ok(clipped.includes('😀'), 'an emoji inside the budget must survive intact');
  });

  // --- dashboard rendering ---------------------------------------------------

  test('/projects with zero live and zero recent sessions shows the no-live guidance without buttons', async () => {
    const fx = makeFixture();
    try {
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/projects'));
      assert.equal(api.sent[0].text,
        "You're linked, but no Pi window is connected right now. Open Pi on your PC and type /tg.");
      assert.equal(api.sent[0].replyMarkup, undefined, 'no rows without any project');
      assert.equal(fx.pollAllCommands().length, 0, 'opening the dashboard enqueues nothing');
    } finally { fx.close(); }
  });

  test('/projects with zero live but recent history renders only disabled Recent rows', async () => {
    const fx = makeFixture();
    try {
      fx.connect(C, GAMMA);
      fx.disconnect(C);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/projects'));
      const rows = rowButtons(api);
      assert.equal(rows.length, 3, 'Recent header + one recent row + Refresh');
      assert.equal(rows[0].text, 'Recent');
      assert.deepEqual(rows[0], { text: 'Recent', disabled: {} },
        'the Recent header must be a native disabled button with no callback_data');
      assert.match(rows[1].text, /⚪/);
      assert.match(rows[1].text, /gamma/);
      assert.match(rows[1].text, /Offline/);
      assert.deepEqual({ ...rows[1], text: 'x' }, { text: 'x', disabled: {} },
        'recent rows must be disabled and carry no callback_data');
      assert.equal(rows[2].text, 'Refresh');
      assert.equal(fx.pollAllCommands().length, 0, 'opening the dashboard enqueues nothing');
    } finally { fx.close(); }
  });

  test('/projects partitions Active now and Recent, newest first, one row per item', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      fx.connect(C, GAMMA);
      fx.disconnect(C);
      fx.advance(1_000);
      fx.connect(D, DELTA);
      fx.disconnect(D);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/projects'));
      const rows = rowButtons(api);
      const texts = rows.map((b) => b.text);
      assert.equal(texts[0], 'Active now');
      assert.match(texts[1], /alpha/);
      assert.match(texts[2], /beta/);
      assert.equal(texts[3], 'Recent');
      assert.match(texts[4], /delta/, 'the most recently seen project comes first');
      assert.match(texts[5], /gamma/);
      assert.equal(texts.length, 7, 'two headers + two live rows + two recent rows + Refresh');
      for (const text of texts.slice(4)) {
        assert.doesNotMatch(text, /alpha|beta/, 'active projects are excluded from Recent');
      }
      for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
        assert.equal(texts.filter((t) => t.includes(name)).length, 1,
          `${name} must appear on exactly one row`);
      }
      assert.deepEqual({ ...rows[4], text: 'x' }, { text: 'x', disabled: {} },
        'the Recent header must be a native disabled button with no callback_data');
      assert.equal(rows[1].callback_data, 'v1:s:aaa111');
    } finally { fx.close(); }
  });

  test('multiple live sessions in one project stay separate rows with the same color', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, { ...BETA, cwd: 'C:/proj/alpha', label: 'alpha two' });
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/projects'));
      const texts = rowButtons(api).map((b) => b.text);
      assert.equal(texts[0], 'Active now');
      assert.match(texts[1], /alpha/);
      assert.match(texts[2], /alpha two/);
      assert.equal(texts.length, 4, 'two session rows + header + Refresh');
      assert.ok(colorOf(texts[1]) !== undefined, 'each row carries a project color glyph');
      assert.equal(colorOf(texts[1]), colorOf(texts[2]),
        'the same project must render the same stable color on every row');
    } finally { fx.close(); }
  });

  test('live rows carry the same stable color glyph the store assigns to the project', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/projects'));
      const projects = fx.store.listRecentTuiProjects({ since: fx.now() - 60_000 });
      const slotByLabel = new Map(projects.map((p) => [p.label, p.colorSlot]));
      const texts = rowButtons(api).map((b) => b.text);
      for (const [index, name] of [[1, 'alpha'], [2, 'beta']]) {
        const slot = slotByLabel.get(name);
        assert.ok(Number.isInteger(slot), `the store must know a color slot for ${name}`);
        assert.ok(texts[index].includes(PROJECT_COLOR_SLOTS[slot]),
          `the row for ${name} must carry the slot-${slot} color glyph`);
      }
    } finally { fx.close(); }
  });

  test('selected renders ✓ + primary, available success, busy/waiting default', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, { ...BETA, state: 'busy' });
      fx.connect(C, { ...GAMMA, state: 'waiting' });
      fx.connect(D, DELTA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      const rows = rowButtons(api);
      assert.equal(rows[0].text, 'Active now');
      const [alpha, busy, waiting, available] = rows.slice(1, 5);
      assert.equal(alpha.style, 'primary');
      assert.ok(alpha.text.startsWith('✓'), 'the selected row must be prefixed with ✓');
      assert.equal(available.style, 'success');
      assert.ok(!available.text.startsWith('✓'));
      assert.equal(busy.style, undefined, 'busy rows use the default style');
      assert.equal(waiting.style, undefined, 'waiting rows use the default style');
      assert.match(busy.text, /🟡/);
      assert.match(busy.text, /Working/);
      assert.match(waiting.text, /Waiting/);
      assert.equal(fx.pollAllCommands().length, 0, 'selecting enqueues nothing');
    } finally { fx.close(); }
  });

  test('tapping another live row moves the ✓/primary selection and re-renders', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      let rows = rowButtons(api);
      assert.ok(rows[1].text.startsWith('✓'));
      assert.equal(rows[1].style, 'primary');
      assert.equal(rows[2].style, 'success');
      await deliver(broker, api, cb('v1:s:bbb222'));
      rows = rowButtons(api);
      assert.ok(rows[2].text.startsWith('✓'));
      assert.equal(rows[2].style, 'primary');
      assert.equal(rows[1].style, 'success');
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('stale and unknown taps re-render safely and never route', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:zzz999'));
      assert.equal(fx.pollAllCommands().length, 0);
      assert.equal(rowButtons(api)[0].text, 'Active now');
      fx.advance(31_000);
      await deliver(broker, api, cb('v1:s:aaa111'));
      assert.equal(fx.pollAllCommands().length, 0, 'a stale tap must enqueue nothing');
      const rows = rowButtons(api);
      assert.ok(rows.every((b) => !b.text.startsWith('✓')),
        'a stale selection must not mark any row');
      assert.ok(rows.some((b) => b.text === 'Recent'),
        'the aged-out project shows under Recent');
    } finally { fx.close(); }
  });

  test('with a held prompt, active rows carry the current generation; stale taps never dispatch', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('hold this'));
      assert.match(api.sent[api.sent.length - 1].text, /message is saved/);
      const pid = lastPendingId(api);
      const rows = rowButtons(api);
      assert.equal(rows[0].text, 'Active now');
      assert.equal(rows[1].callback_data, `v1:p:aaa111:${pid}`);
      assert.equal(rows[2].callback_data, `v1:p:bbb222:${pid}`);
      await deliver(broker, api, cb(`v1:p:aaa111:${'f'.repeat(16)}`));
      assert.equal(fx.pollAllCommands().length, 0, 'a stale generation must never dispatch');
      await deliver(broker, api, cb(`v1:p:aaa111:${pid}`));
      const commands = fx.pollAllCommands();
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'prompt');
      assert.equal(commands[0].payload.text, 'hold this');
    } finally { fx.close(); }
  });

  test('section headers render as native disabled buttons: no callback_data, no style', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:c'));
      const header = rowButtons(api)[0];
      assert.deepEqual(header, { text: 'Active now', disabled: {} },
        'Telegram Bot API 10.3: disabled is the action field, never a style; '
        + 'with no action field there is nothing to tap');
      // Defense in depth: the retired v1:i grammar is malformed now. It is
      // consumed, answered best-effort, and never replied or dispatched.
      const sentBefore = api.sent.length;
      const answeredBefore = api.answered.length;
      await deliver(broker, api, cb('v1:i'));
      assert.equal(api.sent.length, sentBefore, 'a v1:i tap must not produce a reply');
      assert.equal(api.answered.length, answeredBefore + 1);
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('every rendered callback_data stays within 64 UTF-8 bytes', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/projects'));
      await deliver(broker, api, msg('held for the byte check'));
      await deliver(broker, api, cb('v1:r'));
      for (const sent of api.sent) {
        for (const button of (sent.replyMarkup?.inline_keyboard ?? []).flat()) {
          if (button.callback_data === undefined) {
            assert.deepEqual(button, { text: button.text, disabled: {} },
              'disabled rows carry the action field, never callback_data');
            continue;
          }
          assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64,
            `callback_data over 64 bytes: ${button.callback_data}`);
        }
      }
    } finally { fx.close(); }
  });

  test('dashboard text and buttons never expose cwd, ids, pids or internals', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, { ...ALPHA, label: 'alpha C:/secret/path pid 7' });
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/projects'));
      await deliver(broker, api, cb('v1:s:aaa111'));
      const visible = api.sent.map((m) => {
        const buttons = (m.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.text).join(' | ');
        return `${m.text}\n${buttons}`;
      }).join('\n---\n');
      assert.match(visible, /alpha/);
      assert.doesNotMatch(visible, /C:\/secret|C:\/proj|pid|aaa111|bbb222/);
      assert.doesNotMatch(visible, new RegExp(A.trackingId));
    } finally { fx.close(); }
  });

  test('unauthorized dashboard callbacks are dropped silently without answers or replies', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      for (const update of [
        cb('v1:r', { userId: 999 }),
        cb('v1:c', { chatId: 999 }),
        cb('v1:s:aaa111', { isBot: true }),
      ]) {
        await deliver(broker, api, update);
      }
      assert.equal(api.sent.length, 0);
      assert.equal(api.answered.length, 0);
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('destructive Stop/Disconnect/Unlink controls carry style danger — nothing else does', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/projects'));
      await deliver(broker, api, cb('v1:d:aaa111'));
      assert.equal(fx.store.appendTuiEvent({ trackingId: A.trackingId, kind: 'connected', payload: null }).ok, true);
      await broker.drainTuiEvents();
      // Busy state renders the Stop control too, so v1:x is covered.
      assert.equal(fx.store.setTuiSessionState({ ...A, state: 'busy' }).ok, true);
      assert.equal(fx.store.appendTuiEvent({ trackingId: A.trackingId, kind: 'connected', payload: null }).ok, true);
      await broker.drainTuiEvents();
      const destructive = new Set(['Stop the task', 'Disconnect', 'Unlink']);
      let destructiveSeen = 0;
      for (const sent of api.sent) {
        for (const button of (sent.replyMarkup?.inline_keyboard ?? []).flat()) {
          if (destructive.has(button.text)) {
            destructiveSeen++;
            assert.equal(button.style, 'danger', `${button.text} must be styled danger`);
          } else {
            assert.notEqual(button.style, 'danger', `${button.text} must not be danger`);
          }
        }
      }
      assert.ok(destructiveSeen >= 3, 'Stop, Disconnect and Unlink must actually be rendered');
    } finally { fx.close(); }
  });

  test('v1:c and v1:r open/refresh the dashboard and never enqueue a command', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:c'));
      assert.equal(api.sent[0].text, 'Your Pi projects');
      assert.equal(rowButtons(api)[0].text, 'Active now');
      await deliver(broker, api, cb('v1:r'));
      assert.equal(api.sent[1].text, 'Your Pi projects');
      assert.equal(fx.pollAllCommands().length, 0,
        'opening or refreshing the dashboard must enqueue nothing');
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

describe('SelectiveTelegramBroker: one honest outbound throttle record per episode', () => {
  // A saturated limiter makes every denial deterministic without network:
  // the single outbound token is consumed by one successful send and every
  // later take inside the 60s window is denied with retryAfterMs = 60000.
  const THROTTLED_CONFIG = Object.freeze({
    telegram: { allowedUserId: 101, allowedChatId: 202 },
    bridge: { maxMessageChars: 3800, rateLimit: { max: 1, windowMs: 60_000 } },
  });

  function makeFixture() {
    const dir = mkdtempSync(join(TEST_RUNS, 'sel-throttle-'));
    let t = 1_700_000_000_000;
    const now = () => t;
    const store = new Store(join(dir, 'bridge.sqlite'), { now, isProcessAlive: () => true });
    const clientA = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    return {
      store,
      clientA,
      now,
      advance(ms) { t += ms; },
      connectA() {
        assert.equal(clientA.connect({ ...A, shortId: 'aaa111', label: 'alpha', pid: 1111, cwd: 'C:/proj/alpha' }).ok, true);
      },
      close() { store.close(); },
    };
  }

  function newBroker(fx, api, config = THROTTLED_CONFIG) {
    const logs = [];
    const broker = new SelectiveTelegramBroker({
      store: fx.store,
      api,
      config,
      now: fx.now,
      logger: (event) => logs.push(event),
    });
    return { broker, logs };
  }

  const throttleRecords = (logs) => logs.filter((e) => e.code === 'rate_limited_outbound');
  const pendingEvents = (fx) => fx.store.listPendingBrokerTuiEvents({ limit: 10 });

  /** Drop transport leftovers (connectA appends a connected event) so every
   *  test starts from a quiet store. */
  function clearTransport(fx) {
    const pending = pendingEvents(fx);
    if (pending.length > 0) {
      fx.store.acknowledgeTuiEvents({ eventIds: pending.map((e) => e.eventId) });
    }
    while (fx.store.claimNextTuiCommand({ trackingId: A.trackingId, connectionId: A.connectionId }).ok) {}
  }

  test('a single outbound denial on the drain path records exactly one throttle record', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      clearTransport(fx);
      const api = makeFakeApi();
      const { broker, logs } = newBroker(fx, api);
      // The first event consumes the only outbound token and sends fine.
      assert.equal(fx.clientA.publishFinalOutput({ ...A, text: 'FIRST' }).ok, true);
      await broker.drainTuiEvents();
      assert.equal(api.sent.length, 1);
      assert.equal(throttleRecords(logs).length, 0);
      // The second event is denied: exactly ONE record, with the wait the
      // limiter asked for — never one record per log site.
      assert.equal(fx.clientA.publishFinalOutput({ ...A, text: 'SECOND' }).ok, true);
      await broker.drainTuiEvents();
      const records = throttleRecords(logs);
      assert.equal(records.length, 1,
        `a single denial must produce exactly one record, saw ${records.length}`);
      assert.equal(records[0].retryAfterMs, 60_000,
        'the record must state how long the limiter asked the broker to wait');
      assert.equal(pendingEvents(fx).length, 1, 'the denied event stays pending');
      assert.equal(api.sent.length, 1, 'a denied send transports nothing');
    } finally { fx.close(); }
  });

  test('a persistent throttle across poll cycles records once for the whole episode', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      clearTransport(fx);
      const api = makeFakeApi();
      const { broker, logs } = newBroker(fx, api);
      assert.equal(fx.clientA.publishFinalOutput({ ...A, text: 'FIRST' }).ok, true);
      await broker.drainTuiEvents(); // consumes the token
      assert.equal(fx.clientA.publishFinalOutput({ ...A, text: 'SECOND' }).ok, true);
      await broker.drainTuiEvents(); // denied once: the episode record
      assert.equal(throttleRecords(logs).length, 1);
      for (let cycle = 0; cycle < 5; cycle++) {
        fx.advance(1_000); // one poll-gap step, still inside the throttle window
        await broker.drainTuiEvents();
      }
      assert.equal(throttleRecords(logs).length, 1,
        `a persistent throttle must stay one record per episode, saw ${throttleRecords(logs).length}`);
      assert.equal(api.sent.length, 1, 'the broker does not re-attempt the send while still throttled');
      assert.equal(pendingEvents(fx).length, 1, 'the event keeps waiting, it is never dropped');
    } finally { fx.close(); }
  });

  test('a denial after a successful send is a new episode and records again', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      clearTransport(fx);
      const api = makeFakeApi();
      const { broker, logs } = newBroker(fx, api);
      assert.equal(fx.clientA.publishFinalOutput({ ...A, text: 'FIRST' }).ok, true);
      await broker.drainTuiEvents(); // consumes the token
      assert.equal(fx.clientA.publishFinalOutput({ ...A, text: 'SECOND' }).ok, true);
      await broker.drainTuiEvents(); // denied: episode 1
      assert.equal(throttleRecords(logs).length, 1);
      // Once the window frees, the pending event is delivered and silent.
      fx.advance(60_000);
      await broker.drainTuiEvents();
      assert.equal(api.sent.length, 2);
      assert.match(api.sent[1].text, /SECOND/);
      assert.equal(pendingEvents(fx).length, 0);
      assert.equal(throttleRecords(logs).length, 1, 'the recovery itself must not log');
      // A fresh denial now is a NEW episode and must stay fully visible.
      assert.equal(fx.clientA.publishFinalOutput({ ...A, text: 'THIRD' }).ok, true);
      await broker.drainTuiEvents();
      assert.equal(throttleRecords(logs).length, 2,
        'the edge trigger must never swallow a later real throttling event');
    } finally { fx.close(); }
  });

  test('an unthrottled drain records nothing new and behaves exactly as before', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      clearTransport(fx);
      const api = makeFakeApi();
      const { broker, logs } = newBroker(fx, api, BROKER_CONFIG); // generous limiter
      assert.equal(fx.clientA.publishFinalOutput({ ...A, text: 'PLAIN' }).ok, true);
      await broker.drainTuiEvents();
      assert.equal(api.sent.length, 1);
      assert.match(api.sent[0].text, /PLAIN/);
      assert.equal(pendingEvents(fx).length, 0, 'the event is acknowledged after the send');
      assert.equal(throttleRecords(logs).length, 0, 'a healthy send logs no throttle record');
    } finally { fx.close(); }
  });

  test('a rate-limited queued reply records exactly once and stays queued for retry', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      clearTransport(fx);
      const api = makeFakeApi();
      const { broker, logs } = newBroker(fx, api);
      // A first authorized command consumes the single outbound token.
      broker.handleUpdate(msg('/help'));
      await broker.flushReplies();
      assert.equal(api.sent.length, 1);
      assert.equal(throttleRecords(logs).length, 0);
      // A second reply — a callback query, which bypasses the inbound
      // limiter — is throttled outbound: exactly one record, notice kept.
      broker.handleUpdate(cb('v1:c'));
      await broker.flushReplies();
      assert.equal(throttleRecords(logs).length, 1,
        `the flush path must produce exactly one record, saw ${throttleRecords(logs).length}`);
      // Once the window frees, the kept notice is delivered — never lost.
      fx.advance(60_000);
      await broker.flushReplies();
      assert.equal(api.sent.length, 2, 'the queued notice is retried after the throttle');
      assert.equal(throttleRecords(logs).length, 1, 'the recovery itself must not log');
    } finally { fx.close(); }
  });

  // The same one-record invariant, on the failure path. This lived here
  // because the caller duplicated every non-sent outcome it saw, so the
  // defect was one family: a throttle record and a failure record were each
  // written twice for a single send attempt.
  test('a failed send records exactly one failure record', async () => {
    const fx = makeFixture();
    try {
      fx.connectA();
      clearTransport(fx);
      const api = makeFakeApi();
      // A generic transport error is not a TelegramApiError, so it is
      // classified as send_failed rather than as an uncertain send.
      api.failNextSends(1);
      const { broker, logs } = newBroker(fx, api, BROKER_CONFIG);
      assert.equal(fx.clientA.publishFinalOutput({ ...A, text: 'DOOMED' }).ok, true);
      await broker.drainTuiEvents();
      const failures = logs.filter((e) => e.code === 'send_failed' || e.code === 'send_uncertain');
      assert.equal(failures.length, 1,
        `a single failed send must produce exactly one record, saw ${failures.length}`);
      assert.equal(failures[0].code, 'send_failed',
        'a generic transport error is a definite failure, not an uncertain one');
      assert.equal(api.sent.length, 0, 'a failed send transports nothing');
      assert.equal(pendingEvents(fx).length, 1, 'the failed event stays pending for retry');
      assert.equal(throttleRecords(logs).length, 0, 'a failure is not a throttle');
    } finally { fx.close(); }
  });
});

// T4 voice transcription: pre-resolution contract. Transcription resolves
// in pollOnce BEFORE handleUpdate opens its transaction, so the receipt/
// offset atomicity and the synchronous #planMessage stay untouched. No
// network, no real binaries: the transcriber, getFile and downloadFile are
// injected fakes, exactly like the rest of the broker's seams.

/** The one fixed failure reply (no codes, no paths, no transcript echo). */
const AUDIO_FAILURE_REPLY = "I couldn't transcribe that audio. Type it as a message instead.";

/**
 * Fake API extended with the file-download seam: getFile hands out a
 * file_path per fileId, downloadFile hands out fixed bytes. Both count
 * their calls so tests can assert ZERO downloads where required.
 */
function makeAudioApi() {
  const api = makeFakeApi();
  const calls = { getFile: 0, downloadFile: 0 };
  api.getFile = async ({ fileId } = {}) => {
    calls.getFile++;
    return { file_path: `voice/${fileId}.oga` };
  };
  api.downloadFile = async ({ filePath } = {}) => {
    calls.downloadFile++;
    return Buffer.from('ogg-opus-bytes');
  };
  api.calls = calls;
  return api;
}

/** One authorized-by-default voice/audio message update. */
function voice({ userId = 101, chatId = 202, kind = 'voice' } = {}) {
  updateIdSeq++;
  return {
    update_id: updateIdSeq,
    message: {
      message_id: updateIdSeq,
      from: { id: userId, is_bot: false },
      chat: { id: chatId },
      date: 0,
      [kind]: { file_id: `audiofile${updateIdSeq}`, duration: 3 },
    },
  };
}

/** Injectable fake transcriber: returns { text } or throws. */
function fakeTranscriber(text = 'transcribed words') {
  const calls = [];
  return {
    calls,
    async transcribe({ bytes } = {}) {
      calls.push(bytes);
      if (text instanceof Error) throw text;
      return { text };
    },
  };
}

describe('SelectiveTelegramBroker: voice transcription resolves before the transaction (T4)', () => {
  let t;
  let store;
  let clientA;
  let dir;

  before(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'sel-audio-'));
    t = Date.now();
    store = new Store(join(dir, 'bridge.sqlite'), { now: () => t, isProcessAlive: () => true });
    // Exactly ONE live session: the transcript enters the free-text path,
    // which auto-dispatches to the sole live session (T02 semantics).
    clientA = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    assert.equal(clientA.connect({ ...A, shortId: 'aaa111', label: 'alpha', pid: 1111, cwd: 'C:/proj/alpha' }).ok, true);
  });

  after(() => {
    store.close();
  });

  /** Drop transport leftovers so every test starts from a quiet store. */
  function clearTransport() {
    const pending = store.listPendingBrokerTuiEvents({ limit: 256 });
    if (pending.length > 0) {
      store.acknowledgeTuiEvents({ eventIds: pending.map((e) => e.eventId) });
    }
    while (store.claimNextTuiCommand({ trackingId: A.trackingId, connectionId: A.connectionId }).ok) {}
  }

  function newAudioBroker(api, {
    transcriber = null,
    config = BROKER_CONFIG,
    logs = [],
  } = {}) {
    const options = { store, api, config, now: () => t, logger: (event) => logs.push(event) };
    if (transcriber !== null) options.transcriber = transcriber;
    return new SelectiveTelegramBroker(options);
  }

  test('an authorized voice note is transcribed and routed as plain text; offset advanced, inbox recorded', async () => {
    clearTransport();
    const api = makeAudioApi();
    const transcriber = fakeTranscriber('run the whole test suite');
    const broker = newAudioBroker(api, { transcriber });
    const update = voice();
    api.queueUpdate(update);
    await broker.pollOnce();
    await broker.flushReplies();
    assert.equal(api.calls.getFile, 1, 'exactly one getFile');
    assert.equal(api.calls.downloadFile, 1, 'exactly one download');
    assert.deepEqual(
      transcriber.calls,
      [Buffer.from('ogg-opus-bytes')],
      'the downloaded bytes reach the transcriber',
    );
    assert.equal(store.getBrokerTransportOffset(), update.update_id + 1, 'the offset advances');
    const commands = clientA.poll(A).commands;
    assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, 'prompt');
    assert.equal(commands[0].payload.text, 'run the whole test suite',
      'the transcript becomes the prompt through the free-text path');
    assert.match(api.sent[0].text, /Pi · alpha — Prompt queued\./);
    // Inbox recorded: a re-delivery of the same update must plan nothing.
    broker.handleUpdate(update);
    await broker.flushReplies();
    assert.equal(api.sent.length, 1, 'the inbox dedup keeps the outcome one-time');
  });

  test('a forwarded audio (message.audio) takes the same path', async () => {
    clearTransport();
    const api = makeAudioApi();
    const transcriber = fakeTranscriber('dig the hole deeper');
    const broker = newAudioBroker(api, { transcriber });
    const update = voice({ kind: 'audio' });
    api.queueUpdate(update);
    await broker.pollOnce();
    await broker.flushReplies();
    assert.equal(store.getBrokerTransportOffset(), update.update_id + 1);
    const commands = clientA.poll(A).commands;
    assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, 'prompt');
    assert.equal(commands[0].payload.text, 'dig the hole deeper');
  });

  const failureFlavours = [
    ['a throwing transcriber', () => ({ transcriber: fakeTranscriber(new Error('boom C:/secrets/path stderr noise')) })],
    ['a throwing download', (api) => {
      api.downloadFile = async () => { throw new Error('boom download noise'); };
      return { transcriber: fakeTranscriber('never reached') };
    }],
    ['an empty transcript (silence is failure)', () => ({ transcriber: fakeTranscriber('') })],
  ];

  for (const [flavour, makeFailing] of failureFlavours) {
    test(`failure flavour — ${flavour}: offset still advanced, inbox recorded, one fixed reply, nothing leaked`, async () => {
      clearTransport();
      const api = makeAudioApi();
      const { transcriber } = makeFailing(api);
      const logs = [];
      const broker = newAudioBroker(api, { transcriber, logs });
      const update = voice();
      api.queueUpdate(update);
      await broker.pollOnce();
      await broker.flushReplies();
      assert.equal(store.getBrokerTransportOffset(), update.update_id + 1,
        'a failed transcription must never wedge the offset');
      assert.equal(api.sent.length, 1, 'exactly one reply');
      assert.equal(api.sent[0].text, AUDIO_FAILURE_REPLY, 'the reply is the one fixed string');
      assert.equal(clientA.poll(A).commands.length, 0,
        'a failed audio enqueues nothing');
      const transcriptCode = logs.filter((e) => e.code === 'audio_transcription_failed');
      assert.equal(transcriptCode.length, 1, 'exactly one fixed-token log record');
      const leaks = JSON.stringify(logs) + api.sent.map((s) => s.text).join('\n');
      assert.equal(leaks.includes('boom'), false, 'no error text anywhere');
      assert.equal(leaks.includes('C:/secrets'), false, 'no path anywhere');
      assert.equal(leaks.includes('stderr'), false, 'no stderr anywhere');
      assert.equal(leaks.includes('never reached'), false, 'no transcript anywhere');
      // Inbox recorded: a re-delivery must not re-plan or re-reply.
      broker.handleUpdate(update);
      await broker.flushReplies();
      assert.equal(api.sent.length, 1);
    });
  }

  test('an unauthorized sender cannot make the machine transcribe: zero downloads, zero CPU, no reply', async () => {
    clearTransport();
    const api = makeAudioApi();
    const transcriber = fakeTranscriber('never');
    const logs = [];
    const broker = newAudioBroker(api, { transcriber, logs });
    const wrongUser = voice({ userId: 999 });
    const wrongChat = voice({ chatId: 999 });
    api.queueUpdate(wrongUser);
    api.queueUpdate(wrongChat);
    await broker.pollOnce();
    await broker.flushReplies();
    assert.equal(api.calls.getFile, 0, 'no download for an unauthorized voice note');
    assert.equal(api.calls.downloadFile, 0);
    assert.equal(transcriber.calls.length, 0, 'no transcription for an unauthorized voice note');
    assert.equal(api.sent.length, 0, 'no reply');
    assert.equal(store.getBrokerTransportOffset(), wrongChat.update_id + 1,
      'both unauthorized updates are consumed with receipt + offset only');
  });

  test('a rate-limited owner is never downloaded or transcribed and gets the same outcome as rate-limited text', async () => {
    clearTransport();
    const api = makeAudioApi();
    const transcriber = fakeTranscriber('never');
    const logs = [];
    const config = {
      telegram: { allowedUserId: 101, allowedChatId: 202 },
      bridge: { maxMessageChars: 3800, rateLimit: { max: 1, windowMs: 60_000 } },
    };
    const broker = newAudioBroker(api, { transcriber, config, logs });
    // The single inbound token goes to a plain text message first.
    updateIdSeq++;
    const textUpdate = {
      update_id: updateIdSeq,
      message: {
        message_id: updateIdSeq,
        from: { id: 101, is_bot: false },
        chat: { id: 202 },
        date: 0,
        text: '/help',
      },
    };
    api.queueUpdate(textUpdate);
    await broker.pollOnce();
    await broker.flushReplies();
    assert.equal(api.sent.length, 1);
    // The voice note now peeks an exhausted limiter: no download, no CPU.
    const update = voice();
    api.queueUpdate(update);
    await broker.pollOnce();
    await broker.flushReplies();
    assert.equal(api.calls.getFile, 0, 'no download when the inbound limiter is exhausted');
    assert.equal(api.calls.downloadFile, 0);
    assert.equal(transcriber.calls.length, 0);
    assert.equal(api.sent.length, 1, 'no extra reply beyond the text one');
    assert.equal(store.getBrokerTransportOffset(), update.update_id + 1, 'the offset still advances');
    assert.ok(logs.some((e) => e.code === 'rate_limited_inbound'),
      'the same rate-limit record rate-limited text produces');
  });

  test('the audio peek does not consume: with one token left the message still takes it and is processed', async () => {
    clearTransport();
    const api = makeAudioApi();
    const transcriber = fakeTranscriber('process me');
    const config = {
      telegram: { allowedUserId: 101, allowedChatId: 202 },
      bridge: { maxMessageChars: 3800, rateLimit: { max: 1, windowMs: 60_000 } },
    };
    const broker = newAudioBroker(api, { transcriber, config });
    const update = voice();
    api.queueUpdate(update);
    await broker.pollOnce();
    await broker.flushReplies();
    assert.equal(api.calls.getFile, 1, 'the peek saw the one available token');
    const commands = clientA.poll(A).commands;
    assert.equal(commands.length, 1, 'the take after the peek consumed that same token');
    assert.equal(commands[0].payload.text, 'process me');
    assert.match(api.sent[0].text, /Prompt queued\./);
  });

  test('transcription disabled: a voice note behaves exactly as today (silent drop, no download, no reply)', async () => {
    clearTransport();
    const api = makeAudioApi();
    // No injected transcriber and no transcription section: the feature is inert.
    const logs = [];
    const broker = newAudioBroker(api, { logs });
    const update = voice();
    api.queueUpdate(update);
    await broker.pollOnce();
    await broker.flushReplies();
    assert.equal(api.calls.getFile, 0, 'no download when transcription is disabled');
    assert.equal(api.calls.downloadFile, 0);
    assert.equal(api.sent.length, 0, 'today\'s silent drop');
    assert.equal(clientA.poll(A).commands.length, 0);
    assert.equal(store.getBrokerTransportOffset(), update.update_id + 1, 'consumed like any non-text update');
  });

  test('an enabled transcription config constructs the real transcriber and routes through it', async () => {
    clearTransport();
    const api = makeAudioApi();
    const logs = [];
    const config = {
      telegram: { allowedUserId: 101, allowedChatId: 202 },
      bridge: { maxMessageChars: 3800, rateLimit: { max: 1000, windowMs: 60_000 } },
      transcription: {
        enabled: true,
        whisperCliPath: 'missing-whisper-cli.exe',
        modelPath: 'missing-model.bin',
        ffmpegPath: 'missing-ffmpeg.exe',
        language: 'es',
        threads: 1,
        prompt: 'test vocabulary',
        maxAudioBytes: 1024,
        maxDurationSec: 60,
        processTimeoutMs: 1000,
        maxStderrBytes: 1024,
      },
    };
    const broker = newAudioBroker(api, { config, logs });
    const update = voice();
    api.queueUpdate(update);
    await broker.pollOnce();
    await broker.flushReplies();
    assert.equal(api.calls.getFile, 1, 'the real transcriber was constructed and used');
    assert.equal(api.sent.length, 1);
    assert.equal(api.sent[0].text, AUDIO_FAILURE_REPLY,
      'missing tools fail closed to the fixed failure reply');
    assert.equal(logs.filter((e) => e.code === 'audio_transcription_failed').length, 1);
    assert.equal(store.getBrokerTransportOffset(), update.update_id + 1);
  });

  test('an audio update reaching the plan without a resolved outcome fails closed to the fixed failure reply', async () => {
    clearTransport();
    const api = makeAudioApi();
    const transcriber = fakeTranscriber('unused');
    const broker = newAudioBroker(api, { transcriber });
    broker.handleUpdate(voice());
    await broker.flushReplies();
    assert.equal(api.calls.getFile, 0, 'the plan itself never downloads; pre-resolution does');
    assert.equal(api.sent.length, 1);
    assert.equal(api.sent[0].text, AUDIO_FAILURE_REPLY);
  });

  test('video notes and documents stay silently dropped even when transcription is enabled', async () => {
    clearTransport();
    const api = makeAudioApi();
    const transcriber = fakeTranscriber('never');
    const broker = newAudioBroker(api, { transcriber });
    updateIdSeq++;
    const videoNoteUpdate = {
      update_id: updateIdSeq,
      message: {
        message_id: updateIdSeq,
        from: { id: 101, is_bot: false },
        chat: { id: 202 },
        date: 0,
        video_note: { file_id: 'videonote1', duration: 3 },
      },
    };
    updateIdSeq++;
    const documentUpdate = {
      update_id: updateIdSeq,
      message: {
        message_id: updateIdSeq,
        from: { id: 101, is_bot: false },
        chat: { id: 202 },
        date: 0,
        document: { file_id: 'document1' },
      },
    };
    api.queueUpdate(videoNoteUpdate);
    api.queueUpdate(documentUpdate);
    await broker.pollOnce();
    await broker.flushReplies();
    assert.equal(api.calls.getFile, 0, 'only voice and audio are accepted');
    assert.equal(transcriber.calls.length, 0);
    assert.equal(api.sent.length, 0);
    assert.equal(clientA.poll(A).commands.length, 0);
    assert.equal(store.getBrokerTransportOffset(), documentUpdate.update_id + 1);
  });
});


describe('SelectiveTelegramBroker: durable selected-destination parity (T4A)', () => {
  /**
   * Real Store fixture: identity checks, transactions and drift guards all
   * stay real; only explicitly poisoned seams (below) are overridden.
   */
  function makeDurableFixture() {
    const dir = mkdtempSync(join(TEST_RUNS, 'sel-durable-'));
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

  function newDurableBroker(fx, api, store = fx.store) {
    return new SelectiveTelegramBroker({ store, api, config: BROKER_CONFIG, now: fx.now });
  }

  async function deliverDurable(broker, api, update) {
    broker.handleUpdate(update);
    await broker.flushReplies();
    return update;
  }

  /** The exact project key the store derived for a fixture session. */
  function projectKeyOf(fx, trackingId) {
    const session = fx.store.getTuiSession({ trackingId, staleCutoff: fx.now() - 30_000 });
    assert.notEqual(session, null);
    return session.projectKey;
  }

  /**
   * A duck-typed store facade that binds the broker's FULL real-store
   * surface to the real Store, then overrides only the named seams. Used
   * where the store's own drift guards make an adversarial durable state
   * unreachable through the public API: everything except the poisoned
   * seam (identity checks, transactions, clearing) stays real.
   */
  const BROKER_STORE_METHODS = [
    'withTransaction', 'getBrokerTransportOffset', 'advanceBrokerTransportOffset',
    'recordInbox', 'listTuiSessions', 'listRecentTuiProjects', 'enqueueTuiCommand',
    'listPendingBrokerTuiEvents', 'acknowledgeTuiEvents',
    'getSelectedTuiTarget', 'setSelectedTuiTarget', 'clearSelectedTuiTarget',
    'setTuiSessionAlias',
  ];
  function poisonStore(fx, overrides) {
    const bound = Object.fromEntries(
      BROKER_STORE_METHODS.map((name) => [name, fx.store[name].bind(fx.store)]),
    );
    return Object.assign(bound, overrides);
  }

  test('constructor refuses a store missing the durable selection methods', () => {
    const fx = makeDurableFixture();
    try {
      const api = makeFakeApi();
      for (const missing of ['getSelectedTuiTarget', 'setSelectedTuiTarget', 'clearSelectedTuiTarget']) {
        const partial = poisonStore(fx, {});
        delete partial[missing];
        assert.throws(
          () => newDurableBroker(fx, api, partial),
          TypeError,
          `a store without ${missing} must be rejected`,
        );
      }
    } finally { fx.close(); }
  });

  test('dashboard v1:s selection persists durably, survives broker reconstruction and routes plain text', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api1 = makeFakeApi();
      const broker1 = newDurableBroker(fx, api1);
      await deliverDurable(broker1, api1, cb('v1:s:aaa111'));
      assert.deepEqual(
        fx.store.getSelectedTuiTarget(),
        { trackingId: A.trackingId, projectKey: projectKeyOf(fx, A.trackingId) },
        'the dashboard tap must persist the selection durably',
      );
      // A brand-new broker process (memory lost) adopts the durable target.
      const api2 = makeFakeApi();
      const broker2 = newDurableBroker(fx, api2);
      await broker2.start();
      assert.equal(api2.sent.length, 0, 'adoption itself never sends Telegram');
      assert.equal(fx.clientA.poll(A).commands.length, 0, 'adoption never enqueues commands');
      await deliverDurable(broker2, api2, msg('hello from the garden'));
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1, 'the adopted selection must route plain text to A');
      assert.equal(commands[0].kind, 'prompt');
      assert.equal(commands[0].payload.text, 'hello from the garden');
      assert.equal(fx.clientB.poll(B).commands.length, 0);
    } finally { fx.close(); }
  });

  test('/use selection persists and survives a restart', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api1 = makeFakeApi();
      const broker1 = newDurableBroker(fx, api1);
      await deliverDurable(broker1, api1, msg('/use aaa111'));
      assert.deepEqual(
        fx.store.getSelectedTuiTarget(),
        { trackingId: A.trackingId, projectKey: projectKeyOf(fx, A.trackingId) },
      );
      const api2 = makeFakeApi();
      const broker2 = newDurableBroker(fx, api2);
      await broker2.start();
      await deliverDurable(broker2, api2, msg('/status'));
      const commands = fx.clientA.poll(A).commands;
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'status');
    } finally { fx.close(); }
  });

  test('sole-session /start auto-selection persists durably', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      const api = makeFakeApi();
      const broker = newDurableBroker(fx, api);
      await deliverDurable(broker, api, msg('/start'));
      assert.deepEqual(
        fx.store.getSelectedTuiTarget(),
        { trackingId: A.trackingId, projectKey: projectKeyOf(fx, A.trackingId) },
      );
    } finally { fx.close(); }
  });

  test('sole-session plain-text auto-selection persists durably', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      const api = makeFakeApi();
      const broker = newDurableBroker(fx, api);
      await deliverDurable(broker, api, msg('water the tomatoes'));
      assert.deepEqual(
        fx.store.getSelectedTuiTarget(),
        { trackingId: A.trackingId, projectKey: projectKeyOf(fx, A.trackingId) },
      );
    } finally { fx.close(); }
  });

  test('callback status selection persists durably', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      const api = makeFakeApi();
      const broker = newDurableBroker(fx, api);
      await deliverDurable(broker, api, cb('v1:q:aaa111'));
      assert.deepEqual(
        fx.store.getSelectedTuiTarget(),
        { trackingId: A.trackingId, projectKey: projectKeyOf(fx, A.trackingId) },
      );
    } finally { fx.close(); }
  });

  test('a persisted stale target clears at start and never routes', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      const api1 = makeFakeApi();
      const broker1 = newDurableBroker(fx, api1);
      await deliverDurable(broker1, api1, msg('/use aaa111'));
      assert.notEqual(fx.store.getSelectedTuiTarget(), null);
      fx.advance(60_000); // the row survives but the heartbeat is stale: zero live sessions
      const api2 = makeFakeApi();
      const broker2 = newDurableBroker(fx, api2);
      await broker2.start();
      assert.equal(fx.store.getSelectedTuiTarget(), null, 'a stale durable target must clear at start');
      await deliverDurable(broker2, api2, msg('anyone there?'));
      assert.equal(fx.clientA.poll(A).commands.length, 0, 'a cleared target never routes');
    } finally { fx.close(); }
  });

  test('a persisted target whose project no longer matches clears at start', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      const api1 = makeFakeApi();
      const broker1 = newDurableBroker(fx, api1);
      await deliverDurable(broker1, api1, msg('/use aaa111'));
      // Poisoned READ only: simulate a project identity that changed
      // underneath the broker; the real store keeps the real target.
      const store = poisonStore(fx, {
        getSelectedTuiTarget: () => ({ trackingId: A.trackingId, projectKey: 'f'.repeat(64) }),
      });
      const api2 = makeFakeApi();
      const broker2 = newDurableBroker(fx, api2, store);
      await broker2.start();
      assert.equal(fx.store.getSelectedTuiTarget(), null, 'a project-mismatched durable target must clear');
      assert.equal(fx.clientA.poll(A).commands.length, 0);
      assert.equal(api2.sent.length, 0);
    } finally { fx.close(); }
  });

  test('a persisted target naming a missing row clears at start', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      const api1 = makeFakeApi();
      const broker1 = newDurableBroker(fx, api1);
      await deliverDurable(broker1, api1, msg('/use aaa111'));
      // Poisoned READ only: the durable target names a tracking id whose
      // row is gone; the real store keeps the real (stale) target.
      const store = poisonStore(fx, {
        getSelectedTuiTarget: () => ({ trackingId: 'z'.repeat(32), projectKey: projectKeyOf(fx, A.trackingId) }),
      });
      const api2 = makeFakeApi();
      const broker2 = newDurableBroker(fx, api2, store);
      await broker2.start();
      assert.equal(fx.store.getSelectedTuiTarget(), null, 'a missing-row durable target must clear');
      assert.equal(api2.sent.length, 0);
    } finally { fx.close(); }
  });

  test('a refused durable set fails closed: no selection, no durable state, no command', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      const store = poisonStore(fx, {
        setSelectedTuiTarget: () => ({ ok: false, reason: 'forced' }),
      });
      const api = makeFakeApi();
      const broker = newDurableBroker(fx, api, store);
      const update = await deliverDurable(broker, api, msg('hello there'));
      assert.equal(fx.store.getSelectedTuiTarget(), null, 'a refused selection must not persist');
      assert.equal(fx.clientA.poll(A).commands.length, 0, 'a store-refused selection never routes');
      assert.match(api.sent[0].text, /No session selected/);
      assert.equal(fx.store.getBrokerTransportOffset(), update.update_id + 1, 'the receipt still commits');
    } finally { fx.close(); }
  });

  test('a throwing durable set fails closed without wedging the update', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      const store = poisonStore(fx, {
        setSelectedTuiTarget: () => { throw new Error('boom'); },
      });
      const api = makeFakeApi();
      const broker = newDurableBroker(fx, api, store);
      const update = await deliverDurable(broker, api, msg('hello there'));
      assert.equal(fx.store.getSelectedTuiTarget(), null);
      assert.equal(fx.clientA.poll(A).commands.length, 0, 'a throwing set never routes');
      assert.equal(fx.store.getBrokerTransportOffset(), update.update_id + 1, 'the receipt still commits');
    } finally { fx.close(); }
  });

  test('staleness of the selected session clears the durable selection', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      const api = makeFakeApi();
      const broker = newDurableBroker(fx, api);
      await deliverDurable(broker, api, msg('/use aaa111'));
      assert.notEqual(fx.store.getSelectedTuiTarget(), null);
      fx.advance(60_000); // the selected session goes stale
      await deliverDurable(broker, api, msg('/status'));
      assert.equal(fx.store.getSelectedTuiTarget(), null, 'a stale selected session must clear durably');
      assert.equal(fx.clientA.poll(A).commands.length, 0);
    } finally { fx.close(); }
  });

  test('disconnect of the selected session clears the durable selection and never resurrects it', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      const api = makeFakeApi();
      const broker = newDurableBroker(fx, api);
      await deliverDurable(broker, api, msg('/use aaa111'));
      assert.notEqual(fx.store.getSelectedTuiTarget(), null);
      fx.clientA.disconnect({ ...A });
      assert.equal(fx.store.getSelectedTuiTarget(), null, 'the store clears on disconnect');
      await deliverDurable(broker, api, msg('still there?'));
      assert.equal(fx.store.getSelectedTuiTarget(), null, 'the dead selection never persists again');
      assert.equal(fx.clientA.poll(A).commands.length, 0);
    } finally { fx.close(); }
  });

  test('explicit short-id routing never rewrites the durable selection', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newDurableBroker(fx, api);
      await deliverDurable(broker, api, msg('/use aaa111'));
      await deliverDurable(broker, api, msg('/send bbb222 hello beta'));
      const commands = fx.clientB.poll(B).commands;
      assert.equal(commands.length, 1, 'explicit short-id routing still works');
      assert.equal(commands[0].kind, 'prompt');
      assert.deepEqual(
        fx.store.getSelectedTuiTarget(),
        { trackingId: A.trackingId, projectKey: projectKeyOf(fx, A.trackingId) },
        'explicit routing must not rewrite the selection',
      );
    } finally { fx.close(); }
  });

  test('an explicit short-id command with no selection leaves the durable selection empty', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newDurableBroker(fx, api);
      await deliverDurable(broker, api, msg('/send bbb222 hello beta'));
      assert.equal(fx.clientB.poll(B).commands.length, 1);
      assert.equal(fx.store.getSelectedTuiTarget(), null, 'explicit routing must not create a selection');
    } finally { fx.close(); }
  });

  test('opening or refreshing Projects never rewrites the durable selection', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newDurableBroker(fx, api);
      await deliverDurable(broker, api, msg('/use aaa111'));
      await deliverDurable(broker, api, msg('/projects'));
      await deliverDurable(broker, api, cb('v1:r'));
      assert.deepEqual(
        fx.store.getSelectedTuiTarget(),
        { trackingId: A.trackingId, projectKey: projectKeyOf(fx, A.trackingId) },
        'Projects must never rewrite the selection',
      );
    } finally { fx.close(); }
  });

  test('opening Projects with no selection never creates a durable selection', async () => {
    const fx = makeDurableFixture();
    try {
      fx.connectA();
      fx.connectB();
      const api = makeFakeApi();
      const broker = newDurableBroker(fx, api);
      await deliverDurable(broker, api, msg('/projects'));
      await deliverDurable(broker, api, cb('v1:r'));
      assert.equal(fx.store.getSelectedTuiTarget(), null);
    } finally { fx.close(); }
  });
});

describe('SelectiveTelegramBroker: per-session /alias (T4C2)', () => {
  // Same project as ALPHA (same cwd): two live windows in one project.
  const C = Object.freeze({ trackingId: 'c'.repeat(32), connectionId: '3'.repeat(32) });
  const ALPHA = Object.freeze({ shortId: 'aaa111', label: 'alpha', cwd: 'C:/proj/alpha' });
  const BETA = Object.freeze({ shortId: 'bbb222', label: 'beta', cwd: 'C:/proj/beta' });
  const GAMMA = Object.freeze({ shortId: 'ccc333', label: 'alpha two', cwd: 'C:/proj/alpha' });

  const aliasNoSelection = copyModule.aliasNoSelection;
  const aliasInvalid = copyModule.aliasInvalid;
  const aliasFailed = copyModule.aliasFailed;

  function makeFixture() {
    const dir = mkdtempSync(join(TEST_RUNS, 'sel-alias-'));
    let t = Date.now();
    const now = () => t;
    const store = new Store(join(dir, 'bridge.sqlite'), { now, isProcessAlive: () => true });
    const sessions = [];
    return {
      store,
      now,
      advance(ms) { t += ms; },
      connect(id, { shortId, label, cwd, state = null }) {
        const client = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
        assert.equal(client.connect({ ...id, shortId, label, cwd, pid: 4000 + sessions.length }).ok, true);
        if (state !== null) {
          assert.equal(client.setState({ ...id, state }).ok, true);
        }
        sessions.push({ id, client });
        return client;
      },
      disconnect(id) {
        const entry = sessions.find((s) => s.id.trackingId === id.trackingId);
        assert.ok(entry, 'the session to disconnect must exist');
        assert.equal(entry.client.disconnect({ ...id }).ok, true);
      },
      pollAllCommands() {
        const commands = [];
        for (const { id, client } of sessions) {
          commands.push(...client.poll(id).commands);
        }
        return commands;
      },
      close() { store.close(); },
    };
  }

  const BROKER_STORE_METHODS = [
    'withTransaction', 'getBrokerTransportOffset', 'advanceBrokerTransportOffset',
    'recordInbox', 'listTuiSessions', 'listRecentTuiProjects', 'enqueueTuiCommand',
    'listPendingBrokerTuiEvents', 'acknowledgeTuiEvents',
    'getSelectedTuiTarget', 'setSelectedTuiTarget', 'clearSelectedTuiTarget',
    'setTuiSessionAlias',
  ];
  function poisonStore(fx, overrides) {
    const bound = Object.fromEntries(
      BROKER_STORE_METHODS.map((name) => [name, fx.store[name].bind(fx.store)]),
    );
    return Object.assign(bound, overrides);
  }

  function newBroker(fx, api, store = fx.store, logger = () => {}) {
    return new SelectiveTelegramBroker({ store, api, config: BROKER_CONFIG, now: fx.now, logger });
  }

  async function deliver(broker, api, update) {
    broker.handleUpdate(update);
    await broker.flushReplies();
  }

  /** One button per row on the last rendered dashboard. */
  function rowButtons(api) {
    const markup = api.sent[api.sent.length - 1].replyMarkup;
    return (markup?.inline_keyboard ?? []).map((row) => row[0]);
  }

  function sessionAliasOf(fx, id) {
    const row = fx.store.getTuiSession({ trackingId: id.trackingId, staleCutoff: fx.now() - 30_000 });
    return row === null ? null : row.alias;
  }

  function projectKeyOf(fx, id) {
    const row = fx.store.getTuiSession({ trackingId: id.trackingId, staleCutoff: fx.now() - 30_000 });
    assert.notEqual(row, null);
    return row.projectKey;
  }

  test('the constructor requires setTuiSessionAlias', () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const partial = poisonStore(fx, {});
      delete partial.setTuiSessionAlias;
      assert.throws(
        () => newBroker(fx, makeFakeApi(), partial),
        TypeError,
        'a store without setTuiSessionAlias must be rejected',
      );
    } finally { fx.close(); }
  });

  test('/alias <name> renames the selected live session, acknowledges and re-renders the dashboard', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      await deliver(broker, api, msg('/alias   home   office '));
      const reply = api.sent[api.sent.length - 1];
      assert.ok(reply.text.startsWith('Alias saved.\n'),
        'the fixed acknowledgement must be prepended to the re-rendered dashboard');
      assert.ok(reply.text.includes('Your Pi projects'),
        'the dashboard must re-render immediately so the renamed row is visible');
      assert.equal(sessionAliasOf(fx, A), 'home office',
        'the trimmed, whitespace-collapsed alias must be persisted');
      assert.equal(sessionAliasOf(fx, B), null);
      const rows = rowButtons(api);
      assert.ok(rows.some((b) => b.text.includes('home office')), 'the renamed row must render');
      assert.ok(rows.every((b) => !b.text.includes('alpha')), 'the old label must be replaced');
      assert.equal(fx.pollAllCommands().length, 0, '/alias enqueues no TUI command');
    } finally { fx.close(); }
  });

  test('/alias clear clears the selected session alias and re-renders the dashboard', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      await deliver(broker, api, msg('/alias first'));
      assert.equal(sessionAliasOf(fx, A), 'first');
      await deliver(broker, api, msg('/alias clear'));
      assert.equal(sessionAliasOf(fx, A), null, 'the alias must be cleared in the store');
      const reply = api.sent[api.sent.length - 1];
      assert.ok(reply.text.startsWith('Alias cleared.\n'));
      const rows = rowButtons(api);
      assert.ok(rows.some((b) => b.text.includes('alpha')), 'the row falls back to the session label');
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('/alias <shortId> <name> renames that exact live session and leaves the selection untouched', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      await deliver(broker, api, msg('/alias bbb222 garden'));
      assert.equal(sessionAliasOf(fx, B), 'garden');
      assert.equal(sessionAliasOf(fx, A), null, 'the selected session must be untouched');
      const rows = rowButtons(api);
      const alphaRow = rows.find((b) => b.callback_data === 'v1:s:aaa111');
      const betaRow = rows.find((b) => b.callback_data === 'v1:s:bbb222');
      assert.ok(alphaRow.text.startsWith('✓'), 'the selection must not move');
      assert.equal(alphaRow.style, 'primary');
      assert.ok(betaRow.text.includes('garden'), 'the targeted row shows its new alias');
      assert.ok(!betaRow.text.includes('beta'));
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('/alias <shortId> clear clears that exact live session and leaves the selection untouched', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      assert.equal(fx.store.setTuiSessionAlias({ trackingId: B.trackingId, alias: 'garden' }).ok, true);
      await deliver(broker, api, cb('v1:s:aaa111'));
      await deliver(broker, api, msg('/alias bbb222 clear'));
      assert.equal(sessionAliasOf(fx, B), null);
      assert.equal(sessionAliasOf(fx, A), null);
      const rows = rowButtons(api);
      assert.ok(rows.find((b) => b.callback_data === 'v1:s:aaa111').text.startsWith('✓'));
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('a shortId-looking first word that matches nothing is the selected session alias', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      await deliver(broker, api, msg('/alias zzz999 home pc'));
      assert.equal(sessionAliasOf(fx, A), 'zzz999 home pc',
        'the whole argument must become the selected session alias');
      assert.equal(sessionAliasOf(fx, B), null);
      const rows = rowButtons(api);
      assert.ok(rows.some((b) => b.text.includes('zzz999 home pc')));
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('/alias without a live selected session fails closed and never auto-selects', async () => {
    const fx = makeFixture();
    try {
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      // Zero live sessions.
      await deliver(broker, api, msg('/alias home'));
      assert.equal(api.sent[0].text, aliasNoSelection);
      // Exactly one live session, no selection: still no guess.
      fx.connect(A, ALPHA);
      await deliver(broker, api, msg('/alias home'));
      assert.equal(api.sent[1].text, aliasNoSelection);
      assert.equal(sessionAliasOf(fx, A), null, 'a sole session must never be auto-selected');
      // Several live sessions, no selection.
      fx.connect(B, BETA);
      await deliver(broker, api, msg('/alias home'));
      assert.equal(api.sent[2].text, aliasNoSelection);
      // A selection that went stale fails closed the same way.
      await deliver(broker, api, cb('v1:s:aaa111'));
      fx.advance(31_000);
      await deliver(broker, api, msg('/alias home'));
      assert.equal(api.sent[4].text, aliasNoSelection,
        'a stale selection must fail closed, never guess');
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('two live windows in one project show distinct names', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(C, GAMMA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      await deliver(broker, api, msg('/alias garden shed'));
      const rows = rowButtons(api);
      const alphaRow = rows.find((b) => b.callback_data === 'v1:s:aaa111');
      const gammaRow = rows.find((b) => b.callback_data === 'v1:s:ccc333');
      assert.ok(alphaRow.text.includes('garden shed'));
      assert.ok(gammaRow.text.includes('alpha two'), 'the sibling row keeps its own name');
      const colorOf = (text) => text.match(new RegExp(`[${PROJECT_COLOR_SLOTS.join('')}]`, 'gu'))?.[0];
      assert.equal(colorOf(alphaRow.text), colorOf(gammaRow.text),
        'the shared project color must stay stable');
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('the session alias beats the project alias on its own row only', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(C, GAMMA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      const projectKey = projectKeyOf(fx, A);
      assert.equal(fx.store.setTuiProjectAlias({ projectKey, alias: 'proj name' }).ok, true);
      await deliver(broker, api, cb('v1:s:aaa111'));
      await deliver(broker, api, msg('/alias mine'));
      const rows = rowButtons(api);
      const alphaRow = rows.find((b) => b.callback_data === 'v1:s:aaa111');
      const gammaRow = rows.find((b) => b.callback_data === 'v1:s:ccc333');
      assert.ok(alphaRow.text.includes('mine'),
        'the session alias must take precedence over the project alias');
      assert.ok(gammaRow.text.includes('proj name'),
        'the sibling window without a session alias keeps the project alias');
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('Recent stays project-level: a disconnected session alias never leaks', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      const projectKey = projectKeyOf(fx, A);
      assert.equal(fx.store.setTuiSessionAlias({ trackingId: A.trackingId, alias: 'secret window' }).ok, true);
      assert.equal(fx.store.setTuiProjectAlias({ projectKey, alias: 'proj name' }).ok, true);
      fx.disconnect(A);
      await deliver(broker, api, msg('/projects'));
      const rows = rowButtons(api);
      assert.ok(rows.some((b) => b.text.includes('proj name')),
        'the recent row must show the project alias');
      assert.ok(rows.every((b) => !b.text.includes('secret window')),
        'a disconnected session alias must never leak into Recent');
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('duplicate aliases are allowed across sessions', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      await deliver(broker, api, msg('/alias twin'));
      await deliver(broker, api, cb('v1:s:bbb222'));
      await deliver(broker, api, msg('/alias twin'));
      assert.equal(sessionAliasOf(fx, A), 'twin');
      assert.equal(sessionAliasOf(fx, B), 'twin');
      const texts = rowButtons(api).map((b) => b.text);
      assert.equal(texts.filter((t) => t.includes('twin')).length, 2,
        'both rows may carry the same alias');
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('alias input validation: 64 accepted, 65 rejected, control chars and leading slash rejected', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      await deliver(broker, api, msg(`/alias ${'x'.repeat(64)}`));
      assert.equal(sessionAliasOf(fx, A), 'x'.repeat(64), 'a 64-char alias must be accepted');
      assert.ok(api.sent[api.sent.length - 1].text.startsWith('Alias saved.'));
      for (const bad of ['x'.repeat(65), 'bad\u0007name', '/etc/passwd']) {
        const before = fx.store.getBrokerTransportOffset();
        await deliver(broker, api, msg(`/alias ${bad}`));
        assert.equal(api.sent[api.sent.length - 1].text, aliasInvalid,
          'a rejected input gets the fixed safe copy, never an echo');
        assert.equal(fx.store.getBrokerTransportOffset(), before + 1,
          'the receipt and offset still commit for a rejected input');
      }
      assert.equal(sessionAliasOf(fx, A), 'x'.repeat(64),
        'a rejected input must never touch the stored alias');
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('unicode Cc/Cf characters in alias input are rejected: U+0085, U+200B, U+202E', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      // U+0085 NEL (Cc), U+200B zero width space (Cf), U+202E RTL override (Cf).
      for (const bad of ['bad\u0085name', 'bad\u200Bname', 'bad\u202Ename']) {
        const before = fx.store.getBrokerTransportOffset();
        await deliver(broker, api, msg(`/alias ${bad}`));
        assert.equal(api.sent[api.sent.length - 1].text, aliasInvalid,
          'a control/format input gets the fixed safe copy, never an echo');
        assert.equal(fx.store.getBrokerTransportOffset(), before + 1,
          'the receipt and offset still commit for a rejected input');
      }
      assert.equal(sessionAliasOf(fx, A), null, 'no alias mutation for rejected input');
      assert.equal(fx.pollAllCommands().length, 0, 'no TUI command for rejected input');
      // Normal emoji, letters and combining marks must stay accepted.
      const withMarks = 'café \u{1F600} e\u0301';
      await deliver(broker, api, msg(`/alias ${withMarks}`));
      assert.equal(sessionAliasOf(fx, A), withMarks,
        'emoji, letters and combining marks must never be rejected');
      assert.ok(api.sent[api.sent.length - 1].text.startsWith('Alias saved.'));
    } finally { fx.close(); }
  });

  test('permitted joiners: ZWJ emoji, ZWNJ letters and tag-sequence emoji are accepted', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      const zwj = '👩\u200D💻';
      await deliver(broker, api, msg(`/alias ${zwj}`));
      assert.equal(sessionAliasOf(fx, A), zwj,
        'a normal ZWJ emoji must be accepted with its joiner preserved');
      assert.ok(api.sent[api.sent.length - 1].text.startsWith('Alias saved.'));
      const zwnj = 'co\u200Cop';
      await deliver(broker, api, msg(`/alias ${zwnj}`));
      assert.equal(sessionAliasOf(fx, A), zwnj,
        'a real letter sequence with ZWNJ must be accepted');
      const flag = '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
      await deliver(broker, api, msg(`/alias ${flag}`));
      assert.equal(sessionAliasOf(fx, A), flag,
        'tag characters inside a valid emoji flag sequence must be accepted');
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('invisible-only aliases are rejected: joiner-only, tag-only, combining-only', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      for (const bad of ['\u200D', '\u200C', '\u{E0067}\u{E006B}', '\u0301\u0308',
        ' \u200D\u0301 ']) {
        const before = fx.store.getBrokerTransportOffset();
        await deliver(broker, api, msg(`/alias ${bad}`));
        assert.equal(api.sent[api.sent.length - 1].text, aliasInvalid,
          'an alias with no visible base character must get the fixed safe copy');
        assert.equal(fx.store.getBrokerTransportOffset(), before + 1,
          'the receipt and offset still commit for a rejected input');
      }
      assert.equal(sessionAliasOf(fx, A), null, 'no alias mutation for rejected input');
      assert.equal(fx.pollAllCommands().length, 0, 'no TUI command for rejected input');
    } finally { fx.close(); }
  });

  test('a hostile alias is stored but never rendered as a path, short id, tracking id or pid', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      const hostile = 'C:/Users/me tg:abc123 aaaaaaaaaaaaaaaa pid 7 office';
      assert.ok(hostile.length <= 64);
      await deliver(broker, api, msg(`/alias ${hostile}`));
      assert.equal(sessionAliasOf(fx, A), hostile);
      const alphaRow = rowButtons(api).find((b) => b.callback_data === 'v1:s:aaa111');
      for (const forbidden of [/C:\/Users/, /tg:/, /aaaa/, /pid/]) {
        assert.doesNotMatch(alphaRow.text, forbidden,
          `the dashboard must sanitize the hostile alias: ${alphaRow.text}`);
      }
      assert.ok(alphaRow.text.includes('office'), 'the readable remainder must survive');
    } finally { fx.close(); }
  });

  test('a store refusal or throw replies with one fixed failure, logs one fixed code and commits the receipt', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      const codes = [];
      const refused = poisonStore(fx, {
        setTuiSessionAlias: () => ({ ok: false, reason: 'unknown_session' }),
      });
      const refusedBroker = newBroker(fx, api, refused, (entry) => codes.push(entry.code));
      const base = api.sent.length;
      await deliver(refusedBroker, api, msg('/alias aaa111 home'));
      assert.equal(api.sent[base].text, aliasFailed);
      assert.ok(!api.sent[base].text.includes('unknown_session'),
        'the store refusal reason must never reach the reply');
      assert.ok(codes.includes('alias_persist_failed'), 'the fixed failure code must be logged');
      assert.equal(fx.pollAllCommands().length, 0);

      const throwCodes = [];
      const throwing = poisonStore(fx, {
        setTuiSessionAlias: () => { throw new Error('simulated store failure'); },
      });
      const throwingBroker = newBroker(fx, api, throwing, (entry) => throwCodes.push(entry.code));
      const base2 = api.sent.length;
      await deliver(throwingBroker, api, msg('/alias aaa111 home'));
      assert.equal(api.sent[base2].text, aliasFailed);
      assert.ok(throwCodes.includes('alias_persist_failed'));
      assert.equal(fx.pollAllCommands().length, 0, 'a failed alias save enqueues nothing');
      assert.ok(fx.store.getBrokerTransportOffset() > 0,
        'the receipt and offset still commit through the refused updates');
    } finally { fx.close(); }
  });

  test('/alias alone and a bare unique short id show usage and mutate nothing', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, cb('v1:s:aaa111'));
      const base = api.sent.length;
      await deliver(broker, api, msg('/alias'));
      assert.match(api.sent[base].text, /Usage: \/alias/);
      await deliver(broker, api, msg('/alias aaa111'));
      assert.match(api.sent[base + 1].text, /Usage: \/alias/,
        'the advanced form needs <name|clear>, so a bare short id is usage');
      assert.equal(sessionAliasOf(fx, A), null);
      assert.equal(sessionAliasOf(fx, B), null);
      assert.equal(fx.pollAllCommands().length, 0);
    } finally { fx.close(); }
  });

  test('the callback grammar is unchanged: v1:s still selects after an /alias rename', async () => {
    const fx = makeFixture();
    try {
      fx.connect(A, ALPHA);
      fx.connect(B, BETA);
      const api = makeFakeApi();
      const broker = newBroker(fx, api);
      await deliver(broker, api, msg('/alias aaa111 first'));
      assert.equal(sessionAliasOf(fx, A), 'first');
      await deliver(broker, api, cb('v1:s:bbb222'));
      const rows = rowButtons(api);
      const betaRow = rows.find((b) => b.callback_data === 'v1:s:bbb222');
      const alphaRow = rows.find((b) => b.callback_data === 'v1:s:aaa111');
      assert.ok(betaRow.text.startsWith('✓'), 'the select callback must still move the selection');
      assert.ok(alphaRow.text.includes('first'), 'the renamed row still renders its alias');
      await deliver(broker, api, msg('hello there'));
      const commands = fx.pollAllCommands();
      assert.equal(commands.length, 1);
      assert.equal(commands[0].kind, 'prompt', 'plain text still routes to the newly selected session');
    } finally { fx.close(); }
  });
});

// --- T4B2: alias-aware identity headers on session-scoped messages ----------

describe('SelectiveTelegramBroker: alias-aware identity headers (T4B2)', () => {
  const H = Object.freeze({ trackingId: 'c'.repeat(32), connectionId: '3'.repeat(32) });
  const E = Object.freeze({ trackingId: 'd'.repeat(32), connectionId: '4'.repeat(32) });

  /**
   * Fixture with two same-project windows (distinct tracking ids, one cwd),
   * so alias precedence, per-window distinctness and snapshot freezing are
   * all observable through the fake API's visible texts.
   */
  function makeHeaderFixture() {
    const dir = mkdtempSync(join(TEST_RUNS, 'sel-header-'));
    let t = Date.now();
    const now = () => t;
    const store = new Store(join(dir, 'bridge.sqlite'), { now, isProcessAlive: () => true });
    const clientH = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    const clientE = new TuiBridgeClient(store, { staleAfterMs: 30_000 });
    let closed = false;
    const fx = {
      store, clientH, clientE, now, dir,
      advance(ms) { t += ms; },
      close() { if (!closed) { closed = true; store.close(); } },
      newBroker(api) {
        return new SelectiveTelegramBroker({ store, api, config: BROKER_CONFIG, now });
      },
      async deliver(broker, api, update) {
        broker.handleUpdate(update);
        await broker.flushReplies();
      },
      async drain(broker) {
        await broker.drainTuiEvents();
      },
      connectH({ alias = null } = {}) {
        assert.equal(clientH.connect({
          ...H, shortId: 'hhh111', label: 'alpha', pid: 1111,
          cwd: 'C:/proj/alpha', branch: 'main',
        }).ok, true);
        if (alias !== null) fx.aliasH(alias);
      },
      aliasH(alias) {
        assert.equal(store.setTuiSessionAlias({ trackingId: H.trackingId, alias }).ok, true);
      },
      connectE({ alias = null } = {}) {
        assert.equal(clientE.connect({
          ...E, shortId: 'ddd222', label: 'beta', pid: 2222,
          cwd: 'C:/proj/alpha', branch: 'main',
        }).ok, true);
        if (alias !== null) fx.aliasE(alias);
      },
      aliasE(alias) {
        assert.equal(store.setTuiSessionAlias({ trackingId: E.trackingId, alias }).ok, true);
      },
      projectKey() {
        const [row] = store.listTuiSessions({ staleCutoff: now() - 30_000 });
        return row.projectKey;
      },
      square(key) {
        return PROJECT_COLOR_SLOTS[parseInt(key.slice(0, 8), 16) % 8];
      },
    };
    return fx;
  }

  test('live replies prefer the session alias, then the project alias, then the label', async () => {
    const fx = makeHeaderFixture();
    try {
      fx.connectH();
      const key = fx.projectKey();
      const square = fx.square(key);
      assert.equal(fx.store.setTuiProjectAlias({ projectKey: key, alias: 'Alpha HQ' }).ok, true);
      fx.aliasH('alpha window');
      const api = makeFakeApi();
      const broker = fx.newBroker(api);
      await fx.deliver(broker, api, msg('/status'));
      assert.equal(api.sent[0].text, `${square} Pi · alpha window · main — Status requested.`);
      await fx.deliver(broker, api, msg('/start'));
      assert.equal(api.sent[1].text, `Connected to ${square} Pi · alpha window · main. Just type a message and it goes to that Pi.`);
      // Clearing the session alias falls to the project alias.
      fx.aliasH(null);
      await fx.deliver(broker, api, msg('/status'));
      assert.equal(api.sent[2].text, `${square} Pi · Alpha HQ · main — Status requested.`);
      // Clearing the project alias falls to the raw label.
      assert.equal(fx.store.setTuiProjectAlias({ projectKey: key, alias: null }).ok, true);
      await fx.deliver(broker, api, msg('/status'));
      assert.equal(api.sent[3].text, `${square} Pi · alpha · main — Status requested.`);
    } finally { fx.close(); }
  });

  test('same-project windows with distinct aliases produce distinct headers', async () => {
    const fx = makeHeaderFixture();
    try {
      fx.connectH({ alias: 'window one' });
      fx.connectE({ alias: 'window two' });
      const square = fx.square(fx.projectKey());
      const api = makeFakeApi();
      const broker = fx.newBroker(api);
      await fx.deliver(broker, api, msg('/status hhh111'));
      assert.equal(api.sent[0].text, `${square} Pi · window one · main — Status requested.`);
      await fx.deliver(broker, api, msg('/status ddd222'));
      assert.equal(api.sent[1].text, `${square} Pi · window two · main — Status requested.`);
      assert.notEqual(api.sent[0].text, api.sent[1].text);
    } finally { fx.close(); }
  });

  test('a frozen event alias wins over a later rename; a frozen null alias never adopts one', async () => {
    const fx = makeHeaderFixture();
    try {
      fx.connectH(); // auto 'connected' event frozen with a null alias
      const square = fx.square(fx.projectKey());
      fx.aliasH('frozen win');
      assert.equal(fx.store.appendTuiEvent({
        trackingId: H.trackingId, kind: 'connected', payload: null,
      }).ok, true);
      fx.aliasH('renamed win');
      const api = makeFakeApi();
      const broker = fx.newBroker(api);
      await fx.drain(broker);
      assert.equal(api.sent[0].text, `${square} Pi · alpha · main is connected.`,
        'a snapshot alias that was null stays null: no later session alias, no label swap');
      assert.equal(api.sent[1].text, `${square} Pi · frozen win · main is connected.`,
        'a snapshot alias wins even after the live session was renamed');
      for (const record of api.sent) {
        assert.doesNotMatch(record.text, /renamed win/);
      }
    } finally { fx.close(); }
  });

  test('a snapshot null alias falls back to the CURRENT project alias, never a later session alias', async () => {
    const fx = makeHeaderFixture();
    try {
      fx.connectH(); // snapshot alias frozen null
      const key = fx.projectKey();
      const square = fx.square(key);
      assert.equal(fx.store.setTuiProjectAlias({ projectKey: key, alias: 'Alpha HQ' }).ok, true);
      fx.aliasH('late alias');
      const api = makeFakeApi();
      const broker = fx.newBroker(api);
      await fx.drain(broker);
      assert.equal(api.sent[0].text, `${square} Pi · Alpha HQ · main is connected.`,
        'the project alias is a legitimate CURRENT project-level fallback');
      assert.doesNotMatch(api.sent[0].text, /late alias/);
    } finally { fx.close(); }
  });

  test('a legacy all-null snapshot event falls back to the live identity cache', async () => {
    const fx = makeHeaderFixture();
    try {
      fx.connectH({ alias: 'live cache win' });
      assert.equal(fx.store.appendTuiEvent({
        trackingId: H.trackingId, kind: 'connected', payload: null,
      }).ok, true);
      fx.close();
      // Reduce the event to a legacy all-null snapshot and erase the
      // session/project history, exactly like a pre-T4B1 row whose session
      // is gone and that the store backfill could not match.
      const raw = new DatabaseSync(join(fx.dir, 'bridge.sqlite'));
      raw.exec('DELETE FROM tui_sessions; DELETE FROM tui_projects;'
        + 'DELETE FROM tui_session_aliases;'
        + 'UPDATE tui_events SET session_label=NULL, session_alias=NULL,'
        + 'session_branch=NULL, project_key=NULL;');
      raw.close();
      // Reopen: the backfill must find nothing (all sources erased).
      const reopened = new Store(join(fx.dir, 'bridge.sqlite'), {
        now: fx.now, isProcessAlive: () => true,
      });
      const clientH = new TuiBridgeClient(reopened, { staleAfterMs: 30_000 });
      assert.equal(clientH.connect({
        ...H, shortId: 'hhh111', label: 'alpha', pid: 1111,
        cwd: 'C:/proj/alpha', branch: 'main',
      }).ok, true);
      assert.equal(reopened.setTuiSessionAlias({
        trackingId: H.trackingId, alias: 'live cache win',
      }).ok, true);
      const api = makeFakeApi();
      const broker = new SelectiveTelegramBroker({
        store: reopened, api, config: BROKER_CONFIG, now: fx.now,
      });
      await broker.drainTuiEvents();
      assert.ok(api.sent.length >= 1);
      assert.equal(api.sent[0].text, '🟫 Pi · live cache win · main is connected.',
        'only an ALL-NULL legacy snapshot may fall back to the live identity cache');
      assert.doesNotMatch(api.sent[0].text, /⬜/);
      reopened.close();
    } finally { fx.close(); }
  });

  test('disconnected and final_output events after a broker restart use the snapshot color, name and branch', async () => {
    const fx = makeHeaderFixture();
    try {
      fx.connectH({ alias: 'snap win' });
      const square = fx.square(fx.projectKey());
      assert.equal(fx.clientH.publishFinalOutput({ ...H, text: 'final body' }).ok, true);
      assert.equal(fx.clientH.disconnect({ ...H }).ok, true);
      // Fresh broker: memory-only identity cache is empty; only the frozen
      // snapshots on the events remain.
      const api = makeFakeApi();
      const broker = fx.newBroker(api);
      await fx.drain(broker);
      assert.ok(api.sent.length >= 3);
      assert.equal(api.sent[1].text, `${square} Pi · snap win · main\nfinal body`,
        'the final output must keep the frozen alias, branch and project color');
      assert.equal(api.sent[2].text, `${square} Pi · snap win · main disconnected.`,
        'the disconnected notice must keep the frozen identity');
      assert.doesNotMatch(api.sent[1].text, /⬜/);
      assert.doesNotMatch(api.sent[2].text, /⬜/);
    } finally { fx.close(); }
  });

  test('explicit-target acks identify the actual target, not merely the selected session', async () => {
    const fx = makeHeaderFixture();
    try {
      fx.connectH({ alias: 'window one' });
      fx.connectE({ alias: 'window two' });
      const square = fx.square(fx.projectKey());
      const api = makeFakeApi();
      const broker = fx.newBroker(api);
      await fx.deliver(broker, api, msg('/use hhh111'));
      assert.equal(api.sent[0].text, `${square} Pi · window one · main — Selected.`);
      await fx.deliver(broker, api, msg('/status'));
      assert.equal(api.sent[1].text, `${square} Pi · window one · main — Status requested.`,
        'an omitted id resolves through the selection');
      await fx.deliver(broker, api, msg('/status ddd222'));
      assert.equal(api.sent[2].text, `${square} Pi · window two · main — Status requested.`,
        'an explicit id must name the target, not the selection');
    } finally { fx.close(); }
  });

  test('the busy card and the first abort acknowledgement name the session', async () => {
    const fx = makeHeaderFixture();
    try {
      fx.connectH({ alias: 'busy win' });
      assert.equal(fx.clientH.setState({ ...H, state: 'busy' }).ok, true);
      const square = fx.square(fx.projectKey());
      const api = makeFakeApi();
      const broker = fx.newBroker(api);
      await fx.deliver(broker, api, msg('hello there'));
      assert.equal(
        api.sent[0].text,
        `${square} Pi · busy win · main is still working on the current task. `
        + 'What should I do with your message?',
      );
      const abortData = api.sent[0].replyMarkup.inline_keyboard
        .flat()
        .find((button) => button.callback_data.startsWith('v1:a:'))
        .callback_data;
      await fx.deliver(broker, api, cb(abortData));
      const ackTexts = api.sent.slice(1).map((record) => record.text);
      assert.equal(ackTexts[0], `${square} Pi · busy win · main — Stopping the current task...`,
        'the first abort acknowledgement must never be anonymous');
      assert.equal(ackTexts[1], `Stopped. Your message is on its way to ${square} Pi · busy win · main.`);
    } finally { fx.close(); }
  });

  test('status events keep the model in the body only; the header is identity', async () => {
    const fx = makeHeaderFixture();
    try {
      fx.connectH({ alias: 'status win' });
      assert.equal(fx.store.appendTuiEvent({
        trackingId: H.trackingId,
        kind: 'status',
        payload: { state: 'busy', model: 'test-model' },
      }).ok, true);
      const square = fx.square(fx.projectKey());
      const api = makeFakeApi();
      const broker = fx.newBroker(api);
      await fx.drain(broker);
      const statusText = api.sent[1].text;
      assert.equal(statusText.split('\n')[0], `${square} Pi · status win · main status`);
      assert.match(statusText, /model: test-model/);
      assert.doesNotMatch(statusText.split('\n')[0], /model|busy/);
    } finally { fx.close(); }
  });

  test('global and dashboard copy stays unchanged', async () => {
    const fx = makeHeaderFixture();
    try {
      const api = makeFakeApi();
      const broker = fx.newBroker(api);
      await fx.deliver(broker, api, msg('hello'));
      assert.equal(api.sent[0].text, copyModule.plainNoLive,
        'zero live sessions keeps the exact global copy');
      await fx.deliver(broker, api, msg('/start'));
      assert.equal(api.sent[1].text, copyModule.homeNoLive);
      fx.connectH({ alias: 'w1' });
      fx.connectE();
      await fx.deliver(broker, api, msg('/projects'));
      const dashboard = api.sent[2];
      assert.equal(dashboard.text, copyModule.projectsTitle);
      const rows = dashboard.replyMarkup.inline_keyboard.map((row) => row[0]);
      assert.equal(rows[0].text, 'Active now');
      for (const row of rows.slice(1, -1)) {
        assert.doesNotMatch(row.text, /Pi · /,
          'dashboard rows keep projectRowLabel copy, never the identity header');
        assert.match(row.text, /^(🟢|🟡|⚪) [🟦🟪🟧🟩🟨🟫⬛⬜] .+ · (Available|Working|Waiting)$/u);
      }
      assert.equal(rows[rows.length - 1].text, 'Refresh');
    } finally { fx.close(); }
  });

  test('a long final output carries the header exactly once, keyboard on the last chunk, ack after all sends', async () => {
    const fx = makeHeaderFixture();
    try {
      fx.connectH({ alias: 'long win' });
      const square = fx.square(fx.projectKey());
      assert.equal(fx.clientH.publishFinalOutput({ ...H, text: 'A'.repeat(3900) }).ok, true);
      const api = makeFakeApi();
      const broker = fx.newBroker(api);
      await fx.drain(broker);
      const finalChunks = api.sent.slice(1); // [0] is the auto connected event
      assert.ok(finalChunks.length >= 2, 'the final output must actually be chunked');
      const header = `${square} Pi · long win · main`;
      const occurrences = api.sent
        .map((record) => record.text.split(header).length - 1)
        .reduce((sum, count) => sum + count, 0);
      assert.equal(occurrences, 1, 'the header must appear exactly once across all chunks');
      assert.ok(finalChunks[0].text.startsWith(`${header}\n`));
      const last = finalChunks[finalChunks.length - 1];
      assert.deepEqual(
        last.replyMarkup.inline_keyboard[0].map((button) => button.text),
        ['Projects', 'Disconnect'],
        'the keyboard rides only on the final chunk',
      );
      for (let i = 0; i < finalChunks.length - 1; i++) {
        assert.equal(finalChunks[i].replyMarkup, undefined,
          'no keyboard on a non-final chunk');
      }
      assert.equal(fx.store.listPendingBrokerTuiEvents({ limit: 50 }).length, 0,
        'the event is acknowledged only after every chunk was sent');
    } finally { fx.close(); }
  });

  test('an astral-heavy alias survives the full broker path without surrogate damage', async () => {
    const fx = makeHeaderFixture();
    try {
      const astralAlias = '𝕨𝕚𝕟 𝕒'; // 5 astral code points, 10 UTF-16 units
      fx.connectH({ alias: astralAlias });
      const square = fx.square(fx.projectKey());
      assert.equal(fx.clientH.publishFinalOutput({ ...H, text: 'final body' }).ok, true);
      assert.equal(fx.clientH.disconnect({ ...H }).ok, true);
      const api = makeFakeApi();
      const broker = fx.newBroker(api);
      await fx.drain(broker);
      const header = `${square} Pi · ${astralAlias} · main`;
      const finalText = api.sent[1].text;
      assert.equal(finalText, `${header}\nfinal body`);
      assert.equal(api.sent[2].text, `${header} disconnected.`);
      for (const text of [finalText, api.sent[2].text]) {
        assert.doesNotMatch(text,
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
          'a lone surrogate must never reach a Telegram message');
      }
    } finally { fx.close(); }
  });

  test('every visible text stays free of ids, paths, pid mentions and tracking tokens', async () => {
    const fx = makeHeaderFixture();
    try {
      fx.connectH({ alias: 'scan win' });
      fx.connectE({ alias: 'scan two' });
      fx.clientH.setState({ ...H, state: 'busy' });
      const api = makeFakeApi();
      const broker = fx.newBroker(api);
      await fx.deliver(broker, api, msg('/use hhh111'));
      await fx.deliver(broker, api, msg('/projects'));
      await fx.deliver(broker, api, msg('hello there'));
      const abortData = api.sent[api.sent.length - 1].replyMarkup.inline_keyboard
        .flat()
        .find((button) => button.callback_data.startsWith('v1:a:'))
        .callback_data;
      await fx.deliver(broker, api, cb(abortData));
      fx.store.appendTuiEvent({
        trackingId: H.trackingId,
        kind: 'status',
        payload: { state: 'busy', model: 'test-model' },
      });
      fx.clientH.publishFinalOutput({ ...H, text: 'final body' });
      await fx.drain(broker);
      fx.clientH.disconnect({ ...H });
      await fx.drain(broker);
      const forbidden = [
        'hhh111', 'ddd222', H.trackingId, E.trackingId, H.connectionId, E.connectionId,
        'C:/proj/alpha', /pid/i, /\b[0-9a-f]{16,}\b/i, /pi_session/i,
      ];
      const visible = [];
      for (const record of api.sent) {
        visible.push(record.text);
        for (const row of record.replyMarkup?.inline_keyboard ?? []) {
          for (const button of row) visible.push(button.text);
        }
      }
      assert.ok(visible.length > 5, 'the script must have produced visible texts');
      for (const text of visible) {
        for (const needle of forbidden) {
          const hit = needle instanceof RegExp ? needle.test(text) : text.includes(needle);
          assert.ok(!hit, `leaked "${needle}" in: ${JSON.stringify(text)}`);
        }
      }
    } finally { fx.close(); }
  });
});

