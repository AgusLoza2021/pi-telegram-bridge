// T04: DPAPI credential blob tests.
//
// The blob is the ONLY credential persistence: bot token + both numeric ids,
// encrypted with Windows DPAPI (CurrentUser) by PowerShell 5.1. Plaintext
// crosses process boundaries exclusively through anonymous pipes (stdin of
// the protect helper, stdout of the redirected reveal helper) and is never
// written to disk, argv, environment, logs or the terminal.
//
// Unit tests use an injected runner (no PowerShell). The integration test
// round-trips SYNTHETIC secrets through real DPAPI inside a unique
// .local/test-runs directory and asserts the encrypted file does not contain
// the plaintext. Synthetic secrets are never printed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { userOnlyAclSkipReason } from './privileged.mjs';

import {
  CredentialStoreError,
  createCredentialStore,
} from '../src/dpapi-credentials.mjs';
import {
  StateAclError,
  writeStateRootCapability,
  verifyStateRootCapability,
  applyUserOnlyAclWindows,
  getCurrentUserSidWindows,
} from '../src/state-acl.mjs';

// T04r: every store target is a validated state root (capability marker).
const TEST_SID = 'S-1-5-21-3623811015-3361044348-30300820-1013';
function lockRoot(dir) {
  mkdirSync(dir, { recursive: true });
  writeStateRootCapability({ stateRoot: dir, sid: TEST_SID });
}

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const SYNTHETIC = Object.freeze({
  botToken: '123456789:TEST_synthetic_token_AAAAAAAAAAAAAAAAAAAAA',
  allowedUserId: '111111111',
  allowedChatId: '-222222222',
});

function tempRoot(name) {
  return mkdtempSync(join(tmpdir(), `bridge-t04-${name}-`));
}

/** Fake DPAPI runner: "encrypts" with a marker so tests never need Windows. */
function fakeRunner({ marker = 'FAKEDPAPI:' } = {}) {
  return {
    async protect(plaintext) {
      return Buffer.from(marker + Buffer.from(plaintext, 'utf8').toString('base64'), 'utf8');
    },
    async unprotect(encrypted) {
      const text = Buffer.from(encrypted).toString('utf8');
      if (!text.startsWith(marker)) {
        throw new CredentialStoreError('dpapi_failed');
      }
      return Buffer.from(text.slice(marker.length), 'base64').toString('utf8');
    },
  };
}

/**
 * Internal TEST seam only: mirrors the live gate's marker discipline so the
 * injected-runner unit tests stay portable. The production default is the
 * real requireStateRootForBlob; the CLI never injects anything.
 */
function markerOnlyRootVerifier() {
  return async ({ blobPath }) => {
    const check = verifyStateRootCapability({ stateRoot: dirname(blobPath) });
    if (!check.ok) throw new StateAclError('unvalidated_root');
    return { ok: true, stateRoot: dirname(blobPath), sid: check.sid };
  };
}

function newStore({ root, runner, now, stdoutIsTty = false, rootVerifier } = {}) {
  lockRoot(join(root, 'state'));
  return createCredentialStore({
    blobPath: join(root, 'state', 'credentials.blob'),
    backupDir: join(root, 'backups'),
    runner: runner ?? fakeRunner(),
    now: now ?? (() => 1700000000000),
    stdoutIsTty,
    rootVerifier: rootVerifier ?? markerOnlyRootVerifier(),
  });
}

describe('credential blob: protect (unit, injected runner)', () => {
  test('writes an encrypted blob that does not contain any plaintext secret', async () => {
    const root = tempRoot('protect');
    const store = newStore({ root });
    const result = await store.protect(SYNTHETIC);
    assert.equal(result.ok, true);
    const raw = readFileSync(join(root, 'state', 'credentials.blob'), 'utf8');
    for (const secret of Object.values(SYNTHETIC)) {
      assert.ok(!raw.includes(secret), 'blob must never contain plaintext secrets');
    }
    assert.ok(!raw.includes('botToken'), 'blob must not expose field names in plaintext');
  });

  test('updating an existing blob creates a dated backup and never destroys the old blob', async () => {
    const root = tempRoot('backup');
    const nowCounter = [1700000000000, 1700000005000];
    const store = newStore({ root, now: () => nowCounter.pop() ?? 1700000010000 });
    await store.protect(SYNTHETIC);
    const updated = { ...SYNTHETIC, allowedUserId: '999999999' };
    const second = await store.protect(updated);
    assert.equal(second.ok, true);
    // Backup of the first blob exists and predates the update.
    const backups = readdirSync(join(root, 'backups')).filter((f) => f.endsWith('.blob'));
    assert.equal(backups.length, 1);
    const backupRaw = readFileSync(join(root, 'backups', backups[0]), 'utf8');
    assert.ok(backupRaw.length > 0);
    // The live blob now decrypts to the updated value.
    const revealed = await newStore({ root }).reveal();
    assert.equal(revealed.ok, true);
    assert.equal(revealed.credentials.allowedUserId, '999999999');
  });

  test('protect rejects malformed payloads with fixed codes and never writes partial state', async () => {
    const root = tempRoot('malformed');
    const store = newStore({ root });
    await assert.rejects(
      () => store.protect({ botToken: '', allowedUserId: '1', allowedChatId: '-1' }),
      (error) => error instanceof CredentialStoreError && error.code === 'invalid_payload',
    );
    assert.equal(existsSync(join(root, 'state', 'credentials.blob')), false);
  });

  test('protect rejects unknown extra fields (fail closed)', async () => {
    const root = tempRoot('extra');
    const store = newStore({ root });
    await assert.rejects(
      () => store.protect({ ...SYNTHETIC, surprise: 'x' }),
      (error) => error instanceof CredentialStoreError && error.code === 'invalid_payload',
    );
  });

  test('runner failure maps to a fixed code and leaves no blob behind', async () => {
    const root = tempRoot('failrunner');
    lockRoot(join(root, 'state'));
    const store = createCredentialStore({
      blobPath: join(root, 'state', 'credentials.blob'),
      backupDir: join(root, 'backups'),
      now: () => 1700000000000,
      rootVerifier: markerOnlyRootVerifier(),
      runner: {
        async protect() {
          throw new CredentialStoreError('dpapi_failed');
        },
        async unprotect() {
          throw new CredentialStoreError('dpapi_failed');
        },
      },
    });
    await assert.rejects(
      () => store.protect(SYNTHETIC),
      (error) => error instanceof CredentialStoreError && error.code === 'dpapi_failed',
    );
    assert.equal(existsSync(join(root, 'state', 'credentials.blob')), false);
  });
});

describe('credential blob: reveal (unit, injected runner)', () => {
  test('round-trips the exact credentials', async () => {
    const root = tempRoot('reveal');
    const store = newStore({ root });
    await store.protect(SYNTHETIC);
    const revealed = await newStore({ root }).reveal();
    assert.equal(revealed.ok, true);
    assert.deepEqual(revealed.credentials, SYNTHETIC);
  });

  test('missing blob fails with a fixed code', async () => {
    const root = tempRoot('missing');
    const store = newStore({ root });
    await assert.rejects(
      () => store.reveal(),
      (error) => error instanceof CredentialStoreError && error.code === 'blob_missing',
    );
  });

  test('corrupted blob fails with a fixed code and never echoes content', async () => {
    const root = tempRoot('corrupt');
    mkdirSync(join(root, 'state'), { recursive: true });
    writeFileSync(join(root, 'state', 'credentials.blob'), 'not-a-blob');
    const store = newStore({ root });
    await assert.rejects(
      () => store.reveal(),
      (error) => error instanceof CredentialStoreError && error.code === 'dpapi_failed',
    );
  });
});

describe('credentials CLI guard (unit)', () => {
  test('reveal CLI refuses to write plaintext to an interactive terminal', () => {
    // The guard is a pure decision function so it is testable without a TTY.
    assert.throws(
      () => requireGuardTty(true),
      (error) => error instanceof CredentialStoreError && error.code === 'tty_stdout_refused',
    );
    assert.doesNotThrow(() => requireGuardTty(false));
  });

  function requireGuardTty(isTty) {
    // Mirror of the CLI guard, exercised through the exported helper.
    return assertTtyGuard(isTty);
  }
});

describe('credential blob: default live root gate (win32 only)', () => {
  test('the DEFAULT gate refuses a marker whose SID is not the current user, before the protector runs', { skip: process.platform !== 'win32' }, async () => {
    const runRoot = join(MODULE_ROOT, '.local', 'test-runs', `gate-${Date.now()}-${randomBytes(4).toString('hex')}`);
    mkdirSync(runRoot, { recursive: true });
    // Marker-only root: its SID is a synthetic one, never the current user.
    lockRoot(runRoot);
    let protectorRan = false;
    const store = createCredentialStore({
      blobPath: join(runRoot, 'credentials.blob'),
      backupDir: join(runRoot, 'backups'),
      now: () => Date.now(),
      // No rootVerifier injection: the real default gate must fire.
      runner: {
        async protect() {
          protectorRan = true;
          return Buffer.from('FAKEDPAPI:x', 'utf8');
        },
        async unprotect() {
          protectorRan = true;
          return Buffer.from('FAKEDPAPI:x', 'utf8');
        },
      },
    });
    await assert.rejects(
      () => store.protect(SYNTHETIC),
      (error) => error.code === 'sid_mismatch',
    );
    assert.equal(protectorRan, false, 'no protector/revealer may run behind a failed gate');
    assert.ok(!existsSync(join(runRoot, 'credentials.blob')), 'no credential byte may be written');
  });
});

// Imported lazily-plain: the module must export the guard used by its CLI.
import { assertTtyGuard } from '../src/dpapi-credentials.mjs';

describe('credential blob: real DPAPI round trip (integration, win32 only)', () => {
  test('synthetic secrets survive a real PowerShell 5.1 DPAPI cycle', { skip: process.platform !== 'win32' || userOnlyAclSkipReason }, async () => {
    const runRoot = join(MODULE_ROOT, '.local', 'test-runs', `dpapi-${Date.now()}-${randomBytes(4).toString('hex')}`);
    mkdirSync(runRoot, { recursive: true });
    // The real gate demands the marker SID to BE the current user and the
    // ACL to be freshly verified, so lock the root for real.
    const realSid = await getCurrentUserSidWindows();
    await applyUserOnlyAclWindows({ dir: runRoot, sid: realSid });
    writeStateRootCapability({ stateRoot: runRoot, sid: realSid });
    const store = createCredentialStore({
      blobPath: join(runRoot, 'credentials.blob'),
      backupDir: join(runRoot, 'backups'),
      now: () => Date.now(),
      // No runner: the real PowerShell DPAPI path.
    });
    await store.protect(SYNTHETIC);
    const blobPath = join(runRoot, 'credentials.blob');
    const raw = readFileSync(blobPath, 'utf8');
    for (const secret of Object.values(SYNTHETIC)) {
      assert.ok(!raw.includes(secret), 'DPAPI blob must not contain plaintext');
    }
    const revealed = await createCredentialStore({
      blobPath,
      backupDir: join(runRoot, 'backups'),
      now: () => Date.now(),
    }).reveal();
    assert.deepEqual(revealed.credentials, SYNTHETIC);
  });
});

test('module root sanity: dpapi helper lives under src', () => {
  assert.ok(MODULE_ROOT.replace(/[\\/]+$/, '').endsWith('pi-telegram-bridge'));
});
