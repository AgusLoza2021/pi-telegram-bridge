// T04: bridge-control CLI — the read-only status surface and the local
// control writer used by start/stop/status.ps1. Status must be safe
// without credentials and must never expose Telegram ids, tokens or chat
// identities.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store.mjs';
import {
  ControlError,
  readRuntimeStatus,
  writeControlCommand,
} from '../src/bridge-control.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const T0 = 1_700_000_000_000;
const INSTANCE = 'd'.repeat(32);

function setup({ withMeta = true } = {}) {
  const root = mkdtempSync(join(TEST_RUNS, 'ctrl-'));
  const stateRoot = join(root, 'state');
  mkdirSync(stateRoot, { recursive: true });
  const store = new Store(join(stateRoot, 'bridge.sqlite'), {
    now: () => T0,
    isProcessAlive: (pid) => pid === 999,
  });
  const metaPath = join(stateRoot, 'host-meta.json');
  if (withMeta) {
    writeFileSync(metaPath, JSON.stringify({
      instanceId: INSTANCE,
      pid: 999,
      hostGeneration: 3,
      sessionId: 'main',
      piSessionId: 'pi-main',
      piSessionFile: join(root, 'sessions', 'fake.jsonl'),
      piPid: 42424,
      startedAt: T0 - 1000,
      heartbeatAt: T0,
      mode: 'production',
      workerDesired: true,
      workerPid: 30001,
      lastDemoResult: null,
      shutdownAt: null,
    }));
  }
  return { root, stateRoot, store, metaPath };
}

describe('readRuntimeStatus', () => {
  test('reports liveness, heartbeat and request states', () => {
    const ctx = setup();
    const status = readRuntimeStatus({
      store: ctx.store,
      metaPath: ctx.metaPath,
      isProcessAlive: (pid) => pid === 999 || pid === 42424 || pid === 30001,
      now: () => T0 + 1000,
    });
    assert.equal(status.ok, true);
    assert.equal(status.hostLive, true);
    assert.equal(status.workerLive, true);
    assert.equal(status.piLive, true);
    assert.equal(status.heartbeatFresh, true);
    assert.equal(status.instanceIdMatch, true);
    assert.equal(status.state, 'running');
    // No Telegram identities anywhere in the status document.
    const json = JSON.stringify(status);
    assert.ok(!json.includes('allowedUserId'));
    assert.ok(!json.includes('allowedChatId'));
    assert.ok(!json.includes('botToken'));
  });

  test('stale heartbeat and dead processes are reported, never guessed', () => {
    const ctx = setup();
    const status = readRuntimeStatus({
      store: ctx.store,
      metaPath: ctx.metaPath,
      isProcessAlive: () => false,
      now: () => T0 + 60_000,
    });
    assert.equal(status.hostLive, false);
    assert.equal(status.workerLive, false);
    assert.equal(status.piLive, false);
    assert.equal(status.heartbeatFresh, false);
  });

  test('missing meta yields not_initialized with a fixed shape (no throw)', () => {
    const ctx = setup({ withMeta: false });
    const status = readRuntimeStatus({
      store: ctx.store,
      metaPath: ctx.metaPath,
      isProcessAlive: () => false,
      now: () => T0,
    });
    assert.equal(status.ok, true);
    assert.equal(status.state, 'not_initialized');
    assert.equal(status.hostLive, false);
  });

  test('missing instanceId match is flagged (same-owner spoof detection)', () => {
    const ctx = setup();
    const status = readRuntimeStatus({
      store: ctx.store,
      metaPath: ctx.metaPath,
      expectedInstanceId: 'e'.repeat(32),
      isProcessAlive: () => true,
      now: () => T0,
    });
    assert.equal(status.instanceIdMatch, false);
  });
});

describe('writeControlCommand', () => {
  test('writes a typed command bound to the instance id', () => {
    const ctx = setup();
    const result = writeControlCommand({
      stateRoot: ctx.stateRoot,
      instanceId: INSTANCE,
      command: 'stop-host',
      now: () => T0,
    });
    assert.equal(result.ok, true);
    const control = JSON.parse(readFileSync(join(ctx.stateRoot, 'control.json'), 'utf8'));
    assert.equal(control.instanceId, INSTANCE);
    assert.equal(control.command, 'stop-host');
    assert.ok(typeof control.issuedAt === 'number');
  });

  test('unknown commands fail with a fixed code', () => {
    const ctx = setup();
    assert.throws(
      () => writeControlCommand({ stateRoot: ctx.stateRoot, instanceId: INSTANCE, command: 'format-c:' }),
      (e) => e instanceof ControlError && e.code === 'bad_command',
    );
    assert.equal(existsSync(join(ctx.stateRoot, 'control.json')), false);
  });
});
