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
import { join, posix } from 'node:path';
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
