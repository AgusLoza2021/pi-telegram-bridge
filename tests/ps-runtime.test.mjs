// T04r: real PowerShell 5.1 execution tests for the lifecycle scripts.
// Windows only (skipped elsewhere). Every test uses a UNIQUE fresh state
// directory strictly below the module .local, and the assertions are
// drawn from actual icacls/file-system state, never from script output
// alone.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:process';
import { userOnlyAclSkipReason } from './privileged.mjs';

const run = promisify(execFile);
const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCAL_ROOT = join(MODULE_ROOT, '.local');
const TEST_RUNS = join(LOCAL_ROOT, 'test-runs');
const SCRIPTS = join(MODULE_ROOT, 'scripts');
mkdirSync(TEST_RUNS, { recursive: true });
const IS_WIN = platform === 'win32';

async function powershell(file, args) {
  const { stdout, stderr } = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(SCRIPTS, file), ...args,
  ], { cwd: TEST_RUNS, timeout: 120_000 });
  return { stdout, stderr };
}

function uniqueDir(label) {
  return join(TEST_RUNS, `psrun-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
}

// A deterministic fake "pi CLI" file and workspace for discovery-only tests.
function makePiFixtures() {
  const root = uniqueDir('fixtures');
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const cli = join(root, 'cli.js');
  writeFileSync(cli, '// fixture: never executed\n', 'utf8');
  return { cli, workspace: join(root, 'workspace') };
}

async function icaclsText(dir) {
  const { stdout } = await run('icacls', [dir]);
  return stdout;
}

describe('ps-runtime: setup -PrepareOnly (real PS 5.1, unique dirs)', () => {
  before(async function () {
    if (!IS_WIN) this.skip();
  });

  // T06: selective live-TUI mode is the DEFAULT, so prepare-only writes the
  // selective shape (no pi discovery, no followups flag) and nothing else.
  test('prepare-only writes the default selective runtime shape, locks the ACL and the capability — and never touches credentials', async function () {
    // The real setup run must lock the state root down to the invoking user
    // alone, which a hosted runner session cannot hold (tests/privileged.mjs).
    if (userOnlyAclSkipReason) this.skip(userOnlyAclSkipReason);
    const stateDir = uniqueDir('prep');
    const { stdout } = await powershell('setup.ps1', [
      '-PrepareOnly', '-StateDirectory', stateDir,
    ]);
    assert.match(stdout, /PREPARE OK/);
    assert.match(stdout, /Credentials were NOT touched/, 'prepare-only must report untouched credentials');
    // Selective shape exactly: version/instanceId + bridge.mode, no pi object.
    const config = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
    assert.deepEqual(Object.keys(config).sort(), ['bridge', 'instanceId', 'version'],
      'the selective default must carry exactly version, instanceId and bridge');
    assert.equal(config.version, 1);
    assert.ok(/^[0-9a-f]{32}$/.test(config.instanceId));
    assert.deepEqual(config.bridge, { mode: 'selective' },
      'the default runtime must be the selective live-TUI shape');
    assert.ok(!('pi' in config), 'the selective default must not require a pi object');
    // Root capability written by the lock step.
    const capability = JSON.parse(readFileSync(join(stateDir, 'root.capability.json'), 'utf8'));
    assert.equal(capability.kind, 'pi-telegram-bridge-state-root-capability');
    assert.equal(capability.acl, 'user-only');
    // The ACL itself, read back through icacls: no inherited rules.
    const acl = await icaclsText(stateDir);
    assert.ok(!acl.includes('(I)'), 'inheritance must be disabled on the state root');
    assert.ok(acl.includes('(OI)(CI)(F)') || acl.includes('(OI)(CI)F'), 'exactly the user-only grant must remain');
    // No credential blob may exist after prepare-only.
    assert.ok(!existsSync(join(stateDir, 'credentials.bin')), 'prepare-only must never touch credentials');
  });

  test('prepare-only is idempotent: re-running takes a dated backup of runtime.json, keeps the instance id and the selective shape', async function () {
    if (userOnlyAclSkipReason) this.skip(userOnlyAclSkipReason);
    const stateDir = uniqueDir('prep2');
    await powershell('setup.ps1', ['-PrepareOnly', '-StateDirectory', stateDir]);
    const first = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
    await powershell('setup.ps1', ['-PrepareOnly', '-StateDirectory', stateDir]);
    const second = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
    assert.deepEqual(second.bridge, { mode: 'selective' }, 're-runs must keep the selective shape');
    assert.equal(second.version, 1);
    assert.equal(second.instanceId, first.instanceId, 'the committed instance id must be preserved on re-runs');
    const backups = existsSync(join(stateDir, 'backups'))
      ? readdirSync(join(stateDir, 'backups')).sort() : [];
    assert.ok(backups.length >= 1, 'a dated backup of the previous config must exist');
    const backup = JSON.parse(readFileSync(join(stateDir, 'backups', backups[backups.length - 1]), 'utf8'));
    assert.equal(backup.instanceId, first.instanceId, 'the backup must preserve the previous config identity');
  });

  // T06: -LegacyHeadless is the explicit fallback; the pre-T06 runtime shape
  // (pi CLI/workspace + followups flag, no mode key) must stay protected.
  test('-LegacyHeadless -PrepareOnly keeps the legacy headless runtime shape', async function () {
    if (userOnlyAclSkipReason) this.skip(userOnlyAclSkipReason);
    const stateDir = uniqueDir('prep3');
    const fixtures = makePiFixtures();
    const { stdout } = await powershell('setup.ps1', [
      '-PrepareOnly', '-LegacyHeadless', '-StateDirectory', stateDir,
      '-PiCliPath', fixtures.cli, '-PiWorkspace', fixtures.workspace,
    ]);
    assert.match(stdout, /PREPARE OK/);
    const config = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
    assert.deepEqual(Object.keys(config).sort(), ['bridge', 'instanceId', 'pi', 'version'],
      'the legacy headless shape must keep the pi section and no mode key');
    assert.equal(config.version, 1);
    assert.ok(/^[0-9a-f]{32}$/.test(config.instanceId));
    assert.equal(config.pi.cliPath, fixtures.cli);
    assert.equal(config.pi.workspace, fixtures.workspace);
    assert.deepEqual(config.bridge, { followupsEnabled: false },
      'legacy headless keeps the followups default and has no bridge.mode');
    assert.ok(!existsSync(join(stateDir, 'credentials.bin')), 'prepare-only must never touch credentials');
  });

  test('default prepare-only migrates an existing legacy runtime.json to the selective shape without losing the instance id', async function () {
    if (userOnlyAclSkipReason) this.skip(userOnlyAclSkipReason);
    const stateDir = uniqueDir('prep4');
    const fixtures = makePiFixtures();
    await powershell('setup.ps1', [
      '-PrepareOnly', '-LegacyHeadless', '-StateDirectory', stateDir,
      '-PiCliPath', fixtures.cli, '-PiWorkspace', fixtures.workspace,
    ]);
    const legacy = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
    const { stdout } = await powershell('setup.ps1', ['-PrepareOnly', '-StateDirectory', stateDir]);
    assert.match(stdout, /MIGRATION/, 'a legacy-shape rewrite must be announced on the console');
    assert.match(stdout, /PREPARE OK/);
    const migrated = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
    assert.deepEqual(migrated.bridge, { mode: 'selective' });
    assert.ok(!('pi' in migrated), 'the migrated config must drop the pi section');
    assert.equal(migrated.instanceId, legacy.instanceId, 'the instance id survives migration');
    const backups = existsSync(join(stateDir, 'backups'))
      ? readdirSync(join(stateDir, 'backups')).sort() : [];
    assert.ok(backups.length >= 1, 'the legacy config must survive as a dated backup');
  });

  test('a junction state root is refused and the junction TARGET ACL is untouched', async () => {
    const outside = mkdtempSync(join(TEST_RUNS, 'ps-outside-'));
    const outsideState = join(outside, 'state');
    mkdirSync(outsideState);
    const aclBefore = await icaclsText(outsideState);
    // A link INSIDE .local passes the confinement prefix check; the
    // reparse-ancestor check must then refuse it.
    const linkRoot = join(LOCAL_ROOT, 'ps-junction-refusal');
    mkdirSync(linkRoot, { recursive: true });
    const link = join(linkRoot, `link-${Date.now()}`);
    symlinkSync(outsideState, link, 'junction');
    await assert.rejects(
      () => powershell('setup.ps1', [
        '-PrepareOnly', '-StateDirectory', link,
        '-PiCliPath', 'x.js', '-PiWorkspace', '.',
      ]),
      (error) => /reparse|junction/i.test(String(error.stderr)) || error.code !== 0,
    );
    const aclAfter = await icaclsText(outsideState);
    assert.equal(aclAfter, aclBefore, 'the junction target ACL must be untouched');
    void outside;
  });
});

describe('ps-runtime: start.ps1 forwards the exact state root to prerequisites', () => {
  before(async function () {
    if (!IS_WIN) this.skip();
    // Both members prepare a real state root first, so they inherit the
    // same hosted-runner limitation as the prepare-only suite.
    if (userOnlyAclSkipReason) this.skip(userOnlyAclSkipReason);
  });

  const DOT_SOURCE_LINE = ". (Join-Path $PSScriptRoot 'common.ps1')";

  /**
   * Harness: an exact copy of start.ps1 except the common.ps1 dot-source
   * is replaced by a marker comment. The driver pre-loads common.ps1 and
   * SHIMS Test-BridgePrerequisites, so the test asserts which arguments
   * start.ps1 binds to that helper. The shim throws right after logging,
   * so no host process is ever launched and no real node is invoked.
   */
  function makeStartHarness(label) {
    const dir = uniqueDir(label);
    mkdirSync(dir, { recursive: true });
    const source = readFileSync(join(SCRIPTS, 'start.ps1'), 'utf8').replaceAll('\r\n', '\n');
    assert.ok(source.includes(DOT_SOURCE_LINE), 'start.ps1 must dot-source common.ps1');
    const copy = source.replace(DOT_SOURCE_LINE, '# harness copy: common.ps1 pre-loaded by the driver (prerequisite shim)');
    const copyPath = join(dir, 'start-harness.ps1');
    writeFileSync(copyPath, copy, 'utf8');
    const driverPath = join(dir, 'prereq-driver.ps1');
    writeFileSync(driverPath, [
      'param(',
      '    [Parameter(Mandatory = $true)][string]$StartScriptCopy,',
      '    [Parameter(Mandatory = $true)][string]$CommonPath,',
      '    [Parameter(Mandatory = $true)][string]$StateDirectory,',
      '    [Parameter(Mandatory = $true)][string]$PrereqLog,',
      '    [switch]$HostOnly',
      ')',
      '. $CommonPath',
      'function Test-BridgePrerequisites {',
      '    param([switch]$RequireCredentials, [string]$StateRoot)',
      '    Add-Content -LiteralPath $PrereqLog -Value ("call RequireCredentials={0} StateRoot=[{1}]" -f [bool]$RequireCredentials, $StateRoot)',
      "    throw 'HARNESS_STOP_AFTER_PREREQ'",
      '}',
      'try {',
      '    if ($HostOnly) {',
      '        & $StartScriptCopy -HostOnly -StateDirectory $StateDirectory',
      '    } else {',
      '        & $StartScriptCopy -StateDirectory $StateDirectory',
      '    }',
      "    Add-Content -LiteralPath $PrereqLog -Value 'stopped: script-completed-unexpectedly'",
      '} catch {',
      '    Add-Content -LiteralPath $PrereqLog -Value ("stopped: {0}" -f $_.Exception.Message)',
      '}',
      '',
    ].join('\n'), 'utf8');
    return { copyPath, driverPath, logPath: join(dir, 'prereq.log') };
  }

  async function prepareValidState(label) {
    const stateDir = uniqueDir(label);
    const fixtures = makePiFixtures();
    await powershell('setup.ps1', [
      '-PrepareOnly', '-StateDirectory', stateDir,
      '-PiCliPath', fixtures.cli, '-PiWorkspace', fixtures.workspace,
    ]);
    return stateDir;
  }

  async function runPrereqDriver(harness, stateDir, hostOnly) {
    const args = [
      '-File', harness.driverPath,
      '-StartScriptCopy', harness.copyPath,
      '-CommonPath', join(SCRIPTS, 'common.ps1'),
      '-StateDirectory', stateDir,
      '-PrereqLog', harness.logPath,
    ];
    if (hostOnly) args.push('-HostOnly');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
      { cwd: TEST_RUNS, timeout: 120_000 });
    return readFileSync(harness.logPath, 'utf8');
  }

  test('HostOnly start binds -StateRoot to the custom state directory', async () => {
    const stateDir = await prepareValidState('starthost');
    const harness = makeStartHarness('starthost-harness');
    const log = await runPrereqDriver(harness, stateDir, true);
    assert.match(log, /stopped: HARNESS_STOP_AFTER_PREREQ/, 'the shim must stop the script before any host launch');
    const calls = log.split(/\r?\n/).filter((line) => line.startsWith('call '));
    assert.equal(calls.length, 1);
    const normalized = calls[0].toLowerCase();
    assert.match(normalized, /requirecredentials=false/);
    assert.ok(
      normalized.endsWith(`stateroot=[${stateDir.toLowerCase()}]`),
      `prerequisite must receive the exact custom state root, got: ${calls[0]}`,
    );
  });

  test('production start binds -RequireCredentials AND the exact custom state root', async () => {
    const stateDir = await prepareValidState('startprod');
    const harness = makeStartHarness('startprod-harness');
    const log = await runPrereqDriver(harness, stateDir, false);
    assert.match(log, /stopped: HARNESS_STOP_AFTER_PREREQ/, 'the shim must stop the script before any host launch');
    const calls = log.split(/\r?\n/).filter((line) => line.startsWith('call '));
    assert.equal(calls.length, 1);
    const normalized = calls[0].toLowerCase();
    assert.match(normalized, /requirecredentials=true/);
    assert.ok(
      normalized.endsWith(`stateroot=[${stateDir.toLowerCase()}]`),
      `prerequisite must receive the exact custom state root, got: ${calls[0]}`,
    );
  });
});

describe('ps-runtime: log rotation + dated backups (common.ps1 helpers)', () => {
  before(async function () {
    if (!IS_WIN) this.skip();
  });

  test('Rotate-BridgeLogFile archives the old log and leaves a fresh file in place (no truncation, no delete)', async () => {
    const dir = uniqueDir('rotate');
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'host-stdout.log');
    writeFileSync(log, 'OLD LOG CONTENT THAT MUST SURVIVE\n', 'utf8');
    const script = `
      . '${join(SCRIPTS, 'common.ps1').replace(/'/g, "''")}'
      Rotate-BridgeLogFile -Path '${log.replace(/'/g, "''")}'
      Write-Output "done"
    `;
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    assert.match(stdout, /done/);
    assert.ok(existsSync(log), 'a fresh log file must exist at the original path');
    assert.equal(readFileSync(log, 'utf8'), '', 'the fresh log must be empty');
    const archived = [];
    for (const name of readdirSync(dir)) {
      if (name.startsWith('host-stdout.log.') && name !== 'host-stdout.log') {
        archived.push(name);
        assert.equal(readFileSync(join(dir, name), 'utf8'), 'OLD LOG CONTENT THAT MUST SURVIVE\n');
      }
    }
    assert.equal(archived.length, 1, 'exactly one dated archive copy must exist');
  });
});

// T10 regression: the selective-enrollment QR presentation incident. The QR
// block must be rendered by a DIRECT node invocation whose stdout stays
// attached to the owner's terminal (captured pipes decoded the Unicode box
// characters through a legacy Windows code page as mojibake), the QR process
// receives validated username + fresh nonce ONLY (never StdinText/token),
// and the deep-link interpolation must brace ${botUsername} before "?start"
// (an unbraced "$botUsername?start" parsed as one undefined variable name).
describe('ps-runtime: T10 selective enrollment QR presentation (static source)', () => {
  const source = readFileSync(join(SCRIPTS, 'setup.ps1'), 'utf8').replaceAll('\r\n', '\n');

  function selectiveEnrollmentSource() {
    const start = source.indexOf('function Invoke-SelectiveEnrollment {');
    assert.ok(start >= 0, 'setup.ps1 must define Invoke-SelectiveEnrollment');
    const end = source.indexOf('# --- instance id:', start);
    assert.ok(end > start, 'the selective enrollment function body must be bounded');
    return source.slice(start, end);
  }

  // Code-only view: comment lines are stripped so assertions inspect
  // executable shape, never prose.
  function codeOnly(text) {
    return text.split(/\r?\n/).filter((line) => !line.trim().startsWith('#')).join('\n');
  }

  test('the QR step invokes node DIRECTLY on qr-render.mjs, not through the captured Invoke-BridgeNode', () => {
    const code = codeOnly(selectiveEnrollmentSource());
    // The known script path is bound once and invoked via the direct call.
    assert.match(
      code,
      /qrScriptPath = Join-Path \(Get-BridgeModuleRoot\) 'src\\qr-render\.mjs'/,
      'the QR script path must point at the known src/qr-render.mjs',
    );
    assert.match(
      code,
      /& node \$qrScriptPath '--username' \$botUsername '--nonce' \$nonce/,
      'the QR render must be a direct node invocation with username+nonce argv only',
    );
    // Exactly one qr-render reference in code, and its line must not be an
    // Invoke-BridgeNode call: the captured-pipe route caused the mojibake.
    const qrLines = code.split(/\r?\n/).filter((line) => line.includes('qr-render'));
    assert.equal(qrLines.length, 1,
      'qr-render must appear on exactly one code line: the direct invocation');
    assert.ok(!qrLines[0].includes('Invoke-BridgeNode'),
      'the QR render must never be routed through captured Invoke-BridgeNode');
  });

  test('the direct QR invocation carries username+nonce ONLY: no StdinText, no token, fail-closed exit check', () => {
    const code = codeOnly(selectiveEnrollmentSource());
    const from = code.indexOf('& node $qrScriptPath');
    const to = code.indexOf('$LASTEXITCODE', from);
    assert.ok(from >= 0 && to > from, 'the direct QR call and its exit capture must both exist');
    const qrBlock = code.slice(from, to);
    assert.ok(!/StdinText|tokenPlain|\btoken\b/i.test(qrBlock),
      'the QR process must never receive StdinText or any token material');
    assert.match(qrBlock, /'--username'/);
    assert.match(qrBlock, /'--nonce'/);
    // T10 round 2: the exit code is captured into $qrExitCode INSIDE try so it
    // survives the finally-restore; the fail-closed check uses the captured
    // variable, never the raw $LASTEXITCODE after the encoding was restored.
    assert.match(code, /\$qrExitCode = \$LASTEXITCODE/,
      'the child exit code must be captured inside try before the restore');
    assert.match(code, /if \(\$qrExitCode -ne 0\)/,
      'the direct QR invocation must fail closed on a nonzero captured exit code');
    assert.ok(!/if \(\$LASTEXITCODE -ne 0\)/.test(code),
      'the fail-closed check must not read raw $LASTEXITCODE after finally');
    // Fresh local nonce, generated immediately before the QR step.
    assert.match(code, /\$nonce = New-BridgeInstanceId/,
      'the pairing nonce must be freshly generated locally');
  });

  // T10 round 2: PS 5.1 defaults [Console]::OutputEncoding to the legacy OEM
  // code page (IBM437), so even a direct node invocation re-mojibakes the
  // Unicode QR while flowing through PowerShell. The production shape must
  // save the original encoding, set BOM-less UTF-8 inside try, capture the
  // exit code, and restore the original encoding in finally - never leaving
  // a permanent global encoding change behind.
  test('the QR step wraps the invocation in save/set UTF-8/try/finally/restore of the console output encoding', () => {
    const code = codeOnly(selectiveEnrollmentSource());
    const from = code.indexOf('$qrPreviousOutputEncoding = [Console]::OutputEncoding');
    assert.ok(from >= 0, 'the original console output encoding must be saved before the QR step');
    const to = code.indexOf('$qrExitCode -ne 0', from);
    assert.ok(to > from, 'the guarded QR block must be bounded by the fail-closed check');
    const block = code.slice(from, to);
    assert.match(block, /\$qrExitCode = 1/,
      'the exit code must default to failure so an aborted try fails closed');
    assert.match(block, /try \{/);
    assert.match(
      block,
      /\[Console\]::OutputEncoding = New-Object System\.Text\.UTF8Encoding\(\$false\)/,
      'the console output encoding must be switched to BOM-less UTF-8 inside try',
    );
    const setIndex = block.indexOf('[Console]::OutputEncoding = New-Object');
    const callIndex = block.indexOf('& node $qrScriptPath');
    const captureIndex = block.indexOf('$qrExitCode = $LASTEXITCODE');
    const finallyIndex = block.indexOf('finally');
    assert.ok(setIndex >= 0 && callIndex > setIndex,
      'the UTF-8 switch must happen BEFORE the node invocation');
    assert.ok(captureIndex > callIndex,
      'the exit code must be captured after the node invocation, inside try');
    assert.ok(finallyIndex > captureIndex,
      'finally must come after the exit-code capture');
    const restorePart = block.slice(finallyIndex);
    assert.match(
      restorePart,
      /\[Console\]::OutputEncoding = \$qrPreviousOutputEncoding/,
      'the original console output encoding must be restored in finally',
    );
    // Exactly one console-encoding set in the whole selective flow: the
    // temporary one. No other global encoding mutation may exist.
    const setLines = code.split(/\r?\n/)
      .filter((line) => /\[Console\]::OutputEncoding\s*=/.test(line));
    assert.equal(setLines.length, 2,
      'exactly one temporary set inside try plus exactly one restore may exist');
    assert.equal(setLines.filter((line) => line.includes('UTF8Encoding')).length, 1,
      'only the temporary set may assign a new encoding');
    assert.equal(setLines.filter((line) => line.includes('$qrPreviousOutputEncoding')).length, 1,
      'only the finally restore may reassign the saved encoding');
  });

  test('the deep link braces the username interpolation before ?start everywhere it is printed', () => {
    const code = codeOnly(selectiveEnrollmentSource());
    assert.match(
      code,
      /https:\/\/t\.me\/\$\{botUsername\}\?start=\$nonce/,
      'the printed deep link must interpolate ${botUsername} braced',
    );
    assert.ok(!/https:\/\/t\.me\/\$botUsername\?/.test(code),
      'an unbraced "$botUsername?start" interpolation must not exist anywhere');
  });
});

// T10 smoke (parent verifier runs the suite): the known qr-render.mjs script,
// invoked directly with a DUMMY username + nonce exactly like the fixed setup
// step, must emit a clean UTF-8 QR block with no mojibake/replacement markers.
describe('ps-runtime: T10 direct node QR smoke (dummy username+nonce)', () => {
  before(async function () {
    if (!IS_WIN) this.skip();
  });

  test('direct node qr-render emits a clean QR block: no replacement char, no code-page mojibake markers, no token', async () => {
    const { stdout } = await run('node', [
      join(MODULE_ROOT, 'src', 'qr-render.mjs'),
      '--username', 'dummybot',
      '--nonce', '0123456789abcdef0123456789abcdef',
    ], { cwd: TEST_RUNS, timeout: 30_000 });
    assert.match(stdout,
      /^LINK:https:\/\/t\.me\/dummybot\?start=0123456789abcdef0123456789abcdef$/m,
      'the link line must carry exactly the dummy username+nonce');
    assert.ok(/[\u2580\u2584\u2588]/.test(stdout),
      'the QR block characters (\u2580/\u2584/\u2588) must be present');
    assert.ok(!stdout.includes('\uFFFD'), 'no Unicode replacement character may appear');
    // Common UTF-8->legacy-codepage mojibake signatures for the box chars:
    // CP437 shows \u2580/\u2584/\u2588 as "\u0393\u00fb...", Latin-1 as "\u00c3...".
    for (const marker of ['\u0393\u00fb', '\u00c3', '\u00e5\u0096']) {
      assert.ok(!stdout.includes(marker), `no mojibake marker ${JSON.stringify(marker)} may appear`);
    }
    assert.ok(!/token/i.test(stdout), 'the QR output must never mention a token');
  });

  // T10 round 2: proves the PRODUCTION SHAPE works on real Windows PowerShell
  // 5.1: with the console output encoding temporarily switched to BOM-less
  // UTF-8 around a direct node invocation, the QR block arrives intact (no
  // IBM437 \u0393-mojibake, no replacement char) and the original encoding is
  // restored afterwards. Dummy username/nonce only; skipped when this
  // environment cannot change the console encoding at all (e.g. fully
  // redirected CI consoles without a writable output handle).
  test('PS 5.1 harness: temporary UTF-8 console encoding around direct node keeps the QR intact and restores the original encoding', async (t) => {
    const qrScript = join(MODULE_ROOT, 'src', 'qr-render.mjs');
    const probeScript = [
      'try {',
      '    $p = [Console]::OutputEncoding',
      '    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      '    [Console]::OutputEncoding = $p',
      "    Write-Output 'SETTABLE'",
      '} catch {',
      "    Write-Output 'NOT_SETTABLE'",
      '}',
    ].join('\r\n');
    const probe = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', probeScript,
    ], { cwd: TEST_RUNS, timeout: 30_000 });
    if (!probe.stdout.includes('SETTABLE')) {
      t.skip('this environment cannot change the console output encoding; the owner console can');
    }

    // The exact production shape: save, set BOM-less UTF-8, direct node,
    // capture the exit code, restore in finally, report both code pages.
    const harnessScript = [
      '$previous = [Console]::OutputEncoding',
      'Write-Output ("PREV={0}" -f $previous.CodePage)',
      '$exitCode = 1',
      'try {',
      '    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      `    & node '${qrScript.replace(/'/g, "''")}' '--username' 'dummybot' '--nonce' '0123456789abcdef0123456789abcdef'`,
      '    $exitCode = $LASTEXITCODE',
      '} finally {',
      '    [Console]::OutputEncoding = $previous',
      '}',
      'Write-Output ("EXIT={0}" -f $exitCode)',
      'Write-Output ("RESTORED={0}" -f [Console]::OutputEncoding.CodePage)',
    ].join('\r\n');
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', harnessScript,
    ], { cwd: TEST_RUNS, timeout: 60_000 });
    const prev = stdout.match(/PREV=(\d+)/);
    const restored = stdout.match(/RESTORED=(\d+)/);
    assert.ok(prev && restored, 'the harness must report both code pages');
    assert.equal(restored[1], prev[1],
      'the original console output encoding must be restored after finally');
    assert.match(stdout, /EXIT=0/, 'the direct node invocation must succeed');
    assert.match(stdout,
      /LINK:https:\/\/t\.me\/dummybot\?start=0123456789abcdef0123456789abcdef/,
      'the link line must carry exactly the dummy username+nonce');
    assert.ok(/[\u2580\u2584\u2588]/.test(stdout),
      'the QR block characters (\u2580/\u2584/\u2588) must survive the UTF-8 console');
    assert.ok(!stdout.includes('\uFFFD'), 'no Unicode replacement character may appear');
    for (const marker of ['\u0393\u00fb', '\u00c3', '\u00e5\u0096']) {
      assert.ok(!stdout.includes(marker), `no mojibake marker ${JSON.stringify(marker)} may appear`);
    }
    assert.ok(!/token/i.test(stdout), 'the QR output must never mention a token');
  });
});

// F1 fail-fast: the Node.js major-version gate lives ONCE, in common.ps1,
// and must be callable against synthetic 'node --version' output. Empty or
// malformed output fails closed; 18/22 are rejected, 24+ accepted.
describe('ps-runtime: shared Node.js version gate (common.ps1)', () => {
  before(async function () {
    if (!IS_WIN) this.skip();
  });

  const COMMON_PATH = join(SCRIPTS, 'common.ps1');

  async function gateResult(versionOutput) {
    const literal = String(versionOutput).replace(/'/g, "''");
    const script = [
      `. '${COMMON_PATH.replace(/'/g, "''")}'`,
      `if (Test-BridgeNodeVersionGate -VersionOutput '${literal}') { Write-Output 'ACCEPT' } else { Write-Output 'REJECT' }`,
    ].join('\r\n');
    const { stdout } = await run('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { cwd: TEST_RUNS, timeout: 60_000 });
    return stdout.trim();
  }

  test('v24.13.1 and v26.0.0 are accepted', async () => {
    assert.equal(await gateResult('v24.13.1'), 'ACCEPT');
    assert.equal(await gateResult('v26.0.0'), 'ACCEPT');
  });

  test('v18.20.4 and v22.11.0 are rejected', async () => {
    assert.equal(await gateResult('v18.20.4'), 'REJECT');
    assert.equal(await gateResult('v22.11.0'), 'REJECT');
  });

  test('empty and malformed output fail closed', async () => {
    assert.equal(await gateResult(''), 'REJECT');
    assert.equal(await gateResult('garbage'), 'REJECT');
    assert.equal(await gateResult('v24'), 'REJECT', 'an output without a minor segment is malformed, not acceptable');
  });

  test('Get-BridgeNodeMajorVersion parses the leading major and yields nothing for malformed output', async () => {
    const script = [
      `. '${COMMON_PATH.replace(/'/g, "''")}'`,
      "Write-Output (Get-BridgeNodeMajorVersion -VersionOutput 'v24.13.1')",
      "Write-Output (Get-BridgeNodeMajorVersion -VersionOutput 'v22.11.0')",
      "Write-Output (Get-BridgeNodeMajorVersion -VersionOutput 'not-a-version')",
    ].join('\r\n');
    const { stdout } = await run('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { cwd: TEST_RUNS, timeout: 60_000 });
    const lines = stdout.trim().split(/\r?\n/).filter((l) => l.length > 0);
    assert.deepEqual(lines, ['24', '22'],
      'the parser returns the major for well-formed output and nothing for malformed output');
  });

  test('broker-service-common.ps1 reuses the shared parser: no second copy of the version logic', () => {
    const brokerSource = readFileSync(join(SCRIPTS, 'broker-service-common.ps1'), 'utf8').replaceAll('\r\n', '\n');
    assert.match(brokerSource, /Get-BridgeNodeMajorVersion -VersionOutput \$versionOutput/,
      'Test-BrokerServicePrerequisites must delegate parsing to common.ps1');
    assert.ok(!brokerSource.includes("'^v(\\d+)\\.'"),
      'the version regex must exist exactly once, in common.ps1');
  });
});

// Standalone beginner setup contract: the double-click launcher selects this
// mode, while direct setup keeps every advanced and legacy surface.
describe('ps-runtime: launcher-only Beginner setup contract', () => {
  const setupSource = readFileSync(join(SCRIPTS, 'setup.ps1'), 'utf8').replaceAll('\r\n', '\n');
  const installerSource = readFileSync(join(SCRIPTS, 'install-selective-extension.ps1'), 'utf8').replaceAll('\r\n', '\n');
  const commonSource = readFileSync(join(SCRIPTS, 'selective-extension-common.ps1'), 'utf8').replaceAll('\r\n', '\n');

  test('the node presence+version gate precedes state resolution and the beginner path exits friendly before anything exists on disk', () => {
    const nodeCheck = setupSource.indexOf('# --- node check');
    const resolveState = setupSource.indexOf('$stateRoot = Resolve-BridgeStateDirectory');
    assert.ok(nodeCheck >= 0 && resolveState > nodeCheck,
      'the node check block must precede state resolution');
    const gate = setupSource.indexOf('Test-BridgeNodeVersionGate', nodeCheck);
    assert.ok(gate >= 0 && gate < resolveState,
      'the Node.js major-version gate must run before the state root is resolved, created or ACL-locked');
    const checkEnd = setupSource.indexOf('# --- state root', nodeCheck);
    const block = setupSource.slice(nodeCheck, checkEnd);
    assert.match(block, /Test-BridgeNodeVersionGate/,
      'setup must reuse the shared common.ps1 gate, not a second copy of the version logic');
    assert.match(block, /& \$node\.Source --version/,
      'the version output must come from the resolved node itself');
    assert.match(block, /if \(\$Beginner\)\s*\{[\s\S]*?nodejs\.org[\s\S]*?exit 1/,
      'a Beginner failure must print the nodejs.org copy and exit nonzero instead of throwing');
  });

  test('Beginner cannot combine with prepare-only or legacy and rejects before state resolution', () => {
    assert.match(setupSource, /\[switch\]\$Beginner/);
    const guard = setupSource.indexOf('if ($Beginner -and ($PrepareOnly -or $LegacyHeadless))');
    const resolveState = setupSource.indexOf('$stateRoot = Resolve-BridgeStateDirectory');
    assert.ok(guard >= 0 && resolveState > guard,
      'incompatible modes must fail before state resolution or mutation');
  });

  test('Beginner QR is required and never falls through to numeric-id prompts', () => {
    const start = setupSource.indexOf('function Invoke-SelectiveEnrollment {');
    const end = setupSource.indexOf('# --- instance id:', start);
    const enrollment = setupSource.slice(start, end);
    assert.match(enrollment, /if \(\$Beginner\)[\s\S]*Open your phone camera/);
    assert.match(enrollment, /if \(\$Beginner\)[\s\S]*Setup needs the QR connection[\s\S]*exit 4/);
    assert.match(enrollment, /Manual fallback: enter the ids yourself/,
      'advanced setup must retain its manual fallback');
    const manual = enrollment.indexOf("Write-Host 'Manual fallback: enter the ids yourself");
    const beginnerExit = enrollment.lastIndexOf('exit 4', manual);
    assert.ok(beginnerExit >= 0 && beginnerExit < manual,
      'the Beginner guard exits before the advanced numeric-id prompts');
  });

  test('ENROLL and protected save precede the exact installer-task-start plan', () => {
    const enroll = setupSource.indexOf("Read-Host 'Type ENROLL to save it on this PC");
    const protect = setupSource.indexOf("'src\\dpapi-credentials.mjs'", enroll);
    const beginnerPlan = setupSource.indexOf("if ($Beginner) {\n    Write-Host ''\n    Write-Host 'Finishing setup...'", protect);
    assert.ok(enroll >= 0 && protect > enroll && beginnerPlan > protect,
      'explicit ENROLL and protected credential save must precede component changes');
    const planEnd = setupSource.indexOf('# --- post-enrollment offers', beginnerPlan);
    const plan = setupSource.slice(beginnerPlan, planEnd);
    const extension = plan.indexOf("'install-selective-extension.ps1'");
    const task = plan.indexOf("'install-broker-service.ps1'");
    const start = plan.indexOf("'start-broker-service.ps1'");
    assert.ok(extension >= 0 && task > extension && start > task,
      'components must run in installer -> task -> start order');
    assert.match(plan, /-QuietLogPath \$componentLog/);
    assert.match(plan, /if \(\$code -ne 0\)[\s\S]*exit \$code/,
      'the plan stops on the first failing child');
    assert.doesNotMatch(plan, /tokenPlain|credentialJson|botUsername|userId|chatId|nonce/,
      'the component plan receives no enrollment or secret values');
  });

  test('quiet child execution appends every stream to an ignored local log with path-only args', () => {
    const start = setupSource.indexOf('function Invoke-SetupSubscript {');
    const end = setupSource.indexOf('# LEGACY interactive enrollment', start);
    const helper = setupSource.slice(start, end);
    const executable = helper.split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#')).join('\n');
    assert.match(executable, /\[string\]\$QuietLogPath/);
    assert.match(executable, /\*>> \$QuietLogPath/);
    assert.match(executable, /@\('-StateDirectory', \$ScriptStateDirectory\)/);
    assert.doesNotMatch(executable, /token|credential|nonce|allowedUserId|allowedChatId/i);
    assert.match(setupSource, /Join-Path \$stateRoot 'logs\\setup-components\.log'/);
  });

  test('advanced direct setup and long aliases remain available', () => {
    assert.match(setupSource, /Optional local installation/);
    assert.match(setupSource, /Read-Host 'Install the global Pi extension now/);
    assert.match(setupSource, /-PrepareOnly/);
    assert.match(setupSource, /-LegacyHeadless/);
    assert.match(setupSource, /\/telegram-connect \[label\]/);
    assert.match(setupSource, /\/telegram-disconnect and \/telegram-status/);
  });

  test('installed-extension guidance promotes /tg while preserving advanced registration', () => {
    assert.match(installerSource, /inert until local \/tg/);
    assert.doesNotMatch(installerSource, /inert until local \/telegram-connect/);
    assert.match(commonSource, /registers \/tg plus the advanced/);
    assert.match(commonSource, /\/telegram-connect, \/telegram-disconnect and \/telegram-status/);
    assert.match(commonSource, /until \/tg is run locally/);
  });
});
