// T02 WU4: remote-session policy. The bridge profile is intentionally
// narrow: no shell, no MCP, no subagents, no network tools, no OS
// sandbox claims. Reads auto-allowed inside the workspace; write/edit
// require fingerprint + human confirm + dated backup; everything else
// is denied.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyTool,
  checkWorkspacePath,
  actionFingerprint,
  planBackupPath,
  containsSensitive,
} from '../src/policy.mjs';

const WS = fileURLToPath(new URL('..', import.meta.url));

describe('policy: tool classification', () => {
  test('read is auto-allowed', () => {
    assert.deepEqual(classifyTool('read'), { verdict: 'allow' });
  });

  test('shell-like tools are denied', () => {
    for (const tool of ['bash', 'Bash', 'powershell', 'cmd', 'shell', 'terminal_exec']) {
      assert.equal(classifyTool(tool).verdict, 'deny', tool);
      assert.ok(classifyTool(tool).reason.length > 0, `${tool} has a reason`);
    }
  });

  test('MCP tools are denied', () => {
    assert.equal(classifyTool('mcp__filesystem__read_file').verdict, 'deny');
    assert.equal(classifyTool('mcp_filesystem').verdict, 'deny');
  });

  test('subagent/orchestration tools are denied', () => {
    for (const tool of ['agent_spawn', 'subagent_run', 'task', 'delegate']) {
      assert.equal(classifyTool(tool).verdict, 'deny', tool);
    }
  });

  test('network tools are denied', () => {
    for (const tool of ['fetch_content', 'web_search', 'http_request', 'curl']) {
      assert.equal(classifyTool(tool).verdict, 'deny', tool);
    }
  });

  test('write and edit are confirm-only (never auto-allowed)', () => {
    assert.equal(classifyTool('write').verdict, 'confirm');
    assert.equal(classifyTool('edit').verdict, 'confirm');
  });

  test('unknown tools are denied (fail closed)', () => {
    assert.equal(classifyTool('something_entirely_new').verdict, 'deny');
    assert.equal(classifyTool('').verdict, 'deny');
    assert.equal(classifyTool(null).verdict, 'deny');
  });
});

describe('policy: workspace path guard', () => {
  test('paths inside the workspace are allowed', () => {
    const res = checkWorkspacePath({ workspaceRoot: WS, requestedPath: 'src/store.mjs' });
    assert.equal(res.verdict, 'allow');
    assert.ok(resolve(res.resolved).toLowerCase().startsWith(resolve(WS).toLowerCase()));
  });

  test('absolute paths inside the workspace are allowed', () => {
    const res = checkWorkspacePath({ workspaceRoot: WS, requestedPath: join(WS, 'README.md') });
    assert.equal(res.verdict, 'allow');
  });

  test('traversal outside the workspace is denied', () => {
    const res = checkWorkspacePath({ workspaceRoot: WS, requestedPath: '../sibling/secret.txt' });
    assert.equal(res.verdict, 'deny');
  });

  test('absolute paths outside the workspace are denied', () => {
    const res = checkWorkspacePath({ workspaceRoot: WS, requestedPath: 'C:/Windows/System32/config' });
    assert.equal(res.verdict, 'deny');
  });

  test('sensitive files are denied even inside the workspace', () => {
    for (const p of ['.env', '.env.local', '.git/config', '.pi/skills/x/SKILL.md', 'secrets/id_rsa', 'server.pem']) {
      const res = checkWorkspacePath({ workspaceRoot: WS, requestedPath: p });
      assert.equal(res.verdict, 'deny', p);
    }
  });

  test('sensitive matching is case-insensitive (Windows reality)', () => {
    const res = checkWorkspacePath({ workspaceRoot: WS, requestedPath: 'TOOLS/.ENV' });
    assert.equal(res.verdict, 'deny');
  });

  test('malformed input is denied, not thrown', () => {
    assert.equal(checkWorkspacePath({ workspaceRoot: WS, requestedPath: null }).verdict, 'deny');
    assert.equal(checkWorkspacePath({ workspaceRoot: null, requestedPath: 'a.txt' }).verdict, 'deny');
  });

  test('bridge module private state (.local) is sensitive', () => {
    const res = checkWorkspacePath({ workspaceRoot: WS, requestedPath: '.local/backups/x.mjs' });
    assert.equal(res.verdict, 'deny');
  });
});

describe('policy: realpath containment (B5)', () => {
  // Hermetic fake fs: path map keyed by resolved lowercase path.
  function fakeFs(entriesRaw) {
    const entries = new Map();
    for (const [p, node] of entriesRaw) entries.set(resolve(p).toLowerCase(), node);
    const norm = (p) => resolve(p).toLowerCase();
    const lookup = (p) => entries.get(norm(p));
    const real = (p, seen = new Set()) => {
      const e = lookup(p);
      if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (e.type !== 'symlink') return resolve(p);
      const key = norm(p);
      if (seen.has(key)) throw new Error('ELOOP');
      seen.add(key);
      return real(e.target, seen);
    };
    return {
      existsSync: (p) => entries.has(norm(p)),
      realpathSync: (p) => real(p),
      lstatSync: (p) => ({ isSymbolicLink: () => lookup(p)?.type === 'symlink' }),
    };
  }

  const ROOT = 'C:/wrk/WS';

  test('symlink inside the workspace pointing outside is denied', () => {
    const fsOps = fakeFs(new Map([
      [resolve(ROOT), { type: 'dir' }],
      [resolve(ROOT, 'escape'), { type: 'symlink', target: 'C:/Elsewhere' }],
      [resolve('C:/Elsewhere'), { type: 'dir' }],
      [resolve('C:/Elsewhere/secret.txt'), { type: 'file' }],
    ]));
    const res = checkWorkspacePath({ workspaceRoot: ROOT, requestedPath: 'escape/secret.txt', fs: fsOps });
    assert.equal(res.verdict, 'deny');
  });

  test('lexical containment through a symlinked ancestor is denied via realpath', () => {
    const fsOps = fakeFs(new Map([
      [resolve(ROOT), { type: 'dir' }],
      [resolve(ROOT, 'dir'), { type: 'symlink', target: 'C:/Elsewhere' }],
      [resolve('C:/Elsewhere'), { type: 'dir' }],
      [resolve('C:/Elsewhere/file.txt'), { type: 'file' }],
    ]));
    const res = checkWorkspacePath({ workspaceRoot: ROOT, requestedPath: 'dir/file.txt', fs: fsOps });
    assert.equal(res.verdict, 'deny', 'canonical path escapes even though lexical rel is inside');
  });

  test('paths under a symlinked ancestor that resolve INSIDE stay allowed but canonical', () => {
    const fsOps = fakeFs(new Map([
      [resolve(ROOT), { type: 'dir' }],
      [resolve(ROOT, 'link'), { type: 'symlink', target: 'C:/wrk/WS/real' }],
      [resolve(ROOT, 'real'), { type: 'dir' }],
      [resolve(ROOT, 'real/a.txt'), { type: 'file' }],
    ]));
    const res = checkWorkspacePath({ workspaceRoot: ROOT, requestedPath: 'link/a.txt', fs: fsOps });
    // Interior symlinks that stay inside the workspace are contained, but
    // the link component itself is still rejected (fail closed, TOCTOU).
    assert.equal(res.verdict, 'deny');
  });

  test('deepest existing ancestor is canonicalized for not-yet-created files', () => {
    const fsOps = fakeFs(new Map([
      [resolve(ROOT), { type: 'dir' }],
      [resolve(ROOT, 'real'), { type: 'dir' }],
      [resolve(ROOT, 'real', 'newdir'), { type: 'dir' }],
    ]));
    const res = checkWorkspacePath({ workspaceRoot: ROOT, requestedPath: 'real/newdir/newfile.txt', fs: fsOps });
    assert.equal(res.verdict, 'allow');
    assert.ok(resolve(res.resolved).toLowerCase().startsWith(resolve(ROOT, 'real').toLowerCase()));
  });

  test('default fs is used when none is injected (real filesystem sanity)', () => {
    const res = checkWorkspacePath({ workspaceRoot: WS, requestedPath: 'src/store.mjs' });
    assert.equal(res.verdict, 'allow');
  });
});

describe('policy: action fingerprint', () => {
  test('deterministic and independent of key order', () => {
    const a = actionFingerprint({ tool: 'write', args: { path: 'a.txt', content: 'x' } });
    const b = actionFingerprint({ tool: 'write', args: { content: 'x', path: 'a.txt' } });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  test('different tool or args produce different fingerprints', () => {
    const base = actionFingerprint({ tool: 'write', args: { path: 'a.txt', content: 'x' } });
    assert.notEqual(base, actionFingerprint({ tool: 'edit', args: { path: 'a.txt', content: 'x' } }));
    assert.notEqual(base, actionFingerprint({ tool: 'write', args: { path: 'a.txt', content: 'y' } }));
  });
});

describe('policy: dated backup plan', () => {
  test('backup path is next to the target with a dated suffix', () => {
    const res = planBackupPath({
      targetPath: join(WS, 'src/store.mjs'),
      now: Date.UTC(2026, 8, 21, 14, 30, 5),
    });
    assert.equal(res.backupPath, join(WS, 'src/store.mjs.bridge-backup-20260921-143005'));
    assert.equal(res.verdict, 'ok');
  });

  test('unusable target paths are blocked, never silently backed up', () => {
    const res = planBackupPath({ targetPath: null, now: 0 });
    assert.equal(res.verdict, 'block');
  });
});

describe('policy: sensitive-content scan for chat transport', () => {
  test('detects common credential shapes', () => {
    for (const text of [
      'my token is ghp_16C7e42F292c6912E7710c838347Ae178B4a',
      'AWS key AKIAIOSFODNN7EXAMPLE in logs',
      'sk-proj-abcdef1234567890',
      'bot123456:AAHfiqksKZ8WmoZ_M1b3tGvBbCST12e3456',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c',
    ]) {
      assert.equal(containsSensitive(text), true, text.slice(0, 30));
    }
  });

  test('ordinary text is clean', () => {
    for (const text of ['fix the store bug', 'generation is 3', 'request r-1 expired']) {
      assert.equal(containsSensitive(text), false, text);
    }
  });
});
