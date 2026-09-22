// T04: every PowerShell helper must parse cleanly under Windows
// PowerShell 5.1 before it ships (System.Management.Automation.Language
// Parser::ParseFile, exactly what scripts/test.ps1 runs).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(MODULE_ROOT, 'scripts');

function parseFile(path) {
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        '$errs = $null; ' +
        '[System.Management.Automation.Language.Parser]::ParseFile(' +
        `'${path.replace(/'/g, "''")}', [ref]$null, [ref]$errs) | Out-Null; ` +
        'if ($errs -and $errs.Count -gt 0) { $errs | ForEach-Object { Write-Output $_.Message }; exit 1 } else { exit 0 }',
      ],
      { windowsHide: true },
    );
    let out = '';
    ps.stdout.on('data', (c) => { out += c.toString(); });
    ps.on('close', (code) => resolve({ code, out }));
    ps.on('error', () => resolve({ code: -1, out: 'spawn failed' }));
  });
}

describe('PowerShell 5.1 parse checks', { skip: process.platform !== 'win32' }, () => {
  const scripts = readdirSync(SCRIPTS).filter((f) => f.endsWith('.ps1'));
  test('found the module PowerShell scripts', () => {
    assert.ok(scripts.length >= 1, 'scripts directory must contain .ps1 helpers');
  });
  for (const script of scripts) {
    test(`parses cleanly: scripts/${script}`, async () => {
      const { code, out } = await parseFile(join(SCRIPTS, script));
      assert.equal(code, 0, `parse errors in ${script}: ${out}`);
    });
  }
});
