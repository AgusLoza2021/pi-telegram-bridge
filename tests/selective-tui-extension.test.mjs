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

/** Duck-typed ExtensionAPI: records commands, events, sends, tools and exec. */
function makePi() {
  const commands = new Map();
  const eventHandlers = new Map();
  const sentMessages = [];
  const toolRegistrations = [];
  const execCalls = [];
  const pi = {
    commands,
    eventHandlers,
    sentMessages,
    toolRegistrations,
    execCalls,
    /** Per-test fake Git implementation; absent impl makes pi.exec throw. */
    execImpl: null,
    /** The ONLY process-spawning surface; tests must never hit real Git. */
    async exec(command, args, options) {
      execCalls.push({ command, args, options });
      if (typeof pi.execImpl !== 'function') {
        throw new Error('fake pi.exec called without an execImpl');
      }
      return pi.execImpl(command, args, options);
    },
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
  return pi;
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
function makeFixture({ credentials = true, brokerState = 'live', cwd, idle, selectAnswer, gitProposalTtlMs } = {}) {
  const dir = mkdtempSync(join(TEST_RUNS, 'ext-t05-'));
  const stateDirectory = join(dir, 'state');
  if (credentials) {
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, 'credentials.bin'), 'presence-only-placeholder');
    writeBrokerHealthFixture(stateDirectory, brokerState);
  }
  const extension = new SelectiveTuiBridgeExtension(stateDirectory, { gitProposalTtlMs });
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

// --- G3: remote Git commit/push (snapshot-bound, fixed argv, fail closed) ----

const FIXED_COMMIT_MESSAGE = 'chore: update project files';
const GIT_PROPOSAL_ID_RE = /^[0-9a-f]{16,64}$/;

/**
 * Fake Git: answers ONLY the fixed read-only snapshot shapes the extension
 * is allowed to run. Anything else returns success with empty output, so
 * unexpected argv is still visible in execCalls. No real Git process is
 * ever spawned.
 */
function gitScript(overrides = {}) {
  const o = {
    toplevel: 'C:/proj/demo-project\n',
    branch: 'main\n',
    head: 'a'.repeat(40) + '\n',
    // Repo state AFTER the modeled mutation: the new commit's parent is the
    // approved head, its subject is the fixed message, and the upstream
    // tracking ref resolves to the approved head. Overrides model drift.
    parentSha: 'a'.repeat(40) + '\n',
    subject: FIXED_COMMIT_MESSAGE + '\n',
    remoteRefSha: 'a'.repeat(40) + '\n',
    patch: 'diff --git a/x.txt b/x.txt\nindex 111..222 100644\n',
    shortstat: ' 1 file changed, 1 insertion(+)\n',
    upstream: 'origin/main\n',
    ahead: '2\n',
    // Full staged-index listing as `git ls-files --stage -z` would report
    // it; overrides model a different staged index (blob id / mode / path).
    indexListing: `100644 ${'1'.repeat(40)} 0\tx.txt\0`,
    ...overrides,
  };
  return async (_command, args) => {
    const a = args.join(' ');
    const out = (stdout) => ({ code: 0, stdout, stderr: '', killed: false });
    const fail = () => ({ code: 128, stdout: '', stderr: 'fatal: fake', killed: false });
    if (a === 'rev-parse --show-toplevel') return o.toplevel === null ? fail() : out(o.toplevel);
    if (a === 'rev-parse --abbrev-ref HEAD') return o.branch === null ? fail() : out(o.branch);
    if (a === 'rev-parse HEAD') return o.head === null ? fail() : out(o.head);
    if (a === 'rev-parse HEAD^') return o.parentSha === null ? fail() : out(o.parentSha);
    if (a === 'log -1 --pretty=%s HEAD') return o.subject === null ? fail() : out(o.subject);
    if (a === 'rev-parse refs/remotes/origin/main') {
      return o.remoteRefSha === null ? fail() : out(o.remoteRefSha);
    }
    if (a === 'ls-files --stage -z') {
      return o.indexListing === null ? fail() : out(o.indexListing);
    }
    if (args[0] === 'diff' && args.includes('--shortstat')) {
      return o.shortstat === null ? fail() : out(o.shortstat);
    }
    if (args[0] === 'diff' && args.includes('--cached')) {
      return o.patch === null ? fail() : out(o.patch);
    }
    if (a === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') {
      return o.upstream === null ? fail() : out(o.upstream);
    }
    if (a === 'rev-list @{u}..HEAD --count') return o.ahead === null ? fail() : out(o.ahead);
    return out('');
  };
}

/** Connect via /tg, wire the fake Git impl, and return the session row. */
async function connectGitFixture({ idle = true, execImpl = gitScript(), gitProposalTtlMs } = {}) {
  const fx = makeFixture({ selectAnswer: 'Connect', idle, gitProposalTtlMs });
  await fx.run('tg', '');
  const p = fx.probe();
  const session = p.sessions()[0];
  p.close();
  fx.pi.execImpl = execImpl;
  return { fx, session };
}

function enqueueGitCommand(fx, session, kind, payload = null) {
  const p = fx.probe();
  const res = p.store.enqueueTuiCommand({ trackingId: session.trackingId, kind, payload });
  p.close();
  assert.equal(res.ok, true);
}

function pendingEvents(fx, kind) {
  const p = fx.probe();
  const events = p.store.listPendingBrokerTuiEvents({ limit: 128 }).filter((e) => e.kind === kind);
  p.close();
  return events;
}

function commandResults(fx) {
  return pendingEvents(fx, 'command_result').map((e) => e.payload);
}

function latestProposalId(fx) {
  const events = pendingEvents(fx, 'git_proposal');
  return events.length > 0 ? events[events.length - 1].payload.proposalId : null;
}

describe('G3: /commit request builds a snapshot-bound commit proposal', () => {
  test('the proposal message leads with the exact fixed commit message and the snapshot lines', async () => {
    const { fx, session } = await connectGitFixture();
    try {
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      const proposals = pendingEvents(fx, 'git_proposal');
      assert.equal(proposals.length, 1);
      const payload = proposals[0].payload;
      assert.equal(payload.operation, 'commit');
      assert.match(payload.proposalId, GIT_PROPOSAL_ID_RE);
      assert.ok(
        payload.message.startsWith(FIXED_COMMIT_MESSAGE),
        'the automatic commit text must lead the card body exactly',
      );
      assert.ok(payload.message.includes('Branch: main'));
      assert.ok(payload.message.includes('1 file changed, 1 insertion(+)'));
      assert.match(payload.message, /Fingerprint: [0-9a-f]{16}/);
      const results = commandResults(fx);
      assert.equal(results.length, 1, 'exactly one terminal result per command');
      assert.equal(results[0].ok, true);
    } finally { await fx.cleanup(); }
  });

  test('every Git call goes through pi.exec as argv with a bounded timeout and the connection cwd', async () => {
    const { fx, session } = await connectGitFixture();
    try {
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      assert.ok(fx.pi.execCalls.length > 0);
      for (const call of fx.pi.execCalls) {
        assert.equal(call.command, 'git');
        assert.ok(Array.isArray(call.args));
        assert.equal(call.options.cwd, 'C:/proj/demo-project');
        assert.equal(typeof call.options.timeout, 'number');
        assert.ok(call.options.timeout > 0 && call.options.timeout <= 60_000);
      }
    } finally { await fx.cleanup(); }
  });

  test('every diff invocation explicitly forbids external diff/textconv helpers and the index is read via ls-files --stage -z', async () => {
    const { fx, session } = await connectGitFixture();
    try {
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      assert.ok(fx.pi.execCalls.length > 0);
      let sawListing = false;
      for (const call of fx.pi.execCalls) {
        assert.equal(call.command, 'git');
        assert.equal(call.args.includes('-c'), false, 'no per-invocation config overrides');
        assert.equal(call.args.includes('--ext-diff'), false);
        assert.equal(call.args.includes('--textconv'), false);
        if (call.args[0] === 'diff') {
          assert.ok(call.args.includes('--no-ext-diff'),
            'a configured external diff driver must never run');
          assert.ok(call.args.includes('--no-textconv'),
            'a configured textconv filter must never run');
        }
        if (call.args[0] === 'ls-files') {
          sawListing = true;
          assert.deepEqual(call.args, ['ls-files', '--stage', '-z'],
            'the staged index must be captured as a compact deterministic listing');
        }
      }
      assert.equal(sawListing, true, 'the snapshot must capture the staged index listing');
    } finally { await fx.cleanup(); }
  });

  test('a staged binary blob change with identical diff output still produces drift', async () => {
    const binaryDiff = 'Binary files a/shader.bin and b/shader.bin differ\n';
    const base = gitScript({ patch: binaryDiff });
    const listing = (blobId) =>
      `100644 ${blobId} 0\tshader.bin\0`;
    const { fx, session } = await connectGitFixture({
      execImpl: async (command, args, options) => {
        if (args.join(' ') === 'ls-files --stage -z') {
          return { code: 0, stdout: listing('1'.repeat(40)), stderr: '', killed: false };
        }
        return base(command, args, options);
      },
    });
    try {
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      const proposalId = latestProposalId(fx);
      // Between approval and execution the binary blob is replaced with a
      // DIFFERENT object id, while `git diff --cached` and --shortstat
      // render EXACTLY the same (binary blobs both print the same line).
      fx.pi.execImpl = async (command, args, options) => {
        if (args.join(' ') === 'ls-files --stage -z') {
          return { code: 0, stdout: listing('2'.repeat(40)), stderr: '', killed: false };
        }
        return base(command, args, options);
      };
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false,
        'a changed binary blob is a different staged index and must not execute');
      assert.equal(results[1].resultCode, 'git_drift');
      assert.equal(fx.pi.execCalls.some((c) => c.args[0] === 'commit'), false,
        'drift must mean zero mutating calls');
    } finally { await fx.cleanup(); }
  });

  test('nothing staged: the request fails closed without a proposal or a commit call', async () => {
    const { fx, session } = await connectGitFixture({ execImpl: gitScript({ patch: '' }) });
    try {
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      assert.equal(pendingEvents(fx, 'git_proposal').length, 0);
      const results = commandResults(fx);
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, false);
      assert.equal(results[0].resultCode, 'nothing_staged');
      assert.equal(
        fx.pi.execCalls.some((c) => c.args[0] === 'commit'),
        false,
        'no mutating Git call may happen',
      );
    } finally { await fx.cleanup(); }
  });

  test('busy TUI: the request is refused before any Git call', async () => {
    const { fx, session } = await connectGitFixture({ idle: false });
    try {
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      assert.equal(fx.pi.execCalls.length, 0, 'no Git may run while Pi is busy');
      assert.equal(pendingEvents(fx, 'git_proposal').length, 0);
      const results = commandResults(fx);
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, false);
      assert.equal(results[0].resultCode, 'pi_busy');
    } finally { await fx.cleanup(); }
  });

  test('not a repository: the request fails closed without a proposal', async () => {
    const { fx, session } = await connectGitFixture({ execImpl: gitScript({ toplevel: null }) });
    try {
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      assert.equal(pendingEvents(fx, 'git_proposal').length, 0);
      const results = commandResults(fx);
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, false);
      assert.equal(results[0].resultCode, 'not_a_repository');
    } finally { await fx.cleanup(); }
  });

  test('detached HEAD is refused before a proposal is published', async () => {
    const { fx, session } = await connectGitFixture({ execImpl: gitScript({ branch: 'HEAD\n' }) });
    try {
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      assert.equal(pendingEvents(fx, 'git_proposal').length, 0);
      const results = commandResults(fx);
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, false);
      assert.equal(results[0].resultCode, 'detached_head');
    } finally { await fx.cleanup(); }
  });
});

describe('G3: approved commit execution revalidates and uses fixed argv', () => {
  async function approvedFixture({ execImpl = gitScript(), gitProposalTtlMs } = {}) {
    const { fx, session } = await connectGitFixture({ execImpl, gitProposalTtlMs });
    enqueueGitCommand(fx, session, 'git_commit_request');
    await fx.extension.pollOnce();
    const proposalId = latestProposalId(fx);
    assert.ok(proposalId);
    return { fx, session, proposalId };
  }

  test('execute runs exactly `git commit -m <fixed message>` with hooks honored', async () => {
    const { fx, session, proposalId } = await approvedFixture();
    try {
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const commitCalls = fx.pi.execCalls.filter((c) => c.args[0] === 'commit');
      assert.equal(commitCalls.length, 1);
      assert.deepEqual(commitCalls[0].args, ['commit', '-m', FIXED_COMMIT_MESSAGE]);
      const flattened = JSON.stringify(fx.pi.execCalls.map((c) => c.args));
      assert.ok(!flattened.includes('--no-verify'), 'hooks must never be skipped');
      assert.ok(!flattened.includes('core.hooksPath'), 'hook configuration must never be overridden');
      assert.ok(!flattened.includes('"-c"'), 'no git -c config overrides are allowed');
      const results = commandResults(fx);
      assert.equal(results.length, 2);
      assert.equal(results[1].ok, true);
    } finally { await fx.cleanup(); }
  });

  test('HEAD drift between approval and execution refuses the commit', async () => {
    const { fx, session, proposalId } = await approvedFixture();
    try {
      fx.pi.execImpl = gitScript({ head: 'b'.repeat(40) + '\n' });
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results.length, 2);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'git_drift');
      assert.equal(fx.pi.execCalls.some((c) => c.args[0] === 'commit'), false);
    } finally { await fx.cleanup(); }
  });

  test('index drift (staged content changed) refuses the commit', async () => {
    const { fx, session, proposalId } = await approvedFixture();
    try {
      // The staged index changed between approval and execution: a
      // different blob object id in the listing. Diff output is also
      // different, but the listing is what the fingerprint binds.
      fx.pi.execImpl = gitScript({
        patch: 'diff --git a/y.txt b/y.txt\n',
        indexListing: `100644 ${'2'.repeat(40)} 0\tx.txt\0`,
      });
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'git_drift');
      assert.equal(fx.pi.execCalls.some((c) => c.args[0] === 'commit'), false);
    } finally { await fx.cleanup(); }
  });

  test('branch drift refuses the commit', async () => {
    const { fx, session, proposalId } = await approvedFixture();
    try {
      fx.pi.execImpl = gitScript({ branch: 'feature/x\n' });
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].resultCode, 'git_drift');
      assert.equal(fx.pi.execCalls.some((c) => c.args[0] === 'commit'), false);
    } finally { await fx.cleanup(); }
  });

  test('an unknown proposal id (malicious or stale payload) dispatches nothing', async () => {
    const { fx, session } = await approvedFixture();
    try {
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId: 'f'.repeat(16) });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'stale_proposal');
      assert.equal(fx.pi.execCalls.some((c) => c.args[0] === 'commit'), false);
    } finally { await fx.cleanup(); }
  });

  test('a duplicate execute for the same proposal runs the commit exactly once', async () => {
    const { fx, session, proposalId } = await approvedFixture();
    try {
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const commitCalls = fx.pi.execCalls.filter((c) => c.args[0] === 'commit');
      assert.equal(commitCalls.length, 1, 'one-use: the proposal executes at most once');
      const results = commandResults(fx);
      assert.equal(results.length, 3);
      assert.equal(results[1].ok, true);
      assert.equal(results[2].ok, false);
      assert.equal(results[2].resultCode, 'stale_proposal');
    } finally { await fx.cleanup(); }
  });

  test('an expired proposal fails closed even with a matching id', async () => {
    const { fx, session, proposalId } = await approvedFixture({ gitProposalTtlMs: 1 });
    try {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'stale_proposal');
      assert.equal(fx.pi.execCalls.some((c) => c.args[0] === 'commit'), false);
    } finally { await fx.cleanup(); }
  });

  test('an uncertain commit outcome (timeout/kill) reports unknown, never definite failure', async () => {
    const base = gitScript();
    const { fx, session, proposalId } = await approvedFixture({ execImpl: base });
    try {
      // Snapshots succeed; only the mutating commit is killed by its
      // timeout — the real uncertain case: it may or may not have run.
      fx.pi.execImpl = async (command, args, options) => {
        if (args[0] === 'commit') {
          return { code: null, stdout: '', stderr: '', killed: true };
        }
        return base(command, args, options);
      };
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'git_unknown');
      assert.notEqual(results[1].resultCode, 'git_failed');
    } finally { await fx.cleanup(); }
  });

  test('a definite non-hook Git failure reports git_failed without leaking stderr', async () => {
    const base = gitScript();
    const { fx, session, proposalId } = await approvedFixture({ execImpl: base });
    try {
      fx.pi.execImpl = async (command, args, options) => {
        if (args[0] === 'commit') {
          return { code: 1, stdout: '', stderr: 'fatal: secret hook output', killed: false };
        }
        // Unchanged repo: the parent lookup fails and no fixed-subject
        // commit exists, so the post-check proves NO mutation happened.
        if (args[0] === 'rev-parse' && args[1] === 'HEAD^') {
          return { code: 128, stdout: '', stderr: 'fatal: fake', killed: false };
        }
        if (args.join(' ') === 'log -1 --pretty=%s HEAD') {
          return { code: 0, stdout: 'old subject\n', stderr: '', killed: false };
        }
        return base(command, args, options);
      };
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'git_failed');
      assert.ok(
        !JSON.stringify(results).includes('secret hook output'),
        'raw Git stderr must never reach Telegram',
      );
    } finally { await fx.cleanup(); }
  });

  test('a commit exit of 0 is success only when verification proves the approved mutation', async () => {
    const base = gitScript();
    const { fx, session, proposalId } = await approvedFixture({ execImpl: base });
    try {
      // The wrapper maps external signal termination to code 0 — the false
      // success the wrapper may produce. Repo state says NO approved commit
      // exists (HEAD's parent is not the approved head).
      fx.pi.execImpl = async (command, args, options) => {
        if (args[0] === 'commit') return { code: 0, stdout: '', stderr: '', killed: false };
        if (args.join(' ') === 'rev-parse HEAD^') {
          return { code: 0, stdout: 'c'.repeat(40) + '\n', stderr: '', killed: false };
        }
        return base(command, args, options);
      };
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'git_unknown',
        'an unproven mutation must be classified unknown, never success');
    } finally { await fx.cleanup(); }
  });

  test('a verified commit in a SHA-256 repo (64-hex HEAD) reports success', async () => {
    const sha64 = 'a'.repeat(64);
    const { fx, session, proposalId } = await approvedFixture({
      execImpl: gitScript({ head: sha64 + '\n', parentSha: sha64 + '\n' }),
    });
    try {
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, true,
        'a snapshot-valid 64-hex repo that verifies must not be reported unknown');
      assert.equal(results[1].resultCode, 'git_commit_completed');
    } finally { await fx.cleanup(); }
  });

  test('an exception after the mutation reports git_unknown, never internal_error', async () => {
    const base = gitScript();
    const { fx, session, proposalId } = await approvedFixture({ execImpl: base });
    try {
      let commitDone = false;
      fx.pi.execImpl = async (command, args, options) => {
        const result = await base(command, args, options);
        if (args[0] === 'commit') commitDone = true;
        return result;
      };
      // Poison pi.exec with a throwing getter AFTER the mutating call: the
      // runtime surface breaks following a real mutation, so the catch must
      // classify UNCERTAIN — manual inspection before any retry.
      const execDescriptor = Object.getOwnPropertyDescriptor(fx.pi, 'exec');
      Object.defineProperty(fx.pi, 'exec', {
        configurable: true,
        get() {
          if (commitDone) throw new Error('simulated runtime failure');
          return execDescriptor.value;
        },
      });
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'git_unknown',
        'an exception following a mutation must be uncertain, never internal_error');
    } finally { await fx.cleanup(); }
  });

  test('execute-time snapshot failure reports git_unavailable, not git_drift', async () => {
    const base = gitScript();
    const { fx, session, proposalId } = await approvedFixture({ execImpl: base });
    try {
      // The execute-phase revalidation cannot read repository state: that
      // is an availability failure, not proof of drift.
      fx.pi.execImpl = async (command, args, options) => {
        if (args.join(' ') === 'rev-parse HEAD') {
          return { code: 128, stdout: '', stderr: 'fatal: fake', killed: false };
        }
        return base(command, args, options);
      };
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'git_unavailable',
        'an unreadable repository state must not be reported as drift');
      assert.equal(fx.pi.execCalls.some((c) => c.args[0] === 'commit'), false);
    } finally { await fx.cleanup(); }
  });

  test('a killed commit whose repo state proves the mutation still reports unknown', async () => {
    const base = gitScript();
    const { fx, session, proposalId } = await approvedFixture({ execImpl: base });
    try {
      // Signal kill during commit, but the repo state shows a commit with
      // the approved parent and subject: the mutation DID land.
      fx.pi.execImpl = async (command, args, options) => {
        if (args[0] === 'commit') return { code: null, stdout: '', stderr: '', killed: true };
        return base(command, args, options);
      };
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'git_unknown');
    } finally { await fx.cleanup(); }
  });

  test('a successful commit reports exactly one terminal result per command', async () => {
    const { fx, session, proposalId } = await approvedFixture();
    try {
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      assert.equal(commandResults(fx).length, 2, 'exactly one result per command, no duplicates');
    } finally { await fx.cleanup(); }
  });
});

describe('G3: approved push execution targets the configured upstream only', () => {
  async function pushApprovedFixture({ execImpl = gitScript() } = {}) {
    const { fx, session } = await connectGitFixture({ execImpl });
    enqueueGitCommand(fx, session, 'git_push_request');
    await fx.extension.pollOnce();
    const proposalId = latestProposalId(fx);
    assert.ok(proposalId);
    const proposals = pendingEvents(fx, 'git_proposal');
    return { fx, session, proposalId, proposalPayload: proposals[0].payload };
  }

  test('the push proposal card body shows branch, upstream, HEAD and fingerprint', async () => {
    const { fx, proposalPayload } = await pushApprovedFixture();
    try {
      assert.equal(proposalPayload.operation, 'push');
      assert.match(proposalPayload.proposalId, GIT_PROPOSAL_ID_RE);
      assert.ok(proposalPayload.message.includes('Branch: main → origin/main'));
      assert.ok(proposalPayload.message.includes('Ahead: 2 commits'));
      assert.ok(proposalPayload.message.includes(`HEAD: ${'a'.repeat(40)}`));
      assert.match(proposalPayload.message, /Fingerprint: [0-9a-f]{16}/);
    } finally { await fx.cleanup(); }
  });

  test('execute pushes the configured upstream only: tag-scope-proof argv, no force', async () => {
    const { fx, session, proposalId } = await pushApprovedFixture();
    try {
      enqueueGitCommand(fx, session, 'git_push_execute', { proposalId });
      await fx.extension.pollOnce();
      const pushCalls = fx.pi.execCalls.filter((c) => c.args[0] === 'push');
      assert.equal(pushCalls.length, 1);
      // Explicit HEAD refspec + --no-follow-tags + --atomic: configured
      // push.followTags can never expand what leaves the repository.
      assert.deepEqual(
        pushCalls[0].args,
        ['push', '--no-follow-tags', '--atomic', 'origin', 'HEAD:refs/heads/main'],
      );
      const flattened = JSON.stringify(fx.pi.execCalls.map((c) => c.args));
      assert.ok(!flattened.includes('--force'), 'force push must never be possible');
      assert.ok(!flattened.includes('"-f"'), 'force push must never be possible');
      assert.ok(!flattened.includes('--follow-tags'), 'follow-tags must be explicitly disabled');
      const results = commandResults(fx);
      assert.equal(results.length, 2);
      assert.equal(results[1].ok, true);
    } finally { await fx.cleanup(); }
  });

  test('a push exit of 0 is success only when the upstream ref resolves to the approved HEAD', async () => {
    const base = gitScript();
    const { fx, session, proposalId } = await pushApprovedFixture({ execImpl: base });
    try {
      fx.pi.execImpl = async (command, args, options) => {
        if (args[0] === 'push') return { code: 0, stdout: '', stderr: '', killed: false };
        if (args.join(' ') === 'rev-parse refs/remotes/origin/main') {
          return { code: 0, stdout: 'e'.repeat(40) + '\n', stderr: '', killed: false };
        }
        return base(command, args, options);
      };
      enqueueGitCommand(fx, session, 'git_push_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'git_unknown');
    } finally { await fx.cleanup(); }
  });

  test('a verified push in a SHA-256 repo (64-hex HEAD) reports success', async () => {
    const sha64 = 'a'.repeat(64);
    const { fx, session, proposalId } = await pushApprovedFixture({
      execImpl: gitScript({ head: sha64 + '\n', remoteRefSha: sha64 + '\n' }),
    });
    try {
      enqueueGitCommand(fx, session, 'git_push_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, true,
        'a snapshot-valid 64-hex repo whose upstream resolves to the approved HEAD must verify');
      assert.equal(results[1].resultCode, 'git_push_completed');
    } finally { await fx.cleanup(); }
  });

  test('upstream drift between approval and execution refuses the push', async () => {
    const { fx, session, proposalId } = await pushApprovedFixture();
    try {
      fx.pi.execImpl = gitScript({ upstream: 'origin/other\n' });
      enqueueGitCommand(fx, session, 'git_push_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'git_drift');
      assert.equal(fx.pi.execCalls.some((c) => c.args[0] === 'push'), false);
    } finally { await fx.cleanup(); }
  });

  test('no configured upstream fails the request closed', async () => {
    const { fx, session } = await connectGitFixture({ execImpl: gitScript({ upstream: null }) });
    try {
      enqueueGitCommand(fx, session, 'git_push_request');
      await fx.extension.pollOnce();
      assert.equal(pendingEvents(fx, 'git_proposal').length, 0);
      const results = commandResults(fx);
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, false);
      assert.equal(results[0].resultCode, 'no_upstream');
    } finally { await fx.cleanup(); }
  });

  test('an unsafe upstream shape is never turned into argv', async () => {
    const { fx, session } = await connectGitFixture({
      execImpl: gitScript({ upstream: 'origin main\n' }),
    });
    try {
      enqueueGitCommand(fx, session, 'git_push_request');
      await fx.extension.pollOnce();
      assert.equal(pendingEvents(fx, 'git_proposal').length, 0);
      const results = commandResults(fx);
      assert.equal(results[0].ok, false);
      assert.equal(results[0].resultCode, 'no_upstream');
    } finally { await fx.cleanup(); }
  });

  test('an uncertain push outcome reports unknown rather than failure', async () => {
    const { fx, session, proposalId } = await pushApprovedFixture();
    try {
      const base = gitScript();
      fx.pi.execImpl = async (command, args) => {
        if (args[0] === 'push') throw new Error('exec blew up');
        return base(command, args);
      };
      enqueueGitCommand(fx, session, 'git_push_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'git_unknown');
    } finally { await fx.cleanup(); }
  });
});

describe('G4: Git results carry typed operation-specific result codes', () => {
  test('a commit request reports git_commit_proposal_ready', async () => {
    const { fx, session } = await connectGitFixture();
    try {
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, true);
      assert.equal(results[0].resultCode, 'git_commit_proposal_ready');
    } finally { await fx.cleanup(); }
  });

  test('a push request reports git_push_proposal_ready', async () => {
    const { fx, session } = await connectGitFixture();
    try {
      enqueueGitCommand(fx, session, 'git_push_request');
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, true);
      assert.equal(results[0].resultCode, 'git_push_proposal_ready');
    } finally { await fx.cleanup(); }
  });

  test('a verified commit reports git_commit_completed', async () => {
    const { fx, session } = await connectGitFixture();
    try {
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      const proposalId = latestProposalId(fx);
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, true);
      assert.equal(results[1].resultCode, 'git_commit_completed');
    } finally { await fx.cleanup(); }
  });

  test('a verified push reports git_push_completed', async () => {
    const { fx, session } = await connectGitFixture();
    try {
      enqueueGitCommand(fx, session, 'git_push_request');
      await fx.extension.pollOnce();
      const proposalId = latestProposalId(fx);
      enqueueGitCommand(fx, session, 'git_push_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, true);
      assert.equal(results[1].resultCode, 'git_push_completed');
    } finally { await fx.cleanup(); }
  });
});

describe('G3: bounded proposal state, overlap guard and teardown', () => {
  test('a newer request replaces the pending proposal and makes the older id stale', async () => {
    const { fx, session } = await connectGitFixture();
    try {
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      const oldId = latestProposalId(fx);
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      const newId = latestProposalId(fx);
      assert.notEqual(oldId, newId);
      assert.equal(pendingEvents(fx, 'git_proposal').length, 2);
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId: oldId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[2].ok, false);
      assert.equal(results[2].resultCode, 'stale_proposal');
      assert.equal(fx.pi.execCalls.some((c) => c.args[0] === 'commit'), false);
    } finally { await fx.cleanup(); }
  });

  test('async polling cannot overlap an in-flight Git command', async () => {
    const { fx, session } = await connectGitFixture();
    try {
      let release;
      const gate = new Promise((resolveGate) => { release = resolveGate; });
      const base = gitScript();
      fx.pi.execImpl = async (command, args) => {
        if (args[0] === 'commit') {
          await gate;
          return { code: 0, stdout: '', stderr: '', killed: false };
        }
        return base(command, args);
      };
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      const proposalId = latestProposalId(fx);
      enqueueGitCommand(fx, session, 'git_commit_execute', { proposalId });
      const first = fx.extension.pollOnce();
      // Wait until the commit exec is actually in flight.
      while (!fx.pi.execCalls.some((c) => c.args[0] === 'commit')) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 1));
      }
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      const second = await fx.extension.pollOnce();
      assert.equal(
        fx.pi.execCalls.filter((c) => c.args[0] === 'rev-parse').length,
        6,
        'no snapshot for the queued request may run while Git is in flight '
          + '(3 from the request, 3 from the execute revalidation only)',
      );
      release();
      await first;
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results.length, 3, 'every command reports exactly once, in order');
      assert.equal(results[2].ok, true);
    } finally { await fx.cleanup(); }
  });

  test('connection teardown clears the proposal and silences polling', async () => {
    const { fx, session } = await connectGitFixture();
    try {
      enqueueGitCommand(fx, session, 'git_commit_request');
      await fx.extension.pollOnce();
      const proposalId = latestProposalId(fx);
      await fx.run('telegram-disconnect', '');
      // With the connection gone the store refuses commands for the dead
      // tracking id: nothing can reach the extension after teardown.
      const p1 = fx.probe();
      const refused = p1.store.enqueueTuiCommand({
        trackingId: session.trackingId,
        kind: 'git_commit_execute',
        payload: { proposalId },
      });
      p1.close();
      assert.equal(refused.ok, false, 'a dead session must fail closed');
      await fx.extension.pollOnce();
      assert.equal(commandResults(fx).length, 1, 'no result after teardown: nothing executed');
      assert.equal(fx.pi.execCalls.some((c) => c.args[0] === 'commit'), false);
      // A fresh link in the same process must not inherit the proposal.
      await fx.run('tg', '');
      const p = fx.probe();
      const fresh = p.sessions()[0];
      p.close();
      enqueueGitCommand(fx, fresh, 'git_commit_execute', { proposalId });
      await fx.extension.pollOnce();
      const results = commandResults(fx);
      assert.equal(results[1].ok, false);
      assert.equal(results[1].resultCode, 'stale_proposal');
      assert.equal(fx.pi.execCalls.some((c) => c.args[0] === 'commit'), false);
    } finally { await fx.cleanup(); }
  });
});
