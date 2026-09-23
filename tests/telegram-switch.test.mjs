import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Contract for the on-demand phone connection switch.
//
// Every assertion here is STATIC (source text and structural position) on
// purpose. This suite must never call Enable-ScheduledTask,
// Disable-ScheduledTask, Start-ScheduledTask or Unregister-ScheduledTask:
// a test that really flipped the owner's task would cut a live phone
// connection and change what happens at the next sign-in. The repository's
// existing broker suite follows the same rule.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SWITCH_SCRIPT = join(ROOT, 'scripts', 'telegram.ps1');
const LAUNCHER = join(ROOT, 'telegram.cmd');
const COMMON = join(ROOT, 'scripts', 'broker-service-common.ps1');

// Read as text and normalise line endings: the repo is checked out with CRLF
// under core.autocrlf=true on Windows, while every assertion below anchors on
// LF-separated source lines.
const COMMON_SOURCE = readFileSync(COMMON, 'utf8').replaceAll('\r\n', '\n');
const SWITCH_SOURCE = readFileSync(SWITCH_SCRIPT, 'utf8').replaceAll('\r\n', '\n');
const LAUNCHER_SOURCE = readFileSync(LAUNCHER, 'utf8').replaceAll('\r\n', '\n');

// Slices one `function Name {` block up to its closing brace at column 0.
function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name} {`);
  assert.ok(start >= 0, `missing function ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `unterminated function ${name}`);
  return source.slice(start, end);
}

describe('on-demand connection switch', () => {
  test('the switch is a launcher plus a script, both shipped', () => {
    assert.ok(existsSync(SWITCH_SCRIPT), 'scripts/telegram.ps1 must exist');
    assert.ok(existsSync(LAUNCHER), 'telegram.cmd must exist in the repository root');
  });

  test('the switch exposes exactly on, off and status', () => {
    assert.match(SWITCH_SOURCE, /\[ValidateSet\('on',\s*'off',\s*'status'\)\]/,
      'the action parameter must be a closed set of on/off/status');
  });

  test('the switch script never touches task scheduling cmdlets directly', () => {
    // All task mutation stays in the shared lifecycle helpers, so the
    // switch cannot drift from install/start/stop semantics.
    for (const forbidden of [
      'Enable-ScheduledTask',
      'Disable-ScheduledTask',
      'Start-ScheduledTask',
      'Register-ScheduledTask',
      'Unregister-ScheduledTask',
    ]) {
      assert.ok(!SWITCH_SOURCE.includes(forbidden),
        `scripts/telegram.ps1 must delegate instead of calling ${forbidden}`);
    }
    assert.match(SWITCH_SOURCE, /Start-BrokerServiceTask/, 'on must reuse the shared start helper');
    assert.match(SWITCH_SOURCE, /Stop-BrokerServiceTask/, 'off must reuse the shared stop helper');
  });

  test('on refuses to enable the task when credentials are missing', () => {
    const credentialsCheck = SWITCH_SOURCE.indexOf('Test-BrokerCredentialsPresent');
    const startHelper = SWITCH_SOURCE.indexOf('Start-BrokerServiceTask');
    assert.ok(credentialsCheck >= 0,
      'on must verify credentials before enabling: a logon would otherwise enter a start-crash-restart loop');
    assert.ok(startHelper > credentialsCheck,
      'the credentials gate must run before the task is enabled and started');
    assert.match(SWITCH_SOURCE, /SETUP_REQUIRED/,
      'a missing credential must degrade to the SETUP_REQUIRED message, never to a start attempt');
  });

  test('on reuses a live broker instead of starting a second one', () => {
    assert.match(SWITCH_SOURCE, /Get-BrokerLiveMeta/, 'on must read the live broker meta first');
    assert.match(SWITCH_SOURCE, /Test-BrokerHeartbeatFresh/, 'a live broker with a fresh heartbeat is reused');
  });

  test('off disables the task only after the graceful stop was confirmed', () => {
    const block = sliceFunction(COMMON_SOURCE, 'Stop-BrokerServiceTask');
    const stopControl = block.indexOf('Write-BrokerStopControl');
    const wait = block.indexOf('Wait-');
    const disable = block.indexOf('Disable-ScheduledTask');
    assert.ok(stopControl >= 0, 'the stop helper must request the instance-bound graceful stop');
    assert.ok(disable > stopControl,
      'the task must not be disabled before the graceful stop was requested');
    assert.ok(wait > stopControl && wait < disable,
      'the disable must follow a bounded wait for shutdownAt, not a blind disable');
    assert.ok(!block.includes('Stop-Process'),
      'the stop helper must never force-kill a process');
  });

  test('the root launcher delegates and holds no scheduling logic', () => {
    assert.match(LAUNCHER_SOURCE, /scripts\\telegram\.ps1|scripts\/telegram\.ps1/,
      'the launcher must delegate to the PowerShell switch');
    assert.match(LAUNCHER_SOURCE, /%(\*|1)/,
      'the launcher must forward its argument to the switch');
    for (const forbidden of [
      'schtasks',
      'Start-Process',
      'New-Service',
      'Register-ScheduledTask',
      'Unregister-ScheduledTask',
    ]) {
      assert.ok(!LAUNCHER_SOURCE.includes(forbidden),
        `the launcher must not carry scheduling machinery: found ${forbidden}`);
    }
  });
});
