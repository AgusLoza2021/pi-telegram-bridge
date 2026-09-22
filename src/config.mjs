// Validated configuration for the Pi Telegram bridge.
// Precedence: defaults < optional local JSON file < environment.
// Deliberately empty environment credentials fail closed; an ABSENT env var
// falls back to the file value. Validation errors name the offending field
// and NEVER echo secret values, unknown keys or path values.
// pi paths are only checked for shape here; existence/validity is verified
// at runtime or by setup scripts (T04), never via shell commands.

import { readFileSync } from 'node:fs';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const TOP_LEVEL_SECTIONS = Object.freeze(['telegram', 'pi', 'store', 'bridge']);

// Keys that could mutate object prototypes through merging.
const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

const DEFAULTS = Object.freeze({
  telegram: Object.freeze({
    botToken: '',
    allowedUserId: '',
    allowedChatId: '',
  }),
  pi: Object.freeze({
    cliPath: '',
    workspace: '',
  }),
  store: Object.freeze({
    dbPath: '.local/state/bridge.sqlite',
    busyTimeoutMs: 5000,
    maxPayloadBytes: 16384,
    maxActionBytes: 8192,
  }),
  bridge: Object.freeze({
    requestTtlMs: 600000,
    maxMessageChars: 3800,
    rateLimit: Object.freeze({ max: 10, windowMs: 60000 }),
  }),
});

// Hard bounds per numeric field path; [min, max] inclusive.
const NUMERIC_BOUNDS = Object.freeze({
  'store.busyTimeoutMs': [1, 60000],
  'store.maxPayloadBytes': [1024, 1048576],
  'store.maxActionBytes': [256, 1048576],
  'bridge.requestTtlMs': [1, 86400000],
  'bridge.maxMessageChars': [1, 3800],
  'bridge.rateLimit.max': [1, 1000],
  'bridge.rateLimit.windowMs': [1, 3600000],
});

const ENV_TO_PATH = Object.freeze({
  BRIDGE_DB_PATH: ['store', 'dbPath'],
  BRIDGE_REQUEST_TTL_MS: ['bridge', 'requestTtlMs'],
  BRIDGE_MAX_MESSAGE_CHARS: ['bridge', 'maxMessageChars'],
  BRIDGE_RATE_LIMIT_MAX: ['bridge', 'rateLimit', 'max'],
  BRIDGE_RATE_LIMIT_WINDOW_MS: ['bridge', 'rateLimit', 'windowMs'],
  PI_CLI_PATH: ['pi', 'cliPath'],
  PI_WORKSPACE: ['pi', 'workspace'],
});

// Credentials: present-but-empty env means a deliberate choice and fails
// closed instead of silently falling back to the file.
const CREDENTIAL_ENV_KEYS = Object.freeze([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_USER_ID',
  'TELEGRAM_ALLOWED_CHAT_ID',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertBounds(value, field) {
  if (!Number.isSafeInteger(value)) {
    throw new ConfigError(`${field} must be a safe integer`);
  }
  const [min, max] = NUMERIC_BOUNDS[field];
  if (value < min || value > max) {
    throw new ConfigError(`${field} is outside its allowed range`);
  }
}

// Telegram bot tokens: <bot id 8-10 digits>:<30+ secret chars>.
const BOT_TOKEN_PATTERN = /^[0-9]{8,10}:[A-Za-z0-9_-]{30,}$/;

function validateBotToken(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ConfigError('TELEGRAM_BOT_TOKEN is missing; enter it locally in .env');
  }
  if (raw.length > 256 || /\s/.test(raw) || !BOT_TOKEN_PATTERN.test(raw)) {
    throw new ConfigError('TELEGRAM_BOT_TOKEN is malformed');
  }
  if (/^placeholder|^your[_-]?token/i.test(raw)) {
    throw new ConfigError('TELEGRAM_BOT_TOKEN still contains a placeholder value');
  }
  return raw;
}

// User ids: strictly positive decimal, no leading zeros.
// Chat ids: signed nonzero decimal, no leading zeros (private or group).
const USER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const CHAT_ID_PATTERN = /^-?[1-9][0-9]{0,19}$/;

function validateUserId(raw) {
  if (typeof raw !== 'string' || !USER_ID_PATTERN.test(raw)) {
    throw new ConfigError('TELEGRAM_ALLOWED_USER_ID must be a positive decimal id without leading zeros');
  }
  return raw;
}

function validateChatId(raw) {
  if (typeof raw !== 'string' || !CHAT_ID_PATTERN.test(raw)) {
    throw new ConfigError('TELEGRAM_ALLOWED_CHAT_ID must be a signed nonzero decimal id without leading zeros');
  }
  return raw;
}

/**
 * Merge known keys recursively; unknown, forbidden or empty-string values
 * fail closed without echoing the key (keys may contain secrets).
 */
function mergeNode(target, source, section) {
  if (source === undefined || source === null) return;
  for (const [key, value] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new ConfigError(`config file contains a forbidden key in section "${section}"`);
    }
    if (!Object.hasOwn(target, key)) {
      throw new ConfigError(`config file contains an unknown key in section "${section}"`);
    }
    const current = target[key];
    if (isPlainObject(current)) {
      if (!isPlainObject(value)) {
        throw new ConfigError(`config key in section "${section}" must be an object`);
      }
      mergeNode(current, value, section);
      continue;
    }
    if (typeof value !== typeof current) {
      throw new ConfigError(`config key in section "${section}" has the wrong type`);
    }
    if (typeof value === 'string' && value.length === 0) {
      throw new ConfigError(`config key in section "${section}" must not be empty`);
    }
    target[key] = value;
  }
}

function readConfigFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    // No path echo: the path may reveal private directories.
    throw new ConfigError('config file not readable');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Intentionally no content echo: the file may hold credentials.
    throw new ConfigError('config file is not valid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError('config file must contain a JSON object');
  }
  for (const key of Object.keys(parsed)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new ConfigError('config file contains a forbidden top-level key');
    }
    if (!TOP_LEVEL_SECTIONS.includes(key)) {
      // No section name echo.
      throw new ConfigError('config file contains an unknown top-level section');
    }
  }
  return parsed;
}

function defaultConfig() {
  return {
    telegram: { ...DEFAULTS.telegram },
    pi: { ...DEFAULTS.pi },
    store: { ...DEFAULTS.store },
    bridge: { ...DEFAULTS.bridge, rateLimit: { ...DEFAULTS.bridge.rateLimit } },
  };
}

function setAtPath(config, path, value) {
  let node = config;
  for (const key of path.slice(0, -1)) node = node[key];
  node[path[path.length - 1]] = value;
}

function freezeDeep(value) {
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    return Object.freeze(value);
  }
  return value;
}

/**
 * Build the validated runtime configuration.
 * @param {object} [options]
 * @param {object} [options.env] environment map (defaults to process.env)
 * @param {string} [options.file] optional local JSON config file path
 * @returns {object} deeply frozen, validated configuration
 */
export function loadConfig({ env = process.env, file } = {}) {
  const config = defaultConfig();

  if (file !== undefined) {
    const fromFile = readConfigFile(file);
    for (const section of TOP_LEVEL_SECTIONS) {
      mergeNode(config[section], fromFile[section], section);
    }
  }

  // Credentials: absent -> keep file/default; present-but-empty -> fail;
  // non-empty -> override (validated below with everything else).
  const credentialPaths = {
    TELEGRAM_BOT_TOKEN: ['telegram', 'botToken'],
    TELEGRAM_ALLOWED_USER_ID: ['telegram', 'allowedUserId'],
    TELEGRAM_ALLOWED_CHAT_ID: ['telegram', 'allowedChatId'],
  };
  for (const name of CREDENTIAL_ENV_KEYS) {
    if (!Object.hasOwn(env, name)) continue;
    const raw = env[name];
    if (raw === '') {
      throw new ConfigError(`${name} is empty; remove the entry or fill it in locally`);
    }
    setAtPath(config, credentialPaths[name], raw);
  }

  // Optional overrides: empty/absent means "not set".
  for (const [name, path] of Object.entries(ENV_TO_PATH)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const leaf = path[path.length - 1];
    if (leaf === 'dbPath' || leaf === 'cliPath' || leaf === 'workspace') {
      if (typeof raw !== 'string' || raw.length === 0) {
        throw new ConfigError(`${name} must be a non-empty string`);
      }
      setAtPath(config, path, raw);
    } else {
      const value = Number(raw);
      assertBounds(value, path.join('.'));
      setAtPath(config, path, value);
    }
  }

  // Final validation of everything that reached the config.
  config.telegram.botToken = validateBotToken(config.telegram.botToken);
  config.telegram.allowedUserId = validateUserId(config.telegram.allowedUserId);
  config.telegram.allowedChatId = validateChatId(config.telegram.allowedChatId);

  for (const field of Object.keys(NUMERIC_BOUNDS)) {
    let node = config;
    const parts = field.split('.');
    for (const key of parts.slice(0, -1)) node = node[key];
    assertBounds(node[parts[parts.length - 1]], field);
  }

  for (const pathValue of [config.pi.cliPath, config.pi.workspace]) {
    if (pathValue !== '' && (typeof pathValue !== 'string' || pathValue.includes('\0'))) {
      throw new ConfigError('pi path options must be non-empty plain strings');
    }
  }
  if (typeof config.store.dbPath !== 'string' || config.store.dbPath.length === 0
    || config.store.dbPath.includes('\0')) {
    throw new ConfigError('store.dbPath must be a non-empty plain string');
  }

  return freezeDeep(config);
}
