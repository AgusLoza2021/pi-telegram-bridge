// T04: confined state path resolution.
//
// The bridge state root lives under the module's .local directory. All
// state-file resolution goes through resolveStatePath, which fails closed
// on escapes and on symlink/junction reparse points inside the root chain
// (the classic Windows escape hatch). Only components AT or BELOW the state
// root are inspected — ancestors (e.g. a OneDrive-redirected profile) are
// intentionally not scanned to avoid false positives.

import { lstatSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export class StatePathError extends Error {
  constructor(code) {
    super(`state path rejected: ${code}`);
    this.name = 'StatePathError';
    this.code = code;
  }
}

const defaultFs = {
  lstat: (path) => lstatSync(path),
  exists: (path) => existsSync(path),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  stat: (path) => statSync(path),
};

/**
 * Resolve `relative` under `root`, refusing escapes and reparse points.
 * @param {{root: string, relative: string, fs?: object}} options
 * @returns {string} absolute, confined path
 */
export function resolveStatePath({ root, relative: rel, fs = defaultFs }) {
  if (typeof root !== 'string' || root.length === 0 || typeof rel !== 'string' || rel.length === 0) {
    throw new StatePathError('bad_path');
  }
  if (rel.includes('\0')) throw new StatePathError('bad_path');

  const absRoot = resolve(root);
  const target = resolve(absRoot, rel);
  if (isAbsolute(rel) && resolve(rel) !== target) {
    throw new StatePathError('path_escape');
  }
  const back = relative(absRoot, target);
  if (back === '' || back.startsWith('..') || isAbsolute(back)) {
    throw new StatePathError('path_escape');
  }

  // Walk every component at or below the root; a symlink or junction in
  // the chain is an escape attempt (libuv reports junctions as symlinks).
  let current = absRoot;
  const parts = back.split(sep);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stats;
    try {
      stats = fs.lstat(current);
    } catch {
      break; // Does not exist yet: nothing below can be a reparse point.
    }
    if (stats.isSymbolicLink()) {
      throw new StatePathError('reparse_escape');
    }
    if (i < parts.length - 1 && !stats.isDirectory()) {
      throw new StatePathError('not_a_directory');
    }
  }
  return target;
}

/**
 * Create the state root (and any missing parents at or below the first
 * existing ancestor), refusing reparse points in the chain. Idempotent.
 * @param {{root: string, fs?: object}} options
 */
export function ensureStateRoot(root, fs = defaultFs) {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    throw new StatePathError('bad_path');
  }
  const absRoot = resolve(root);
  let current = absRoot;
  const missing = [];
  // Find the deepest existing ancestor, checking each candidate component.
  for (;;) {
    if (fs.exists(current)) {
      let stats;
      try {
        stats = fs.lstat(current);
      } catch {
        throw new StatePathError('reparse_escape');
      }
      if (stats.isSymbolicLink()) throw new StatePathError('reparse_escape');
      if (!stats.isDirectory()) throw new StatePathError('not_a_directory');
      break;
    }
    missing.push(current);
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  fs.mkdir(absRoot);
  // Re-verify: another process must not have swapped in a reparse point.
  let finalStats;
  try {
    finalStats = fs.lstat(absRoot);
  } catch {
    throw new StatePathError('not_a_directory');
  }
  if (finalStats.isSymbolicLink() || !finalStats.isDirectory()) {
    throw new StatePathError('reparse_escape');
  }
  return absRoot;
}
