// Shared gate for the integration tests that need an environment where the
// bridge state root can be locked down to the invoking user ALONE.
//
// Those tests drive a real security invariant: once the ACL is applied, the
// state root must be readable by the current user and by nobody else. The
// invariant holds in an ordinary desktop session, but not in a session whose
// user is a member of BUILTIN\Administrators, which is what a hosted Windows
// runner is. There, Windows keeps an explicit Administrators ACE on a freshly
// created directory even after the icacls lock-down succeeds, so the check
// below reports the state root as unsafe and refuses it.
//
// The probe deliberately reads raw icacls output instead of importing src/,
// so that a bug in the code under test can never turn into a silent skip:
// only the environment can cause one.
//
// false -> the invariant is expressible here and the tests run.
// string -> the tests skip, and the string is the reason printed in the log.
//
// The run-value is `false`, deliberately not `null`: Node's test runner
// skips a test for ANY `skip` value that is not exactly `false` (including
// `null` and `undefined`), so a `null` run-value would silently skip every
// test this gate was meant to protect while the suite still reads green.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function currentUserSid() {
  const script = '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value';
  const options = { encoding: 'utf8' };
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options).trim();
}

function probeUserOnlyAcl() {
  if (process.platform !== 'win32') return 'this host is not win32';

  const directory = mkdtempSync(join(tmpdir(), 'pi-bridge-acl-probe-'));
  try {
    const sid = currentUserSid();
    execFileSync('icacls', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { encoding: 'utf8' });
    const reported = execFileSync('icacls', [directory], { encoding: 'utf8' });
    const present = [...new Set(reported.match(/S-1-[0-9-]+/g) ?? [])];
    const unexpected = present.filter((entry) => entry !== sid);
    const namedAdministrators = /BUILTIN\\Administrators/i.test(reported);
    if (unexpected.length > 0 || namedAdministrators) {
      const kept = unexpected.length > 0 ? unexpected.join(', ') : 'BUILTIN\\Administrators';
      return `this session cannot hold a user-only ACL: icacls kept ${kept}`;
    }
    return false;
  } catch (error) {
    const detail = String(error?.message ?? error).split('\n')[0];
    return `this session cannot apply a user-only ACL: ${detail}`;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export const userOnlyAclSkipReason = probeUserOnlyAcl();
