// T04: runtime ops config loader (nonsecret). The ops config carries the
// pi discovery results, the instance identity and the followups flag that
// MUST be validated identically on worker and host.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RuntimeConfigError, loadRuntimeConfig } from '../src/runtime-config.mjs';

const VALID = {
  version: 1,
  instanceId: 'a'.repeat(32),
  pi: { cliPath: 'C:\\Program Files\\nodejs\\node.exe', workspace: 'C:/repo' },
  bridge: { followupsEnabled: false },
};

function tempConfig(overrides = {}, drop = []) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-t04-cfg-'));
  const path = join(root, 'runtime.json');
  const value = { ...VALID, ...overrides };
  for (const key of drop) delete value[key];
  if (overrides !== null) writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('runtime config loader', () => {
  test('accepts a valid config and normalizes types', () => {
    const config = loadRuntimeConfig(tempConfig());
    assert.equal(config.version, 1);
    assert.equal(config.instanceId, 'a'.repeat(32));
    assert.equal(config.bridge.followupsEnabled, false);
    assert.equal(config.pi.cliPath, 'C:\\Program Files\\nodejs\\node.exe');
  });

  test('missing file fails with a fixed code', () => {
    assert.throws(
      () => loadRuntimeConfig(join(tmpdir(), `bridge-t04-none-${Date.now()}`, 'x.json')),
      (e) => e instanceof RuntimeConfigError && e.code === 'no_config',
    );
  });

  test('invalid JSON fails with a fixed code and never echoes content', () => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-t04-cfg-'));
    const path = join(root, 'runtime.json');
    writeFileSync(path, '{oops');
    assert.throws(() => loadRuntimeConfig(path), (e) => e instanceof RuntimeConfigError && e.code === 'bad_config');
  });

  test('unknown keys, wrong types and bad identity fail closed', () => {
    assert.throws(() => loadRuntimeConfig(tempConfig({ surprise: 1 })), (e) => e.code === 'bad_config');
    assert.throws(() => loadRuntimeConfig(tempConfig({ instanceId: 'short' })), (e) => e.code === 'bad_config');
    assert.throws(
      () => loadRuntimeConfig(tempConfig({ bridge: { followupsEnabled: 'yes' } })),
      (e) => e.code === 'bad_config',
    );
    assert.throws(() => loadRuntimeConfig(tempConfig({}, ['pi'])), (e) => e.code === 'bad_config');
  });
});
