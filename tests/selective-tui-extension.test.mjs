// T05: beginner /tg one-command opt-in — extension-level behavior tests.
//
// Imports the TypeScript extension directly under Node 24 type stripping
// (no transpiler, no extra dependency). The ExtensionAPI and
// ExtensionContext are duck-typed fakes; every state root is a fresh temp
// directory strictly below the module's git-ignored .local/test-runs.
// No network, no Telegram, no credentials content, no model calls: the
// fake pi records sendUserMessage/registerTool invocations so the tests
// can prove none happen.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store.mjs';
import { TuiBridgeClient } from '../src/tui-bridge-client.mjs';
import { SelectiveTuiBridgeExtension, createSelectiveTuiExtension } from '../extension/selective-tui-extension.ts';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

// The process-wide opt-in flag key documented in the extension source. The
// tests use it only to simulate fresh-process and continuity lifecycles.
const OPT_IN_KEY = '__piTelegramBridgeOptIn__';

// Exact local TUI copy (docs/BEGINNER_UX.md section 4 as implemented).
const MSG_TG_USAGE = 'Use /tg to link this Pi, or /tg off to unlink it.';
const MSG_TG_NOT_TUI = 'telegram bridge: /tg requires interactive TUI mode';
const MSG_TG_ALREADY_UNLINKED = "This Pi isn't linked to Telegram. Type /tg to link it.";
const MSG_C1_CONFIRM =
  "Link this Pi window to Telegram? You'll be able to send it messages from your phone and it will reply there.";
const MSG_C4_BUSY =
  'Note: this Pi is in the middle of a task. Its result will arrive on Telegram when it finishes.';
const MSG_C5_UNLINK_ASK = 'Unlink this Pi from Telegram?';
const MSG_C7_BUSY =
  'Warning: a task is still running here. Its result will NOT be sent to Telegram anymore.';
const MSG_C6_UNLINKED = 'Unlinked. This window no longer talks to Telegram.';
const MSG_C8_SETUP =
  "Your PC isn't linked to Telegram yet. Double-click Setup Pi Telegram on your PC first, then come back here.";
const MSG_C2_PHONE_UNAVAILABLE =
  "Linked, but the phone connection on this PC isn't running right now. In the Pi Telegram folder run \".\\telegram on\", then send your message again. This Pi will stay linked.";
const msgC2 = (bareLabel) =>
  `Linked. Send a message from your phone — this Pi (Pi · ${bareLabel}) will answer. Type /tg off to unlink.`;
const msgC3 = (bareLabel, state) =>
  `This Pi is linked as 'Pi · ${bareLabel}' (currently ${state}). Type /tg off to unlink.`;
const msgC3Unavailable = (bareLabel) =>
  `This Pi is linked as 'Pi · ${bareLabel}', but the phone connection on this PC isn't running right now. Run ".\\telegram on" in the Pi Telegram folder, then try again.`;
const TEST_INSTANCE_ID = 'a'.repeat(32);

/** Duck-typed ExtensionAPI: records commands, events, sends and tools. */
function makePi() {
  const commands = new Map();
  const eventHandlers = new Map();
  const sentMessages = [];
  const toolRegistrations = [];
  return {
    commands,
    eventHandlers,
    sentMessages,
    toolRegistrations,
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(tool) { toolRegistrations.push(tool); },
    on(event, handler) {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event).push(handler);
    },
    async emit(event, payload, ctx) {
      for (const handler of eventHandlers.get(event) ?? []) {
        await handler(payload, ctx);
      }
    },
  };
}

/**
 * Duck-typed ExtensionContext. `selectAnswer` is a fixed value (string or
 * undefined = timeout/cancel) or a function (title, options) => choice.
 */
function makeCtx({ mode = 'tui', cwd = 'C:/proj/demo-project', idle = true, selectAnswer } = {}) {
  const notifications = [];
  const dialogs = [];
  const statuses = [];
  const ui = {
    notify: (message, level) => { notifications.push({ message, level }); },
    setStatus: (key, value) => { statuses.push({ key, value }); },
    select: async (title, options) => {
      dialogs.push({ title, options });
      return typeof selectAnswer === 'function' ? selectAnswer(title, options) : selectAnswer;
    },
  };
  const ctx = {
    mode,
    ui,
    isIdle: () => idle,
    sessionManager: {
      getSessionId: () => 'sess-0001',
      getSessionFile: () => 'C:/sessions/main.jsonl',
    },
    abort() {},
  };
  // cwd === null models a context with no working directory at all.
  if (cwd !== null) ctx.cwd = cwd;
  return { ctx, notifications, dialogs, statuses };
}

function writeBrokerHealthFixture(stateDirectory, state = 'live') {
  mkdirSync(stateDirectory, { recursive: true });
  if (state !== 'missing-runtime') {
    writeFileSync(
      join(stateDirectory, 'runtime.json'),
      JSON.stringify({ version: 1, instanceId: TEST_INSTANCE_ID, bridge: { mode: 'selective' } }),
    );
  }
  if (state === 'missing-meta') return;
  if (state === 'malformed-meta') {
    writeFileSync(join(stateDirectory, 'broker-meta.json'), '{ not json');
    return;
  }
  const meta = {
    instanceId: state === 'mismatched-instance' ? 'b'.repeat(32) : TEST_INSTANCE_ID,
    pid: state === 'invalid-pid' ? 0 : state === 'dead-pid' ? 2_147_483_647 : process.pid,
    startedAt: Date.now(),
    heartbeatAt: state === 'stale' ? Date.now() - 60_000 : Date.now(),
    shutdownAt: state === 'shutdown' ? Date.now() : null,
  };
  writeFileSync(join(stateDirectory, 'broker-meta.json'), JSON.stringify(meta));
}

/**
 * One isolated extension lifecycle: fresh state root, fresh fake pi and
 * context. Cleanup is idempotent: the advanced disconnect is invoked (a
 * no-op when not connected) and the process-global opt-in flag is cleared.
 */
function makeFixture({ credentials = true, brokerState = 'live', cwd, idle, selectAnswer } = {}) {
  const dir = mkdtempSync(join(TEST_RUNS, 'ext-t05-'));
  const stateDirectory = join(dir, 'state');
  if (credentials) {
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, 'credentials.bin'), 'presence-only-placeholder');
    writeBrokerHealthFixture(stateDirectory, brokerState);
  }
  const extension = new SelectiveTuiBridgeExtension(stateDirectory);
  const pi = makePi();
  extension.register(pi);
  const context = makeCtx({ cwd, idle, selectAnswer });
  const sqlitePath = join(stateDirectory, 'bridge.sqlite');

  async function run(command, args, ctx = context.ctx) {
    const definition = pi.commands.get(command);
    if (!definition) throw new Error(`command not registered: ${command}`);
    await definition.handler(args, ctx);
  }

  /** Second store handle over the same sqlite for assertions (or null). */
  function probe() {
    if (!existsSync(sqlitePath)) return null;
    const store = new Store(sqlitePath);
    const client = new TuiBridgeClient(store);
    return { store, client, sessions: () => client.listSessions(), close: () => store.close() };
  }

  async function cleanup() {
    try {
      if (pi.commands.get('telegram-disconnect')) {
        await run('telegram-disconnect', '');
      }
    } catch {
      // Cleanup must never mask a test failure.
    }
    delete globalThis[OPT_IN_KEY];
  }

  return { dir, stateDirectory, sqlitePath, extension, pi, ...context, run, probe, cleanup };
}

/** Seed one live session with the given label directly into the store. */
function seedLiveSession(fx, label) {
  const store = new Store(fx.sqlitePath, { isProcessAlive: () => true });
  const client = new TuiBridgeClient(store);
  const result = client.connect({ label, pid: process.pid });
  assert.equal(result.ok, true);
  store.close();
  return { trackingId: result.trackingId, connectionId: result.connectionId };
}

describe('/tg registration and argument completion', () => {
  test('tg is registered with off completion; advanced commands stay registered; no tools', async () => {
    const fx = makeFixture();
    try {
      assert.ok(fx.pi.commands.get('tg'));
      assert.match(fx.pi.commands.get('tg').description, /Telegram/);
      for (const name of ['telegram-connect', 'telegram-disconnect', 'telegram-status']) {
        assert.ok(fx.pi.commands.get(name), `${name} must remain registered`);
      }
      const complete = fx.pi.commands.get('tg').getArgumentCompletions;
      assert.deepEqual(complete(''), [{ value: 'off', label: 'off' }]);
      assert.deepEqual(complete('o'), [{ value: 'off', label: 'off' }]);
      assert.deepEqual(complete('off'), [{ value: 'off', label: 'off' }]);
      assert.equal(complete('x'), null);
      assert.equal(complete('offx'), null);
      assert.equal(fx.pi.toolRegistrations.length, 0, 'the extension must register no tools');
    } finally { await fx.cleanup(); }
  });
});

describe('/tg fails closed outside the interactive TUI', () => {
  test('non-TUI context: local error notification, no dialog, no connection', async () => {
    const fx = makeFixture();
    try {
      const cli = makeCtx({ mode: 'cli' });
      await fx.run('tg', '', cli.ctx);
      assert.deepEqual(cli.notifications, [{ message: MSG_TG_NOT_TUI, level: 'error' }]);
      assert.equal(cli.dialogs.length, 0);
      assert.equal(fx.probe(), null, 'no store may be created outside the TUI');
      // /tg off fails closed the same way.
      await fx.run('tg', 'off', cli.ctx);
      assert.equal(cli.dialogs.length, 0);
      assert.equal(fx.probe(), null);
    } finally { await fx.cleanup(); }
  });
});

describe('/tg with incomplete setup (MSG-C8)', () => {
  test('exact friendly copy, no leaked path, no dialog, no store creation', async () => {
    const fx = makeFixture({ credentials: false });
    try {
      await fx.run('tg', '');
      assert.deepEqual(fx.notifications, [{ message: MSG_C8_SETUP, level: 'warning' }]);
      assert.ok(!fx.notifications[0].message.includes(fx.stateDirectory));
      assert.ok(!fx.notifications[0].message.includes('credentials'));
      assert.ok(!fx.notifications[0].message.includes(fx.dir));
      assert.equal(fx.dialogs.length, 0);
      assert.equal(fx.probe(), null, 'the guard must not create or touch the store');
    } finally { await fx.cleanup(); }
  });
});

describe('/tg connect flow', () => {
  test('confirmation dialog with literal options; Cancel is a no-op that creates nothing', async () => {
    const fx = makeFixture({ selectAnswer: 'Cancel' });
    try {
      await fx.run('tg', '');
      assert.equal(fx.dialogs.length, 1);
      assert.equal(fx.dialogs[0].title, MSG_C1_CONFIRM);
      assert.deepEqual(fx.dialogs[0].options, ['Connect', 'Cancel']);
      assert.equal(fx.notifications.length, 0, 'Cancel must produce no status change copy');
      assert.equal(fx.probe(), null, 'Cancel must not create the store');
      // Timeout/dismissal (undefined) is the same no-op.
      const fx2 = makeFixture();
      try {
        await fx2.run('tg', '');
        assert.equal(fx2.probe(), null);
      } finally { await fx2.cleanup(); }
    } finally { await fx.cleanup(); }
  });

  test('busy connect appends MSG-C4 to the confirmation title', async () => {
    const fx = makeFixture({ idle: false, selectAnswer: 'Cancel' });
    try {
      await fx.run('tg', '');
      assert.equal(fx.dialogs[0].title, `${MSG_C1_CONFIRM}\n${MSG_C4_BUSY}`);
      assert.deepEqual(fx.dialogs[0].options, ['Connect', 'Cancel']);
    } finally { await fx.cleanup(); }
  });

  test('Connect links this Pi with the auto label and reports MSG-C2', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      assert.deepEqual(fx.notifications, [
        { message: msgC2('demo-project'), level: 'info' },
      ]);
      const p = fx.probe();
      assert.ok(p, 'connecting must create the store');
      const sessions = p.sessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].label, 'demo-project');
      assert.equal(sessions[0].live, true);
      assert.equal(sessions[0].cwd, 'C:/proj/demo-project');
      p.close();
      const footer = fx.statuses.find((s) => s.key === 'pi-telegram');
      assert.ok(footer && footer.value.startsWith('tg:'), 'the footer must show the live short id');
      assert.ok(globalThis[OPT_IN_KEY], 'connecting writes the process-local opt-in');
    } finally { await fx.cleanup(); }
  });

  test('/tg while connected is an idempotent status without re-confirmation (MSG-C3)', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      const dialogsBefore = fx.dialogs.length;
      await fx.run('tg', '');
      assert.deepEqual(fx.notifications[1], {
        message: msgC3('demo-project', 'connected'),
        level: 'info',
      });
      assert.equal(fx.dialogs.length, dialogsBefore, 'no second confirmation dialog');
      const p = fx.probe();
      assert.equal(p.sessions().length, 1, 'no second connection may appear');
      p.close();
    } finally { await fx.cleanup(); }
  });
});

describe('/tg broker availability copy', () => {
  for (const brokerState of [
    'missing-meta',
    'missing-runtime',
    'malformed-meta',
    'mismatched-instance',
    'stale',
    'shutdown',
    'dead-pid',
    'invalid-pid',
  ]) {
    test(`${brokerState}: links locally but reports the phone connection unavailable`, async () => {
      const fx = makeFixture({ brokerState, selectAnswer: 'Connect' });
      try {
        await fx.run('tg', '');
        assert.deepEqual(fx.notifications, [
          { message: MSG_C2_PHONE_UNAVAILABLE, level: 'info' },
        ]);
        const p = fx.probe();
        assert.ok(p, 'unavailable broker metadata must not block local linking');
        const sessions = p.sessions();
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].live, true, 'the Pi stays linked for automatic recovery');
        p.close();
        const message = fx.notifications[0].message;
        assert.ok(!message.includes(fx.stateDirectory));
        assert.ok(!message.includes(TEST_INSTANCE_ID));
        assert.doesNotMatch(message, /broker|broker-meta|runtime|credentials|\.json|\bpid\b|tg:/i);
      } finally { await fx.cleanup(); }
    });
  }

  test('/tg status becomes truthful if a previously live broker heartbeat goes stale', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      writeBrokerHealthFixture(fx.stateDirectory, 'stale');
      await fx.run('tg', '');
      assert.deepEqual(fx.notifications[1], {
        message: msgC3Unavailable('demo-project'),
        level: 'info',
      });
      assert.equal(fx.dialogs.length, 1, 'status stays idempotent with no second confirmation');
      const p = fx.probe();
      assert.equal(p.sessions().length, 1);
      p.close();
    } finally { await fx.cleanup(); }
  });
});

describe('/tg automatic labels (sanitization, bounds, collisions)', () => {
  test('label comes from the cwd folder name, whitespace preserved', async () => {
    const fx = makeFixture({ cwd: 'C:/work/my app', selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      assert.deepEqual(fx.notifications[0], { message: msgC2('my app'), level: 'info' });
    } finally { await fx.cleanup(); }
  });

  test('trailing separators and control characters are removed', async () => {
    const fx = makeFixture({ cwd: 'C:/proj/app/', selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      assert.equal(fx.notifications[0].message, msgC2('app'));
    } finally { await fx.cleanup(); }
  });

  test('control characters collapse; the label stays a single bounded token', async () => {
    const fx = makeFixture({ cwd: 'C:/proj/we\tird', selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      assert.equal(fx.notifications[0].message, msgC2('we ird'));
      const p = fx.probe();
      assert.equal(p.sessions()[0].label, 'we ird');
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('the label is bounded to the store limit of 64 chars', async () => {
    const fx = makeFixture({ cwd: `C:/proj/${'g'.repeat(80)}`, selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      const p = fx.probe();
      assert.equal(p.sessions()[0].label, 'g'.repeat(64));
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('no cwd falls back to the process cwd folder name; bare root falls back to Pi', async () => {
    const fx = makeFixture({ cwd: null, selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      const p = fx.probe();
      assert.equal(p.sessions()[0].label, basename(process.cwd()));
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('empty root path derives the bare fallback label Pi (no Pi · prefix stored)', async () => {
    const fx = makeFixture({ cwd: '/', selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      const p = fx.probe();
      assert.equal(p.sessions()[0].label, 'Pi');
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('a live same-label session gets ordinal (2)', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      seedLiveSession(fx, 'demo-project');
      await fx.run('tg', '');
      const p = fx.probe();
      const labels = p.sessions().map((s) => s.label).sort();
      assert.deepEqual(labels, ['demo-project', 'demo-project (2)']);
      assert.equal(fx.notifications[0].message, msgC2('demo-project (2)'));
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('base + (2) already live: the next link becomes (3)', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      seedLiveSession(fx, 'demo-project');
      seedLiveSession(fx, 'demo-project (2)');
      await fx.run('tg', '');
      const p = fx.probe();
      const labels = p.sessions().map((s) => s.label).sort();
      assert.deepEqual(labels, ['demo-project', 'demo-project (2)', 'demo-project (3)']);
      assert.equal(fx.notifications[0].message, msgC2('demo-project (3)'));
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('a gap in the ordinals is filled with the LOWEST free ordinal', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      // (2) is free: the allocator must take it, never skip to (4).
      seedLiveSession(fx, 'demo-project');
      seedLiveSession(fx, 'demo-project (3)');
      await fx.run('tg', '');
      const p = fx.probe();
      const labels = p.sessions().map((s) => s.label).sort();
      assert.deepEqual(labels, ['demo-project', 'demo-project (2)', 'demo-project (3)']);
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('duplicate plain labels: the allocator still picks the lowest free ordinal', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      // Two windows already carry the bare label (e.g. linked via the
      // advanced command before this allocator existed).
      seedLiveSession(fx, 'demo-project');
      seedLiveSession(fx, 'demo-project');
      await fx.run('tg', '');
      const p = fx.probe();
      const labels = p.sessions().map((s) => s.label).sort();
      assert.deepEqual(labels, ['demo-project', 'demo-project', 'demo-project (2)']);
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('unrelated labels are ignored by the allocator', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      seedLiveSession(fx, 'other');
      seedLiveSession(fx, 'unrelated (2)');
      seedLiveSession(fx, 'gardentabl');
      await fx.run('tg', '');
      const p = fx.probe();
      const mine = p.sessions().find((s) => s.cwd === 'C:/proj/demo-project');
      assert.equal(mine.label, 'demo-project', 'a prefix-sharing label must not force an ordinal');
      assert.equal(fx.notifications[0].message, msgC2('demo-project'));
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('a near-64-char base is clipped so the suffix fits the 64-char limit', async () => {
    const fx = makeFixture({ cwd: `C:/proj/${'g'.repeat(80)}`, selectAnswer: 'Connect' });
    try {
      seedLiveSession(fx, 'g'.repeat(64));
      await fx.run('tg', '');
      const p = fx.probe();
      const mine = p.sessions().find((s) => s.cwd === `C:/proj/${'g'.repeat(80)}`);
      assert.equal(mine.label, `${'g'.repeat(60)} (2)`);
      assert.equal(mine.label.length, 64, 'the stored label must fit the store limit exactly');
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('the allocated label stays stable for the connection lifetime even when the slot frees up', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      const seed = seedLiveSession(fx, 'demo-project');
      await fx.run('tg', '');
      const p = fx.probe();
      const mine = p.sessions().find((s) => s.label === 'demo-project (2)');
      assert.ok(mine, 'the second link gets ordinal (2)');
      const trackingId = mine.trackingId;
      p.close();
      // The colliding first window goes away: recomputing now would yield
      // the bare base, but the stored label must never be recomputed.
      const probe = fx.probe();
      assert.equal(
        probe.client.disconnect({ trackingId: seed.trackingId, connectionId: seed.connectionId }).ok,
        true,
      );
      probe.close();
      await fx.pi.emit('session_shutdown', { reason: 'reload' }, fx.ctx);
      const replacement = new SelectiveTuiBridgeExtension(fx.stateDirectory);
      const replacementPi = makePi();
      replacement.register(replacementPi);
      await replacementPi.emit('session_start', {}, makeCtx({}).ctx);
      const reconnected = fx.probe();
      const sessions = reconnected.sessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].trackingId, trackingId);
      assert.equal(sessions[0].label, 'demo-project (2)', 'the stored label survives the reload');
      reconnected.close();
      delete globalThis[OPT_IN_KEY];
    } finally { await fx.cleanup(); }
  });
});

describe('/tg off unlink flow', () => {
  test('idle: Unlink/Cancel dialog; Cancel keeps the link', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      const unlinkFx = makeCtx({ selectAnswer: 'Cancel' });
      await fx.run('tg', 'off', unlinkFx.ctx);
      assert.equal(unlinkFx.dialogs.length, 1);
      assert.equal(unlinkFx.dialogs[0].title, MSG_C5_UNLINK_ASK);
      assert.deepEqual(unlinkFx.dialogs[0].options, ['Unlink', 'Cancel']);
      assert.ok(!unlinkFx.notifications.some((n) => n.message === MSG_C6_UNLINKED));
      const p = fx.probe();
      assert.equal(p.sessions().length, 1, 'Cancel must keep the live connection');
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('idle: Unlink disconnects, clears opt-in and reports MSG-C6', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      assert.ok(globalThis[OPT_IN_KEY]);
      const unlinkFx = makeCtx({ selectAnswer: 'Unlink' });
      await fx.run('tg', 'off', unlinkFx.ctx);
      assert.deepEqual(unlinkFx.notifications, [
        { message: MSG_C6_UNLINKED, level: 'info' },
      ]);
      const p = fx.probe();
      assert.equal(p.sessions().length, 0, 'the remote row must be gone');
      p.close();
      assert.equal(globalThis[OPT_IN_KEY], undefined, 'the opt-in must be cleared');
      // The footer clear lands in the context that ran the unlink flow,
      // not in the original connect context.
      const cleared = unlinkFx.statuses.filter(
        (s) => s.key === 'pi-telegram' && s.value === undefined,
      );
      assert.ok(cleared.length >= 1, 'the footer status must be cleared');
    } finally { await fx.cleanup(); }
  });

  test('busy: MSG-C7 warning with Unlink anyway/Cancel; Unlink anyway unlinks', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      const busyFx = makeCtx({ idle: false, selectAnswer: 'Unlink anyway' });
      await fx.run('tg', 'off', busyFx.ctx);
      assert.equal(busyFx.dialogs[0].title, `${MSG_C5_UNLINK_ASK}\n${MSG_C7_BUSY}`);
      assert.deepEqual(busyFx.dialogs[0].options, ['Unlink anyway', 'Cancel']);
      assert.deepEqual(busyFx.notifications, [{ message: MSG_C6_UNLINKED, level: 'info' }]);
      const p = fx.probe();
      assert.equal(p.sessions().length, 0);
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('busy: Cancel keeps the link', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      const busyFx = makeCtx({ idle: false, selectAnswer: 'Cancel' });
      await fx.run('tg', 'off', busyFx.ctx);
      const p = fx.probe();
      assert.equal(p.sessions().length, 1);
      p.close();
      assert.ok(globalThis[OPT_IN_KEY], 'Cancel must keep the process-local opt-in');
    } finally { await fx.cleanup(); }
  });

  test('/tg off while disconnected is a friendly no-op with no store mutation', async () => {
    const fx = makeFixture();
    try {
      await fx.run('tg', 'off');
      assert.deepEqual(fx.notifications, [
        { message: MSG_TG_ALREADY_UNLINKED, level: 'info' },
      ]);
      assert.equal(fx.dialogs.length, 0);
      assert.equal(fx.probe(), null, 'no store may be created by the already-unlinked status');
      assert.equal(globalThis[OPT_IN_KEY], undefined);
    } finally { await fx.cleanup(); }
  });
});

describe('/tg invalid arguments', () => {
  test('any other argument shows the beginner usage and connects nothing', async () => {
    for (const args of ['now', 'off extra', 'connect', 'demo-project']) {
      const fx = makeFixture({ selectAnswer: 'Connect' });
      try {
        await fx.run('tg', args);
        assert.deepEqual(fx.notifications, [{ message: MSG_TG_USAGE, level: 'info' }]);
        assert.equal(fx.dialogs.length, 0);
        assert.equal(fx.probe(), null);
      } finally { await fx.cleanup(); }
    }
  });

  test('invalid args while connected show the usage and never change the link', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      await fx.run('tg', 'label me');
      assert.deepEqual(fx.notifications[1], { message: MSG_TG_USAGE, level: 'info' });
      const p = fx.probe();
      assert.equal(p.sessions().length, 1);
      p.close();
    } finally { await fx.cleanup(); }
  });
});

describe('advanced /telegram-* commands preserved', () => {
  test('custom label override, status format, double-connect guard and disconnect', async () => {
    const fx = makeFixture();
    try {
      await fx.run('telegram-connect', 'my-label');
      assert.match(fx.notifications[0].message, /^telegram bridge connected: tg:[A-Za-z0-9_-]+$/);
      const p = fx.probe();
      assert.equal(p.sessions()[0].label, 'my-label');
      const shortId = p.sessions()[0].shortId;
      p.close();
      await fx.run('telegram-status', '');
      assert.equal(
        fx.notifications[1].message,
        `telegram bridge: tg:${shortId} state=connected pid=${process.pid}`
          + ` label=my-label cwd=C:/proj/demo-project session=sess-0001`,
      );
      await fx.run('telegram-connect', 'second');
      assert.equal(
        fx.notifications[2].message,
        `telegram bridge: already connected as tg:${shortId}`,
      );
      await fx.run('telegram-disconnect', '');
      assert.equal(fx.notifications[3].message, 'telegram bridge disconnected');
      const p2 = fx.probe();
      assert.equal(p2.sessions().length, 0);
      p2.close();
    } finally { await fx.cleanup(); }
  });

  test('the advanced long label is bounded to 64 chars exactly as before', async () => {
    const fx = makeFixture();
    try {
      await fx.run('telegram-connect', 'x'.repeat(70));
      const p = fx.probe();
      assert.equal(p.sessions()[0].label, 'x'.repeat(64));
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('the advanced command still works without the beginner dialog', async () => {
    const fx = makeFixture();
    try {
      await fx.run('telegram-connect', '');
      assert.equal(fx.dialogs.length, 0, 'the advanced path must never open a dialog');
      assert.equal(fx.notifications[0].level, 'info');
    } finally { await fx.cleanup(); }
  });
});

describe('process-local lifecycle: no auto-connect, opt-in continuity', () => {
  test('a fresh extension lifecycle never connects by itself', async () => {
    const fx = makeFixture();
    try {
      delete globalThis[OPT_IN_KEY];
      const fresh = makeCtx({});
      await fx.pi.emit('session_start', {}, fresh.ctx);
      assert.equal(fx.probe(), null, 'no store may even be created without opt-in');
      assert.equal(fx.dialogs.length, 0);
    } finally { await fx.cleanup(); }
  });

  test('reload continuity: a new instance reconnects with the same tracking id and label', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      const before = fx.probe();
      const trackingId = before.sessions()[0].trackingId;
      before.close();
      await fx.pi.emit('session_shutdown', { reason: 'reload' }, fx.ctx);
      const afterShutdown = fx.probe();
      assert.equal(afterShutdown.sessions().length, 0, 'the old row is released');
      afterShutdown.close();
      // New extension instance, same OS process (reload/session replacement).
      const replacement = new SelectiveTuiBridgeExtension(fx.stateDirectory);
      const replacementPi = makePi();
      replacement.register(replacementPi);
      const replacementCtx = makeCtx({});
      await replacementPi.emit('session_start', {}, replacementCtx.ctx);
      const reconnected = fx.probe();
      const sessions = reconnected.sessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].trackingId, trackingId, 'the same process-owned tracking id');
      assert.equal(sessions[0].label, 'demo-project');
      reconnected.close();
      delete globalThis[OPT_IN_KEY];
    } finally { await fx.cleanup(); }
  });

  test('a fresh process (no opt-in flag) stays disconnected even after a previous link', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      delete globalThis[OPT_IN_KEY];
      await fx.pi.emit('session_shutdown', { reason: 'quit' }, fx.ctx);
      const freshProcess = new SelectiveTuiBridgeExtension(fx.stateDirectory);
      const freshPi = makePi();
      freshProcess.register(freshPi);
      await freshPi.emit('session_start', {}, makeCtx({}).ctx);
      const p = fx.probe();
      assert.equal(p.sessions().length, 0, 'a fresh process must never auto-connect');
      p.close();
    } finally { await fx.cleanup(); }
  });
});

describe('no model involvement and factory wiring', () => {
  test('a full /tg cycle sends no user messages and registers no tools', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      await fx.run('tg', '');
      await fx.run('tg', 'off', makeCtx({ selectAnswer: 'Unlink' }).ctx);
      assert.equal(fx.pi.sentMessages.length, 0, 'sendUserMessage must never be called by /tg');
      assert.equal(fx.pi.toolRegistrations.length, 0);
    } finally { await fx.cleanup(); }
  });

  test('the factory accepts a custom state directory and behaves identically', async () => {
    const dir = mkdtempSync(join(TEST_RUNS, 'ext-t05-factory-'));
    const stateDirectory = join(dir, 'state');
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, 'credentials.bin'), 'presence-only-placeholder');
    writeBrokerHealthFixture(stateDirectory);
    try {
      const extension = createSelectiveTuiExtension({ stateDirectory });
      const pi = makePi();
      extension.register(pi);
      const context = makeCtx({ selectAnswer: 'Connect' });
      await pi.commands.get('tg').handler('', context.ctx);
      assert.deepEqual(context.notifications, [
        { message: msgC2('demo-project'), level: 'info' },
      ]);
      delete globalThis[OPT_IN_KEY];
    } finally {
      delete globalThis[OPT_IN_KEY];
    }
  });
});
