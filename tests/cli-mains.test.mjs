// T04: CLI entrypoint coverage. The demo host main is exercised through
// the exact same code path scripts/smoke-windows.ps1 uses (no real pi,
// no credentials, no network). The control CLI is exercised for both the
// status surface and the command writer.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { Writable } from 'node:stream';

import { runHostMain } from '../src/runtime-host.mjs';
import { main as controlMain } from '../src/bridge-control.mjs';
import { main as enrollMain } from '../src/enroll.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

function captureIo() {
  const stdout = [];
  const stderr = [];
  const io = {
    stdin: new PassThrough(),
    stdout: new Writable({
      write(chunk, _enc, cb) { stdout.push(String(chunk)); cb(); },
    }),
    stderr: new Writable({
      write(chunk, _enc, cb) { stderr.push(String(chunk)); cb(); },
    }),
  };
  return { io, stdout, stderr };
}

function smokeStateDir() {
  const dir = mkdtempSync(join(TEST_RUNS, 'cli-'));
  const config = {
    version: 1,
    instanceId: 'c'.repeat(32),
    pi: { cliPath: 'unused-in-demo', workspace: dir },
    bridge: { followupsEnabled: false },
  };
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify(config));
  return dir;
}

describe('runtime-host CLI (demo lifecycle)', () => {
  test('host-only demo completes and records the result, exit 0', async () => {
    const dir = smokeStateDir();
    const code = await runHostMain(['--state-dir', dir, '--config', join(dir, 'runtime.json'), '--demo']);
    assert.equal(code, 0);
    const meta = JSON.parse(readFileSync(join(dir, 'host-meta.json'), 'utf8'));
    assert.equal(meta.lastDemoResult, 'completed');
    assert.equal(meta.mode, 'host_demo');
    assert.equal(meta.shutdownAt != null, true);
  });

  test('bad usage exits 1 with a fixed code', async () => {
    const { io } = captureIo();
    const code = await runHostMain([], io);
    assert.equal(code, 1);
  });
});

describe('bridge-control CLI', () => {
  test('status --json reports not_initialized without meta and never invents data', async () => {
    const dir = smokeStateDir();
    const { io, stdout } = captureIo();
    const code = await controlMain(['status', '--state-dir', dir, '--json'], io);
    assert.equal(code, 0);
    const status = JSON.parse(stdout.join(''));
    assert.equal(status.ok, true);
    assert.equal(status.state, 'not_initialized');
  });

  test('control writes the typed command file bound to the instance id', async () => {
    const dir = smokeStateDir();
    const { io, stdout } = captureIo();
    const code = await controlMain(
      ['control', '--command', 'stop-host', '--state-dir', dir, '--instance', 'c'.repeat(32)],
      io,
    );
    assert.equal(code, 0);
    assert.ok(stdout.join('').startsWith('OK control:stop-host'));
    const control = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8'));
    assert.equal(control.command, 'stop-host');
    assert.equal(control.instanceId, 'c'.repeat(32));
    assert.equal(existsSync(join(dir, 'control.json')), true);
  });

  test('unknown commands fail with a fixed code and never write the file', async () => {
    const dir = smokeStateDir();
    const { io } = captureIo();
    const code = await controlMain(
      ['control', '--command', 'wipe', '--state-dir', dir, '--instance', 'c'.repeat(32)],
      io,
    );
    assert.equal(code, 3);
    assert.equal(existsSync(join(dir, 'control.json')), false);
  });
});

describe('enroll CLI (offline paths only)', () => {
  test('bad usage fails closed without touching the network', async () => {
    const { io } = captureIo();
    const code = await enrollMain(['frobnicate'], io);
    assert.equal(code, 1);
  });

  test('empty stdin token fails closed', async () => {
    const { io } = captureIo();
    const done = enrollMain(['check-bot'], io);
    io.stdin.end('');
    const code = await done;
    assert.equal(code, 1);
  });

  test('pair-start with a malformed nonce fails closed before the network', async () => {
    for (const nonce of [undefined, 'pair feed-face', 'A'.repeat(32), 'a'.repeat(31)]) {
      const { io, stdout } = captureIo();
      const argv = nonce === undefined
        ? ['pair-start']
        : ['pair-start', '--nonce', nonce];
      const done = enrollMain(argv, io);
      io.stdin.end('123456789:TEST_synthetic_token_AAAAAAAAAAAAAAAAAAAAA');
      const code = await done;
      assert.equal(code, 1, `nonce ${JSON.stringify(nonce)} must be refused`);
      assert.equal(stdout.join(''), 'ERR:bad_usage\n');
    }
  });

  test('pair-start with a bad duration-ms fails closed', async () => {
    const { io, stdout } = captureIo();
    const done = enrollMain(
      ['pair-start', '--nonce', '0123456789abcdef0123456789abcdef', '--duration-ms', 'nope'],
      io,
    );
    io.stdin.end('123456789:TEST_synthetic_token_AAAAAAAAAAAAAAAAAAAAA');
    const code = await done;
    assert.equal(code, 1);
    assert.equal(stdout.join(''), 'ERR:bad_usage\n');
  });

  test('pair-start with an empty stdin token fails closed', async () => {
    const { io, stdout } = captureIo();
    const done = enrollMain(
      ['pair-start', '--nonce', '0123456789abcdef0123456789abcdef'],
      io,
    );
    io.stdin.end('');
    const code = await done;
    assert.equal(code, 1);
    assert.equal(stdout.join(''), 'ERR:unauthorized\n');
  });
});
