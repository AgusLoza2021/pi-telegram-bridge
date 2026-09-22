import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (relativePath) => readFileSync(join(ROOT, relativePath), 'utf8');

const TEXT_EXTENSIONS = new Set(['.cmd', '.json', '.md', '.mjs', '.ps1', '.ts', '.yml']);
function publicTextFiles(directory = ROOT) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (['.git', '.local', '.atl', 'node_modules'].includes(entry)) continue;
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...publicTextFiles(absolute));
    } else if (TEXT_EXTENSIONS.has(extname(entry)) || entry === '.gitignore' || entry === 'LICENSE') {
      files.push(absolute);
    }
  }
  return files;
}

const REQUIRED = [
  'LICENSE',
  'SECURITY.md',
  'CONTRIBUTING.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/pull_request_template.md',
];

describe('public repository hygiene', () => {
  test('ships the required legal, security and contributor surfaces', () => {
    for (const relative of REQUIRED) {
      assert.equal(existsSync(join(ROOT, relative)), true, `${relative} must exist`);
    }
    assert.match(read('LICENSE'), /^MIT License\r?$/m);
    assert.equal(JSON.parse(read('package.json')).license, 'MIT');
    assert.match(read('README.md'), /\[MIT License\]\(LICENSE\)/);
    assert.match(read('README.md'), /\[SECURITY\.md\]\(SECURITY\.md\)/);
    assert.match(read('README.md'), /\[CONTRIBUTING\.md\]\(CONTRIBUTING\.md\)/);
    assert.match(read('.gitignore'), /^\.atl\/$/m, 'Pi-local runtime metadata must stay untracked');
  });

  test('security policy names the protected data and private reporting route', () => {
    const policy = read('SECURITY.md');
    assert.match(policy, /Report a vulnerability/);
    assert.match(policy, /Do not open a public issue/i);
    for (const boundary of [
      'outbound Telegram long polling',
      'exact enrolled Telegram user',
      'DPAPI CurrentUser',
      'explicit `/tg` opt-in',
      'never a generic shell',
      'finalized assistant text only',
    ]) {
      assert.ok(policy.includes(boundary), `missing security boundary: ${boundary}`);
    }
    for (const protectedItem of ['bot token', 'Telegram user or chat identifiers', 'credentials.bin', 'bridge.sqlite', 'raw logs']) {
      assert.ok(policy.includes(protectedItem), `missing protected item: ${protectedItem}`);
    }
  });

  test('contributor gate is pinned and excludes real-state commands from automation', () => {
    const guide = read('CONTRIBUTING.md');
    assert.match(guide, /npm ci --ignore-scripts --omit=dev --no-audit --no-fund/);
    assert.match(guide, /npm test/);
    assert.match(guide, /scripts\/test\.ps1/);
    assert.match(guide, /should \*\*not\*\* run setup, enrollment, service-install, service-start, or Telegram smoke scripts/);
    assert.match(guide, /Conventional Commit/);
  });

  test('public issue form asks for no secret-bearing attachment or raw diagnostic', () => {
    const form = read('.github/ISSUE_TEMPLATE/bug_report.yml');
    assert.match(form, /private vulnerability-reporting flow/);
    assert.match(form, /I removed bot tokens, Telegram IDs, QR\/pairing data/);
    assert.doesNotMatch(form, /label:\s*(logs?|attachments?|database|state files?)/i);
    assert.doesNotMatch(form, /upload|attach (?:a |the )?(?:file|screenshot|log)/i);
  });

  test('pull-request template makes security and verification review explicit', () => {
    const template = read('.github/pull_request_template.md');
    assert.match(template, /Exact Telegram user \+ private-chat authorization/);
    assert.match(template, /No remote shell/);
    assert.match(template, /npm test/);
    assert.match(template, /scripts\/test\.ps1/);
  });

  test('the complete public text candidate contains no parent-repository or real-user path', () => {
    const thisTest = join(ROOT, 'tests', 'public-repo-hygiene.test.mjs');
    const candidates = publicTextFiles().filter((file) => file !== thisTest);
    const combined = candidates.map((file) => `${relative(ROOT, file)}\n${readFileSync(file, 'utf8')}`).join('\n');
    const legacyModulePath = ['tools', 'pi-telegram-bridge'].join('/');
    const internalTaskPath = ['odd', 'tasks'].join('/');
    assert.ok(!combined.toLowerCase().includes(legacyModulePath), 'legacy parent-module path leaked');
    assert.ok(!combined.toLowerCase().includes(internalTaskPath), 'internal task path leaked');
    assert.doesNotMatch(combined, /C:\\Users\\(?!you\b|me\b|x\b)|C:\/Users\/(?!you\b|me\b|x\b)/i);
  });
});
