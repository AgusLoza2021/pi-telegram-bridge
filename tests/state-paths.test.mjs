// T04: state path confinement tests.
//
// The bridge state root must stay confined under the module's .local
// directory. Path resolution rejects escapes (`..`, absolute targets, drive
// changes) and any symlink/junction reparse point in the chain (a junction
// is the classic Windows escape hatch).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { StatePathError, resolveStatePath, ensureStateRoot } from '../src/state-paths.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'bridge-t04-paths-'));
}

describe('resolveStatePath: confinement', () => {
  test('resolves a normal relative path under the root', () => {
    const root = tempRoot();
    const resolved = resolveStatePath({ root, relative: 'state/bridge.sqlite' });
    assert.ok(resolved.startsWith(root));
    assert.ok(resolved.endsWith(join('state', 'bridge.sqlite')));
  });

  test('rejects .. escapes', () => {
    const root = tempRoot();
    assert.throws(
      () => resolveStatePath({ root, relative: '../outside' }),
      (e) => e instanceof StatePathError && e.code === 'path_escape',
    );
  });

  test('rejects absolute targets', () => {
    const root = tempRoot();
    assert.throws(
      () => resolveStatePath({ root, relative: join(tmpdir(), 'elsewhere') }),
      (e) => e instanceof StatePathError && e.code === 'path_escape',
    );
  });

  test('rejects drive-absolute Windows paths', () => {
    const root = tempRoot();
    assert.throws(
      () => resolveStatePath({ root, relative: 'C:\\Windows\\evil' }),
      (e) => e instanceof StatePathError && e.code === 'path_escape',
    );
  });

  test('rejects empty and NUL-bearing paths', () => {
    const root = tempRoot();
    assert.throws(
      () => resolveStatePath({ root, relative: '' }),
      (e) => e instanceof StatePathError,
    );
    assert.throws(
      () => resolveStatePath({ root, relative: 'state\0/x' }),
      (e) => e instanceof StatePathError && e.code === 'bad_path',
    );
  });
});

describe('resolveStatePath: reparse points', () => {
  test('rejects a symlinked intermediate directory (real junction on win32)', { skip: process.platform !== 'win32' }, () => {
    const root = tempRoot();
    const outside = mkdtempSync(join(tmpdir(), 'bridge-t04-outside-'));
    mkdirSync(join(root, 'state'), { recursive: true });
    symlinkSync(outside, join(root, 'state', 'link'), 'junction');
    assert.throws(
      () => resolveStatePath({ root, relative: 'state/link/blob' }),
      (e) => e instanceof StatePathError && e.code === 'reparse_escape',
    );
  });

  test('rejects a symlinked final component', { skip: process.platform !== 'win32' }, () => {
    const root = tempRoot();
    const outsideFile = join(mkdtempSync(join(tmpdir(), 'bridge-t04-outside-')), 'f.txt');
    mkdirSync(join(root, 'state'), { recursive: true });
    symlinkSync(outsideFile, join(root, 'state', 'blob'), 'file');
    assert.throws(
      () => resolveStatePath({ root, relative: 'state/blob' }),
      (e) => e instanceof StatePathError && e.code === 'reparse_escape',
    );
  });

  test('accepts plain directories created under the root', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'state'), { recursive: true });
    const resolved = resolveStatePath({ root, relative: 'state/sub/file' });
    assert.ok(resolved.startsWith(root));
  });
});

describe('ensureStateRoot', () => {
  test('creates the root and is idempotent', () => {
    const root = join(tempRoot(), 'nested', 'state-root');
    ensureStateRoot(root);
    assert.ok(existsSync(root));
    ensureStateRoot(root);
  });

  test('refuses to create a root whose parent chain contains a reparse point', { skip: process.platform !== 'win32' }, () => {
    const base = tempRoot();
    const outside = mkdtempSync(join(tmpdir(), 'bridge-t04-outside-'));
    symlinkSync(outside, join(base, 'jump'), 'junction');
    assert.throws(
      () => ensureStateRoot(join(base, 'jump', 'deeper')),
      (e) => e instanceof StatePathError && e.code === 'reparse_escape',
    );
  });
});
