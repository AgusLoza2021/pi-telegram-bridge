// T06b-pre regression: the global (auto-discovery) extension payload must
// cover the extension's runtime relative import closure EXACTLY. The
// incident this guards against: extension/selective-tui-extension.ts
// imports '../src/beginner-copy.mjs', but Get-SelectivePayloadMap did not
// stage it, so the installed copy failed to resolve its imports and fresh
// Pi processes could not load the extension at all.
//
// Strategy (static, no installation, no mutation):
//  1. Walk the runtime relative-import closure starting from the
//     extension file (skipping type-only imports and non-relative
//     host-package/builtin imports).
//  2. Parse Get-SelectivePayloadMap's RelativePath entries out of the
//     PowerShell source.
//  3. Assert closure == map, exactly once each, with the original
//     extension\ + src\ relative layout preserved in DestinationRel.
//  4. Assert no credential/state/log/runtime files can enter the payload.
// On win32 the test additionally dot-sources the script READ-ONLY and
// enumerates Get-SelectivePayloadMap live (the function only builds path
// objects; dot-sourcing defines functions and installs nothing) and
// cross-checks the live map against the static parse.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, posix, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSION_REL = 'extension/selective-tui-extension.ts';
const COMMON_PS1 = join(MODULE_ROOT, 'scripts', 'selective-extension-common.ps1');

function resolveRelative(fromRepoRel, importSpec) {
  return posix.normalize(posix.join(posix.dirname(fromRepoRel), importSpec));
}

// Runtime relative-import closure. Type-only imports carry no runtime
// cost and are skipped; bare package specifiers and node: builtins are
// provided by the host, never staged.
function collectRuntimeRelativeClosure(entryRel) {
  const closure = new Set();
  const queue = [entryRel];
  while (queue.length > 0) {
    const current = queue.pop();
    if (closure.has(current)) continue;
    closure.add(current);
    const abs = join(MODULE_ROOT, ...current.split('/'));
    assert.ok(existsSync(abs), `closure file must exist in the repo: ${current}`);
    const source = readFileSync(abs, 'utf8');
    for (const line of source.split(/\r?\n/)) {
      if (/^\s*import\s+type\b/.test(line)) continue;
      const match = /\bfrom\s+['"](\.[^'"]+)['"]/.exec(line);
      if (!match) continue;
      const target = resolveRelative(current, match[1]);
      if (!/\.mjs$/.test(target)) continue;
      queue.push(target);
    }
  }
  return closure;
}

// Parse the payload map's RelativePath/DestinationRel pairs straight out
// of the PowerShell source, so the test cannot pass because of a typo in
// a hand-maintained expectation list.
function parsePayloadMapFromSource() {
  const source = readFileSync(COMMON_PS1, 'utf8').replaceAll('\r\n', '\n');
  const body = /function\s+Get-SelectivePayloadMap\s*\{([\s\S]*?)\n\}/.exec(source);
  assert.ok(body, 'Get-SelectivePayloadMap must exist in selective-extension-common.ps1');
  const entries = [];
  const entryRe =
    /RelativePath\s+=\s+'([^']+)'\s*\n\s*DestinationRel\s+=\s+'([^']+)'/g;
  let match;
  while ((match = entryRe.exec(body[1])) !== null) {
    entries.push({ relativePath: match[1], destinationRel: match[2] });
  }
  return entries;
}

// Nothing sensitive may ever be staged next to the extension: no
// credentials, tokens, state roots, session data, logs or runtime
// machinery. The payload is source code only, under extension/ or src/.
const FORBIDDEN_PAYLOAD_PATTERN =
  /credential|token|secret|api[_-]?key|state|session|outbox|log|\.local|dpapi|broker|runtime|worker|host|enroll|policy|config\.mjs|security/i;

const EXPECTED_PAYLOAD = new Set([
  'extension/selective-tui-extension.ts',
  'src/tui-bridge-client.mjs',
  'src/store.mjs',
  'src/beginner-copy.mjs',
]);

describe('selective extension packaging', () => {
  const closure = collectRuntimeRelativeClosure(EXTENSION_REL);
  const staticMap = parsePayloadMapFromSource();
  const staticRelativePaths = staticMap.map((e) => e.relativePath);

  test('extension import closure is exactly the expected runtime set', () => {
    assert.deepEqual(
      [...closure].sort(),
      [...EXPECTED_PAYLOAD].sort(),
      'the runtime relative-import closure drifted; update EXPECTED_PAYLOAD deliberately',
    );
  });

  test('every runtime relative import is represented exactly once in the payload map', () => {
    for (const required of closure) {
      const occurrences = staticRelativePaths.filter((p) => p === required).length;
      assert.equal(
        occurrences,
        1,
        `payload map must contain '${required}' exactly once (found ${occurrences})`,
      );
    }
  });

  test('payload map has no entries outside the import closure', () => {
    for (const entry of staticRelativePaths) {
      assert.ok(
        closure.has(entry),
        `payload map stages '${entry}' but the extension never imports it`,
      );
    }
  });

  test('type-only host package imports are not payload entries', () => {
    const extensionSource = readFileSync(join(MODULE_ROOT, ...EXTENSION_REL.split('/')), 'utf8');
    const hostImports = [...extensionSource.matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1])
      .filter((spec) => !spec.startsWith('.'));
    assert.ok(hostImports.length >= 1, 'extension is expected to import host packages');
    for (const spec of hostImports) {
      assert.ok(
        !staticRelativePaths.some((p) => p.includes(spec)),
        `host package import '${spec}' must never become a payload entry`,
      );
    }
  });

  test('no credential/state/log/runtime file can enter the payload', () => {
    for (const entry of staticRelativePaths) {
      assert.doesNotMatch(
        entry,
        FORBIDDEN_PAYLOAD_PATTERN,
        `payload entry '${entry}' matches the forbidden sensitive/runtime pattern`,
      );
      assert.match(
        entry,
        /^(extension|src)\//,
        `payload entry '${entry}' must live under extension/ or src/`,
      );
    }
  });

  test('installed layout preserves the extension/ + src/ relative paths the imports need', () => {
    for (const entry of staticMap) {
      assert.equal(
        entry.destinationRel,
        entry.relativePath.replaceAll('/', '\\'),
        `DestinationRel of '${entry.relativePath}' must mirror its original layout`,
      );
    }
    // The extension is installed at extension\selective-tui-extension.ts,
    // so each '../src/*.mjs' import must resolve to a staged sibling.
    for (const required of closure) {
      if (required === EXTENSION_REL) continue;
      assert.ok(
        staticMap.some((e) => e.relativePath === required),
        `installed layout must stage '${required}' beside the extension for its relative import`,
      );
    }
  });

  test('every payload entry points at an existing source file', () => {
    for (const entry of staticMap) {
      const abs = join(MODULE_ROOT, ...entry.relativePath.split('/'));
      assert.ok(existsSync(abs), `payload source must exist: ${entry.relativePath}`);
    }
  });

  test('install/uninstall notice contract: full restart required, /reload alone not sufficient', () => {
    // The notice lives in the shared PowerShell source and the uninstall
    // early return; both must demand a FULL close+reopen because the
    // extension has multiple runtime modules a /reload can mix.
    const common = readFileSync(COMMON_PS1, 'utf8');
    assert.match(common, /FULLY CLOSED and REOPENED/i);
    assert.match(common, /\/reload alone is NOT sufficient/);
    assert.match(common, /multiple runtime modules/i);
    const uninstall = readFileSync(
      join(MODULE_ROOT, 'scripts', 'uninstall-selective-extension.ps1'), 'utf8',
    );
    assert.match(uninstall, /fully closed and reopened/i);
    assert.match(uninstall, /\/reload alone is not sufficient/i);
  });

  describe('live PowerShell enumeration (read-only)', { skip: process.platform !== 'win32' }, () => {
    function enumerateLivePayloadMap() {
      return new Promise((resolvePromise) => {
        const ps = spawn(
          'powershell.exe',
          [
            '-NoProfile', '-NonInteractive', '-Command',
            // Dot-source defines functions only (no install path runs);
            // enumerating the map builds path objects and touches nothing.
            `. '${COMMON_PS1.replace(/'/g, "''")}'; ` +
              'Get-SelectivePayloadMap | ' +
              "ForEach-Object { '{0}|{1}' -f $_.RelativePath, $_.DestinationRel }",
          ],
          { windowsHide: true },
        );
        let out = '';
        ps.stdout.on('data', (c) => { out += c.toString(); });
        ps.stderr.on('data', (c) => { out += c.toString(); });
        ps.on('close', (code) => resolvePromise({ code, out }));
        ps.on('error', () => resolvePromise({ code: -1, out: 'spawn failed' }));
      });
    }

    test('live Get-SelectivePayloadMap matches the static parse exactly', async () => {
      const { code, out } = await enumerateLivePayloadMap();
      assert.equal(code, 0, `PowerShell enumeration failed: ${out}`);
      const live = out
        .split(/\r?\n/)
        .filter((line) => line.includes('|'))
        .map((line) => {
          const [relativePath, destinationRel] = line.split('|');
          return { relativePath, destinationRel };
        });
      assert.deepEqual(
        live,
        staticMap,
        'live payload map and statically parsed map must stay identical',
      );
    });
  });
});

describe('on-demand load: nothing of this project may stay in Pi auto-discovery', () => {
  // The owner chose "nothing installed by default": the payload lives
  // beside Pi's auto-discovery root and is loaded only with an explicit
  // 'pi -e'. These assertions are the invariant that keeps it that way:
  // one copy under <agent-dir>\extensions re-enables global loading for
  // every project and every session.
  const COMMON_SOURCE = readFileSync(COMMON_PS1, 'utf8').replaceAll('\r\n', '\n');
  const INSTALLER_SOURCE = readFileSync(
    join(MODULE_ROOT, 'scripts', 'install-selective-extension.ps1'), 'utf8',
  ).replaceAll('\r\n', '\n');
  const UNINSTALL_SOURCE = readFileSync(
    join(MODULE_ROOT, 'scripts', 'uninstall-selective-extension.ps1'), 'utf8',
  ).replaceAll('\r\n', '\n');
  const LAUNCHER_PS1_SOURCE = readFileSync(
    join(MODULE_ROOT, 'scripts', 'launch-pi-with-bridge.ps1'), 'utf8',
  ).replaceAll('\r\n', '\n');
  const CMD_SOURCE = readFileSync(join(MODULE_ROOT, 'pi-telegram.cmd'), 'utf8')
    .replaceAll('\r\n', '\n');

  // Comments explain the rules, so only executable lines are asserted on:
  // prose about the discovery root or about '-ne' must never satisfy a
  // guard, and the PowerShell '-ne' operator must never trip one either.
  function executableLines(source) {
    return source
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith('#'))
      .join('\n');
  }

  function functionBody(source, name) {
    const match = new RegExp(`function\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
    assert.ok(match, `${name} must exist in the shared PowerShell source`);
    return match[1];
  }

  test('the payload helper is a SIBLING of the discovery root, never below it', () => {
    const body = functionBody(COMMON_SOURCE, 'Get-SelectiveOnDemandExtensionDir');
    assert.match(
      body,
      /Join-Path \(Get-SelectiveUserProfile\) '\.pi\\agent\\pi-telegram-bridge'/,
      'the on-demand payload must be pinned to the documented sibling path',
    );
    assert.doesNotMatch(
      body,
      /Get-SelectiveExtensionsRoot/,
      'resolving the payload through the discovery root would silently re-enable global loading',
    );
  });

  test('the installer writes the payload only through the on-demand helper', () => {
    const code = executableLines(INSTALLER_SOURCE);
    assert.match(code, /\$destination = Get-SelectiveOnDemandExtensionDir -Create/);
    assert.doesNotMatch(
      code,
      /\$destination = Join-Path \$extensionsRoot/,
      'the installer must not target the auto-discovery root any more',
    );
  });

  test('a leftover discovery copy is migrated out BEFORE the payload is written', () => {
    const code = executableLines(INSTALLER_SOURCE);
    const migrate = code.indexOf('Remove-SelectiveLegacyDiscoveryCopy -Stamp $stamp');
    const create = code.indexOf('$destination = Get-SelectiveOnDemandExtensionDir -Create');
    assert.ok(migrate >= 0, 'the installer must migrate a leftover discovery copy');
    assert.ok(
      create >= 0 && migrate < create,
      'migration must run first, so a failed install never leaves a legacy copy loading everywhere',
    );
  });

  test('migration archives a verified copy before moving and never deletes recursively', () => {
    const body = functionBody(COMMON_SOURCE, 'Remove-SelectiveLegacyDiscoveryCopy');
    const archive = body.indexOf('Copy-SelectiveDirectoryContents');
    const move = body.indexOf('Move-Item -LiteralPath $legacy');
    assert.ok(
      archive >= 0 && move >= 0 && archive < move,
      'the complete verified archive must exist before the directory is moved away',
    );
    assert.doesNotMatch(
      body,
      /Remove-Item[^\n]*-Recurse/,
      'only the emptied husk may be removed: a recursive delete could destroy unarchived content',
    );
  });

  test('uninstall clears the discovery root on both its paths', () => {
    const code = executableLines(UNINSTALL_SOURCE);
    const calls = code.match(/Remove-SelectiveLegacyDiscoveryCopy/g) ?? [];
    assert.ok(
      calls.length >= 2,
      'the already-absent early return and the normal path must both clear the discovery root',
    );
  });

  test('the launcher loads the payload explicitly and never suppresses extensions', () => {
    const code = executableLines(LAUNCHER_PS1_SOURCE);
    assert.match(
      code,
      /& \$pi\.Source -e \$payload @piArguments/,
      'the launcher must load the payload with an explicit -e and forward every argument',
    );
    assert.doesNotMatch(
      code,
      /["']-ne["']|--no-extensions/,
      'the no-extensions flag would also strip the project and other global extensions',
    );
    assert.match(code, /exit \$LASTEXITCODE/, 'the launcher must propagate the Pi exit code');
    // 'cd', 'pushd', 'chdir' and the PowerShell 'Set-Location' family all move
    // the working directory; Pi would then open the wrong folder.
    assert.doesNotMatch(
      code,
      /\b(Set-Location|Push-Location|Pop-Location|cd|chdir)\b/i,
      'the launcher must never change the working directory: Pi opens the caller project',
    );
    assert.doesNotMatch(
      code,
      /Test-Path -LiteralPath \$entry -PathType Leaf\)\s*\{[\s\S]*?New-Item/,
      'the launcher must never install anything itself',
    );
    // Only a real Windows entry point may be started: falling back to the
    // extensionless npm shell script makes '&' fail with a bare error.
    assert.ok(
      code.includes('\\.(cmd|exe|bat)$'),
      'the launcher must filter for a runnable Windows entry point (pi.cmd or pi.exe)',
    );
    assert.doesNotMatch(
      code,
      /\$pi = \$piCandidates \| Select-Object -First 1/,
      'there must be no unfiltered fallback to a non-runnable pi script',
    );
  });

  test('the cmd entry point resolves the launcher through %~dp0 and forwards %*', () => {
    assert.match(CMD_SOURCE, /-File "%~dp0scripts\\launch-pi-with-bridge\.ps1" %\*/);
    assert.match(CMD_SOURCE, /^exit \/b %PI_EXIT%$/m, 'the exit code must survive the wrapper');
    // Only executable lines: the 'rem' block explains why this file does not
    // cd, and that prose must neither satisfy nor trip the guard.
    const cmdCode = CMD_SOURCE
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim().toLowerCase();
        return trimmed.length > 0 && !trimmed.startsWith('rem') && !trimmed.startsWith('::');
      })
      .join('\n');
    assert.doesNotMatch(
      cmdCode,
      /(^|[^a-z])(cd|pushd|chdir)([^a-z]|$)/im,
      'no cd/pushd: the project the user is standing in must stay the one Pi opens',
    );
    const uses = CMD_SOURCE.match(/%~dp0/g) ?? [];
    const quoted = CMD_SOURCE.match(/"%~dp0/g) ?? [];
    assert.ok(uses.length > 0, 'the launcher must anchor on %~dp0');
    assert.equal(
      uses.length,
      quoted.length,
      'every %~dp0 occurrence must sit inside double quotes (the path may contain spaces)',
    );
  });

  describe('live PowerShell path resolution (read-only)', { skip: process.platform !== 'win32' }, () => {
    function resolveLivePaths() {
      return new Promise((resolvePromise) => {
        const ps = spawn(
          'powershell.exe',
          [
            '-NoProfile', '-NonInteractive', '-Command',
            `. '${COMMON_PS1.replace(/'/g, "''")}'; ` +
              "'{0}|{1}|{2}' -f (Get-SelectiveOnDemandExtensionDir), (Get-SelectiveGlobalExtensionDir), (Get-SelectiveExtensionsRoot)",
          ],
          { windowsHide: true },
        );
        let out = '';
        ps.stdout.on('data', (c) => { out += c.toString(); });
        ps.stderr.on('data', (c) => { out += c.toString(); });
        ps.on('close', (code) => resolvePromise({ code, out }));
        ps.on('error', () => resolvePromise({ code: -1, out: 'spawn failed' }));
      });
    }

    test('the live payload is a sibling of the discovery root and is not created', async () => {
      const { code, out } = await resolveLivePaths();
      assert.equal(code, 0, `PowerShell resolution failed: ${out}`);
      const [onDemand, global, extensionsRoot] = out.trim().split('|').map((v) => v.trim());
      assert.ok(onDemand && global && extensionsRoot, `unexpected output: ${out}`);
      assert.equal(
        global.toLowerCase(),
        join(extensionsRoot, 'pi-telegram-bridge').toLowerCase(),
        'the legacy path must stay the documented discovery location',
      );
      assert.ok(
        onDemand.toLowerCase().endsWith('\\pi-telegram-bridge'),
        `unexpected on-demand payload: ${onDemand}`,
      );
      assert.ok(
        !`${onDemand.toLowerCase()}\\`.startsWith(`${extensionsRoot.toLowerCase()}\\`),
        `the on-demand payload (${onDemand}) must not sit under the discovery root (${extensionsRoot})`,
      );
      assert.equal(
        dirname(onDemand).toLowerCase(),
        dirname(extensionsRoot).toLowerCase(),
        'the payload must be a sibling of the extensions root',
      );
    });
  });

  test('the resolver only writes when -Create is passed', () => {
    // Status and the launcher call it without -Create: resolving a path
    // must stay read-only, otherwise a status check could install state.
    const body = functionBody(COMMON_SOURCE, 'Get-SelectiveOnDemandExtensionDir');
    const guard = body.indexOf('if ($Create)');
    assert.ok(guard >= 0, 'creation must be guarded by the -Create switch');
    assert.ok(
      body.indexOf('New-Item') > guard,
      'New-Item must live inside the -Create branch',
    );
  });
});
