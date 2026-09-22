// T04: runtime ops config loader (nonsecret). T06: added the
// broker-specific loader (loadBrokerRuntimeConfig) for the selective
// live-TUI runtime, which needs only the validated instanceId and the
// state/config identity - no pi CLI/workspace discovery. The legacy
// loader below keeps its exact strict shape for the headless host.
//
// The ops config is the operator-created JSON document in the state root
// that carries the instance identity and, for the legacy headless host,
// the pi discovery results and the followups permission flag. The
// selective live-TUI shape (bridge.mode = 'selective') needs neither. It
// contains no secrets: the Telegram credentials live exclusively in the
// DPAPI blob. Both the headless host and the worker still load the
// legacy document through loadRuntimeConfig and validate the followups
// flag with identical strictness — permission duplication would create
// a bypass window.

import { readFileSync } from 'node:fs';

export class RuntimeConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeConfigError';
    this.code = code;
  }
}

const INSTANCE_RE = /^[0-9a-f]{32}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(obj, expected) {
  return isPlainObject(obj)
    && Object.keys(obj).length === expected.length
    && expected.every((k) => Object.hasOwn(obj, k));
}

function fail(code, detail) {
  throw new RuntimeConfigError(code, `runtime config rejected (${detail})`);
}

/**
 * Broker-specific runtime config loader (T06, selective live-TUI mode).
 *
 * Accepts BOTH shapes so an existing ops config stays readable and
 * migratable without ever rewriting it behind the operator's back:
 * - selective:  { version, instanceId, bridge: { mode: 'selective' } }
 * - legacy:     the exact headless shape accepted by loadRuntimeConfig
 *               (pi.cliPath/workspace + bridge.followupsEnabled)
 *
 * Everything else fails closed with the same error codes and
 * content-free messages as loadRuntimeConfig.
 *
 * @param {string} path absolute or repo-relative path to runtime.json
 * @returns {{version: number, instanceId: string,
 *            mode: 'selective'|'legacy-headless',
 *            pi?: {cliPath: string, workspace: string},
 *            bridge: {mode?: string, followupsEnabled?: boolean}}}
 */
export function loadBrokerRuntimeConfig(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new RuntimeConfigError('no_config', 'runtime ops config is missing');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('bad_config', 'not valid JSON');
  }
  if (!isPlainObject(parsed)) fail('bad_config', 'unexpected top-level shape');
  if (exactKeys(parsed, ['version', 'instanceId', 'bridge'])) {
    // Selective live-TUI shape: no pi discovery is required. The broker
    // never spawns or owns Pi, so nothing else may be mandatory here.
    if (parsed.version !== 1) fail('bad_config', 'unsupported version');
    if (typeof parsed.instanceId !== 'string' || !INSTANCE_RE.test(parsed.instanceId)) {
      fail('bad_config', 'bad instance id');
    }
    if (!exactKeys(parsed.bridge, ['mode'])) fail('bad_config', 'bad bridge section');
    if (parsed.bridge.mode !== 'selective') fail('bad_config', 'bridge.mode must be selective');
    return {
      version: parsed.version,
      instanceId: parsed.instanceId,
      mode: 'selective',
      bridge: { mode: 'selective' },
    };
  }
  // Legacy headless shape stays readable by the broker: the pi section
  // is validated with the same strictness as the headless host but is
  // simply not consumed by the broker.
  if (exactKeys(parsed, ['version', 'instanceId', 'pi', 'bridge'])) {
    const legacy = loadRuntimeConfig(path);
    return { ...legacy, mode: 'legacy-headless' };
  }
  fail('bad_config', 'unexpected top-level shape');
}

/**
 * Load and validate the runtime ops config. Error codes: 'no_config',
 * 'bad_config'. Error messages never quote file content.
 *
 * @param {string} path absolute or repo-relative path to runtime.json
 * @returns {{version: number, instanceId: string, pi: {cliPath: string, workspace: string}, bridge: {followupsEnabled: boolean}}}
 */
export function loadRuntimeConfig(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new RuntimeConfigError('no_config', 'runtime ops config is missing');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('bad_config', 'not valid JSON');
  }
  if (!exactKeys(parsed, ['version', 'instanceId', 'pi', 'bridge'])) fail('bad_config', 'unexpected top-level shape');
  if (parsed.version !== 1) fail('bad_config', 'unsupported version');
  if (typeof parsed.instanceId !== 'string' || !INSTANCE_RE.test(parsed.instanceId)) {
    fail('bad_config', 'bad instance id');
  }
  if (!exactKeys(parsed.pi, ['cliPath', 'workspace'])) fail('bad_config', 'bad pi section');
  if (typeof parsed.pi.cliPath !== 'string' || parsed.pi.cliPath.length === 0) fail('bad_config', 'bad pi.cliPath');
  if (typeof parsed.pi.workspace !== 'string' || parsed.pi.workspace.length === 0) fail('bad_config', 'bad pi.workspace');
  if (!exactKeys(parsed.bridge, ['followupsEnabled'])) fail('bad_config', 'bad bridge section');
  if (typeof parsed.bridge.followupsEnabled !== 'boolean') fail('bad_config', 'bridge.followupsEnabled must be boolean');
  return {
    version: parsed.version,
    instanceId: parsed.instanceId,
    pi: { cliPath: parsed.pi.cliPath, workspace: parsed.pi.workspace },
    bridge: { followupsEnabled: parsed.bridge.followupsEnabled },
  };
}
