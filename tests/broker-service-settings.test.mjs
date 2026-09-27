import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMMON = join(ROOT, 'scripts', 'broker-service-common.ps1');
const INSTALLER = join(ROOT, 'scripts', 'install-broker-service.ps1');
// Normalise once so multi-line literal searches work on CRLF checkouts too.
const COMMON_SOURCE = readFileSync(COMMON, 'utf8').replaceAll('\r\n', '\n');
const INSTALLER_SOURCE = readFileSync(INSTALLER, 'utf8').replaceAll('\r\n', '\n');
const IS_WIN = process.platform === 'win32';
// Task action fragment added to every inline XML fixture: the verifier must
// require the wscript.exe hidden-launcher action, so the fixtures must carry
// one for the accept case to stay meaningful. The shape mirrors what Task
// Scheduler actually persists: <Exec> is a CONTAINER with <Command> inside,
// and Windows uppercases the SystemRoot segment (C:\WINDOWS\System32).
const TASK_ACTIONS_FRAGMENT = '<Actions Context="Author"><Exec>'
  + '<Command>C:\\WINDOWS\\System32\\wscript.exe</Command>'
  + '<Arguments>"C:\\proj\\.local\\broker-launch.vbs"</Arguments>'
  + '<WorkingDirectory>C:\\proj</WorkingDirectory>'
  + '</Exec></Actions>';

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

  test('trigger builder installs a plain logon trigger with no repetition', () => {
    const start = COMMON_SOURCE.indexOf('function New-BrokerServiceTaskTrigger {');
    const end = COMMON_SOURCE.indexOf('\n}\n', start);
    assert.ok(start >= 0 && end > start);
    const builder = COMMON_SOURCE.slice(start, end);
    assert.match(builder, /New-ScheduledTaskTrigger -AtLogOn -User \$UserIdentity/,
      'the trigger must be a plain logon trigger for the given user');
    assert.doesNotMatch(builder, /Repetition|RepetitionInterval|-Once/,
      'the builder must install no repetition: the broker is strictly on-demand');
  });

  test('Windows PowerShell 5.1 builds the plain logon trigger with no repetition', { skip: !IS_WIN }, () => {
    const command = [
      `. ${quotePs(COMMON)}`,
      "$t = New-BrokerServiceTaskTrigger -UserIdentity 'BROKERTESTUSER'",
      '  $rep = $t.Repetition',
      '  $interval = ""',
      '  if ($null -ne $rep) { $p = $rep.PSObject.Properties[\'Interval\']; if ($null -ne $p) { $interval = "$($p.Value)" } }',
      '[PSCustomObject]@{',
      '  triggerType = $t.CimClass.CimClassName',
      '  repetitionInterval = $interval',
      '} | ConvertTo-Json -Compress',
    ].join('\r\n');
    const trigger = JSON.parse(ps(command));
    assert.equal(trigger.triggerType, 'MSFT_TaskLogonTrigger');
    assert.doesNotMatch(trigger.repetitionInterval, /PT\d/,
      'the constructed trigger must carry no repetition interval');
  });

  test('generated VBS Run call waits on the broker so the task state stays truthful', () => {
    assert.match(COMMON_SOURCE, /'CreateObject\("WScript\.Shell"\)\.Run "\{0\}", 0, True'/,
      'the launcher Run call must use window style 0 AND bWaitOnReturn True');
    assert.doesNotMatch(COMMON_SOURCE, /, 0, False'/,
      'the launcher must never run the broker without waiting');
  });

  test('registered XML verifier accepts the safe shape and rejects idle-stop regression', { skip: !IS_WIN }, () => {
    // The accept fixture is the strict on-demand shape: a PLAIN logon
    // trigger with no repetition anywhere in the document.
    const plainLogonTrigger = '<Triggers><LogonTrigger></LogonTrigger></Triggers>';
    const good = '<Task><Settings>'
      + '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'
      + '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'
      + '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'
      + '<StartWhenAvailable>true</StartWhenAvailable>'
      + '<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd></IdleSettings>'
      + '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'
      + '<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>'
      + '</Settings>'
      + plainLogonTrigger
      + TASK_ACTIONS_FRAGMENT
      + '</Task>';
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

  test('registered XML verifier rejects a repetition anywhere in the persisted XML', { skip: !IS_WIN }, () => {
    // The broker is strictly on-demand: ANY <Repetition> in the persisted
    // XML would re-fire the task on a schedule, so the verifier must fail
    // closed wherever the element appears - inside the logon trigger or
    // anywhere else in the document.
    const base = '<Task><Settings>'
      + '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'
      + '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'
      + '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'
      + '<StartWhenAvailable>true</StartWhenAvailable>'
      + '<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd></IdleSettings>'
      + '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'
      + '<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>'
      + '</Settings>';
    const repetition = '<Repetition><Interval>PT5M</Interval><StopAtDurationEnd>true</StopAtDurationEnd></Repetition>';
    const command = [
      `. ${quotePs(COMMON)}`,
      `$base = ${quotePs(base)}`,
      `$repetition = ${quotePs(repetition)}`,
      `$inTrigger = $base + "<Triggers><LogonTrigger>" + $repetition + "</LogonTrigger></Triggers>" + ${quotePs(TASK_ACTIONS_FRAGMENT)}`,
      `$outside = $base + $repetition + "<Triggers><LogonTrigger></LogonTrigger></Triggers>" + ${quotePs(TASK_ACTIONS_FRAGMENT)}`,
      'foreach ($xml in @($inTrigger, $outside)) {',
      '  $rejected = $false',
      '  try { Assert-BrokerServiceTaskXml -TaskXml $xml | Out-Null } catch { $rejected = $true }',
      '  if (-not $rejected) { throw "persisted repetition was accepted" }',
      '}',
      'Write-Output "OK"',
    ].join('; ');
    assert.equal(ps(command), 'OK');
  });

  test('registered XML verifier rejects a direct node.exe action (hidden launcher required)', { skip: !IS_WIN }, () => {
    // The task action must be the hidden wscript.exe launcher, never a
    // console node.exe whose window can kill the broker on close: mutating
    // the action command to node.exe must fail the persisted-XML check.
    const good = '<Task><Settings>'
      + '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'
      + '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>'
      + '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'
      + '<StartWhenAvailable>true</StartWhenAvailable>'
      + '<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd></IdleSettings>'
      + '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'
      + '<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>'
      + '</Settings>'
      + '<Triggers><LogonTrigger></LogonTrigger></Triggers>'
      + TASK_ACTIONS_FRAGMENT
      + '</Task>';
    const command = [
      `. ${quotePs(COMMON)}`,
      `$good = ${quotePs(good)}`,
      'Assert-BrokerServiceTaskXml -TaskXml $good | Out-Null',
      '$directNode = $good.Replace("wscript.exe", "node.exe")',
      '$rejected = $false',
      'try { Assert-BrokerServiceTaskXml -TaskXml $directNode | Out-Null } catch { $rejected = $true }',
      'if (-not $rejected) { throw "direct node.exe action was accepted" }',
      'Write-Output "OK"',
    ].join('; ');
    assert.equal(ps(command), 'OK');
  });

  test('installer builds its task action through the single-source hidden-launcher helper', () => {
    assert.match(INSTALLER_SOURCE,
      /\$action = New-BrokerServiceTaskAction -NodeExe \$nodeExe -BrokerScript \$brokerScript -StateRoot \$stateRoot/,
      'the installer must build its task action through New-BrokerServiceTaskAction');
    assert.ok(!INSTALLER_SOURCE.includes('New-ScheduledTaskAction -Execute $nodeExe'),
      'the installer must not build the action directly from node.exe: only the hidden-launcher helper may');
  });

  test('Windows PowerShell 5.1 builds the wscript hidden-launcher action and a credential-free generated VBS', { skip: !IS_WIN }, () => {
    // In-process function test: no task is registered and nothing outside the
    // temp dir is touched. Get-BridgeModuleRoot is re-pointed at the temp dir
    // so the generated launcher lands in <tmp>\.local instead of the module.
    const tmp = mkdtempSync(join(tmpdir(), 'broker-launcher-'));
    try {
      const localDir = join(tmp, '.local');
      mkdirSync(localDir, { recursive: true });
      const nodeExe = join(tmp, 'fake', 'node.exe');
      const brokerScript = join(tmp, 'fake', 'src', 'runtime-broker.mjs');
      const stateRoot = join(tmp, 'state');
      const command = [
        `. ${quotePs(COMMON)}`,
        `function Get-BridgeModuleRoot { return ${quotePs(tmp)} }`,
        `$nodeExe = ${quotePs(nodeExe)}`,
        `$brokerScript = ${quotePs(brokerScript)}`,
        `$stateRoot = ${quotePs(stateRoot)}`,
        '$action = New-BrokerServiceTaskAction -NodeExe $nodeExe -BrokerScript $brokerScript -StateRoot $stateRoot',
        '$launcherPath = Join-Path (Get-BridgeModuleRoot) \'.local\\broker-launch.vbs\'',
        '$vbs = [System.IO.File]::ReadAllText($launcherPath)',
        '[PSCustomObject]@{',
        '  execute = $action.Execute',
        '  arguments = $action.Arguments',
        '  workingDirectory = $action.WorkingDirectory',
        '  vbs = $vbs',
        '} | ConvertTo-Json -Compress',
      ].join('\r\n');
      const result = JSON.parse(ps(command));
      assert.ok(result.execute.endsWith('wscript.exe'),
        `action must execute wscript.exe, got: ${result.execute}`);
      assert.ok(result.arguments.includes('"') && result.arguments.includes('broker-launch.vbs'),
        `arguments must contain the quoted launcher path, got: ${result.arguments}`);
      assert.equal(result.workingDirectory, tmp);
      assert.match(result.vbs, /^' Pi Telegram Bridge - hidden broker launcher \(generated; do not edit\)\./);
      assert.ok(result.vbs.includes(', 0, True'), 'the Run call must use window style 0 AND wait, so the task state stays truthful and IgnoreNew prevents a duplicate instance');
      assert.ok(result.vbs.includes(`""${nodeExe}""`),
        'the node invocation must carry doubled quotes inside the VBS string literal');
      assert.ok(result.vbs.includes(`--state-dir ""${stateRoot}""`),
        'the state dir must carry doubled quotes inside the VBS string literal');
      assert.ok(!/token|secret/i.test(result.vbs), 'the generated launcher must be credential-free by construction');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('installer reads back and verifies the task after registration', () => {
    const register = INSTALLER_SOURCE.indexOf('Register-ScheduledTask');
    const exportTask = INSTALLER_SOURCE.indexOf('Export-ScheduledTask', register);
    const assertTask = INSTALLER_SOURCE.indexOf('Assert-BrokerServiceTaskXml', exportTask);
    assert.match(INSTALLER_SOURCE, /\$settings = New-BrokerServiceTaskSettings/);
    assert.match(INSTALLER_SOURCE, /\$trigger = New-BrokerServiceTaskTrigger -UserIdentity \$identityName/,
      'the installer must build its trigger through the single-source helper');
    assert.ok(register >= 0 && exportTask > register && assertTask > exportTask,
      'registration must be followed by XML readback and fail-closed verification');
  });

  test('installer disables the freshly registered task as a top-level statement and starts it only from an indented statement inside the -Start block', () => {
    // Text-level proof: this check matches installer source text and does not
    // execute PowerShell. In this installer top-level statements sit at
    // column 0 and the -Start block body is indented, so the line-anchored
    // matches below prove the disable is unconditional (a conditional wrap
    // would indent it) and that the single start call is an indented
    // statement inside the block guarded by the -Start switch.
    assert.match(INSTALLER_SOURCE, /\[switch\]\$Start/,
      'the installer must declare the explicit -Start switch');
    assert.match(INSTALLER_SOURCE, /^Disable-ScheduledTask -TaskName \$taskName \| Out-Null$/m,
      'Disable-ScheduledTask must be a column-0 top-level statement: wrapping it in a conditional would indent it');
    const disable = INSTALLER_SOURCE.indexOf('Disable-ScheduledTask -TaskName $taskName');
    const startBranch = INSTALLER_SOURCE.indexOf('if ($Start) {');
    assert.ok(startBranch >= 0 && disable < startBranch,
      'the disable must precede the -Start guard');
    assert.match(INSTALLER_SOURCE,
      /^if \(\$Start\) \{[ \t]*\n(?:[^\n]*\n){0,20}?[ \t]+Start-BrokerServiceTask -TaskName \$taskName/m,
      'Start-BrokerServiceTask must be an indented statement inside the block guarded by if ($Start)');
    assert.equal((INSTALLER_SOURCE.match(/Start-BrokerServiceTask/g) ?? []).length, 1,
      'Start-BrokerServiceTask must be called exactly once, inside the -Start block');
  });

  test('installer disables the task before the XML readback, so a failed readback cannot leave the task enabled', () => {
    // Text-level proof: Disable-ScheduledTask must precede both
    // Export-ScheduledTask and Assert-BrokerServiceTaskXml. The task is
    // registered ENABLED, so if the disable came after the readback, a
    // throw inside the readback (empty XML, failed settings pattern) would
    // abort the installer under $ErrorActionPreference = 'Stop' before the
    // disable ever ran, leaving the task enabled at every sign-in.
    const disable = INSTALLER_SOURCE.indexOf('Disable-ScheduledTask -TaskName $taskName');
    const exportTask = INSTALLER_SOURCE.indexOf('Export-ScheduledTask');
    const assertTask = INSTALLER_SOURCE.indexOf('Assert-BrokerServiceTaskXml');
    assert.ok(disable >= 0, 'Disable-ScheduledTask must be present');
    assert.ok(disable < exportTask,
      'the disable must run before the XML readback (Export-ScheduledTask)');
    assert.ok(disable < assertTask,
      'the disable must run before the fail-closed verification (Assert-BrokerServiceTaskXml)');
  });

  test('installer never enables or starts the task by itself: no Enable-/Start-ScheduledTask anywhere and the single Start-BrokerServiceTask call sits positionally inside the if ($Start) block', () => {
    // Text-level proof. The Beginner plan runs this installer WITHOUT -Start,
    // so the disable-then-maybe-start design only holds if the helper
    // Start-BrokerServiceTask (which enables AND starts) is reachable from
    // inside the if ($Start) block alone. A direct Enable-ScheduledTask or
    // Start-ScheduledTask call anywhere in the file would reintroduce a
    // logon-enabled task after the Beginner path, so both cmdlet names are
    // banned in any casing or quoting style (a quoted or differently cased
    // invocation still contains the cmdlet name verbatim). Residual a
    // text-level ban cannot close: a cmdlet name assembled at runtime (for
    // example & ('Enable-' + 'ScheduledTask')) never contains the banned
    // substring in the source text.
    const lowered = INSTALLER_SOURCE.toLowerCase();
    assert.ok(!lowered.includes('enable-scheduledtask'),
      'the installer must never call Enable-ScheduledTask: it would re-enable the task the Beginner path must leave off');
    assert.ok(!lowered.includes('start-scheduledtask'),
      'the installer must never call Start-ScheduledTask directly: only Start-BrokerServiceTask inside the -Start guard may start the task');
    // The same evasion through an external tool: appending e.g.
    // `schtasks.exe /Change /TN $taskName /ENABLE` (or /Run) re-enables or
    // starts the task while every cmdlet ban above still passes. The
    // external tool name is banned in any casing; the ScheduledTasks module
    // is the only supported route to enable, run or start the task in this
    // file.
    assert.ok(!lowered.includes('schtasks'),
      'the installer must never invoke schtasks in any casing: the ScheduledTasks module is the only supported route to enable or start the task there');
    const callMatches = [...INSTALLER_SOURCE.matchAll(/Start-BrokerServiceTask/g)];
    assert.equal(callMatches.length, 1,
      'Start-BrokerServiceTask must appear exactly once in the installer');
    const callIndex = callMatches[0].index;
    const blockStart = INSTALLER_SOURCE.indexOf('if ($Start) {');
    assert.ok(blockStart >= 0 && callIndex > blockStart,
      'the Start-BrokerServiceTask call must sit after the if ($Start) line');
    // Positional containment: the first column-0 '}' after the guard opens is
    // the end of that block (the block body is indented), so the call must sit
    // before it, not merely somewhere after the guard line.
    const blockEnd = blockStart + INSTALLER_SOURCE.slice(blockStart).search(/^}/m);
    assert.ok(blockEnd > callIndex,
      'the Start-BrokerServiceTask call must sit inside the if ($Start) block, before its closing brace');
  });
});
