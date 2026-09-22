// T04r: state-root ACL + capability contract.
//
// The DPAPI credential blob may only live inside a state root that was
// explicitly locked down (Windows ACL restricted to the current user,
// inheritance removed) by the setup/locking step, and that carries the
// root capability marker. The credential store verifies the capability
// before any protect/reveal, so the standalone Node CLI cannot bypass
// the ACL discipline by being invoked directly.
//
// The capability document is the shared contract between the PowerShell
// layer (scripts/common.ps1 Lock-BridgeStateRoot) and this module: same
// kind, same fields. Neither side accepts the other's sloppiness.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:process';
import { homedir } from 'node:os';

export const STATE_ROOT_CAPABILITY_KIND = 'pi-telegram-bridge-state-root-capability';
const CAPABILITY_FILE = 'root.capability.json';
const SID_PATTERN = /^S-1-\d{1,10}(?:-\d{1,10})+$/;

export class StateAclError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'StateAclError';
    this.code = code;
  }
}

function timestampName(now) {
  const t = typeof now === 'function' ? now() : Date.now();
  return new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function assertRealDirectory(stateRoot) {
  if (typeof stateRoot !== 'string' || stateRoot.length === 0) {
    throw new StateAclError('bad_state_root');
  }
  let stats;
  try {
    stats = lstatSync(stateRoot);
  } catch {
    throw new StateAclError('bad_state_root');
  }
  if (!stats.isDirectory()) throw new StateAclError('bad_state_root');
}

function capabilityPath(stateRoot) {
  return join(stateRoot, CAPABILITY_FILE);
}

function validateCapabilityDocument(document) {
  if (document === null || typeof document !== 'object') return false;
  if (document.version !== 1) return false;
  if (document.kind !== STATE_ROOT_CAPABILITY_KIND) return false;
  if (document.acl !== 'user-only') return false;
  if (typeof document.sid !== 'string' || !SID_PATTERN.test(document.sid)) return false;
  if (typeof document.createdAt !== 'string' || document.createdAt.length === 0) return false;
  return true;
}

/**
 * Write the root capability marker. Call ONLY after the real ACL lock
 * succeeded (the PowerShell locking helper does exactly that).
 */
export function writeStateRootCapability({ stateRoot, sid, now } = {}) {
  assertRealDirectory(stateRoot);
  if (typeof sid !== 'string' || !SID_PATTERN.test(sid)) {
    throw new StateAclError('bad_capability_sid');
  }
  const document = {
    version: 1,
    kind: STATE_ROOT_CAPABILITY_KIND,
    acl: 'user-only',
    sid,
    createdAt: new Date(typeof now === 'function' ? now() : Date.now()).toISOString(),
  };
  const path = capabilityPath(stateRoot);
  const tmp = `${path}.tmp-${timestampName(now)}-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(document, null, 2), 'utf8');
  renameSync(tmp, path);
  return { ok: true, path };
}

/** Verify the capability marker; never throws for absent/invalid data. */
export function verifyStateRootCapability({ stateRoot } = {}) {
  try {
    assertRealDirectory(stateRoot);
  } catch {
    return { ok: false, code: 'missing_capability' };
  }
  let raw;
  try {
    raw = readFileSync(capabilityPath(stateRoot), 'utf8');
  } catch {
    return { ok: false, code: 'missing_capability' };
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'bad_capability' };
  }
  if (!validateCapabilityDocument(document)) {
    return { ok: false, code: 'bad_capability' };
  }
  return { ok: true, sid: document.sid };
}

/**
 * The credential-store gate: the blob's directory must BE a validated
 * state root, and the caller must BE the user it was locked for. The
 * capability marker alone is NEVER trusted. Before any credential byte
 * is protected or revealed this gate, in order:
 *   1. validates the capability marker (kind, shape, sid); the blob path
 *      must stay inside that root;
 *   2. requires the CURRENT Windows SID to equal the marker SID — an
 *      operation under another account (or a stolen root) is refused;
 *   3. freshly re-verifies the REAL directory ACL, read-only. This gate
 *      never applies or repairs an ACL; setup/locking did that earlier.
 * Unsupported platforms, unresolvable identities and unverifiable ACLs
 * fail closed with fixed codes only: no SID, path or child-process
 * output is ever printed. The live check functions are injectable as an
 * internal TEST seam only — production callers (CLI included) always
 * use the real defaults, so there is no CLI bypass.
 */
export async function requireStateRootForBlob({
  blobPath,
  getCurrentSid = getCurrentUserSidWindows,
  verifyAcl = verifyUserOnlyAclWindows,
} = {}) {
  if (typeof blobPath !== 'string' || blobPath.length === 0) {
    throw new StateAclError('unvalidated_root');
  }
  const stateRoot = resolve(dirname(blobPath));
  const check = verifyStateRootCapability({ stateRoot });
  if (!check.ok) {
    throw new StateAclError('unvalidated_root');
  }
  const normalizedBlob = resolve(blobPath);
  if (!normalizedBlob.startsWith(stateRoot + (platform === 'win32' ? '\\' : '/'))) {
    throw new StateAclError('unvalidated_root');
  }
  let currentSid;
  try {
    currentSid = await getCurrentSid();
  } catch (error) {
    if (error instanceof StateAclError) throw error;
    throw new StateAclError('sid_unavailable');
  }
  if (currentSid !== check.sid) {
    throw new StateAclError('sid_mismatch');
  }
  let acl;
  try {
    acl = await verifyAcl({ dir: stateRoot, sid: currentSid });
  } catch (error) {
    if (error instanceof StateAclError) throw error;
    throw new StateAclError('acl_verify_failed');
  }
  if (!acl.ok) {
    throw new StateAclError(acl.code ?? 'acl_verify_failed');
  }
  return { ok: true, stateRoot, sid: currentSid };
}

// ---------------------------------------------------------------------------
// Windows ACL enforcement (real icacls/PowerShell, no stubs).
// ---------------------------------------------------------------------------

function assertNotReparsePoint(path) {
  // A symlink or junction answers readlink; ordinary directories do not.
  try {
    readlinkSync(path);
    throw new StateAclError('reparse_point');
  } catch (error) {
    if (error instanceof StateAclError) throw error;
    // ENOENT / EINVAL / UNKNOWN: not a reparse point (or not there yet).
  }
}

/**
 * Walk every existing ancestor of `dir` (and `dir` itself, when present)
 * and refuse if ANY of them is a reparse point. This catches junction
 * roots planted inside .local as well as symlinked parents.
 */
export function assertNoReparseAncestors(dir) {
  const current = resolve(dir);
  const root = (platform === 'win32')
    ? current.slice(0, 3) // e.g. "C:\"
    : '/';
  let probe = current;
  while (probe.length > root.length) {
    if (existsSync(probe)) assertNotReparsePoint(probe);
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
}

async function runCapture(file, args) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return promisify(execFile)(file, args, { windowsHide: true });
}

/** Resolve the current interactive user's SID through .NET (PowerShell). */
export async function getCurrentUserSidWindows() {
  if (platform !== 'win32') throw new StateAclError('unsupported_platform');
  const { stdout } = await runCapture('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  ]);
  const sid = stdout.trim();
  if (!SID_PATTERN.test(sid)) throw new StateAclError('bad_capability_sid');
  return sid;
}

/**
 * Enforce a user-only ACL on `dir` (real icacls, checked exit code):
 * inheritance removed, exactly one grant for the given SID, propagated
 * to children. The ACL is verified through PowerShell's Get-Acl with
 * SID translation before returning.
 */
export async function applyUserOnlyAclWindows({ dir, sid, now } = {}) {
  if (platform !== 'win32') throw new StateAclError('unsupported_platform');
  if (typeof dir !== 'string' || dir.length === 0) throw new StateAclError('bad_state_root');
  const effectiveSid = typeof sid === 'string' && SID_PATTERN.test(sid)
    ? sid
    : await getCurrentUserSidWindows();

  assertNoReparseAncestors(dir);

  const already = lstatSync(dir, { throwIfNoEntry: false });
  if (!already) {
    mkdirSync(dir, { recursive: true });
  } else if (!already.isDirectory()) {
    throw new StateAclError('bad_state_root');
  }
  assertNotReparsePoint(dir);

  const grant = await runCapture('icacls', [dir, '/inheritance:r', '/grant:r', `*${effectiveSid}:(OI)(CI)F`]);
  if (grant.stderr && grant.stderr.trim().length > 0) {
    throw new StateAclError('icacls_failed');
  }
  const check = await verifyUserOnlyAclWindows({ dir, sid: effectiveSid });
  if (!check.ok) throw new StateAclError(check.code ?? 'acl_verify_failed');
  return { ok: true, sid: effectiveSid, now: typeof now === 'function' ? now() : undefined };
}

/**
 * Verify (read-only) that `dir` carries the user-only ACL: inheritance
 * disabled, no inherited entries, and the only identity is `sid` when
 * given. Uses Get-Acl + SID translation so account-name display cannot
 * fool the check.
 */
export async function verifyUserOnlyAclWindows({ dir, sid } = {}) {
  if (platform !== 'win32') throw new StateAclError('unsupported_platform');
  const script = [
    `$a = Get-Acl -LiteralPath '${String(dir).replace(/'/g, "''")}'`,
    '$protected = $a.AreAccessRulesProtected',
    '$sids = @($a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value })',
    "Write-Output (\"PROTECTED=\" + $protected)",
    "Write-Output (\"COUNT=\" + $sids.Count)",
    "Write-Output (\"SIDS=\" + ($sids -join ','))",
  ].join('; ');
  const { stdout } = await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const lines = Object.fromEntries(stdout.trim().split(/\r?\n/).map((line) => {
    const eq = line.indexOf('=');
    return [line.slice(0, eq), line.slice(eq + 1)];
  }));
  if (lines.PROTECTED !== 'True') return { ok: false, code: 'acl_inheritance_enabled' };
  const sids = (lines.SIDS ?? '').split(',').filter((entry) => entry.length > 0);
  if (Number(lines.COUNT) !== sids.length || sids.length !== 1) {
    return { ok: false, code: 'acl_unexpected_identities' };
  }
  if (typeof sid === 'string' && sids[0] !== sid) {
    return { ok: false, code: 'acl_unexpected_identities' };
  }
  return { ok: true, sid: sids[0] };
}

// Home-dir convenience for callers that confine under the user profile.
export function defaultStateRootBase() {
  return homedir();
}
