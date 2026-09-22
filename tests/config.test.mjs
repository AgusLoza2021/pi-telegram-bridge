// T01 config contract tests, rev 2 (defects B1-B5).
// Precedence: defaults < local JSON file < environment. Deliberately empty
// env credentials fail closed; absent env falls back to the file.
// No real credentials: every "secret" below is an obviously fake fixture.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, ConfigError } from '../src/config.mjs';

const FAKE_TOKEN = '1234567890:FAKE_fixture_token_not_real_abcDEFghi';
const FAKE_USER = '111111111';
const FAKE_CHAT = '222222222';

function envWith(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_ALLOWED_USER_ID: FAKE_USER,
    TELEGRAM_ALLOWED_CHAT_ID: FAKE_CHAT,
    ...overrides,
  };
}

// Test artifacts live only under the module's ignored .local/test-runs.
const TEST_RUNS = fileURLToPath(new URL('../.local/test-runs/', import.meta.url));
mkdirSync(TEST_RUNS, { recursive: true });

function writeConfigFile(name, content) {
  const dir = mkdtempSync(join(TEST_RUNS, 'cfg-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

describe('config: valid environment', () => {
  test('parses required values and applies safe defaults', () => {
    const cfg = loadConfig({ env: envWith() });
    assert.equal(cfg.telegram.botToken, FAKE_TOKEN);
    assert.equal(cfg.telegram.allowedUserId, FAKE_USER);
    assert.equal(cfg.telegram.allowedChatId, FAKE_CHAT);
    assert.equal(cfg.store.dbPath.endsWith('.local/state/bridge.sqlite'), true);
    assert.equal(cfg.store.busyTimeoutMs, 5000);
    assert.equal(cfg.store.maxPayloadBytes, 16384);
    assert.equal(cfg.store.maxActionBytes, 8192);
    assert.equal(cfg.bridge.requestTtlMs, 600000);
    assert.equal(cfg.bridge.maxMessageChars, 3800);
    assert.equal(cfg.bridge.rateLimit.max, 10);
    assert.equal(cfg.bridge.rateLimit.windowMs, 60000);
    // Host generation is managed by the host, never user configuration.
    assert.equal('hostGeneration' in cfg.bridge, false);
  });

  test('environment overrides defaults and file', () => {
    const file = writeConfigFile('env-over-file', { bridge: { requestTtlMs: 1000 } });
    const cfg = loadConfig({
      env: envWith({ BRIDGE_REQUEST_TTL_MS: '2000' }),
      file,
    });
    assert.equal(cfg.bridge.requestTtlMs, 2000);
  });

  test('local file overrides defaults for non-credential fields', () => {
    const file = writeConfigFile('file-over-defaults', {
      pi: { cliPath: 'C:/fake/pi', workspace: 'C:/fake/ws' },
    });
    const cfg = loadConfig({ env: envWith(), file });
    assert.equal(cfg.pi.cliPath, 'C:/fake/pi');
    assert.equal(cfg.pi.workspace, 'C:/fake/ws');
  });

  test('rejects values beyond hard upper bounds', () => {
    const cases = [
      ['BRIDGE_MAX_MESSAGE_CHARS', '4000'],
      ['BRIDGE_REQUEST_TTL_MS', String(86400000 + 1)],
      ['BRIDGE_RATE_LIMIT_MAX', '1001'],
      ['BRIDGE_RATE_LIMIT_WINDOW_MS', String(3600000 + 1)],
    ];
    for (const [name, value] of cases) {
      assert.throws(
        () => loadConfig({ env: envWith({ [name]: value }) }),
        ConfigError,
        `${name}=${value} should be rejected`,
      );
    }
  });

  test('rejects non-positive store and bridge numbers', () => {
    const file = writeConfigFile('bad-numbers', {
      store: { busyTimeoutMs: 0, maxPayloadBytes: -1, maxActionBytes: 0 },
      bridge: { requestTtlMs: 0, maxMessageChars: 0, rateLimit: { max: 0, windowMs: -5 } },
    });
    assert.throws(() => loadConfig({ env: envWith(), file }), ConfigError);
  });
});

describe('config: precedence for credentials (B1)', () => {
  const fileWithCreds = () => writeConfigFile('file-creds', {
    telegram: {
      botToken: FAKE_TOKEN,
      allowedUserId: FAKE_USER,
      allowedChatId: FAKE_CHAT,
    },
  });

  test('absent env falls back to file credentials', () => {
    const cfg = loadConfig({ env: {}, file: fileWithCreds() });
    assert.equal(cfg.telegram.botToken, FAKE_TOKEN);
    assert.equal(cfg.telegram.allowedUserId, FAKE_USER);
    assert.equal(cfg.telegram.allowedChatId, FAKE_CHAT);
  });

  test('deliberate empty env credentials fail even when the file has them', () => {
    assert.throws(
      () => loadConfig({ env: envWith({ TELEGRAM_BOT_TOKEN: '' }), file: fileWithCreds() }),
      ConfigError,
    );
    assert.throws(
      () => loadConfig({ env: { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_ALLOWED_USER_ID: '', TELEGRAM_ALLOWED_CHAT_ID: FAKE_CHAT }, file: fileWithCreds() }),
      ConfigError,
    );
  });

  test('valid env credentials override the file', () => {
    const otherToken = '0987654321:OTHER_fixture_token_not_real_XYabZc';
    const cfg = loadConfig({
      env: envWith({ TELEGRAM_BOT_TOKEN: otherToken }),
      file: fileWithCreds(),
    });
    assert.equal(cfg.telegram.botToken, otherToken);
  });

  test('absent env and no file fails closed', () => {
    assert.throws(() => loadConfig({ env: {} }), ConfigError);
  });
});

describe('config: validation without echoing secrets (B2, B4)', () => {
  test('rejects syntactically invalid tokens without echo', () => {
    for (const bad of ['no-colon-here', '1234567890:short', 'abc:AAAAaaaBBBbbbCCCcccDDDdddEEEeeeFFFg']) {
      assert.throws(
        () => loadConfig({ env: envWith({ TELEGRAM_BOT_TOKEN: bad }) }),
        (err) => err instanceof ConfigError && !err.message.includes(bad),
        `token "${'len:' + bad.length}" should be rejected`,
      );
    }
  });

  test('accepts well-formed token shape', () => {
    const cfg = loadConfig({ env: envWith() });
    assert.equal(cfg.telegram.botToken, FAKE_TOKEN);
  });

  test('unknown nested keys are rejected without echoing the key', () => {
    const file = writeConfigFile('unknown-key', {
      bridge: { unknownKeyWithSecretValue: 1 },
    });
    assert.throws(
      () => loadConfig({ env: envWith(), file }),
      (err) => err instanceof ConfigError
        && !err.message.includes('unknownKeyWithSecretValue'),
    );
  });

  test('unknown top-level sections are rejected without echoing the name', () => {
    const file = writeConfigFile('unknown-section', { secretSectionName: {} });
    assert.throws(
      () => loadConfig({ env: envWith(), file }),
      (err) => err instanceof ConfigError
        && !err.message.includes('secretSectionName'),
    );
  });

  test('unreadable or malformed files fail without echoing path or content', () => {
    assert.throws(
      () => loadConfig({ env: envWith(), file: join(TEST_RUNS, 'does-not-exist.json') }),
      (err) => err instanceof ConfigError
        && !err.message.includes('does-not-exist.json'),
    );
    const file = writeConfigFile('broken-json', '{ this is not json "');
    assert.throws(
      () => loadConfig({ env: envWith(), file }),
      (err) => err instanceof ConfigError
        && !err.message.includes('this is not json'),
    );
  });

  test('prototype-polluting keys are rejected', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const file = writeConfigFile(`proto-${key}`, { bridge: { [key]: { x: 1 } } });
      assert.throws(() => loadConfig({ env: envWith(), file }), ConfigError, key);
    }
  });

  test('pi paths must be non-empty strings; existence checked at runtime', () => {
    const file = writeConfigFile('empty-pi', { pi: { cliPath: '' } });
    assert.throws(() => loadConfig({ env: envWith(), file }), ConfigError);
    const ok = writeConfigFile('absent-pi', {});
    const cfg = loadConfig({ env: envWith(), file: ok });
    assert.equal(cfg.pi.cliPath, '');
  });
});

describe('config: numeric identity semantics (B5)', () => {
  test('user id is strictly positive decimal without leading zeros', () => {
    for (const bad of ['0', '007', '-5', '1.5', '']) {
      assert.throws(
        () => loadConfig({ env: envWith({ TELEGRAM_ALLOWED_USER_ID: bad }) }),
        ConfigError,
        `user id "${bad}" should be rejected`,
      );
    }
    assert.equal(loadConfig({ env: envWith() }).telegram.allowedUserId, FAKE_USER);
  });

  test('chat id is signed nonzero decimal without leading zeros', () => {
    for (const bad of ['0', '007', '+123', '--5', 'abc']) {
      assert.throws(
        () => loadConfig({ env: envWith({ TELEGRAM_ALLOWED_CHAT_ID: bad }) }),
        (err) => err instanceof ConfigError && !err.message.includes(bad),
        `chat id "${bad}" should be rejected`,
      );
    }
    const negative = '-100200300';
    const cfg = loadConfig({ env: envWith({ TELEGRAM_ALLOWED_CHAT_ID: negative }) });
    assert.equal(cfg.telegram.allowedChatId, negative);
  });
});

describe('config: deep freeze (B3)', () => {
  test('every returned object is frozen', () => {
    const cfg = loadConfig({ env: envWith() });
    assert.equal(Object.isFrozen(cfg), true);
    assert.equal(Object.isFrozen(cfg.telegram), true);
    assert.equal(Object.isFrozen(cfg.pi), true);
    assert.equal(Object.isFrozen(cfg.store), true);
    assert.equal(Object.isFrozen(cfg.bridge), true);
    assert.equal(Object.isFrozen(cfg.bridge.rateLimit), true);
    assert.throws(() => { cfg.bridge.maxMessageChars = 1; });
    assert.throws(() => { cfg.bridge.rateLimit.max = 1; });
  });
});
