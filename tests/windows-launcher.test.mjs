// T06/T06a: permanent static tests for the Windows 11 double-click entry point.
//
// Pure text assertions over the launcher bytes: no PowerShell spawn, no
// launcher execution, no setup, no npm, no network. The launcher is a `.cmd`
// wrapper, so it is intentionally invisible to the PowerShell 5.1 AST
// discovery in ps-scripts.test.mjs (which only reads `scripts/*.ps1`); these
// tests pin the wrapper contract instead: cd to the script's own folder, a
// dependency preflight (tools, files, exact local version probe) before any
// token prompt, one deterministic module-local `npm ci` only when needed, one
// local setup.ps1 invocation, masked-copy beginner output, and the setup exit
// code surviving the pause.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHER_NAME = 'Setup Pi Telegram.cmd';
const LAUNCHER_PATH = join(MODULE_ROOT, LAUNCHER_NAME);
const SCRIPTS_DIR = join(MODULE_ROOT, 'scripts');

const RAW = readFileSync(LAUNCHER_PATH, 'utf8');
const CONTENT = RAW.replace(/\r\n/g, '\n');
const LINES = CONTENT.split('\n');
const nonEmpty = () => LINES.map((l, i) => [l.trim(), i]).filter(([l]) => l.length > 0);
const echoCopy = () => LINES.filter((l) => /^echo /i.test(l.trim()))
  .map((l) => l.trim().replace(/^echo /i, ''))
  .join('\n');

const POWERSHELL_LINE = 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "scripts\\setup.ps1" -Beginner';
const CAPTURE_LINE = 'set "SETUP_EXIT=%ERRORLEVEL%"';
const NPM_CAPTURE_LINE = 'set "NPM_EXIT=%ERRORLEVEL%"';
const NPM_CI_LINE = 'npm ci --ignore-scripts --omit=dev --no-audit --no-fund';
const NPM_LOG_REDIRECT = '>".local\\logs\\setup-dependencies.log" 2>&1';
const SUCCESS_COPY = 'Setup complete.';
const SUCCESS_ACTION_COPY = 'Open or restart Pi, type /tg, choose Connect, then send a normal Telegram message.';
const FAILURE_COPY = 'Setup stopped before it could finish.';
const FAILURE_KEPT_COPY = 'Your existing link and settings were kept safe.';
const NPM_FAILURE_COPY = "Setup couldn't prepare the required local files. Check your internet connection and try again.";
const README_POINTER = 'For help, open the README file in this folder and look for the "Fix problems" section.';
const PAUSE_COPY = 'Press any key to close this window.';

// Pure model of the launcher's label-based branch structure. String in,
// ordered sections out; used to prove failure branches exit before the
// PowerShell line without executing anything.
function parseSections(content) {
  const sections = [];
  let current = { label: null, lines: [] };
  for (const line of content.split('\n')) {
    const label = line.trim().match(/^:([A-Za-z0-9_-]+)$/);
    if (label) {
      sections.push(current);
      current = { label: label[1], lines: [] };
    } else {
      current.lines.push(line.trim());
    }
  }
  sections.push(current);
  return sections;
}

function lineIndex(exact) {
  return LINES.findIndex((l) => l.trim() === exact);
}

describe('launcher: working directory and script quoting', () => {
  test('opens with @echo off, setlocal and a %~dp0 cd', () => {
    assert.equal(LINES[0], '@echo off');
    assert.ok(LINES.includes('setlocal'));
    assert.ok(LINES.includes('cd /d "%~dp0"'), 'must cd to the launcher folder via %~dp0');
  });

  test('sets a friendly window title', () => {
    const titles = LINES.filter((l) => /^title \S/.test(l.trim()));
    assert.equal(titles.length, 1);
    assert.doesNotMatch(titles[0], /powershell|cmd\.exe|dpapi|broker/i);
  });

  test('cd happens before the preflight and the PowerShell invocation', () => {
    const cdIndex = LINES.indexOf('cd /d "%~dp0"');
    const probeIndex = LINES.findIndex((l) => l.trim().startsWith('node -e '));
    const psIndex = LINES.findIndex((l) => l.trim() === POWERSHELL_LINE);
    assert.ok(cdIndex >= 0 && probeIndex > cdIndex && psIndex > probeIndex);
  });
});

describe('launcher: dependency preflight before the setup path', () => {
  const probeIndex = LINES.findIndex((l) => l.trim().startsWith('node -e '));
  const psIndex = LINES.findIndex((l) => l.trim() === POWERSHELL_LINE);

  test('checks node.exe, npm.cmd, package.json and package-lock.json before anything else', () => {
    const checks = ['where node.exe', 'where npm.cmd', 'if not exist "package.json"', 'if not exist "package-lock.json"'];
    let cursor = -1;
    for (const check of checks) {
      const idx = LINES.findIndex((l, i) => i > cursor && l.includes(check));
      assert.ok(idx >= 0, `missing preflight check: ${check}`);
      cursor = idx;
    }
    assert.ok(cursor < probeIndex, 'tool and file checks must precede the version probe');
  });

  test('every tool/file check branches to the friendly missing-tools failure', () => {
    const checkIndexes = LINES.reduce((acc, l, i) => {
      if (l.includes('where node.exe') || l.includes('where npm.cmd') ||
          l.includes('if not exist "package.json"') || l.includes('if not exist "package-lock.json"')) {
        acc.push(i);
      }
      return acc;
    }, []);
    assert.equal(checkIndexes.length, 4, 'exactly four preflight checks');
    for (const idx of checkIndexes) {
      const line = LINES[idx].trim();
      const follower = (LINES[idx + 1] ?? '').trim();
      // Both guard shapes are valid: an inline self-guard
      // (`... goto missing-tools` on the check line itself) or a two-line
      // guard (`if errorlevel 1 goto missing-tools` on the follower line).
      const selfGuarded = line.endsWith('goto missing-tools');
      const followerGuarded = !checkIndexes.includes(idx + 1) && follower !== ''
        && /^(if errorlevel 1 |.*)?goto missing-tools$/.test(follower);
      assert.ok(selfGuarded !== followerGuarded,
        `each preflight check must guard the missing-tools branch exactly once (line ${idx + 1})`);
    }
  });

  test('the whole preflight precedes the PowerShell/token path', () => {
    assert.ok(probeIndex >= 0 && psIndex > probeIndex,
      'probe must exist and run before the setup.ps1 invocation');
  });

  test('the dependency probe is exactly one local node -e version comparison, offline', () => {
    // Two node -e lines exist by design: the Node.js major-version gate first,
    // then the qrcode-terminal dependency probe. This test pins the dependency
    // probe (the second); the gate is pinned in its own test below.
    const probes = LINES.filter((l) => l.trim().startsWith('node -e '));
    assert.equal(probes.length, 2,
      'exactly two node -e lines: the Node.js version gate and the dependency probe');
    const probe = probes[1];
    assert.ok(probe.includes("fs.readFileSync('package.json','utf8')"),
      'reads the expected version from module package.json');
    assert.ok(probe.includes("dependencies['qrcode-terminal']"),
      'compares the qrcode-terminal dependency version');
    assert.ok(probe.includes("fs.readFileSync('node_modules/qrcode-terminal/package.json','utf8')"),
      'reads the installed version from the local node_modules copy');
    assert.ok(probe.includes('installed===expected'), 'exact expected-vs-installed comparison');
    assert.ok(probe.includes('process.exit(0)') && probe.includes('process.exit(1)'),
      'exit codes decide the branch');
    assert.doesNotMatch(probe, /https?:\/\/|curl|wget|fetch/i, 'probe never touches the network');
  });

  test('the Node.js major-version gate runs before the dependency comparison and fails closed', () => {
    const probes = LINES.map((l, i) => [l.trim(), i]).filter(([l]) => l.startsWith('node -e '));
    assert.equal(probes.length, 2,
      'exactly two node -e lines: the Node.js version gate and the dependency probe');
    const [gate, gateIndex] = probes[0];
    assert.match(gate, /process\.versions\.node/, 'reads the running Node.js version from node itself');
    assert.match(gate, />=\s*24/, 'requires Node.js major version 24 or newer');
    assert.match(gate, /process\.exit\(1\)/, 'exits nonzero when Node.js is too old or unreadable');
    assert.doesNotMatch(gate, /https?:\/\/|curl|wget|fetch/i, 'gate never touches the network');
    const depProbeIndex = probes[1][1];
    assert.ok(gateIndex < depProbeIndex,
      'the version gate must run before the qrcode-terminal dependency comparison');
    const guard = (LINES[gateIndex + 1] ?? '').trim();
    assert.equal(guard, 'if errorlevel 1 goto node-too-old',
      'an old Node.js must branch to the friendly node-too-old failure, never reach npm ci');
  });
});

describe('launcher: deterministic local dependency install', () => {
  test('the only package command is npm ci with the exact approved flag set', () => {
    const npmLines = LINES.filter((l) => l.includes('npm ci'));
    assert.equal(npmLines.length, 1, 'exactly one npm ci');
    assert.ok(npmLines[0].trim().startsWith(NPM_CI_LINE), 'exact approved flag set');
    assert.ok(npmLines[0].includes(NPM_LOG_REDIRECT), 'npm output is redirected to the log');
  });

  test('no other package, download, global or lifecycle command exists', () => {
    const commands = LINES.filter((l) => !/^echo /i.test(l.trim())).join('\n');
    const FORBIDDEN = [
      /\bnpm\s+(install|i|update|upgrade|link|run|test|exec|rebuild)\b/,
      /\bnpx\b/,
      /\byarn\b|\bpnpm\b/,
      /(^|\s)--global\b|(^|\s)-g\b/,
      /\bpreinstall\b|\bpostinstall\b/,
      /\b(curl|wget|bitsadmin|certutil)\b/i,
      /https?:\/\//,
    ];
    const probeCount = (commands.match(/\bnode\s+-e\b/g) ?? []).length;
    assert.equal(probeCount, 2,
      'the only node -e lines are the Node.js version gate and the dependency probe');
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(commands, pattern, `forbidden command pattern ${pattern} in launcher`);
    }
  });

  test('the dependency log is module-local, quoted and its directory is created first', () => {
    assert.ok(CONTENT.includes('if not exist ".local\\logs" mkdir ".local\\logs"'),
      'local logs directory is created when missing');
    const mkdirIndex = LINES.findIndex((l) => l.includes('mkdir ".local\\logs"'));
    const npmIndex = LINES.findIndex((l) => l.includes('npm ci'));
    assert.ok(mkdirIndex >= 0 && mkdirIndex < npmIndex, 'mkdir precedes npm ci');
    assert.ok(CONTENT.includes(NPM_LOG_REDIRECT), 'quoted module-local redirect');
    assert.ok(!/".*[A-Za-z]:\\/.test(CONTENT.match(/>"[^"]*setup-dependencies\.log"/)?.[0] ?? ''),
      'log path must be module-relative, never an absolute drive path');
  });

  test('the install branch prints exactly one beginner progress line before npm ci', () => {
    const start = lineIndex(':install-dependencies');
    const npmIndex = LINES.findIndex((l) => l.includes('npm ci'));
    const progress = LINES.slice(start, npmIndex).filter((l) => /^echo /i.test(l.trim()));
    assert.equal(progress.length, 1, 'exactly one beginner progress line');
    assert.doesNotMatch(progress[0], /\bnpm\b|\bci\b|\binstall\b|\bdependency\b/i,
      'progress line stays jargon-free for beginners');
  });

  test('npm exit code is captured immediately and failure leaves before setup', () => {
    const ordered = nonEmpty();
    const npmIdx = ordered.findIndex(([l]) => l.startsWith(NPM_CI_LINE));
    assert.ok(npmIdx >= 0);
    assert.equal(ordered[npmIdx + 1][0], NPM_CAPTURE_LINE,
      'npm exit capture is the very next command');
    const guardIdx = ordered.findIndex(([l]) => l === 'if not "%NPM_EXIT%"=="0" goto dependencies-failed');
    assert.ok(guardIdx > npmIdx, 'failure guard follows the capture');
  });
});

describe('launcher: failure branches never reach the setup path', () => {
  const sections = parseSections(CONTENT);
  const byLabel = (label) => sections.find((s) => s.label === label);
  const setupSectionIndex = sections.findIndex((s) => s.label === 'launch-setup');

  test('node-too-old, missing-tools and dependencies-failed exist and precede launch-setup', () => {
    const tooOldIdx = sections.findIndex((s) => s.label === 'node-too-old');
    const missingIdx = sections.findIndex((s) => s.label === 'missing-tools');
    const depsIdx = sections.findIndex((s) => s.label === 'dependencies-failed');
    assert.ok(tooOldIdx >= 0 && missingIdx >= 0 && depsIdx >= 0 && setupSectionIndex >= 0);
    assert.ok(tooOldIdx < setupSectionIndex && missingIdx < setupSectionIndex && depsIdx < setupSectionIndex,
      'failure sections must be ordered before the setup section');
  });

  test('each failure branch exits nonzero without any PowerShell reference', () => {
    for (const label of ['node-too-old', 'missing-tools', 'dependencies-failed']) {
      const section = byLabel(label);
      assert.ok(section, `branch :${label} exists`);
      assert.equal(section.lines.filter((l) => /powershell/i.test(l)).length, 0,
        `:${label} must not invoke PowerShell`);
      const exits = section.lines.filter((l) => /^exit \/b /.test(l));
      assert.equal(exits.length, 1, `:${label} exits exactly once`);
      assert.doesNotMatch(exits[0], /^exit \/b 0$/, `:${label} propagates nonzero`);
    }
    const tooOldExits = byLabel('node-too-old').lines.filter((l) => /^exit \/b /.test(l));
    assert.equal(tooOldExits[0], 'exit /b 1', 'node-too-old exits 1, npm/setup codes are unrelated');
    const missingExits = byLabel('missing-tools').lines.filter((l) => /^exit \/b /.test(l));
    assert.equal(missingExits[0], 'exit /b 1');
    const depsExits = byLabel('dependencies-failed').lines.filter((l) => /^exit \/b /.test(l));
    assert.equal(depsExits[0], 'exit /b %NPM_EXIT%', 'npm failure propagates the npm code');
  });

  test('node-too-old failure copy names the fix and pauses before propagating its exit code', () => {
    const section = byLabel('node-too-old');
    assert.ok(section, 'branch :node-too-old exists');
    const copy = section.lines.filter((l) => /^echo /i.test(l.trim()))
      .map((l) => l.trim().replace(/^echo /i, ''))
      .join('\n');
    assert.ok(copy.includes('This setup needs a newer Node.js on this computer.'),
      'exact beginner copy line 1');
    assert.ok(copy.includes('Get the current version from nodejs.org, install it, then try this setup again.'),
      'exact beginner copy line 2 with the next action');
    assert.doesNotMatch(copy, /\bnpm\b|\bci\b|\bversion \d/i, 'no version-number or package-manager jargon');
    assert.ok(copy.includes(PAUSE_COPY), 'failure branch pauses');
    const pauseIdx = section.lines.findIndex((l) => /^pause >nul$/.test(l));
    const exitIdx = section.lines.findIndex((l) => /^exit \/b /.test(l));
    assert.ok(pauseIdx >= 0 && exitIdx > pauseIdx,
      ':node-too-old pauses before propagating its exit code');
  });

  test('npm failure shows the exact beginner copy, the README pointer and a pause', () => {
    const deps = byLabel('dependencies-failed');
    const copy = deps.lines.filter((l) => /^echo /i.test(l.trim())).join('\n');
    assert.ok(copy.includes(NPM_FAILURE_COPY), 'exact npm failure copy');
    assert.ok(copy.includes(README_POINTER), 'README Fix problems pointer');
    assert.ok(copy.includes(PAUSE_COPY), 'failure branch pauses');
  });

  test('missing-tools failure copy stays friendly and actionable', () => {
    const copy = byLabel('missing-tools').lines.filter((l) => /^echo /i.test(l.trim())).join('\n');
    assert.match(copy, /Node\.js/i, 'names the missing requirement in beginner terms');
    assert.match(copy, /nodejs\.org/i, 'points to where to get it');
    assert.doesNotMatch(copy, /\bnpm\b|\bci\b|\binstall\s+--/i, 'no package-manager jargon');
  });
});

describe('launcher: already-installed path skips npm ci', () => {
  test('a matching local version jumps straight to setup, never through npm', () => {
    const probeIndex = lineIndexRange().probe;
    const skipIndex = LINES.findIndex((l, i) => i > probeIndex && l.trim() === 'goto launch-setup');
    const installLabelIndex = lineIndex(':install-dependencies');
    const npmIndex = LINES.findIndex((l) => l.includes('npm ci'));
    assert.ok(probeIndex >= 0 && skipIndex > probeIndex, 'probe success has a direct setup jump');
    assert.ok(skipIndex < installLabelIndex && installLabelIndex < npmIndex,
      'the success jump precedes the install branch, so npm ci is unreachable when versions match');
  });

  function lineIndexRange() {
    return { probe: LINES.findIndex((l) => l.trim().startsWith('node -e ')) };
  }
});

describe('launcher: single local PowerShell invocation', () => {
  test('invokes system powershell.exe exactly once with the pinned argument line', () => {
    const psLines = LINES.filter((l) => /powershell/i.test(l));
    assert.equal(psLines.length, 1, 'exactly one PowerShell invocation');
    assert.equal(psLines[0].trim(), POWERSHELL_LINE);
  });

  test('targets only the repository-local quoted setup.ps1', () => {
    const refs = CONTENT.match(/[\w\\.\/-]+\.ps1/g) ?? [];
    assert.deepEqual(refs, ['scripts\\setup.ps1']);
    assert.ok(CONTENT.includes('-File "scripts\\setup.ps1"'), 'script path must be quoted');
    assert.doesNotMatch(CONTENT, /-File\s+"?%~dp0/, '-File must use the cd-relative path, not %~dp0');
  });

  test('selects the launcher-only Beginner mode and no advanced mode', () => {
    const line = LINES.find((entry) => entry.trim() === POWERSHELL_LINE);
    assert.ok(line, 'the exact Beginner invocation must exist');
    assert.equal((line.match(/-Beginner/g) ?? []).length, 1);
    assert.doesNotMatch(line, /-PrepareOnly|-LegacyHeadless/);
  });
});

describe('launcher: forbidden forwarding and infrastructure', () => {
  test('never forwards arguments or environment into the child', () => {
    assert.doesNotMatch(CONTENT, /%\*/, 'no %* forwarding');
    assert.doesNotMatch(CONTENT, /%[1-9]/, 'no positional argument forwarding');
    assert.doesNotMatch(CONTENT, /\$env:/i, 'no environment variable forwarding');
    assert.doesNotMatch(CONTENT, /\d{9,10}:[A-Za-z0-9_-]{30,}/, 'no bot-token literal');
    assert.doesNotMatch(echoCopy(), /\btoken\b|\bsecret\b|\bcredential\b/i,
      'no token or secret wording in beginner output');
  });

  test('contains no downloads, elevation, registry, service or endpoint machinery', () => {
    const FORBIDDEN = [
      /\b(curl|wget|bitsadmin|certutil)\b/i,
      /Invoke-(WebRequest|RestMethod|Expression)/i,
      /Download(File|String|Data)\b/i,
      /-Verb\s+RunAs/i,
      /\brunas?\b/i,
      /\belevat/i,
      /\bschtasks\b/i,
      /\b(Start|New|Stop)-Service\b/i,
      /\breg(edit|\s+(add|delete|import|export|query))\b/i,
      /HKEY_|HKLM|HKCU/,
      /\bnetsh\b/i,
      /https?:\/\//,
      /-EncodedCommand/i,
      /TcpListener|\bnc\b/i,
    ];
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(CONTENT, pattern, `forbidden pattern ${pattern} found in launcher`);
    }
  });

  test('wrapper prints no infrastructure jargon in its beginner output', () => {
    const JARGON = [
      'dpapi', 'broker', 'acl', 'scheduled task', 'registry', 'credential', 'token',
      'powershell', 'execution policy', 'script', 'service', 'endpoint', 'stack',
    ];
    for (const word of JARGON) {
      assert.doesNotMatch(echoCopy(), new RegExp(word.replace(' ', '\\s+'), 'i'),
        `jargon "${word}" leaked into wrapper output`);
    }
  });
});

describe('launcher: exit-code capture and propagation order', () => {
  test('captures %ERRORLEVEL% immediately after the PowerShell invocation', () => {
    const ordered = nonEmpty();
    const psIdx = ordered.findIndex(([l]) => l === POWERSHELL_LINE);
    assert.ok(psIdx >= 0);
    assert.equal(ordered[psIdx + 1][0], CAPTURE_LINE,
      'the capture must be the very next command after powershell.exe');
  });

  test('setup success, failure and pause copy all come after the capture', () => {
    const captureIdx = LINES.findIndex((l) => l.trim() === CAPTURE_LINE);
    for (const marker of [SUCCESS_COPY, SUCCESS_ACTION_COPY, FAILURE_COPY, FAILURE_KEPT_COPY, PAUSE_COPY]) {
      const idx = LINES.findIndex((l, i) => i > captureIdx && l.includes(marker));
      assert.ok(idx > captureIdx, `"${marker}" must appear in the setup tail after the capture`);
    }
  });

  test('every exit path pauses with the beginner line before propagating its code', () => {
    const pauses = LINES.filter((l) => /^pause >nul$/.test(l.trim()));
    assert.equal(pauses.length, 4,
      'one pause per exit path (node too old, missing tools, npm failure, setup)');
    const sections = parseSections(CONTENT);
    for (const label of ['node-too-old', 'missing-tools', 'dependencies-failed']) {
      const section = sections.find((s) => s.label === label);
      const pauseIdx = section.lines.findIndex((l) => /^pause >nul$/.test(l));
      const exitIdx = section.lines.findIndex((l) => /^exit \/b /.test(l));
      assert.ok(pauseIdx >= 0 && exitIdx > pauseIdx, `:${label} pauses before its exit`);
    }
    const last = nonEmpty().at(-1);
    assert.equal(last[0], 'exit /b %SETUP_EXIT%', 'propagates the captured setup code');
  });
});

describe('launcher: beginner copy', () => {
  test('success copy is exactly two adjacent beginner lines', () => {
    const first = LINES.findIndex((line) => line.trim() === `echo ${SUCCESS_COPY}`);
    assert.ok(first >= 0, 'the first success line must exist');
    assert.equal(LINES[first + 1].trim(), `echo ${SUCCESS_ACTION_COPY}`,
      'the action line must immediately follow the success line');
  });

  test('setup failure copy reassures and points at the README Fix problems section', () => {
    assert.ok(CONTENT.includes(FAILURE_COPY));
    assert.ok(CONTENT.includes(FAILURE_KEPT_COPY));
    const pointers = LINES.filter((l) => l.includes('Fix problems'));
    assert.equal(pointers.length, 2, 'README pointer appears on both failure branches');
    for (const pointer of pointers) {
      assert.match(pointer, /README/i);
    }
  });

  test('no path skips the pause (no goto after the setup capture)', () => {
    const waitBlock = CONTENT.slice(CONTENT.indexOf(CAPTURE_LINE));
    assert.ok(!waitBlock.includes('goto'), 'no path skips the pause (no goto after capture)');
  });
});

describe('launcher: static path-with-spaces safety', () => {
  test('every %~dp0 use is inside double quotes', () => {
    const uses = CONTENT.match(/%~dp0/g) ?? [];
    const quoted = CONTENT.match(/"%~dp0"/g) ?? [];
    assert.ok(uses.length > 0, 'launcher must anchor on %~dp0');
    assert.equal(uses.length, quoted.length, 'every %~dp0 occurrence must be quoted');
  });

  test('a hostile path with spaces and quotes cannot break the cd or -File', () => {
    assert.equal(LINES.find((l) => l.includes('cd /d')), 'cd /d "%~dp0"');
    assert.match(CONTENT, /-File "scripts\\setup\.ps1" -Beginner/);
  });
});

describe('launcher: PowerShell AST discovery is unaffected', () => {
  test('the launcher is a .cmd file at the module root, never parsed as ps1', () => {
    assert.equal(extname(LAUNCHER_NAME), '.cmd');
    assert.match(LAUNCHER_NAME, /\.cmd$/i);
  });

  test('scripts/ holds no .cmd files, so the scripts/*.ps1 AST sweep is unchanged', () => {
    const scripts = readdirSync(SCRIPTS_DIR);
    assert.equal(scripts.filter((f) => f.toLowerCase().endsWith('.cmd')).length, 0);
    assert.equal(scripts.filter((f) => f.toLowerCase() === LAUNCHER_NAME.toLowerCase()).length, 0);
    assert.ok(scripts.some((f) => f.toLowerCase().endsWith('.ps1')),
      'ps1 discovery target must still exist');
  });
});
