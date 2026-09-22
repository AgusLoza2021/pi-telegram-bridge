// Remote-session policy for the Pi Telegram bridge (T02).
//
// Honest profile, documented in the README: this is NOT an OS sandbox.
// It is an allowlist + path guard + approval gate. The bridge profile:
//   - `read` inside the workspace: allowed.
//   - `write`/`edit` inside the workspace: confirmed by the human, with
//     an action fingerprint and a dated backup, or blocked if unsafe.
//   - shell, PowerShell, MCP tools, subagents, network tools, unknown
//     tools: denied.
// There are no sandbox claims and no command strings ever come from chat.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const defaultFs = { existsSync, lstatSync, realpathSync };

const CONFIRM_TOOLS = new Set(['write', 'edit']);
const ALLOW_TOOLS = new Set(['read']);

const DENY_TOOL_PATTERNS = [
  /^(bash|sh|shell|cmd|powershell|pwsh|terminal.*)$/i,
  /^mcp([_.-]|__)/i,
  /^(agent_spawn|subagent|subagent_run|delegate|task)$/i,
  /^(fetch_content|web_search|http_request|curl|wget|net_.*|http.*)$/i,
];

// Sensitive files that must never be touched by a remote session, in any
// casing, anywhere in the path.
const SENSITIVE_PATH_PATTERNS = [
  /(^|[\\/])\.env/i,
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])\.pi([\\/]|$)/i,
  /(^|[\\/])\.local([\\/]|$)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])id_rsa/i,
  /(^|[\\/])id_ed25519/i,
  /\.pem$/i,
  /(^|[\\/])credentials?([\\/]|$)/i,
];

const SENSITIVE_TEXT_PATTERNS = [
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub PAT
  /\bgho_[A-Za-z0-9]{20,}\b/, // GitHub OAuth
  /\bsk-[A-Za-z0-9_-]{20,}\b/, // OpenAI-style secret keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /[0-9]{5,10}:[A-Za-z0-9_-]{30,}/, // Telegram-style bot token (with or without 'bot' prefix)
  /\bBearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
];

/**
 * Classify a tool call from the remote session.
 * @returns {{verdict: 'allow'|'confirm'|'deny', reason?: string}}
 */
export function classifyTool(toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return { verdict: 'deny', reason: 'missing tool name' };
  }
  if (ALLOW_TOOLS.has(toolName)) return { verdict: 'allow' };
  if (CONFIRM_TOOLS.has(toolName)) {
    return { verdict: 'confirm', reason: 'write or edit needs fingerprint, human confirm and a dated backup' };
  }
  for (const pattern of DENY_TOOL_PATTERNS) {
    if (pattern.test(toolName)) {
      return { verdict: 'deny', reason: 'tool denied by bridge policy (shell/MCP/subagent/network profile)' };
    }
  }
  return { verdict: 'deny', reason: 'unknown tool: denied by default' };
}

/**
 * Lexical workspace path guard. Verdict is allow/deny; deny includes a
 * reason. Case-insensitive on the sensitive-list and containment check
 * because Windows paths are case-insensitive in practice.
 */
export function checkWorkspacePath({ workspaceRoot, requestedPath, fs: fsOps = defaultFs }) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    return { verdict: 'deny', reason: 'missing workspace root' };
  }
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    return { verdict: 'deny', reason: 'missing path' };
  }
  const root = resolve(workspaceRoot);
  const target = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
  const rel = relative(root, target);
  if (rel !== '' && rel !== '.') {
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { verdict: 'deny', reason: 'path escapes the workspace' };
    }
  }
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(requestedPath)) {
      return { verdict: 'deny', reason: 'sensitive path denied by policy' };
    }
  }

  // B5: lexical checks are not enough on Windows (junctions/symlinks).
  // Canonicalize the root AND the target through realpath (deepest existing
  // ancestor, so not-yet-created files work), then re-check containment on
  // the canonical pair.
  let canonicalRoot;
  let canonicalTarget;
  try {
    canonicalRoot = canonicalize(root, fsOps);
    canonicalTarget = canonicalize(target, fsOps);
  } catch {
    return { verdict: 'deny', reason: 'path could not be canonicalized' };
  }
  const canonicalRel = relative(canonicalRoot, canonicalTarget);
  if (canonicalRel !== '' && canonicalRel !== '.') {
    if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) {
      return { verdict: 'deny', reason: 'canonical path escapes the workspace (junction/symlink)' };
    }
  }
  // Fail closed on symlink/junction components BELOW the workspace root:
  // they can be swapped between check and use (TOCTOU).
  if (rel !== '' && rel !== '.') {
    const segments = rel.split(/[\\/]+/).filter((s) => s.length > 0);
    let prefix = canonicalRoot;
    for (const segment of segments) {
      prefix = join(prefix, segment);
      try {
        if (fsOps.lstatSync(prefix).isSymbolicLink()) {
          return { verdict: 'deny', reason: 'symlinked path component denied (TOCTOU)' };
        }
      } catch {
        // Component does not exist yet; only later components can exist.
        break;
      }
    }
  }
  return { verdict: 'allow', resolved: canonicalTarget };
}

/**
 * realpath via the deepest existing ancestor. Unresolved leaf segments are
 * re-attached so paths for files that do not exist yet still canonicalize.
 */
function canonicalize(p, fsOps) {
  let current = resolve(p);
  const leaf = [];
  for (let guard = 0; guard < 128; guard += 1) {
    if (fsOps.existsSync(current)) {
      let real = fsOps.realpathSync(current);
      for (let i = leaf.length - 1; i >= 0; i -= 1) {
        real = join(real, leaf[i]);
      }
      return real;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(p); // Filesystem root reached; nothing to canonicalize.
    }
    leaf.push(basename(current));
    current = parent;
  }
  return resolve(p);
}

/**
 * Deterministic fingerprint of one candidate action (tool + args). Two
 * runs with the same action produce the same fingerprint; humans confirm
 * fingerprints, not prose.
 */
export function actionFingerprint({ tool, args }) {
  const stable = JSON.stringify({ tool, args }, (_key, value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return value;
  });
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

function formatStamp(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * Plan the dated backup for a write/edit confirmation. Blocking verdict
 * when the target cannot be safely backed up (never silently skip).
 */
export function planBackupPath({ targetPath, now }) {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return { verdict: 'block', reason: 'missing target path' };
  }
  if (!Number.isSafeInteger(now)) {
    return { verdict: 'block', reason: 'missing timestamp' };
  }
  const stamp = formatStamp(new Date(now));
  return { verdict: 'ok', backupPath: `${targetPath}.bridge-backup-${stamp}` };
}

/**
 * Scan chat-bound text for credential shapes. If something matches, the
 * host blocks transport instead of redacting (redaction here would change
 * the meaning of a decision or an error message).
 */
export function containsSensitive(text) {
  if (typeof text !== 'string') return false;
  return SENSITIVE_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}
