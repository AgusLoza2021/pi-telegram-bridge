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
import { existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

import { Store } from '../src/store.mjs';
import { TuiBridgeClient } from '../src/tui-bridge-client.mjs';

// The extension imports `Type` from 'typebox' — a host-provided package
// Pi resolves for extension code at runtime (see Pi's extension loader
// aliases). The bridge repo deliberately does not depend on typebox, so
// this test process maps the bare specifier to the first locally installed
// copy (repo-local first, then Pi's bundled module tree) BEFORE loading the
// extension source. No install, no network, no dependency mutation.
function resolveHostTypebox() {
  const candidates = [
    fileURLToPath(new URL('../node_modules/typebox/build/index.mjs', import.meta.url)),
    join(homedir(), '.pi', 'agent', 'npm', 'node_modules', 'typebox', 'build', 'index.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

const TYPEBOX_ENTRY = resolveHostTypebox();
if (!TYPEBOX_ENTRY) {
  throw new Error('host typebox package not found: the selective extension requires it');
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'typebox') return { url: TYPEBOX_ENTRY, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const {
  SelectiveTuiBridgeExtension,
  createSelectiveTuiExtension,
  readGitBranch,
} = await import('../extension/selective-tui-extension.ts');

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
function makeFixture({ credentials = true, brokerState = 'live', cwd, idle, selectAnswer, injections } = {}) {
  const dir = mkdtempSync(join(TEST_RUNS, 'ext-t05-'));
  const stateDirectory = join(dir, 'state');
  if (credentials) {
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, 'credentials.bin'), 'presence-only-placeholder');
    writeBrokerHealthFixture(stateDirectory, brokerState);
  }
  const extension = new SelectiveTuiBridgeExtension(stateDirectory, injections);
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
      // T3B: exactly ONE deliberate tool — the remote ordinary-choice tool.
      // The native ask_user_choice is never overridden.
      assert.equal(fx.pi.toolRegistrations.length, 1, 'exactly the one deliberate choice tool');
      assert.equal(fx.pi.toolRegistrations[0].name, 'telegram_ask_user_choice');
      assert.notEqual(fx.pi.toolRegistrations[0].name, 'ask_user_choice');
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
      // T3B: the single deliberate remote-choice tool, unchanged by /tg use.
      assert.equal(fx.pi.toolRegistrations.length, 1);
      assert.equal(fx.pi.toolRegistrations[0].name, 'telegram_ask_user_choice');
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

// --- T2 metadata pipeline: filesystem-only git branch detection -------------

/** Creates <root>/.git/HEAD with the given raw content. */
function writeGitRepo(root, head = 'ref: refs/heads/main\n') {
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), head);
}

describe('extension git branch detection (readGitBranch)', () => {
  test('normal repo: a .git directory with a ref HEAD parses to a sanitized branch', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'branch-normal-'));
    writeGitRepo(root, 'ref: refs/heads/main\n');
    assert.equal(readGitBranch(root), 'main');
  });

  test('nested cwd below the repo root walks up to the repo .git', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'branch-nested-'));
    writeGitRepo(root, 'ref: refs/heads/Feature/Ci.1\n');
    const deep = join(root, 'src', 'lib', 'deep');
    mkdirSync(deep, { recursive: true });
    assert.equal(readGitBranch(deep), 'Feature/Ci.1');
  });

  test('worktree pointer with a relative gitdir resolves against the directory containing .git', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'branch-wt-rel-'));
    mkdirSync(join(root, 'real', '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(
      join(root, 'real', '.git', 'worktrees', 'wt', 'HEAD'),
      'ref: refs/heads/feature/one\n',
    );
    mkdirSync(join(root, 'wt'), { recursive: true });
    writeFileSync(join(root, 'wt', '.git'), 'gitdir: ../real/.git/worktrees/wt\n');
    assert.equal(readGitBranch(join(root, 'wt')), 'feature/one');
  });

  test('worktree pointer with an absolute gitdir target is used as-is', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'branch-wt-abs-'));
    const gitdir = join(root, 'real', '.git', 'worktrees', 'wt2');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/feature/two\n');
    mkdirSync(join(root, 'wt'), { recursive: true });
    writeFileSync(join(root, 'wt', '.git'), `gitdir: ${gitdir}\n`);
    assert.equal(readGitBranch(join(root, 'wt')), 'feature/two');
  });

  test('detached HEAD (40 or 64 hex, any case) maps to the fixed string detached', () => {
    const root40 = mkdtempSync(join(TEST_RUNS, 'branch-det40-'));
    writeGitRepo(root40, `${'a'.repeat(40)}\n`);
    assert.equal(readGitBranch(root40), 'detached');
    const root64 = mkdtempSync(join(TEST_RUNS, 'branch-det64-'));
    writeGitRepo(root64, `${'F'.repeat(64)}\n`);
    assert.equal(readGitBranch(root64), 'detached');
  });

  test('no repo reachable within the bounded traversal returns null', () => {
    // A deep nonexistent path: the bounded walk exhausts before any real
    // directory (and therefore any real .git) can be reached.
    const deep = 'C:\\' + Array.from({ length: 70 }, () => 'x').join('\\');
    assert.equal(readGitBranch(deep), null);
  });

  test('hostile branch strings in HEAD sanitize to null without throwing raw content', () => {
    const hostileHeads = [
      'ref: refs/heads/..\n',
      'ref: refs/heads/a/../b\n',
      'ref: refs/heads/a//b\n',
      'ref: refs/heads//leading\n',
      'ref: refs/heads/trailing/\n',
      'ref: refs/heads/@{x\n',
      'ref: refs/heads/back\\slash\n',
      'ref: refs/heads/a b\n',
      'ref: refs/heads/a\tb\n',
      'ref: refs/heads/a\u0000b\n',
      'ref: refs/heads/\n',
      `ref: refs/heads/${'a'.repeat(129)}\n`,
    ];
    for (const head of hostileHeads) {
      const root = mkdtempSync(join(TEST_RUNS, 'branch-hostile-'));
      writeGitRepo(root, head);
      assert.equal(
        readGitBranch(root),
        null,
        `hostile HEAD must yield null: ${JSON.stringify(head)}`,
      );
    }
  });

  test('malformed or oversize .git pointer files return null', () => {
    const emptyRoot = mkdtempSync(join(TEST_RUNS, 'branch-ptr-empty-'));
    writeFileSync(join(emptyRoot, '.git'), '');
    assert.equal(readGitBranch(emptyRoot), null);

    const junkRoot = mkdtempSync(join(TEST_RUNS, 'branch-ptr-junk-'));
    writeFileSync(join(junkRoot, '.git'), 'hello world\n');
    assert.equal(readGitBranch(junkRoot), null);

    const bigRoot = mkdtempSync(join(TEST_RUNS, 'branch-ptr-big-'));
    writeFileSync(join(bigRoot, '.git'), `gitdir: ${'a'.repeat(5000)}\n`);
    assert.equal(readGitBranch(bigRoot), null);
  });

  test('pointer chains are not followed: a gitdir target whose HEAD is itself a pointer yields null', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'branch-chain-'));
    const gitdir = join(root, 'wt-gitdir');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'HEAD'), 'gitdir: ../elsewhere\n');
    writeFileSync(join(root, '.git'), `gitdir: ${gitdir}\n`);
    assert.equal(readGitBranch(root), null);
  });

  test('missing, empty, oversize or unparseable HEAD files return null', () => {
    const missing = mkdtempSync(join(TEST_RUNS, 'branch-head-missing-'));
    mkdirSync(join(missing, '.git'), { recursive: true });
    assert.equal(readGitBranch(missing), null);

    const oversize = mkdtempSync(join(TEST_RUNS, 'branch-head-big-'));
    mkdirSync(join(oversize, '.git'), { recursive: true });
    writeFileSync(join(oversize, '.git', 'HEAD'), 'x'.repeat(5000));
    assert.equal(readGitBranch(oversize), null);

    const empty = mkdtempSync(join(TEST_RUNS, 'branch-head-empty-'));
    mkdirSync(join(empty, '.git'), { recursive: true });
    writeFileSync(join(empty, '.git', 'HEAD'), '');
    assert.equal(readGitBranch(empty), null);

    const garbage = mkdtempSync(join(TEST_RUNS, 'branch-head-junk-'));
    writeGitRepo(garbage, 'this is not a ref or a hash\n');
    assert.equal(readGitBranch(garbage), null);
  });

  test('a 128-char branch is accepted at the bound', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'branch-max-'));
    const branch = `f${'e'.repeat(126)}t`;
    writeGitRepo(root, `ref: refs/heads/${branch}\n`);
    assert.equal(readGitBranch(root), branch);
  });

  test('invalid inputs return null', () => {
    assert.equal(readGitBranch(null), null);
    assert.equal(readGitBranch(undefined), null);
    assert.equal(readGitBranch(''), null);
    assert.equal(readGitBranch(123), null);
  });
});

describe('/tg connect stores git branch metadata (T2)', () => {
  test('beginner /tg connect stores the branch in the live session and project history', async () => {
    const repoRoot = mkdtempSync(join(TEST_RUNS, 'branch-repo-'));
    writeGitRepo(repoRoot, 'ref: refs/heads/feature/ci\n');
    // The cwd must be an existing directory (F1 contract).
    mkdirSync(join(repoRoot, 'nested'), { recursive: true });
    const fx = makeFixture({ selectAnswer: 'Connect', cwd: join(repoRoot, 'nested') });
    try {
      await fx.run('tg', '');
      const p = fx.probe();
      const sessions = p.sessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].branch, 'feature/ci');
      const project = p.store.listRecentTuiProjects({ since: 0 })[0];
      assert.equal(project.branch, 'feature/ci');
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('connect with unusable git metadata still links with branch null', async () => {
    const plain = mkdtempSync(join(TEST_RUNS, 'branch-plain-'));
    // A .git that is neither a repo directory nor a gitdir pointer yields
    // no branch; connecting must succeed anyway with branch null.
    writeFileSync(join(plain, '.git'), 'not a gitdir pointer\n');
    const fx = makeFixture({ selectAnswer: 'Connect', cwd: join(plain, 'work') });
    try {
      await fx.run('tg', '');
      const p = fx.probe();
      const sessions = p.sessions();
      assert.equal(sessions.length, 1, 'branch detection failure must never block linking');
      assert.equal(sessions[0].branch, null);
      const project = p.store.listRecentTuiProjects({ since: 0 })[0];
      assert.equal(project.branch, null);
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('reconnect-from-opt-in recomputes and stores the branch', async () => {
    const repoRoot = mkdtempSync(join(TEST_RUNS, 'branch-reconnect-'));
    writeGitRepo(repoRoot, 'ref: refs/heads/first\n');
    mkdirSync(join(repoRoot, 'work'), { recursive: true });
    const fx = makeFixture({ selectAnswer: 'Connect', cwd: join(repoRoot, 'work') });
    try {
      await fx.run('tg', '');
      let p = fx.probe();
      assert.equal(p.sessions()[0].branch, 'first');
      p.close();
      await fx.pi.emit('session_shutdown', { reason: 'reload' }, fx.ctx);
      // The branch moved while the session was down; the replacement
      // context re-enters the same working directory.
      writeFileSync(join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/second\n');
      const replacement = new SelectiveTuiBridgeExtension(fx.stateDirectory);
      const replacementPi = makePi();
      replacement.register(replacementPi);
      const replacementCtx = makeCtx({ cwd: join(repoRoot, 'work') });
      await replacementPi.emit('session_start', {}, replacementCtx.ctx);
      p = fx.probe();
      const sessions = p.sessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].branch, 'second', 'reconnect must re-detect the branch');
      const project = p.store.listRecentTuiProjects({ since: 0 })[0];
      assert.equal(project.branch, 'second');
      p.close();
      delete globalThis[OPT_IN_KEY];
    } finally { await fx.cleanup(); }
  });
});

describe('readGitBranch correction round (F1/F2/F3)', () => {
  test('F1: a nonexistent cwd returns null without any ancestor walk', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'branch-f1-'));
    writeGitRepo(root, 'ref: refs/heads/main\n');
    // The repo is reachable by walking up, but the cwd itself does not
    // exist: fail closed without inheriting the ancestor repo.
    assert.equal(readGitBranch(join(root, 'does-not-exist')), null);
  });

  test('F1: a file cwd returns null', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'branch-f1file-'));
    writeGitRepo(root, 'ref: refs/heads/main\n');
    writeFileSync(join(root, 'plainfile'), 'x');
    assert.equal(readGitBranch(join(root, 'plainfile')), null);
  });

  test('F2: a .git at the homedir boundary is skipped for descendants but used when cwd is the homedir itself', () => {
    const outer = mkdtempSync(join(TEST_RUNS, 'branch-home-'));
    writeGitRepo(outer, 'ref: refs/heads/outerboundary\n');
    const fakeHome = join(outer, 'fakehome');
    writeGitRepo(fakeHome, 'ref: refs/heads/homerootrepo\n');
    writeGitRepo(join(fakeHome, 'repo'), 'ref: refs/heads/main\n');
    const plain = join(fakeHome, 'plain');
    mkdirSync(plain, { recursive: true });
    const deep = join(fakeHome, 'repo', 'deep');
    mkdirSync(deep, { recursive: true });

    // A descendant of home must not inherit the home dotfiles repo: the
    // walk skips home's .git and keeps climbing to the outer repo.
    assert.equal(readGitBranch(plain, { homeDir: fakeHome }), 'outerboundary');
    // A repo rooted below home is still found normally.
    assert.equal(readGitBranch(deep, { homeDir: fakeHome }), 'main');
    // A cwd that IS the home may still use its own repo.
    assert.equal(readGitBranch(fakeHome, { homeDir: fakeHome }), 'homerootrepo');
  });

  test('F2: production call — a temp dir below the real homedir never inherits the home or drive-root dotfiles repos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'branch-realhome-'));
    // On this machine both the user profile directory and the drive root
    // exist as real git repos (master); the boundary rules must skip both
    // for a descendant cwd, so an unrelated temp project cannot be labeled
    // by their dotfiles repos.
    assert.equal(readGitBranch(dir), null);
  });

  test('F2: UNC/network/device cwd paths are rejected', () => {
    assert.equal(readGitBranch('\\\\server\\share\\proj'), null);
    assert.equal(readGitBranch('//server/share/proj'), null);
    assert.equal(readGitBranch('\\\\?\\C:\\proj'), null);
    assert.equal(readGitBranch('\\\\.\\C:\\proj'), null);
  });

  test('F2: UNC/device absolute gitdir targets are rejected; local drive-letter targets still work', () => {
    const uncRoot = mkdtempSync(join(TEST_RUNS, 'branch-unc-'));
    writeFileSync(join(uncRoot, '.git'), 'gitdir: \\\\server\\share\\repo\n');
    assert.equal(readGitBranch(uncRoot), null);

    const deviceRoot = mkdtempSync(join(TEST_RUNS, 'branch-device-'));
    writeFileSync(join(deviceRoot, '.git'), 'gitdir: \\\\?\\C:\\repo\n');
    assert.equal(readGitBranch(deviceRoot), null);
  });

  test('F3: symlink/junction .git markers are rejected without following them', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'branch-link-'));
    const realRepo = mkdtempSync(join(TEST_RUNS, 'branch-link-target-'));
    writeGitRepo(realRepo, 'ref: refs/heads/linked\n');
    let made = false;
    try {
      symlinkSync(realRepo, join(root, '.git'), 'junction');
      made = true;
    } catch {
      // Junction creation can be unavailable in restricted environments.
    }
    if (made) {
      assert.equal(readGitBranch(root), null, 'a junction .git must fail closed');
    }
  });

  test('F3: symlinked HEAD files are rejected without following them', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'branch-headlink-'));
    const realHead = mkdtempSync(join(TEST_RUNS, 'branch-headlink-target-'));
    writeGitRepo(realHead, 'ref: refs/heads/linkedhead\n');
    mkdirSync(join(root, '.git'), { recursive: true });
    let made = false;
    try {
      symlinkSync(join(realHead, '.git', 'HEAD'), join(root, '.git', 'HEAD'), 'file');
      made = true;
    } catch {
      // File-symlink creation can require privileges on Windows.
    }
    if (made) {
      assert.equal(readGitBranch(root), null, 'a symlinked HEAD must fail closed');
    }
  });
});

// --- T3B: telegram_ask_user_choice — the remote ordinary-choice tool --------

const CHOICE_TOOL_NAME = 'telegram_ask_user_choice';
const REQUEST_ID = 'ab12cd34ef56ab12'; // 16 lowercase hex chars
const CHOICE_TTL_MS = 30 * 60 * 1000; // production default: exactly 30 minutes
const POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 10_000;

/** Test injections: fixed request id, captured timeout scheduling, optional clock. */
function makeChoiceInjections({ now, timeoutMs, requestId = REQUEST_ID } = {}) {
  const scheduled = [];
  const cleared = [];
  const injections = {
    scheduled,
    cleared,
    scheduleChoiceTimeout(callback, ms) {
      scheduled.push({ callback, ms });
      return scheduled.length;
    },
    clearChoiceTimeout(handle) {
      cleared.push(handle);
    },
  };
  if (now) injections.now = now;
  if (timeoutMs !== undefined) injections.choiceTimeoutMs = timeoutMs;
  if (requestId !== undefined) injections.requestIdFactory = () => requestId;
  return injections;
}

/**
 * Connect with interval capture: the poll/heartbeat interval callbacks are
 * captured instead of scheduled, so T3B tests drive ticks deterministically
 * and prove the real timers keep firing during an awaited execute.
 */
async function connectWithCapturedTicks(fx, args = '') {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const captured = [];
  globalThis.setInterval = (callback, ms) => {
    captured.push({ callback, ms });
    return captured.length;
  };
  globalThis.clearInterval = () => {};
  try {
    await fx.run('tg', args);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
  return {
    poll: captured.find((t) => t.ms === POLL_INTERVAL_MS)?.callback ?? null,
    heartbeat: captured.find((t) => t.ms === HEARTBEAT_INTERVAL_MS)?.callback ?? null,
  };
}

/** Direct durable reads: raw event/command rows bypass every in-process view. */
function rawEvents(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare('SELECT kind, payload_json AS payloadJson FROM tui_events ORDER BY event_id')
      .all();
  } finally { db.close(); }
}

function rawCommandRow(dbPath, commandId) {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare('SELECT state, result_code AS resultCode FROM tui_commands WHERE command_id = ?')
      .get(commandId);
  } finally { db.close(); }
}

function rawSetHeartbeatAt(dbPath, trackingId, heartbeatAt) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('UPDATE tui_sessions SET heartbeat_at = ? WHERE tracking_id = ?')
      .run(heartbeatAt, trackingId);
  } finally { db.close(); }
}

function rawHeartbeatAt(dbPath, trackingId) {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare('SELECT heartbeat_at AS heartbeatAt FROM tui_sessions WHERE tracking_id = ?')
      .get(trackingId)?.heartbeatAt;
  } finally { db.close(); }
}

/** Insert a command row bypassing Store validation: only raw-row corruption
 *  can deliver a malformed payload past the T1 fail-closed persistence. */
function rawInsertCommand(dbPath, trackingId, commandId, kind, payload) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      `INSERT INTO tui_commands
         (command_id, tracking_id, kind, payload_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(commandId, trackingId, kind, JSON.stringify(payload), Date.now(), Date.now());
  } finally { db.close(); }
}

function choiceTool(fx) {
  assert.equal(fx.pi.toolRegistrations.length, 1, 'exactly the one deliberate tool');
  return fx.pi.toolRegistrations[0];
}

function callChoiceTool(fx, params, signal) {
  return choiceTool(fx).execute('tool-call-1', params, signal, undefined, fx.ctx);
}

function choiceParams(overrides = {}) {
  return {
    question: 'Deploy now or wait?',
    options: [
      { label: 'Deploy now', description: 'Ship to production', value: 'deploy-now' },
      { label: 'Wait', description: 'Keep it local', value: 'wait' },
    ],
    ...overrides,
  };
}

function choiceRequestEvents(fx) {
  return rawEvents(fx.sqlitePath).filter((e) => e.kind === 'choice_request');
}

function commandResultEvents(fx) {
  return rawEvents(fx.sqlitePath).filter((e) => e.kind === 'command_result');
}

/** Bounded wait used only to observe that a promise did NOT settle. */
function settleDelay(ms = 25) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Fixed JSON tool-result contract: text and details match, nothing else. */
function assertChoiceResult(result, expectedPayload) {
  const text = typeof result.content?.[0]?.text === 'string' ? result.content[0].text : null;
  assert.ok(text, 'the tool result must carry one text content block');
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(text), expectedPayload);
  assert.deepEqual(result.details, expectedPayload, 'details must match the JSON text exactly');
}

/**
 * One connected extension with a pending remote choice. Poll/heartbeat tick
 * callbacks are captured; the pending tool promise is returned unresolved.
 */
async function makePendingFixture({ params = choiceParams(), injections, selectAnswer = 'Connect', idle } = {}) {
  const inj = injections ?? makeChoiceInjections();
  const fx = makeFixture({ selectAnswer, injections: inj, idle });
  const ticks = await connectWithCapturedTicks(fx);
  let outcome;
  let settled = false;
  const pendingPromise = callChoiceTool(fx, params, undefined).then(
    (value) => { settled = true; outcome = value; return value; },
    (error) => { settled = true; outcome = error; return Promise.reject(error); },
  );
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const p = fx.probe();
  const sessions = p.sessions();
  const trackingId = sessions[0].trackingId;
  const connectionId = sessions[0].connectionId;
  p.close();
  return {
    fx, inj, ticks, pendingPromise,
    isSettled: () => settled,
    outcome: () => outcome,
    trackingId,
    connectionId,
    /** Enqueue one choice_response through the shared store. */
    enqueue(payload) {
      const probe = fx.probe();
      try {
        const res = probe.store.enqueueTuiCommand({
          trackingId, kind: 'choice_response', payload,
        });
        assert.equal(res.ok, true);
        return res.commandId;
      } finally { probe.close(); }
    },
  };
}

describe('telegram_ask_user_choice registration, schema and metadata (T3B)', () => {
  test('exactly one distinct tool is registered and ask_user_choice is never overridden', async () => {
    const fx = makeFixture();
    try {
      assert.equal(fx.pi.toolRegistrations.length, 1);
      const tool = fx.pi.toolRegistrations[0];
      assert.equal(tool.name, CHOICE_TOOL_NAME);
      assert.notEqual(tool.name, 'ask_user_choice');
      assert.equal(typeof tool.execute, 'function');
    } finally { await fx.cleanup(); }
  });

  test('schema: strict bounds, exact keys, additionalProperties:false at both levels, no custom-response field', async () => {
    const fx = makeFixture();
    try {
      const schema = choiceTool(fx).parameters;
      assert.equal(schema.additionalProperties, false, 'top level must close extras');
      assert.deepEqual(Object.keys(schema.properties).sort(), ['options', 'question']);
      const question = schema.properties.question;
      assert.equal(question.type, 'string');
      assert.equal(question.minLength, 1);
      assert.equal(question.maxLength, 500);
      const options = schema.properties.options;
      assert.equal(options.type, 'array');
      assert.equal(options.minItems, 2);
      assert.equal(options.maxItems, 4);
      const option = options.items;
      assert.equal(option.type, 'object');
      assert.equal(option.additionalProperties, false, 'option level must close extras');
      assert.deepEqual(Object.keys(option.properties).sort(), ['description', 'label', 'value']);
      assert.equal(option.properties.label.minLength, 1);
      assert.equal(option.properties.label.maxLength, 64);
      assert.equal(option.properties.description.minLength, 1);
      assert.equal(option.properties.description.maxLength, 300);
      assert.equal(option.properties.value.minLength, 1);
      assert.equal(option.properties.value.maxLength, 512);
      // No custom-response / free-text field anywhere in the schema.
      assert.equal(option.properties.customResponse, undefined);
      assert.equal(schema.properties.customResponse, undefined);
      assert.equal(schema.properties.responseText, undefined);
    } finally { await fx.cleanup(); }
  });

  test('metadata: ordinary-choice guidance, call-alone and the explicit native-consent exclusion', async () => {
    const fx = makeFixture();
    try {
      const tool = choiceTool(fx);
      const allMetadata = [tool.description, ...(tool.promptGuidelines ?? [])].join('\n');
      assert.match(allMetadata, /instead of/i, 'use it instead of a local-only ordinary choice');
      assert.match(allMetadata, /2[–-]4/, 'names the 2–4 option band');
      assert.match(allMetadata, /workflow/i);
      assert.match(allMetadata, /alone/i, 'call it alone');
      assert.match(allMetadata, /parallel/i, 'never parallel with other tools');
      assert.match(allMetadata, /never/i);
      assert.match(allMetadata, /consent/i, 'excludes provider-owned consent');
      assert.match(allMetadata, /gentle ai/i, 'excludes Gentle AI review consent');
      assert.match(allMetadata, /permission/i);
      assert.match(allMetadata, /security/i);
      assert.match(allMetadata, /maintenance/i);
      assert.match(allMetadata, /destructive/i);
      assert.match(allMetadata, /trust/i, 'excludes project trust');
      assert.match(allMetadata, /secret/i, 'excludes secrets');
      assert.match(allMetadata, /editor/i, 'excludes editor input');
      assert.match(allMetadata, /free-text|custom/i, 'excludes free-text/custom responses');
      assert.match(tool.promptSnippet, /telegram/i, 'promptSnippet names the capability');
      assert.match(tool.promptSnippet, /choice|decision|question/i);
      assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length >= 1);
      for (const guideline of tool.promptGuidelines) {
        assert.match(guideline, /telegram_ask_user_choice/, 'every guideline names the tool');
      }
      assert.equal(tool.executionMode, 'sequential', 'defense-in-depth: never parallel');
    } finally { await fx.cleanup(); }
  });
});

describe('telegram_ask_user_choice refusals return fixed local JSON', () => {
  test('not linked: fixed refused JSON, no store created, nothing published', async () => {
    const fx = makeFixture();
    try {
      const result = await callChoiceTool(fx, choiceParams(), undefined);
      assertChoiceResult(result, { status: 'refused', reason: 'not_linked' });
      assert.equal(fx.probe(), null, 'the refusal must not create the store');
    } finally { await fx.cleanup(); }
  });

  test('broker unavailable: links fine but the tool refuses with a fixed code, nothing published', async () => {
    const fx = makeFixture({ brokerState: 'stale', selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      assert.ok(fx.probe(), 'linking still succeeds locally');
      const result = await callChoiceTool(fx, choiceParams(), undefined);
      assertChoiceResult(result, { status: 'refused', reason: 'broker_unavailable' });
      assert.equal(choiceRequestEvents(fx).length, 0);
    } finally { await fx.cleanup(); }
  });

  for (const [label, params] of Object.entries({
    'empty question': { question: '', options: choiceParams().options },
    'overlong question': { question: 'q'.repeat(501), options: choiceParams().options },
    'one option': { question: 'q', options: choiceParams().options.slice(0, 1) },
    'five options': {
      question: 'q',
      options: [
        ...choiceParams().options,
        ...choiceParams().options,
        choiceParams().options[0],
      ],
    },
    'missing value': {
      question: 'q',
      options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b', value: 'b' },
      ],
    },
    'extra option field': {
      question: 'q',
      options: [
        { label: 'A', description: 'a', value: 'a', extra: 'x' },
        { label: 'B', description: 'b', value: 'b' },
      ],
    },
    'overlong label': {
      question: 'q',
      options: [
        { label: 'l'.repeat(65), description: 'a', value: 'a' },
        { label: 'B', description: 'b', value: 'b' },
      ],
    },
    'overlong description': {
      question: 'q',
      options: [
        { label: 'A', description: 'd'.repeat(301), value: 'a' },
        { label: 'B', description: 'b', value: 'b' },
      ],
    },
    'overlong value': {
      question: 'q',
      options: [
        { label: 'A', description: 'a', value: 'v'.repeat(513) },
        { label: 'B', description: 'b', value: 'b' },
      ],
    },
    'empty label': {
      question: 'q',
      options: [
        { label: '', description: 'a', value: 'a' },
        { label: 'B', description: 'b', value: 'b' },
      ],
    },
    'non-object option': { question: 'q', options: ['A', { label: 'B', description: 'b', value: 'b' }] },
    'extra top-level field': {
      question: 'q',
      options: choiceParams().options,
      customResponse: 'free text',
    },
  })) {
    test(`invalid input (${label}): fixed refused JSON, nothing published`, async () => {
      const fx = makeFixture({ selectAnswer: 'Connect' });
      try {
        await fx.run('tg', '');
        const result = await callChoiceTool(fx, params, undefined);
        assertChoiceResult(result, { status: 'refused', reason: 'invalid_input' });
        assert.equal(choiceRequestEvents(fx).length, 0);
        const p = fx.probe();
        assert.equal(p.sessions()[0].state, 'connected', 'state must not flip to waiting');
        p.close();
      } finally { await fx.cleanup(); }
    });
  }

  test('credential-shaped question, label or description: refused before persistence', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      const secret = 'ghp_' + 'a'.repeat(25);
      const cases = [
        { question: `use ${secret} now?`, options: choiceParams().options },
        {
          question: 'pick one',
          options: [
            { label: `key sk-${'x'.repeat(24)}`, description: 'a', value: secret },
            { label: 'B', description: 'b', value: 'b' },
          ],
        },
        {
          question: 'pick one',
          options: [
            { label: 'A', description: `token 12345:${'z'.repeat(35)}`, value: 'a' },
            { label: 'B', description: 'b', value: 'b' },
          ],
        },
      ];
      for (const params of cases) {
        const result = await callChoiceTool(fx, params, undefined);
        assertChoiceResult(result, { status: 'refused', reason: 'refused_credentials' });
      }
      assert.equal(choiceRequestEvents(fx).length, 0, 'nothing may be published');
      const p = fx.probe();
      assert.equal(p.sessions()[0].state, 'connected');
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('question that sanitizes empty: refused_empty_question', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      const result = await callChoiceTool(fx, choiceParams({ question: 'tg:abc123' }), undefined);
      assertChoiceResult(result, { status: 'refused', reason: 'refused_empty_question' });
      assert.equal(choiceRequestEvents(fx).length, 0);
    } finally { await fx.cleanup(); }
  });

  test('one pending per instance: a second concurrent call is busy and disturbs nothing', async () => {
    const pending = await makePendingFixture();
    try {
      assert.equal(choiceRequestEvents(pending.fx).length, 1);
      const busyResult = await callChoiceTool(pending.fx, choiceParams({
        question: 'Second question?',
      }), undefined);
      assertChoiceResult(busyResult, { status: 'refused', reason: 'busy' });
      assert.equal(choiceRequestEvents(pending.fx).length, 1, 'no second request published');
      assert.equal(pending.isSettled(), false, 'the first request stays pending');
      // The original pending request still resolves normally afterwards.
      pending.enqueue({ requestId: REQUEST_ID, index: 0 });
      pending.ticks.poll();
      const result = await pending.pendingPromise;
      assertChoiceResult(result, { status: 'selected', index: 0, value: 'deploy-now' });
    } finally { await pending.fx.cleanup(); }
  });

  test('publish failure: refused with a fixed code, no pending left behind', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      const ticks = await connectWithCapturedTicks(fx);
      // Force the publish to throw by patching the client prototype; the
      // extension must fail closed, not crash Pi and not leave a pending.
      const originalPublish = TuiBridgeClient.prototype.publishChoiceRequest;
      TuiBridgeClient.prototype.publishChoiceRequest = () => {
        throw new TypeError('store gone');
      };
      let result;
      try {
        result = await callChoiceTool(fx, choiceParams(), undefined);
      } finally {
        TuiBridgeClient.prototype.publishChoiceRequest = originalPublish;
      }
      assertChoiceResult(result, { status: 'refused', reason: 'publish_failed' });
      assert.equal(choiceRequestEvents(fx).length, 0);
      // The instance must accept a later request (no stuck pending state):
      // a retried call publishes and resolves normally.
      const probe = fx.probe();
      let trackingId;
      try {
        trackingId = probe.sessions()[0].trackingId;
      } finally { probe.close(); }
      const retryPromise = callChoiceTool(fx, choiceParams(), undefined);
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      assert.equal(choiceRequestEvents(fx).length, 1, 'the retry published');
      // Answer the ACTUAL published request (production crypto id here).
      const publishedRequestId = JSON.parse(choiceRequestEvents(fx)[0].payloadJson).requestId;
      const retryProbe = fx.probe();
      let commandId;
      try {
        commandId = retryProbe.store.enqueueTuiCommand({
          trackingId,
          kind: 'choice_response',
          payload: { requestId: publishedRequestId, index: 0 },
        }).commandId;
      } finally { retryProbe.close(); }
      ticks.poll();
      const retry = await retryPromise;
      assertChoiceResult(retry, { status: 'selected', index: 0, value: 'deploy-now' });
      const row = rawCommandRow(fx.sqlitePath, commandId);
      assert.equal(row.state, 'completed');
    } finally { await fx.cleanup(); }
  });
});

describe('telegram_ask_user_choice selection lifecycle', () => {
  test('selected: exact request published (no value), waiting state, exact local value/index back', async () => {
    const FIXED_NOW = 1_700_000_000_000;
    const inj = makeChoiceInjections({ now: () => FIXED_NOW });
    const pending = await makePendingFixture({ injections: inj });
    try {
      // The published request: exact shape, values excluded, injected clock.
      const events = choiceRequestEvents(pending.fx);
      assert.equal(events.length, 1);
      const payload = JSON.parse(events[0].payloadJson);
      assert.deepEqual(Object.keys(payload).sort(), ['expiresAt', 'options', 'question', 'requestId']);
      assert.equal(payload.requestId, REQUEST_ID);
      assert.equal(payload.question, 'Deploy now or wait?');
      assert.equal(payload.expiresAt, FIXED_NOW + CHOICE_TTL_MS, 'exactly 30 minutes ahead of the injected now');
      assert.deepEqual(
        payload.options,
        [
          { label: 'Deploy now', description: 'Ship to production' },
          { label: 'Wait', description: 'Keep it local' },
        ],
        'only label+description travel; value never enters the store',
      );
      // Timeout scheduled for the exact production TTL.
      assert.equal(inj.scheduled.length, 1);
      assert.equal(inj.scheduled[0].ms, CHOICE_TTL_MS);
      // Waiting state while pending.
      let p = pending.fx.probe();
      assert.equal(p.sessions()[0].state, 'waiting');
      p.close();
      // The exact local answer: index 1 → value 'wait'.
      pending.enqueue({ requestId: REQUEST_ID, index: 1 });
      pending.ticks.poll();
      const result = await pending.pendingPromise;
      assertChoiceResult(result, { status: 'selected', index: 1, value: 'wait' });
      // The command settles silently: no command_result event ever.
      assert.equal(commandResultEvents(pending.fx).length, 0);
      p = pending.fx.probe();
      assert.equal(p.sessions()[0].state, 'connected', 'derived state restored');
      p.close();
      // Timer cleared exactly once; firing it late is a no-op.
      assert.equal(inj.cleared.length, 1);
      assert.equal(inj.cleared[0], 1, 'the exact scheduled handle was cleared');
      inj.scheduled[0].callback();
      const p2 = pending.fx.probe();
      assert.equal(p2.sessions()[0].state, 'connected', 'late timer fire changes nothing');
      p2.close();
    } finally { await pending.fx.cleanup(); }
  });

  test('production defaults: crypto request id, exactly 30-minute TTL, real clock expiry', async () => {
    const inj = makeChoiceInjections({ requestId: undefined });
    const pending = await makePendingFixture({ injections: inj });
    try {
      const payload = JSON.parse(choiceRequestEvents(pending.fx)[0].payloadJson);
      assert.match(payload.requestId, /^[0-9a-f]{16}$/, '16 lowercase hex chars from node:crypto');
      assert.equal(inj.scheduled[0].ms, CHOICE_TTL_MS, 'production default is exactly 30 minutes');
      assert.ok(
        Math.abs(payload.expiresAt - (Date.now() + CHOICE_TTL_MS)) < 5_000,
        'expiresAt is now + 30 minutes on the real clock',
      );
      pending.enqueue({ requestId: payload.requestId, cancelled: true });
      pending.ticks.poll();
      await pending.pendingPromise;
    } finally { await pending.fx.cleanup(); }
  });

  test('cancelled: fixed JSON, silent completion, state restored, timer cleared', async () => {
    const pending = await makePendingFixture();
    try {
      const commandId = pending.enqueue({ requestId: REQUEST_ID, cancelled: true });
      pending.ticks.poll();
      const result = await pending.pendingPromise;
      assertChoiceResult(result, { status: 'cancelled' });
      const row = rawCommandRow(pending.fx.sqlitePath, commandId);
      assert.equal(row.state, 'completed');
      assert.equal(row.resultCode, null);
      assert.equal(commandResultEvents(pending.fx).length, 0, 'no chat spam');
      const p = pending.fx.probe();
      assert.equal(p.sessions()[0].state, 'connected');
      p.close();
      assert.equal(pending.inj.cleared.length, 1);
    } finally { await pending.fx.cleanup(); }
  });

  test('timeout: fixed JSON, command after deadline is silently stale and cannot resurrect', async () => {
    const pending = await makePendingFixture();
    try {
      pending.inj.scheduled[0].callback();
      const result = await pending.pendingPromise;
      assertChoiceResult(result, { status: 'timed_out' });
      assert.equal(pending.inj.cleared.length, 1);
      const p = pending.fx.probe();
      assert.equal(p.sessions()[0].state, 'connected');
      p.close();
      // A matching response arriving after the deadline is silently failed.
      const commandId = pending.enqueue({ requestId: REQUEST_ID, index: 0 });
      pending.ticks.poll();
      const row = rawCommandRow(pending.fx.sqlitePath, commandId);
      assert.equal(row.state, 'failed');
      assert.equal(row.resultCode, 'choice_stale');
      assert.equal(commandResultEvents(pending.fx).length, 0, 'no chat spam even for stale taps');
    } finally { await pending.fx.cleanup(); }
  });
});

describe('telegram_ask_user_choice abort paths', () => {
  test('already-aborted signal: fixed JSON without publishing anything', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      const controller = new AbortController();
      controller.abort();
      const result = await callChoiceTool(fx, choiceParams(), controller.signal);
      assertChoiceResult(result, { status: 'aborted' });
      assert.equal(choiceRequestEvents(fx).length, 0, 'no request for an already-aborted call');
    } finally { await fx.cleanup(); }
  });

  test('abort while pending: fixed JSON, timer cleared, later response is silently stale', async () => {
    const controller = new AbortController();
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      const ticks = await connectWithCapturedTicks(fx);
      const pendingPromise = callChoiceTool(fx, choiceParams(), controller.signal);
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      assert.equal(choiceRequestEvents(fx).length, 1);
      controller.abort();
      const result = await pendingPromise;
      assertChoiceResult(result, { status: 'aborted' });
      const p = fx.probe();
      assert.equal(p.sessions()[0].state, 'connected');
      p.close();
      const probe = fx.probe();
      let commandId;
      try {
        commandId = probe.store.enqueueTuiCommand({
          trackingId: probe.sessions()[0].trackingId,
          kind: 'choice_response',
          payload: { requestId: REQUEST_ID, index: 0 },
        }).commandId;
      } finally { probe.close(); }
      ticks.poll();
      const row = rawCommandRow(fx.sqlitePath, commandId);
      assert.equal(row.state, 'failed');
      assert.equal(row.resultCode, 'choice_stale');
      assert.equal(commandResultEvents(fx).length, 0);
    } finally { await fx.cleanup(); }
  });

  test('waiting beats busy: agentActive and uiPromptActive never mask the pending choice', async () => {
    const pending = await makePendingFixture();
    try {
      await pending.fx.pi.emit('agent_start', {}, pending.fx.ctx);
      let p = pending.fx.probe();
      assert.equal(p.sessions()[0].state, 'waiting', 'waiting has priority over busy');
      p.close();
      await pending.fx.pi.emit('agent_settled', {}, pending.fx.ctx);
      await pending.fx.pi.emit('ui_prompt_start', {}, pending.fx.ctx);
      p = pending.fx.probe();
      assert.equal(p.sessions()[0].state, 'waiting', 'native uiPromptActive remains waiting too');
      p.close();
      await pending.fx.pi.emit('ui_prompt_end', {}, pending.fx.ctx);
      pending.enqueue({ requestId: REQUEST_ID, index: 1 });
      pending.ticks.poll();
      await pending.pendingPromise;
      p = pending.fx.probe();
      assert.equal(p.sessions()[0].state, 'connected');
      p.close();
    } finally { await pending.fx.cleanup(); }
  });

  test('native ui_prompt path remains notification-only: state flips, no choice machinery', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      await fx.run('tg', '');
      await fx.pi.emit('ui_prompt_start', {}, fx.ctx);
      let p = fx.probe();
      assert.equal(p.sessions()[0].state, 'waiting');
      p.close();
      await fx.pi.emit('ui_prompt_end', {}, fx.ctx);
      p = fx.probe();
      assert.equal(p.sessions()[0].state, 'connected');
      p.close();
      assert.equal(choiceRequestEvents(fx).length, 0, 'ui_prompt never publishes a choice');
      assert.equal(fx.pi.sentMessages.length, 0);
    } finally { await fx.cleanup(); }
  });
});

describe('telegram_ask_user_choice interruption paths', () => {
  for (const reason of ['quit', 'reload', 'new', 'resume', 'fork']) {
    test(`session_shutdown (${reason}) settles the blocked tool as interrupted`, async () => {
      const pending = await makePendingFixture();
      try {
        await pending.fx.pi.emit('session_shutdown', { reason }, pending.fx.ctx);
        const result = await pending.pendingPromise;
        assertChoiceResult(result, { status: 'interrupted' });
        assert.equal(pending.isSettled(), true);
      } finally { await pending.fx.cleanup(); }
    });
  }

  test('explicit unlink (tg off) during a pending choice resolves interrupted', async () => {
    const pending = await makePendingFixture();
    try {
      await pending.fx.run('tg', 'off', makeCtx({ selectAnswer: 'Unlink' }).ctx);
      const result = await pending.pendingPromise;
      assertChoiceResult(result, { status: 'interrupted' });
    } finally { await pending.fx.cleanup(); }
  });

  test('remote disconnect command during a pending choice: tool interrupted, ordinary report intact', async () => {
    const pending = await makePendingFixture();
    try {
      const probe = pending.fx.probe();
      let commandId;
      try {
        commandId = probe.store.enqueueTuiCommand({
          trackingId: pending.trackingId,
          kind: 'disconnect',
          payload: null,
        }).commandId;
      } finally { probe.close(); }
      pending.ticks.poll();
      const result = await pending.pendingPromise;
      assertChoiceResult(result, { status: 'interrupted' });
      // Ordinary command reporting is unchanged: completed WITH its event.
      const row = rawCommandRow(pending.fx.sqlitePath, commandId);
      assert.equal(row.state, 'completed');
      const results = commandResultEvents(pending.fx);
      assert.equal(results.length, 1, 'exactly one ordinary command_result event');
      assert.equal(JSON.parse(results[0].payloadJson).ok, true);
    } finally { await pending.fx.cleanup(); }
  });

  test('ownership loss during a pending choice resolves interrupted', async () => {
    const pending = await makePendingFixture();
    try {
      // Age the owner row past the staleness window, then replace it from
      // another client: the extension's next heartbeat must detect the loss.
      rawSetHeartbeatAt(pending.fx.sqlitePath, pending.trackingId, Date.now() - 60_000);
      const probe = pending.fx.probe();
      let replaced;
      try {
        replaced = probe.client.connect({
          trackingId: pending.trackingId,
          label: 'thief',
          pid: 424_242,
        });
      } finally { probe.close(); }
      assert.equal(replaced.ok, true, 'the stale owner is safely replaced');
      pending.ticks.heartbeat();
      const result = await pending.pendingPromise;
      assertChoiceResult(result, { status: 'interrupted' });
    } finally { await pending.fx.cleanup(); }
  });
});

describe('silent choice dispatch: exact binding, no events, no fabricated answers', () => {
  test('mismatched requestId is silently failed and never settles the real pending tool', async () => {
    const pending = await makePendingFixture();
    try {
      const commandId = pending.enqueue({ requestId: 'ffffffffffffffff', index: 0 });
      pending.ticks.poll();
      const row = rawCommandRow(pending.fx.sqlitePath, commandId);
      assert.equal(row.state, 'failed');
      assert.equal(row.resultCode, 'choice_stale');
      assert.equal(pending.isSettled(), false, 'the real tool must stay pending');
      await settleDelay();
      assert.equal(pending.isSettled(), false);
      // The tool is still alive: a matching command now resolves it.
      pending.enqueue({ requestId: REQUEST_ID, index: 0 });
      pending.ticks.poll();
      const result = await pending.pendingPromise;
      assertChoiceResult(result, { status: 'selected', index: 0, value: 'deploy-now' });
      assert.equal(commandResultEvents(pending.fx).length, 0);
    } finally { await pending.fx.cleanup(); }
  });

  test('out-of-local-range index is silently failed and the pending tool survives', async () => {
    const pending = await makePendingFixture();
    try {
      // Two local options: store-legal index 2 is out of range locally.
      const commandId = pending.enqueue({ requestId: REQUEST_ID, index: 2 });
      pending.ticks.poll();
      const row = rawCommandRow(pending.fx.sqlitePath, commandId);
      assert.equal(row.state, 'failed');
      assert.equal(row.resultCode, 'choice_invalid');
      assert.equal(pending.isSettled(), false);
      pending.enqueue({ requestId: REQUEST_ID, cancelled: true });
      pending.ticks.poll();
      await pending.pendingPromise;
    } finally { await pending.fx.cleanup(); }
  });

  for (const [label, payload] of Object.entries({
    'extra fields': { requestId: REQUEST_ID, index: 0, extra: 'x' },
    'non-integer index': { requestId: REQUEST_ID, index: 1.5 },
    'cancelled false': { requestId: REQUEST_ID, cancelled: false },
    'mixed variant': { requestId: REQUEST_ID, index: 0, cancelled: true },
    'string index': { requestId: REQUEST_ID, index: '0' },
    'non-hex requestId': { requestId: 'NOT-HEX-AT-ALL', index: 0 },
  })) {
    test(`malformed response (${label}) via raw row: silently failed, pending untouched`, async () => {
      const pending = await makePendingFixture();
      try {
        const commandId = `cmd-raw-${label.replaceAll(' ', '-')}`;
        rawInsertCommand(pending.fx.sqlitePath, pending.trackingId, commandId, 'choice_response', payload);
        pending.ticks.poll();
        const row = rawCommandRow(pending.fx.sqlitePath, commandId);
        assert.equal(row.state, 'failed', 'the malformed command must settle as failed');
        assert.ok(
          row.resultCode === 'choice_invalid' || row.resultCode === 'choice_stale',
          `bounded code expected, got ${row.resultCode}`,
        );
        assert.equal(pending.isSettled(), false, 'a malformed command must never settle the tool');
        await settleDelay();
        assert.equal(pending.isSettled(), false);
        assert.equal(commandResultEvents(pending.fx).length, 0, 'no chat spam on invalid paths');
        // The pending tool still resolves from a valid command.
        pending.enqueue({ requestId: REQUEST_ID, index: 1 });
        pending.ticks.poll();
        await pending.pendingPromise;
      } finally { await pending.fx.cleanup(); }
    });
  }

  test('silently failing to settle (throw) never fabricates an answer and never falls through to reporting', async () => {
    const pending = await makePendingFixture();
    const originalSettle = TuiBridgeClient.prototype.settleChoiceResponse;
    TuiBridgeClient.prototype.settleChoiceResponse = () => {
      throw new TypeError('store gone');
    };
    try {
      const commandId = pending.enqueue({ requestId: REQUEST_ID, index: 1 });
      pending.ticks.poll();
      await settleDelay();
      assert.equal(pending.isSettled(), false, 'no fabricated answer on a throwing settle');
      const row = rawCommandRow(pending.fx.sqlitePath, commandId);
      assert.equal(row.state, 'claimed', 'the command must not be reported completed or failed');
      assert.equal(commandResultEvents(pending.fx).length, 0, 'no generic report fall-through');
    } finally {
      TuiBridgeClient.prototype.settleChoiceResponse = originalSettle;
      await pending.fx.cleanup();
    }
  });

  test('silently refused settle (ok:false) also leaves the tool pending without spam', async () => {
    const pending = await makePendingFixture();
    const originalSettle = TuiBridgeClient.prototype.settleChoiceResponse;
    TuiBridgeClient.prototype.settleChoiceResponse = () => ({ ok: false, reason: 'claim_lost' });
    try {
      const commandId = pending.enqueue({ requestId: REQUEST_ID, index: 1 });
      pending.ticks.poll();
      await settleDelay();
      assert.equal(pending.isSettled(), false);
      const row = rawCommandRow(pending.fx.sqlitePath, commandId);
      assert.equal(row.state, 'claimed');
      assert.equal(commandResultEvents(pending.fx).length, 0);
    } finally {
      TuiBridgeClient.prototype.settleChoiceResponse = originalSettle;
      await pending.fx.cleanup();
    }
  });

  test('ordinary commands still report with events while choice commands never do', async () => {
    const fx = makeFixture({ selectAnswer: 'Connect' });
    try {
      const ticks = await connectWithCapturedTicks(fx);
      const probe = fx.probe();
      let statusCommandId;
      let promptCommandId;
      try {
        const trackingId = probe.sessions()[0].trackingId;
        statusCommandId = probe.store.enqueueTuiCommand({
          trackingId, kind: 'status', payload: null,
        }).commandId;
        promptCommandId = probe.store.enqueueTuiCommand({
          trackingId, kind: 'prompt', payload: { text: '/tg off' },
        }).commandId;
      } finally { probe.close(); }
      ticks.poll();
      const statusRow = rawCommandRow(fx.sqlitePath, statusCommandId);
      assert.equal(statusRow.state, 'completed');
      const promptRow = rawCommandRow(fx.sqlitePath, promptCommandId);
      assert.equal(promptRow.state, 'failed');
      assert.equal(promptRow.resultCode, 'rejected_slash_prefix');
      const results = commandResultEvents(fx);
      assert.equal(results.length, 2, 'ordinary commands keep their command_result events');
      const oks = results.map((e) => JSON.parse(e.payloadJson).ok).sort();
      assert.deepEqual(oks, [false, true]);
      assert.equal(choiceRequestEvents(fx).length, 0);
    } finally { await fx.cleanup(); }
  });

  test('poll and heartbeat keep running during the awaited execute', async () => {
    const pending = await makePendingFixture();
    try {
      assert.equal(typeof pending.ticks.poll, 'function', 'poll timer registered');
      assert.equal(typeof pending.ticks.heartbeat, 'function', 'heartbeat timer registered');
      const before = rawHeartbeatAt(pending.fx.sqlitePath, pending.trackingId);
      const commandId = pending.enqueue({ requestId: REQUEST_ID, index: 0 });
      // The poll tick fires while the tool promise is still unresolved —
      // this IS the dispatch path — and the heartbeat tick still works too.
      pending.ticks.poll();
      pending.ticks.heartbeat();
      const result = await pending.pendingPromise;
      assertChoiceResult(result, { status: 'selected', index: 0, value: 'deploy-now' });
      const after = rawHeartbeatAt(pending.fx.sqlitePath, pending.trackingId);
      assert.ok(after >= before, 'the heartbeat tick refreshed the live session');
      const row = rawCommandRow(pending.fx.sqlitePath, commandId);
      assert.equal(row.state, 'completed');
    } finally { await pending.fx.cleanup(); }
  });
});

// --- Mixed-version runtime guard (restart_required) -------------------------
//
// Production incident: after install + /reload a NEW extension instance was
// wired to OLD cached runtime modules (old beginner-copy.mjs without
// containsCredentialShape, old TuiBridgeClient/Store), and the choice tool
// crashed with a raw `containsCredentialShape is not a function` TypeError.
// The contract below pins the guard: a mixed runtime must refuse with the
// fixed compact `restart_required` JSON BEFORE any credential scan,
// sanitization, helper call or publish — no event, no pending state, no
// timer, no leaked ids/paths/raw errors.
describe('telegram_ask_user_choice mixed-runtime guard (restart_required)', () => {
  /** Calls the tool and resolves false if it is still pending after 250ms
   *  (pre-guard behavior: publish + block) so RED fails fast, never hangs. */
  async function callRefusingFast(fx, params) {
    const toolPromise = callChoiceTool(fx, params, undefined);
    const refused = await Promise.race([
      toolPromise.then(() => true),
      settleDelay(250).then(() => false),
    ]);
    return { toolPromise, refused };
  }

  test('injected mixed runtime: fixed restart_required JSON, nothing published, no pending state, no timer', async () => {
    const inj = { ...makeChoiceInjections(), choiceRuntimeReady: () => false };
    const fx = makeFixture({ selectAnswer: 'Connect', injections: inj });
    try {
      await fx.run('tg', '');
      const { toolPromise, refused } = await callRefusingFast(fx, choiceParams());
      assert.equal(
        refused,
        true,
        'a mixed runtime must refuse immediately instead of publishing and blocking',
      );
      const result = await toolPromise;
      assertChoiceResult(result, { status: 'refused', reason: 'restart_required' });
      assert.equal(choiceRequestEvents(fx).length, 0, 'no choice request may be published');
      assert.equal(inj.scheduled.length, 0, 'no deadline timer may be armed');
      assert.equal(inj.cleared.length, 0, 'nothing scheduled means nothing to clear');
      const p = fx.probe();
      assert.equal(p.sessions()[0].state, 'connected', 'no pending choice may flip state to waiting');
      p.close();
    } finally { await fx.cleanup(); }
  });

  test('guard precedes the credential scan: restart_required even for credential-shaped input', async () => {
    const inj = { ...makeChoiceInjections(), choiceRuntimeReady: () => false };
    const fx = makeFixture({ selectAnswer: 'Connect', injections: inj });
    try {
      await fx.run('tg', '');
      const secret = 'ghp_' + 'a'.repeat(25);
      const { toolPromise, refused } = await callRefusingFast(fx, choiceParams({
        question: `use ${secret} now?`,
      }));
      assert.equal(refused, true, 'the guard must fire before any credential scan');
      const result = await toolPromise;
      assertChoiceResult(result, { status: 'refused', reason: 'restart_required' });
      assert.equal(choiceRequestEvents(fx).length, 0);
    } finally { await fx.cleanup(); }
  });

  test('refusal result leaks nothing: no ids, paths or raw errors in text or details', async () => {
    const inj = { ...makeChoiceInjections(), choiceRuntimeReady: () => false };
    const fx = makeFixture({ selectAnswer: 'Connect', injections: inj });
    try {
      await fx.run('tg', '');
      const { toolPromise, refused } = await callRefusingFast(fx, choiceParams());
      assert.equal(refused, true);
      const result = await toolPromise;
      const text = result.content[0].text;
      assert.ok(!text.includes(fx.stateDirectory));
      assert.ok(!text.includes(fx.sqlitePath));
      assert.ok(!text.includes(REQUEST_ID));
      assert.doesNotMatch(text, /error|exception|typeerror/i);
      assert.deepEqual(result.details, { status: 'refused', reason: 'restart_required' });
    } finally { await fx.cleanup(); }
  });
});
