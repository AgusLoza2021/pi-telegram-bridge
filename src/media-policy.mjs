// Outbound media policy for ONE photo (additive slice).
//
// This module is pure with respect to the outside world: it performs no
// network I/O, never touches Telegram, and never imports any transport
// module. It only inspects the local filesystem and either accepts the
// photo or fails closed with a small typed error carrying a fixed
// machine-readable code — never a raw fs message, never a path.
//
// Policy:
// - The resolved real path must stay inside an allowed root (default:
//   the process cwd, overridable by the caller). `..` escapes and
//   symlinks/junctions whose target leaves the root are refused.
// - Extension allowlist: .png, .jpg, .jpeg, .webp (case-insensitive).
// - Size cap: MAX_PHOTO_BYTES (10 MB). The file must exist and be a
//   regular file, not a directory.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';

/** Hard cap for one outbound photo: 10 MB. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Case-insensitive extension allowlist, stored lowercase. */
export const PHOTO_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp']);

/** Fixed-code rejection. The message carries only the code. */
export class MediaPolicyError extends Error {
  /**
   * @param {string} code one of: bad_path, bad_root, path_escape,
   *   not_found, not_a_file, bad_extension, too_large
   */
  constructor(code) {
    super(`media policy rejected: ${code}`);
    this.name = 'MediaPolicyError';
    this.code = code;
  }
}

function escapes(base, candidate) {
  const back = relative(base, candidate);
  // Matches the containment convention used by src/state-paths.mjs.
  return back === '' || back.startsWith('..') || isAbsolute(back);
}

/**
 * Validate one outbound photo and return the exact bytes to send.
 *
 * @param {object} options
 * @param {string} options.filePath path of the photo; absolute paths are
 *   accepted only when they resolve inside the allowed root
 * @param {string} [options.root] allowed root directory (default: the
 *   process cwd); must be absolute and must exist
 * @param {number} [options.maxBytes] size cap (default: MAX_PHOTO_BYTES)
 * @returns {{realPath: string, filename: string, bytes: Buffer}}
 *   realPath is the symlink-resolved absolute path inside the root,
 *   filename is the upload filename, bytes are the file contents.
 * @throws {MediaPolicyError} with a fixed code on any policy violation
 */
export function validateOutboundPhoto({ filePath, root = process.cwd(), maxBytes = MAX_PHOTO_BYTES } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
    throw new MediaPolicyError('bad_path');
  }
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0') || !isAbsolute(root)) {
    throw new MediaPolicyError('bad_root');
  }
  const absRoot = resolve(root);
  let rootStats;
  try {
    rootStats = statSync(absRoot);
  } catch {
    throw new MediaPolicyError('bad_root');
  }
  if (!rootStats.isDirectory()) throw new MediaPolicyError('bad_root');
  // Symlink-resolve the root itself so a link planted as the root cannot
  // be used to fake containment for a target that really sits outside.
  let realRoot;
  try {
    realRoot = realpathSync(absRoot);
  } catch {
    throw new MediaPolicyError('bad_root');
  }

  const candidate = resolve(absRoot, filePath);
  if (escapes(absRoot, candidate)) throw new MediaPolicyError('path_escape');

  // Lexical containment is not enough: a symlink or junction inside the
  // root may point outside. The real target must stay inside the real
  // root for the photo to be accepted.
  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new MediaPolicyError('not_found');
  }
  if (escapes(realRoot, real)) throw new MediaPolicyError('path_escape');

  if (!PHOTO_EXTENSIONS.includes(extname(real).toLowerCase())) {
    throw new MediaPolicyError('bad_extension');
  }
  let stats;
  try {
    stats = statSync(real);
  } catch {
    throw new MediaPolicyError('not_found');
  }
  if (!stats.isFile()) throw new MediaPolicyError('not_a_file');
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new MediaPolicyError('bad_root');
  }
  if (stats.size > maxBytes) throw new MediaPolicyError('too_large');

  let bytes;
  try {
    bytes = readFileSync(real);
  } catch {
    throw new MediaPolicyError('not_found');
  }
  return { realPath: real, filename: basename(real), bytes };
}
