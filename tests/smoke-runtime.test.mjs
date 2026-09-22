// T04r2: focused tests for the smoke-runtime HARNESS logic only.
// No live child, no network: the real SessionHost (with a fake adapter)
// produces the REAL API shapes (outbox rows, request rows, host-meta)
// the harness must read, so shape drift (e.g. `.state` vs `.status`,
// options nested in payload) is caught without spawning pi.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { platform } from 'node:process';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_RUNS = join(MODULE_ROOT, '.local', 'test-runs');
mkdirSync(TEST_RUNS, { recursive: true });
const IS_WIN = platform === 'win32';

const T0 = 1_700_000_000_000;

// Harness module under test.
const harnessUrl = pathToFileURL(join(MODULE_ROOT, 'scripts', 'smoke-runtime.mjs')).href;
let harness = null;

// Real SessionHost + fake adapter: the shape producer.
const { SessionHost } = await import('../src/session-host.mjs');
const { Store } = await import('../src/store.mjs');

class FakeAdapter {
  constructor(label) {
    this.label = label;
    this.started = false;
    this.sent = [];
    this.uiResponses = [];
    this.eventHandlers = [];
    this.uiHandlers = [];
    this.disposed = false;
    this.nonce = null; // parsed from the /bridge-demo prompt, like the real extension
  }
  async start() {
    this.started = true;
    return { sessionId: `pi-${this.label}`, sessionFile: `fake-${this.label}.jsonl`, pid: 42000 };
  }
  onEvent(handler) { this.eventHandlers.push(handler); }
  onUiRequest(handler) { this.uiHandlers.push(handler); }
  send(command) {
    this.sent.push(command);
    const text = typeof command?.message === 'string' ? command.message : '';
    const match = text.match(/\/bridge-demo ([0-9a-f]+)/);
    if (match) this.nonce = match[1];
    return Promise.resolve({ success: true, command: command.type });
  }
  respondUi(id, response) {
    this.uiResponses.push({ id, response });
    // REAL extension shape: answering the select triggers the
    // nonce-bound notify that completes the demo lifecycle.
    if (response && typeof response === 'object' && typeof response.value === 'string' && this.nonce) {
      const message = JSON.stringify({ nonce: this.nonce, choice: response.value });
      queueMicrotask(() => {
        for (const h of this.uiHandlers) h({ id: `${id}-notify`, method: 'notify', message });
      });
    }
  }
  isRunning() { return this.started; }
  async dispose() { this.started = false; this.disposed = true; }
  emitUi(request) { for (const h of this.uiHandlers) h(request); }
  emitEvent(event) { for (const h of this.eventHandlers) h(event); }
}

/** Real host+store+adapter producing REAL rows; returns everything. */
function produceRealShapes() {
  const dir = mkdtempSync(join(TEST_RUNS, 'smokeharness-'));
  const store = new Store(join(dir, 'main.sqlite'), {
    now: () => T0,
    isProcessAlive: (pid) => pid === 999,
  });
  let adapter = null;
  const host = new SessionHost({
    store,
    ownerId: 'smoke-harness-test',
    pid: 999,
    adapterFactory: ({ sessionId }) => {
      adapter = new FakeAdapter(sessionId);
      return adapter;
    },
    requestTtlMs: 60_000,
  });
  return { dir, store, host, get adapter() { return adapter; } };
}

before(async () => {
  harness = await import(harnessUrl);
});

after(async () => {
  // Nothing persistent to clean; artifacts stay under .local/test-runs.
});

describe('smoke-runtime harness: parseSmokeArgs (CLI validation)', () => {
  test('accepts existing absolute canonical paths', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 'args-'));
    const cli = join(dir, 'cli.js');
    const ws = join(dir, 'ws');
    writeFileSync(cli, '// fixture\n', 'utf8');
    mkdirSync(ws, { recursive: true });
    const parsed = harness.parseSmokeArgs(['--pi-cli', cli, '--pi-workspace', ws]);
    assert.equal(parsed.piCli, cli);
    assert.equal(parsed.piWorkspace, ws);
  });

  test('throws fixed codes for missing, relative or non-existent inputs (no process.exit)', () => {
    const dir = mkdtempSync(join(TEST_RUNS, 'args2-'));
    const cli = join(dir, 'cli.js');
    writeFileSync(cli, '// fixture\n', 'utf8');
    assert.throws(() => harness.parseSmokeArgs([]), (e) => e.code === 'args_missing');
    assert.throws(
      () => harness.parseSmokeArgs(['--pi-cli', 'relative.js', '--pi-workspace', cli]),
      (e) => e.code === 'args_not_absolute',
    );
    assert.throws(
      () => harness.parseSmokeArgs(['--pi-cli', join(dir, 'nope.js'), '--pi-workspace', dir]),
      (e) => e.code === 'args_not_found',
    );
  });
});

describe('smoke-runtime harness: real SessionHost shapes (no live child)', () => {
  test('extractPendingDialog reads approval_request with options NESTED in payload (real outbox row)', async () => {
    const ctx = produceRealShapes();
    try {
      await ctx.host.startSession('main');
      ctx.host.tick(T0 + 1000); // drain start noise
      // Real demo lifecycle: the host sends /bridge-demo and pi replies
      // with the REAL dialog shape the bridge emits in production.
      const started = ctx.host.startDemo('main');
      assert.equal(started.ok, true);
      await new Promise((resolve) => setImmediate(resolve));
      ctx.adapter.emitUi({
        id: 'ui-1',
        method: 'select',
        title: 'Demo',
        options: ['Option A', 'Option B'],
      });
      const rows = ctx.store.listPendingOutbox();
      const dialog = harness.extractPendingDialog(rows);
      assert.equal(dialog.kind, 'approval_request');
      assert.equal(typeof dialog.requestId, 'string');
      assert.ok(Array.isArray(dialog.options) && dialog.options.length >= 1);
      assert.equal(dialog.options[0], 'Option A');
    } finally {
      await ctx.host.dispose();
      ctx.store.close();
    }
  });

  test('extractPendingDialog throws fixed codes when nothing pending or options unrenderable', async () => {
    assert.throws(() => harness.extractPendingDialog([]), (e) => e.code === 'no_pending_dialog');
    // Real shape but empty options: the harness must refuse to decide.
    assert.throws(
      () => harness.extractPendingDialog([
        { outboxId: 1, requestId: 'r1', kind: 'approval_request', payload: { requestId: 'r1', options: [] } },
      ]),
      (e) => e.code === 'dialog_missing_options',
    );
  });

  test('assertCompletedDecision reads the REAL row field `.state` (not .status) and the decision choice', async () => {
    const ctx = produceRealShapes();
    try {
      await ctx.host.startSession('main');
      ctx.host.tick(T0 + 1000);
      const started = ctx.host.startDemo('main');
      assert.equal(started.ok, true);
      await new Promise((resolve) => setImmediate(resolve));
      // REAL demo shape: the extension (not a model tool) opens the
      // select while the demo lifecycle is open; the typed answer flows
      // back as the nonce-bound notify after the decision is applied.
      ctx.adapter.emitUi({
        id: 'ui-1',
        method: 'select',
        title: 'Demo',
        options: ['Option A', 'Option B'],
      });
      const dialog = harness.extractPendingDialog(ctx.store.listPendingOutbox());
      // The typed decision: exactly what the worker writes for a human.
      ctx.store.enqueueAction({
        actionId: 'smoke-decision-1',
        type: 'decision',
        payload: { requestId: dialog.requestId, decision: { value: 'Option A' } },
      });
      ctx.host.tick(T0 + 2000);
      // The decision triggers respondUi, and the extension's nonce-bound
      // notify completes the lifecycle asynchronously.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const row = ctx.store.getRequest(dialog.requestId);
      // The row REALLY has `.state`; if the harness reads `.status` this
      // assertion exposes the drift.
      assert.equal(typeof row.state, 'string');
      assert.equal(row.state, 'completed');
      assert.equal(row.result?.choice, 'Option A', 'the demo path records the choice in result');
      harness.assertCompletedDecision(row, 'Option A');
      // A wrong choice must fail the assert even when completed.
      assert.throws(() => harness.assertCompletedDecision(row, 'Option B'));
    } finally {
      await ctx.host.dispose();
      ctx.store.close();
    }
  });

  test('assertCompletedDecision fails closed for failed/failed-state rows and missing fields', () => {
    assert.throws(
      () => harness.assertCompletedDecision({ state: 'waiting_decision', decision: null }, 'x'),
      (e) => e.code === 'decision_not_completed',
    );
    assert.throws(
      () => harness.assertCompletedDecision({ state: 'failed', decision: null }, 'x'),
      (e) => e.code === 'decision_failed',
    );
    assert.throws(
      () => harness.assertCompletedDecision({ state: 'completed', decision: { value: 'a' } }, 'b'),
      (e) => e.code === 'decision_choice_mismatch',
    );
  });
});

describe('smoke-runtime harness: meta identity checks', () => {
  test('assertMetaIdentity requires nonempty piPid/piSessionId and rejects piPid==hostPid', () => {
    const good = { mode: 'host_only_real', pid: 100, piPid: 200, piSessionId: 'sess-1' };
    harness.assertMetaIdentity(good);
    assert.throws(
      () => harness.assertMetaIdentity({ ...good, piPid: null }),
      (e) => e.code === 'meta_missing_pi_identity',
    );
    assert.throws(
      () => harness.assertMetaIdentity({ ...good, piSessionId: '' }),
      (e) => e.code === 'meta_missing_pi_identity',
    );
    assert.throws(
      () => harness.assertMetaIdentity({ ...good, piPid: 100 }),
      (e) => e.code === 'meta_pi_pid_is_host_pid',
    );
    assert.throws(
      () => harness.assertMetaIdentity({ ...good, mode: 'host_demo' }),
      (e) => e.code === 'meta_wrong_mode',
    );
  });

  test('assertSamePiChild detects pid or session drift (no silent skip when piSessionId empty)', () => {
    harness.assertSamePiChild({ piPid: 200, piSessionId: 's1' }, { piPid: 200, piSessionId: 's1' });
    assert.throws(
      () => harness.assertSamePiChild({ piPid: 200, piSessionId: 's1' }, { piPid: 300, piSessionId: 's1' }),
      (e) => e.code === 'pi_child_changed',
    );
    assert.throws(
      () => harness.assertSamePiChild({ piPid: 200, piSessionId: 's1' }, { piPid: 200, piSessionId: 's2' }),
      (e) => e.code === 'pi_child_changed',
    );
    // An empty session id in the "after" meta is drift, never skipped.
    assert.throws(
      () => harness.assertSamePiChild({ piPid: 200, piSessionId: 's1' }, { piPid: 200, piSessionId: '' }),
      (e) => e.code === 'pi_child_changed',
    );
  });
});

describe('smoke-runtime harness: sanitized diagnostics', () => {
  test('sanitizeDiagnostic strips absolute paths and bounds length', () => {
    const raw = 'ERR boom at C:\\Users\\someone\\secret\\project\\config.json with token=abcdef123456 ' + 'x'.repeat(5000);
    const clean = harness.sanitizeDiagnostic(raw, 400);
    assert.ok(clean.length <= 400);
    assert.ok(!clean.includes('C:\\Users\\someone'), 'absolute paths must be redacted');
    assert.ok(!clean.includes('abcdef123456'), 'token-like values must be redacted');
  });
});

describe('smoke-runtime harness: gracefulStopOwnHost (control channel only)', { skip: !IS_WIN }, () => {
  test('writes stop-host bound to OUR instance, waits for shutdownAt, never signals PIDs', async () => {
    const dir = mkdtempSync(join(TEST_RUNS, 'graceful-'));
    mkdirSync(dir, { recursive: true });
    const metaPath = join(dir, 'host-meta.json');
    writeFileSync(metaPath, JSON.stringify({
      instanceId: 'a'.repeat(32),
      pid: 424242, // not our pid; must never be signalled
      mode: 'host_only_real',
      shutdownAt: null,
    }), 'utf8');

    const work = harness.gracefulStopOwnHost({
      stateRoot: dir,
      instanceId: 'a'.repeat(32),
      // Small poll so the test is fast; we flip the meta after a tick.
      pollMs: 20,
      waitMs: 2000,
      afterCommand: () => {
        writeFileSync(metaPath, JSON.stringify({
          instanceId: 'a'.repeat(32),
          pid: 424242,
          mode: 'host_only_real',
          shutdownAt: T0 + 5,
        }), 'utf8');
      },
    });
    const report = await work;
    assert.equal(report.ok, true);
    const control = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8'));
    assert.equal(control.command, 'stop-host');
    assert.equal(control.instanceId, 'a'.repeat(32));
  });

  test('refuses an instance id mismatch (fail closed, no control file written)', async () => {
    const dir = mkdtempSync(join(TEST_RUNS, 'graceful2-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'host-meta.json'), JSON.stringify({
      instanceId: 'a'.repeat(32), pid: 424242, shutdownAt: null,
    }), 'utf8');
    await assert.rejects(
      () => harness.gracefulStopOwnHost({
        stateRoot: dir,
        instanceId: 'b'.repeat(32),
        pollMs: 10,
        waitMs: 100,
      }),
      (e) => e.code === 'stop_instance_mismatch',
    );
    assert.ok(!existsSync(join(dir, 'control.json')));
  });

  test('reports an explicit failure when shutdown is never confirmed (no force, no kill)', async () => {
    const dir = mkdtempSync(join(TEST_RUNS, 'graceful3-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'host-meta.json'), JSON.stringify({
      instanceId: 'c'.repeat(32), pid: 424242, shutdownAt: null,
    }), 'utf8');
    const report = await harness.gracefulStopOwnHost({
      stateRoot: dir,
      instanceId: 'c'.repeat(32),
      pollMs: 20,
      waitMs: 150,
    });
    assert.equal(report.ok, false);
    assert.equal(report.reason, 'stop_unconfirmed');
  });
});
