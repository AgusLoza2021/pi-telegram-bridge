// T04r: state-root ACL + capability contract.
//
// The DPAPI credential blob may only ever be written into a state root
// that (a) was locked down to the current user via a real Windows ACL and
// (b) carries the root capability marker written by the setup/locking
// step. The standalone Node credential CLI must refuse to operate on a
// root without that validated capability (no direct CLI bypass).
//
// The Windows ACL tests exercise icacls/PowerShell FOR REAL (no stubs)
// and are skipped on non-win32 platforms.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:process';
import { userOnlyAclSkipReason } from './privileged.mjs';

import {
  writeStateRootCapability,
  verifyStateRootCapability,
  requireStateRootForBlob,
  applyUserOnlyAclWindows,
  verifyUserOnlyAclWindows,
  STATE_ROOT_CAPABILITY_KIND,
} from '../src/state-acl.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });
const IS_WIN = platform === 'win32';
const FAKE_SID = 'S-1-5-21-3623811015-3361044348-30300820-1013';

describe('state-acl: root capability (portable)', () => {
  test('write + verify round-trips the capability document', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'acl-'));
    const result = writeStateRootCapability({ stateRoot: root, sid: FAKE_SID });
    assert.equal(result.ok, true);
    const check = verifyStateRootCapability({ stateRoot: root });
    assert.equal(check.ok, true);
    assert.equal(check.sid, FAKE_SID);
  });

  test('a missing or malformed capability is refused', () => {
    const root = mkdtempSync(join(TEST_RUNS, 'acl-'));
    const missing = verifyStateRootCapability({ stateRoot: root });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'missing_capability');
    writeFileSync(join(root, 'root.capability.json'), JSON.stringify({ version: 1, kind: 'something-else' }));
    const bad = verifyStateRootCapability({ stateRoot: root });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'bad_capability');
  });

  test('requireStateRootForBlob refuses a blob outside an unvalidated root', async () => {
    const root = mkdtempSync(join(TEST_RUNS, 'acl-'));
    await assert.rejects(
      () => requireStateRootForBlob({ blobPath: join(root, 'credentials.bin'), ...LIVE_STUBS }),
      (error) => error.code === 'unvalidated_root',
    );
    writeStateRootCapability({ stateRoot: root, sid: FAKE_SID });
    // Does not throw now (the live identity/ACL checks are stubbed so this
    // describe stays portable; the REAL live gate is exercised on win32).
    await requireStateRootForBlob({ blobPath: join(root, 'credentials.bin'), ...LIVE_STUBS });
  });

  test('the blob path must stay inside the validated root', async () => {
    const root = mkdtempSync(join(TEST_RUNS, 'acl-'));
    writeStateRootCapability({ stateRoot: root, sid: FAKE_SID });
    await assert.rejects(
      () => requireStateRootForBlob({ blobPath: join(root, '..', 'escape.bin'), ...LIVE_STUBS }),
      (error) => error.code === 'unvalidated_root',
    );
  });

  test('the live gate refuses a marker whose SID is not the CURRENT user (fail closed)', async () => {
    const root = mkdtempSync(join(TEST_RUNS, 'acl-'));
    writeStateRootCapability({ stateRoot: root, sid: FAKE_SID });
    await assert.rejects(
      () => requireStateRootForBlob({
        blobPath: join(root, 'credentials.bin'),
        getCurrentSid: async () => 'S-1-5-21-3623811015-3361044348-30300820-9999',
        verifyAcl: async () => ({ ok: true, sid: 'S-1-5-21-3623811015-3361044348-30300820-9999' }),
      }),
      (error) => error.code === 'sid_mismatch',
    );
  });

  test('the live gate refuses when the fresh ACL verification fails (marker alone is never trusted)', async () => {
    const root = mkdtempSync(join(TEST_RUNS, 'acl-'));
    writeStateRootCapability({ stateRoot: root, sid: FAKE_SID });
    await assert.rejects(
      () => requireStateRootForBlob({
        blobPath: join(root, 'credentials.bin'),
        getCurrentSid: async () => FAKE_SID,
        verifyAcl: async () => ({ ok: false, code: 'acl_inheritance_enabled' }),
      }),
      (error) => error.code === 'acl_inheritance_enabled',
    );
  });

  test('the live gate fails closed when the current SID cannot be established', async () => {
    const root = mkdtempSync(join(TEST_RUNS, 'acl-'));
    writeStateRootCapability({ stateRoot: root, sid: FAKE_SID });
    await assert.rejects(
      () => requireStateRootForBlob({
        blobPath: join(root, 'credentials.bin'),
        getCurrentSid: async () => {
          throw new Error('synthetic resolver failure');
        },
        verifyAcl: async () => ({ ok: true, sid: FAKE_SID }),
      }),
      (error) => error.code === 'sid_unavailable',
    );
  });
});

// Internal test seam: the portable describe above stubs the live Windows
// checks; production callers (CLI included) always use the real defaults.
const LIVE_STUBS = {
  getCurrentSid: async () => FAKE_SID,
  verifyAcl: async () => ({ ok: true, sid: FAKE_SID }),
};

describe('state-acl: real Windows ACL (win32 only)', () => {
  let realSid = null;

  before(async function () {
    if (!IS_WIN) this.skip();
    // A hosted runner session cannot hold a user-only state root at all:
    // skip with the environment reason instead of failing the invariant.
    if (userOnlyAclSkipReason) this.skip(userOnlyAclSkipReason);
    // Resolve the CURRENT user's SID the same way the scripts do.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ]);
    realSid = stdout.trim();
    assert.match(realSid, /^S-1-/);
  });

  test('applyUserOnlyAclWindows enforces a real user-only ACL and verification passes', async () => {
    if (!IS_WIN) return;
    const root = mkdtempSync(join(TEST_RUNS, 'aclwin-'));
    const dir = join(root, 'state');
    mkdirSync(dir);
    const applied = await applyUserOnlyAclWindows({ dir, sid: realSid });
    assert.equal(applied.ok, true);
    const check = await verifyUserOnlyAclWindows({ dir, sid: realSid });
    assert.equal(check.ok, true, `verification failed: ${check.code ?? ''}`);
  });

  test('a reparse/junction root is refused WITHOUT touching the target ACL', async () => {
    if (!IS_WIN) return;
    const root = mkdtempSync(join(TEST_RUNS, 'acllink-'));
    const target = join(root, 'target');
    mkdirSync(target);
    await applyUserOnlyAclWindows({ dir: target, sid: realSid });
    const aclBefore = await snapshotAcl(target);
    const link = join(root, 'link');
    symlinkSync(target, link, 'junction');
    await assert.rejects(
      () => applyUserOnlyAclWindows({ dir: link, sid: realSid }),
      (error) => error.code === 'reparse_ancestor' || error.code === 'reparse_point',
    );
    const aclAfter = await snapshotAcl(target);
    assert.equal(aclAfter, aclBefore, 'the junction target ACL must be untouched');
  });

  test('the credential store refuses a root whose ACL was locked but capability is missing', async () => {
    if (!IS_WIN) return;
    const root = mkdtempSync(join(TEST_RUNS, 'aclcap-'));
    const dir = join(root, 'state');
    mkdirSync(dir);
    await applyUserOnlyAclWindows({ dir, sid: realSid });
    const { createCredentialStore } = await import('../src/dpapi-credentials.mjs');
    const store = createCredentialStore({
      blobPath: join(dir, 'credentials.bin'),
      backupDir: join(dir, 'backups'),
    });
    await assert.rejects(
      () => store.protect({ botToken: '111: synthetic', allowedUserId: '1', allowedChatId: '1' }),
      (error) => error.code === 'unvalidated_root',
    );
    assert.ok(!existsSync(join(dir, 'credentials.bin')), 'no blob may appear in an unvalidated root');
    await assert.rejects(() => store.reveal(), (error) => error.code === 'unvalidated_root');
  });
});

describe('state-acl: live identity + fresh ACL gate before credentials (win32 only)', () => {
  let realSid = null;

  before(async function () {
    if (!IS_WIN) this.skip();
    // Same environment gate as the real-ACL suite above: the live gate
    // demands a state root locked down to the invoking user alone.
    if (userOnlyAclSkipReason) this.skip(userOnlyAclSkipReason);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ]);
    realSid = stdout.trim();
    assert.match(realSid, /^S-1-/);
  });

  test('a marker naming the real SID plus a REAL user-only ACL passes the live gate', async () => {
    if (!IS_WIN) return;
    const root = mkdtempSync(join(TEST_RUNS, 'acllive-'));
    await applyUserOnlyAclWindows({ dir: root, sid: realSid });
    writeStateRootCapability({ stateRoot: root, sid: realSid });
    const check = await requireStateRootForBlob({ blobPath: join(root, 'credentials.bin') });
    assert.equal(check.ok, true);
  });

  test('a valid marker with a WRONG SID is refused before any credential operation', async () => {
    if (!IS_WIN) return;
    const root = mkdtempSync(join(TEST_RUNS, 'aclsid-'));
    await applyUserOnlyAclWindows({ dir: root, sid: realSid });
    // The marker is well-formed and the ACL matches the real user, but it
    // names a different SID: the live gate must refuse on identity alone.
    writeStateRootCapability({ stateRoot: root, sid: FAKE_SID });
    await assert.rejects(
      () => requireStateRootForBlob({ blobPath: join(root, 'credentials.bin') }),
      (error) => error.code === 'sid_mismatch',
    );
  });

  test('a reopened inherited ACL is refused even with a fully valid marker', async () => {
    if (!IS_WIN) return;
    const root = mkdtempSync(join(TEST_RUNS, 'aclinherit-'));
    await applyUserOnlyAclWindows({ dir: root, sid: realSid });
    writeStateRootCapability({ stateRoot: root, sid: realSid });
    // Simulate the ACL being reopened AFTER locking: inheritance enabled.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('icacls', [root, '/inheritance:e']);
    await assert.rejects(
      () => requireStateRootForBlob({ blobPath: join(root, 'credentials.bin') }),
      (error) => error.code === 'acl_inheritance_enabled',
    );
  });
});

describe('state-acl: privileged probe run-value contract', () => {
  test('userOnlyAclSkipReason is exactly false or a non-empty reason, never null/undefined', () => {
    // Node's test runner skips a test for ANY `skip` value that is not
    // exactly `false` — including `null` and `undefined`. The probe's
    // run-value therefore must be `false`, or every call site passing it
    // straight into `skip:` would silently skip the very tests it exists
    // to protect while the suite still reads green.
    const value = userOnlyAclSkipReason;
    const ok = value === false
      || (typeof value === 'string' && value.length > 0);
    assert.ok(
      ok,
      `userOnlyAclSkipReason must be exactly false or a non-empty string, got ${JSON.stringify(value) ?? String(value)}: any non-false value makes the test runner skip the guarded tests`,
    );
  });
});

async function snapshotAcl(dir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run('icacls', [dir]);
  return stdout;
}

after(() => {
  // No cleanup of prior artifacts: test dirs stay under .local/test-runs.
  void rmSync;
});
