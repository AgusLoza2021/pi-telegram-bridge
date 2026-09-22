import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMMON = join(ROOT, 'scripts', 'broker-service-common.ps1');
const INSTALLER = join(ROOT, 'scripts', 'install-broker-service.ps1');
const COMMON_SOURCE = readFileSync(COMMON, 'utf8');
const INSTALLER_SOURCE = readFileSync(INSTALLER, 'utf8');
const IS_WIN = process.platform === 'win32';

function ps(command) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`PowerShell failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function quotePs(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

describe('broker service task settings', () => {
  test('production builder explicitly prevents ten-minute idle termination and bounds restart', () => {
    const start = COMMON_SOURCE.indexOf('function New-BrokerServiceTaskSettings {');
    const end = COMMON_SOURCE.indexOf('\n}\n', start);
    assert.ok(start >= 0 && end > start);
    const builder = COMMON_SOURCE.slice(start, end);
    for (const required of [
      '-AllowStartIfOnBatteries',
      '-DontStopIfGoingOnBatteries',
      '-DontStopOnIdleEnd',
      '-ExecutionTimeLimit ([TimeSpan]::Zero)',
      '-MultipleInstances IgnoreNew',
      '-StartWhenAvailable',
      '-RestartCount 3',
      '-RestartInterval (New-TimeSpan -Minutes 1)',
    ]) {
      assert.ok(builder.includes(required), `missing task setting: ${required}`);
    }
    assert.doesNotMatch(builder, /-RunOnlyIfIdle|-RestartOnIdle/);
  });

  test('Windows PowerShell 5.1 constructs the intended settings object without registering a task', { skip: !IS_WIN }, () => {
    const command = [
      `. ${quotePs(COMMON)}`,
      '$s = New-BrokerServiceTaskSettings',
      '[PSCustomObject]@{',
      '  stopOnIdleEnd = $s.IdleSettings.StopOnIdleEnd',
      '  executionTimeLimit = "$($s.ExecutionTimeLimit)"',
      '  multipleInstances = "$($s.MultipleInstances)"',
      '  restartCount = $s.RestartCount',
      '  restartInterval = "$($s.RestartInterval)"',
      '  disallowStartOnBatteries = $s.DisallowStartIfOnBatteries',
      '  stopOnBatteries = $s.StopIfGoingOnBatteries',
      '  startWhenAvailable = $s.StartWhenAvailable',
      '} | ConvertTo-Json -Compress',
    ].join('\r\n');
    const settings = JSON.parse(ps(command));
    assert.equal(settings.stopOnIdleEnd, false);
    assert.match(settings.executionTimeLimit, /^(00:00:00|PT0S)$/);
    assert.equal(settings.multipleInstances, 'IgnoreNew');
    assert.equal(settings.restartCount, 3);
    assert.match(settings.restartInterval, /^(00:01:00|PT1M)$/);
    assert.equal(settings.disallowStartOnBatteries, false);
    assert.equal(settings.stopOnBatteries, false);
    assert.equal(settings.startWhenAvailable, true);
  });

  test('registered XML verifier accepts the safe shape and rejects idle-stop regression', { skip: !IS_WIN }, () => {
    const good = '<Task><Settings>'
      + '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'
      + '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'
      + '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'
      + '<StartWhenAvailable>true</StartWhenAvailable>'
      + '<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd></IdleSettings>'
      + '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'
      + '<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>'
      + '</Settings></Task>';
    const command = [
      `. ${quotePs(COMMON)}`,
      `$good = ${quotePs(good)}`,
      'Assert-BrokerServiceTaskXml -TaskXml $good | Out-Null',
      '$bad = $good.Replace("<StopOnIdleEnd>false</StopOnIdleEnd>", "<StopOnIdleEnd>true</StopOnIdleEnd>")',
      '$rejected = $false',
      'try { Assert-BrokerServiceTaskXml -TaskXml $bad | Out-Null } catch { $rejected = $true }',
      'if (-not $rejected) { throw "idle-stop regression was accepted" }',
      'Write-Output "OK"',
    ].join('; ');
    assert.equal(ps(command), 'OK');
  });

  test('installer reads back and verifies the task after registration', () => {
    const register = INSTALLER_SOURCE.indexOf('Register-ScheduledTask');
    const exportTask = INSTALLER_SOURCE.indexOf('Export-ScheduledTask', register);
    const assertTask = INSTALLER_SOURCE.indexOf('Assert-BrokerServiceTaskXml', exportTask);
    assert.match(INSTALLER_SOURCE, /\$settings = New-BrokerServiceTaskSettings/);
    assert.ok(register >= 0 && exportTask > register && assertTask > exportTask,
      'registration must be followed by XML readback and fail-closed verification');
  });
});
