// Media policy tests (additive slice): no network, no Telegram, no real
// credentials. Every case runs against real files inside a fresh temp
// directory, so symlink/junction behavior is exercised against the real
// filesystem (junction fallback keeps the escape test portable on
// Windows, where file symlinks may require privileges).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateOutboundPhoto,
  MediaPolicyError,
  MAX_PHOTO_BYTES,
  PHOTO_EXTENSIONS,
} from '../src/media-policy.mjs';

const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeRoot(label) {
  const root = mkdtempSync(join(TEST_RUNS, `media-${label}-`));
  mkdirSync(join(root, 'inside'), { recursive: true });
  return root;
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MediaPolicyError, `expected MediaPolicyError, got ${error.name}: ${error.message}`);
    return error.code;
  }
  assert.fail('expected the policy to reject the input');
}

describe('media-policy: extension allowlist', () => {
  test('accepts every allowed extension, case-insensitively', () => {
    for (const ext of PHOTO_EXTENSIONS) {
      const root = makeRoot('allow');
      const file = join(root, `photo${ext}`);
      writeFileSync(file, PNG_MAGIC);
      const photo = validateOutboundPhoto({ filePath: file, root });
      assert.equal(photo.filename, `photo${ext}`);
      assert.ok(photo.bytes.equals(PNG_MAGIC));
    }
  });

  test('accepts an uppercase extension', () => {
    const root = makeRoot('upper');
    const file = join(root, 'photo.PNG');
    writeFileSync(file, PNG_MAGIC);
    const photo = validateOutboundPhoto({ filePath: file, root });
    assert.equal(photo.filename, 'photo.PNG');
  });

  for (const [name, file] of [['a .txt file', 'notes.txt'], ['a file with no extension', 'photo']]) {
    test(`refuses ${name} with a fixed code`, () => {
      const root = makeRoot('ext');
      const file2 = join(root, file);
      writeFileSync(file2, 'hello');
      assert.equal(codeOf(() => validateOutboundPhoto({ filePath: file2, root })), 'bad_extension');
    });
  }
});

describe('media-policy: size cap', () => {
  test('the cap constant is exactly 10 MB', () => {
    assert.equal(MAX_PHOTO_BYTES, 10 * 1024 * 1024);
  });

  test('refuses a file one byte over the cap', () => {
    const root = makeRoot('cap');
    const file = join(root, 'big.png');
    writeFileSync(file, Buffer.alloc(MAX_PHOTO_BYTES + 1, 0x41));
    assert.equal(codeOf(() => validateOutboundPhoto({ filePath: file, root })), 'too_large');
  });

  test('accepts a file exactly at the cap', () => {
    const root = makeRoot('capok');
    const file = join(root, 'exact.png');
    writeFileSync(file, Buffer.alloc(MAX_PHOTO_BYTES, 0x41));
    const photo = validateOutboundPhoto({ filePath: file, root });
    assert.equal(photo.bytes.length, MAX_PHOTO_BYTES);
  });
});

describe('media-policy: root containment', () => {
  test('refuses a .. escape with a fixed code', () => {
    const root = makeRoot('escape');
    const outside = mkdtempSync(join(TEST_RUNS, 'media-outside-'));
    const file = join(outside, 'photo.png');
    writeFileSync(file, PNG_MAGIC);
    assert.equal(
      codeOf(() => validateOutboundPhoto({ filePath: join(root, '..', 'photo.png'), root })),
      'path_escape',
    );
    // The same escape through an absolute path outside the root.
    assert.equal(codeOf(() => validateOutboundPhoto({ filePath: file, root })), 'path_escape');
  });

  test('accepts a .. traversal that resolves back inside the root', () => {
    const root = makeRoot('back');
    writeFileSync(join(root, 'photo.png'), PNG_MAGIC);
    const photo = validateOutboundPhoto({ filePath: join(root, 'inside', '..', 'photo.png'), root });
    assert.equal(photo.filename, 'photo.png');
  });

  test('refuses a symlink whose target leaves the root (junction fallback on Windows)', () => {
    const root = makeRoot('sym');
    const outsideDir = mkdtempSync(join(TEST_RUNS, 'media-sym-out-'));
    const outsideFile = join(outsideDir, 'photo.png');
    writeFileSync(outsideFile, PNG_MAGIC);

    let made = null;
    try {
      symlinkSync(outsideFile, join(root, 'link.png'), 'file');
      made = 'file';
    } catch {
      // File symlinks may need privileges on Windows; a directory
      // junction needs none and escapes the root the same way.
      try {
        symlinkSync(outsideDir, join(root, 'linkdir'), 'junction');
        made = 'junction';
      } catch {
        made = null;
      }
    }
    if (made === null) {
      assert.ok(true, 'skipped: this platform grants neither file symlinks nor junctions here');
      return;
    }
    const linkPath = made === 'file' ? join(root, 'link.png') : join(root, 'linkdir', 'photo.png');
    assert.equal(codeOf(() => validateOutboundPhoto({ filePath: linkPath, root })), 'path_escape');
  });

  test('accepts a symlink that stays inside the root when one can be created', () => {
    const root = makeRoot('sym-in');
    writeFileSync(join(root, 'real.png'), PNG_MAGIC);
    let made = false;
    try {
      symlinkSync(join(root, 'real.png'), join(root, 'alias.png'), 'file');
      made = true;
    } catch {
      made = false;
    }
    if (!made) {
      assert.ok(true, 'skipped: file symlinks are not grantable on this platform');
      return;
    }
    const photo = validateOutboundPhoto({ filePath: join(root, 'alias.png'), root });
    assert.ok(photo.bytes.equals(PNG_MAGIC));
  });
});

describe('media-policy: file shape and root sanity', () => {
  test('refuses a missing file with a fixed code', () => {
    const root = makeRoot('missing');
    assert.equal(codeOf(() => validateOutboundPhoto({ filePath: join(root, 'ghost.png'), root })), 'not_found');
  });

  test('refuses a directory named like a photo with a fixed code', () => {
    const root = makeRoot('dir');
    mkdirSync(join(root, 'photo.png'));
    assert.equal(codeOf(() => validateOutboundPhoto({ filePath: join(root, 'photo.png'), root })), 'not_a_file');
  });

  test('refuses a non-absolute root with a fixed code', () => {
    const root = makeRoot('abs');
    const file = join(root, 'photo.png');
    writeFileSync(file, PNG_MAGIC);
    assert.equal(codeOf(() => validateOutboundPhoto({ filePath: file, root: 'relative/root' })), 'bad_root');
  });

  test('refuses a root that does not exist with a fixed code', () => {
    const root = makeRoot('no-root');
    const file = join(root, 'photo.png');
    writeFileSync(file, PNG_MAGIC);
    assert.equal(
      codeOf(() => validateOutboundPhoto({ filePath: file, root: join(root, 'nope') })),
      'bad_root',
    );
  });

  test('refuses a missing or empty path argument with a fixed code', () => {
    const root = makeRoot('badpath');
    assert.equal(codeOf(() => validateOutboundPhoto({ root })), 'bad_path');
    assert.equal(codeOf(() => validateOutboundPhoto({ filePath: '', root })), 'bad_path');
  });

  test('default root is the process cwd', () => {
    const root = makeRoot('cwd');
    const file = join(root, 'photo.png');
    writeFileSync(file, PNG_MAGIC);
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const photo = validateOutboundPhoto({ filePath: 'photo.png' });
      assert.equal(photo.filename, 'photo.png');
    } finally {
      process.chdir(previousCwd);
    }
  });
});
