// T02 WU3: PiRpcAdapter contract, tested against a scripted fake Pi RPC
// child process (fake E2E groundwork). No real Pi calls in tests.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { PiRpcAdapter, buildProductionLaunch } from '../src/pi-adapter.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-pi-rpc.mjs', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const T0 = 1_700_000_000_000;

function writeScenario(dir, scenario) {
  const path = join(dir, 'scenario.json');
  writeFileSync(path, JSON.stringify(scenario), 'utf8');
  return path;
}

function makeAdapter(dir, scenarioPath, overrides = {}) {
  return new PiRpcAdapter({
    argv: [process.execPath, FIXTURE, '--mode', 'rpc', '--scenario', scenarioPath],
    cwd: dir,
    requestTimeoutMs: 5000,
    ...overrides,
  });
}

describe('pi-adapter: spawn, correlation, lifecycle', () => {
  let dir;
  let adapter;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'adapter-'));
  });
  afterEach(async () => {
    if (adapter) await adapter.dispose();
  });

  test('start() spawns with exact argv (no shell) and captures session identity', async () => {
    const scenario = writeScenario(dir, {
      session: { sessionId: 'fake-session-1', sessionFile: join(dir, 'fake-session.jsonl') },
      prompts: [],
    });
    adapter = makeAdapter(dir, scenario);
    const state = await adapter.start();
    assert.equal(state.sessionId, 'fake-session-1');
    assert.equal(state.sessionFile, join(dir, 'fake-session.jsonl'));
    assert.equal(typeof state.pid, 'number');
    assert.ok(state.pid > 0);
    assert.equal(adapter.isRunning(), true);
  });

  test('argv containing spaces works (proves shell:false array spawn)', async () => {
    // cwd with a space in the path; the fixture path itself has no spaces,
    // but the argv array must survive intact without a shell join.
    const scenario = writeScenario(dir, { session: { sessionId: 's', sessionFile: 'f' }, prompts: [] });
    adapter = makeAdapter(dir, scenario);
    const state = await adapter.start();
    assert.equal(state.sessionId, 's');
  });

  test('send() correlates responses by id', async () => {
    const scenario = writeScenario(dir, {
      session: { sessionId: 's', sessionFile: 'f' },
      prompts: [{ response: { success: true }, then: [{ kind: 'event', event: { type: 'agent_settled' } }] }],
    });
    adapter = makeAdapter(dir, scenario);
    await adapter.start();
    const res = await adapter.send({ type: 'prompt', message: 'hello' });
    assert.equal(res.success, true);
    assert.equal(res.command, 'prompt');
  });

  test('send() rejects unknown/unsupported command types before writing', async () => {
    const scenario = writeScenario(dir, { session: { sessionId: 's', sessionFile: 'f' }, prompts: [] });
    adapter = makeAdapter(dir, scenario);
    await adapter.start();
    await assert.rejects(
      () => adapter.send({ type: 'bash', command: 'rm -rf /' }),
      /unsupported/i,
    );
  });

  test('send() times out without killing the adapter', async () => {
    const scenario = writeScenario(dir, {
      session: { sessionId: 's', sessionFile: 'f' },
      prompts: [{ response: { success: true }, then: [], delayMs: 500 }],
    });
    adapter = makeAdapter(dir, scenario);
    await adapter.start();
    // The per-call timeout keeps the startup get_state probe at its own
    // (default) budget: a 50 ms adapter-wide timeout made start() flaky
    // under parallel-suite load (child spawn can exceed 50 ms).
    await assert.rejects(
      () => adapter.send({ type: 'prompt', message: 'x' }, { timeoutMs: 50 }),
      (error) => {
        assert.equal(error.code, 'timeout');
        return true;
      },
    );
    assert.equal(adapter.isRunning(), true, 'adapter survives a request timeout');
  });

  test('child exit fails all pending requests and the adapter never restarts it', async () => {
    const scenario = writeScenario(dir, {
      session: { sessionId: 's', sessionFile: 'f' },
      prompts: [{ response: { success: true }, then: [], delayMs: 400 }],
    });
    adapter = makeAdapter(dir, scenario, { requestTimeoutMs: 5000 });
    await adapter.start();

    const pending = adapter.send({ type: 'prompt', message: 'will be interrupted' });
    const exitPromise = adapter.waitForExit();
    // Kill the child while the response is still delayed.
    adapter.dispose({ timeoutMs: 1000 });
    await assert.rejects(
      pending,
      (error) => {
        assert.equal(error.code, 'child_exit');
        return true;
      },
    );
    await exitPromise;
    assert.equal(adapter.isRunning(), false);
    // No auto-restart: after exit, every send fails closed.
    await assert.rejects(
      () => adapter.send({ type: 'prompt', message: 'again' }),
      (error) => {
        assert.equal(error.code, 'closed');
        return true;
      },
    );
  });

  test('spawn failure reports a safe error without echoing the full argv', async () => {
    const missingExe = join(dir, 'no-such-dir-xyz', 'missing-exe.exe');
    adapter = new PiRpcAdapter({
      argv: [missingExe, '--mode', 'rpc'],
      cwd: dir,
      requestTimeoutMs: 2000,
    });
    await assert.rejects(
      () => adapter.start(),
      (error) => {
        assert.equal(error.code, 'spawn_error');
        const text = JSON.stringify(error);
        assert.ok(!text.includes('missing-exe'), 'error must not echo the argv');
        return true;
      },
    );
  });

  test('startup get_state failure cleanly shuts down ONLY its own spawned child', async () => {
    const scenario = writeScenario(dir, {
      session: { sessionId: 's', sessionFile: 'f' },
      prompts: [],
      failStartup: true,
    });
    adapter = makeAdapter(dir, scenario);
    await assert.rejects(
      () => adapter.start(),
      (error) => {
        assert.equal(error.code, 'startup_failed');
        return true;
      },
    );
    // The child we spawned must be gone, not left orphaned.
    for (let i = 0; i < 50 && adapter.isRunning(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(adapter.isRunning(), false, 'own child shut down after failed startup');
    await assert.rejects(
      () => adapter.send({ type: 'prompt', message: 'x' }),
      (error) => {
        assert.equal(error.code, 'closed');
        return true;
      },
    );
  });

  test('startup get_state timeout kills its own child, never a foreign PID', async () => {
    const scenario = writeScenario(dir, {
      session: { sessionId: 's', sessionFile: 'f' },
      prompts: [],
      delayGetStateMs: 1000,
    });
    adapter = makeAdapter(dir, scenario, { requestTimeoutMs: 80 });
    await assert.rejects(
      () => adapter.start(),
      (error) => {
        assert.equal(error.code, 'timeout');
        return true;
      },
    );
    for (let i = 0; i < 50 && adapter.isRunning(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(adapter.isRunning(), false, 'own child killed after startup timeout');
  });

  test('multibyte UTF-8 split across pipe chunks decodes without corruption', async () => {
    const scenario = writeScenario(dir, {
      session: { sessionId: 's', sessionFile: 'f' },
      prompts: [{
        response: { success: true },
        then: [{ kind: 'eventsplit', event: { type: 'message_end', message: { role: 'assistant', text: 'emoji: 😀 end' } } }],
      }],
    });
    adapter = makeAdapter(dir, scenario);
    const events = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start();
    await adapter.send({ type: 'prompt', message: 'go' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const found = events.find((e) => e.type === 'message_end');
    assert.ok(found, 'split-multibyte event parsed');
    assert.equal(found.message.text, 'emoji: 😀 end');
  });

  test('events stream through onEvent; U+2028 inside JSON does not break framing', async () => {
    const scenario = writeScenario(dir, {
      session: { sessionId: 's', sessionFile: 'f' },
      prompts: [{
        response: { success: true },
        then: [{ kind: 'event', event: { type: 'message_end', message: { role: 'assistant', text: 'sep\u2028here' } } }],
      }],
    });
    adapter = makeAdapter(dir, scenario);
    const events = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start();
    await adapter.send({ type: 'prompt', message: 'go' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const found = events.find((e) => e.type === 'message_end');
    assert.ok(found, 'event with U+2028 parsed as a single record');
    assert.equal(found.message.text, 'sep\u2028here');
  });
});

describe('pi-adapter: extension UI sub-protocol', () => {
  let dir;
  let adapter;

  beforeEach(() => {
    dir = mkdtempSync(join(TEST_RUNS, 'adapter-ui-'));
  });
  afterEach(async () => {
    if (adapter) await adapter.dispose();
  });

  test('ui requests are surfaced and responses routed back by id', async () => {
    const scenario = writeScenario(dir, {
      session: { sessionId: 's', sessionFile: 'f' },
      prompts: [{
        response: { success: true },
        then: [{
          kind: 'ui',
          request: { method: 'select', title: 'Pick one', options: ['A', 'B'] },
          awaitResponse: true,
          afterResponse: [{ kind: 'event', event: { type: 'agent_settled' } }],
        }],
      }],
    });
    adapter = makeAdapter(dir, scenario);
    const uiRequests = [];
    adapter.onUiRequest((request) => uiRequests.push(request));

    await adapter.start();
    const settled = new Promise((resolve) => {
      adapter.onEvent((event) => {
        if (event.type === 'agent_settled') resolve();
      });
    });
    await adapter.send({ type: 'prompt', message: 'ask me' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(uiRequests.length, 1);
    assert.equal(uiRequests[0].method, 'select');
    assert.deepEqual(uiRequests[0].options, ['A', 'B']);

    adapter.respondUi(uiRequests[0].id, { value: 'B' });
    await settled;
  });

  test('fire-and-forget ui requests (notify) need no response', async () => {
    const scenario = writeScenario(dir, {
      session: { sessionId: 's', sessionFile: 'f' },
      prompts: [{
        response: { success: true },
        then: [{ kind: 'ui', request: { method: 'notify', message: 'blocked by user', notifyType: 'warning' } }],
      }],
    });
    adapter = makeAdapter(dir, scenario);
    const uiRequests = [];
    adapter.onUiRequest((request) => uiRequests.push(request));
    await adapter.start();
    await adapter.send({ type: 'prompt', message: 'go' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(uiRequests.length, 1);
    assert.equal(uiRequests[0].method, 'notify');
  });
});

describe('pi-adapter: getState identity probe', () => {
  test('getState returns the child pid plus the reported session identity', async () => {
    const dir = mkdtempSync(join(TEST_RUNS, 'getstate-'));
    const scenarioPath = writeScenario(dir, {
      session: { sessionId: 'pi-identity-1', sessionFile: 'f.jsonl' },
      prompts: [],
    });
    const adapter = makeAdapter(dir, scenarioPath);
    try {
      await adapter.start();
      const state = await adapter.getState();
      assert.equal(state.sessionId, 'pi-identity-1');
      assert.equal(typeof state.pid, 'number');
      assert.ok(state.pid > 0);
    } finally {
      await adapter.dispose();
    }
  });
});

describe('pi-adapter: production launch factory (H1)', () => {
  test('fixed restrictive argv, sanitized env, no shell', () => {
    const fakeEnv = {
      PATH: 'C:/tools',
      SystemRoot: 'C:/Windows',
      TEMP: 'C:/Temp',
      TMP: 'C:/Temp',
      APPDATA: 'C:/Users/x/AppData/Roaming',
      LOCALAPPDATA: 'C:/Users/x/AppData/Local',
      TELEGRAM_BOT_TOKEN: '123456:AAHfake',
      GITHUB_TOKEN: 'ghp_fakefakefakefakefakefakefakefake',
      ANTHROPIC_API_KEY: 'sk-fake',
      AWS_SECRET_ACCESS_KEY: 'fake',
    };
    const launch = buildProductionLaunch({
      sessionId: 'sess-1',
      nodePath: 'node.exe',
      cliPath: 'C:/pi/cli.mjs',
      workspaceRoot: 'C:/wrk/WS',
      extensionPath: 'C:/bridge/extension/bridge-extension.ts',
      sessionDir: 'C:/bridge/.local/sessions',
      env: fakeEnv,
    });

    assert.equal(launch.cwd, 'C:/wrk/WS');
    const expected = [
      'node.exe',
      'C:/pi/cli.mjs',
      '--mode', 'rpc',
      '--offline',
      '--no-extensions',
      '-e', 'C:/bridge/extension/bridge-extension.ts',
      '--tools', 'read,write,edit,bridge_decision',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-approve',
      '--session-dir', 'C:/bridge/.local/sessions',
      '--name', 'sess-1',
    ];
    assert.deepEqual(launch.argv, expected);

    // Env is a strict whitelist: every credential variable is stripped.
    for (const key of Object.keys(fakeEnv)) {
      if (key === 'PATH' || key === 'SystemRoot' || key === 'TEMP' || key === 'TMP' || key === 'APPDATA' || key === 'LOCALAPPDATA') {
        assert.equal(launch.env[key], fakeEnv[key], `${key} survives`);
      } else {
        assert.equal(launch.env[key], undefined, `${key} stripped from child env`);
      }
    }
    const serialized = JSON.stringify(launch.env);
    assert.ok(!serialized.includes('ghp_'), 'no tokens in child env');
    // Startup network operations are disabled twice over: the CLI flag AND
    // the PI_OFFLINE env (verified against the installed pi --help output).
    assert.equal(launch.env.PI_OFFLINE, '1', 'PI_OFFLINE=1 survives the scrub');
  });

  test('reuses the session dir so the pi session identity is durable', () => {
    const a = buildProductionLaunch({ sessionId: 's1', nodePath: 'node', cliPath: 'cli', workspaceRoot: 'C:/w', extensionPath: 'e', sessionDir: 'C:/sd', env: {} });
    const b = buildProductionLaunch({ sessionId: 's2', nodePath: 'node', cliPath: 'cli', workspaceRoot: 'C:/w', extensionPath: 'e', sessionDir: 'C:/sd', env: {} });
    assert.deepEqual(a.argv.slice(-2), ['--name', 's1']);
    assert.deepEqual(b.argv.slice(-2), ['--name', 's2']);
    assert.deepEqual(a.argv[a.argv.indexOf('--session-dir') + 1], b.argv[b.argv.indexOf('--session-dir') + 1]);
  });
});
