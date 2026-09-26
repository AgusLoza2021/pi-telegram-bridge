// AGENTS.md contract test: the photo instructions Pi loads at startup must
// keep pointing at a real, existing script and must not drift from the policy
// those instructions describe. A stale AGENTS.md makes an agent confidently
// run the wrong command, and nothing else in the suite would catch it.
//
// No network and no credentials: this reads files and compares strings.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_PHOTO_BYTES, PHOTO_EXTENSIONS } from '../src/media-policy.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AGENTS_PATH = join(ROOT, 'AGENTS.md');

function readAgents() {
  return readFileSync(AGENTS_PATH, 'utf8');
}

describe('AGENTS.md photo instructions', () => {
  test('exists at the project root', () => {
    assert.ok(existsSync(AGENTS_PATH), 'AGENTS.md must exist for Pi to load it');
  });

  test('points at a script that exists', () => {
    const text = readAgents();
    assert.match(
      text,
      /scripts\/send-photo\.mjs/,
      'AGENTS.md must name the send-photo entry point',
    );
    assert.ok(
      existsSync(join(ROOT, 'scripts', 'send-photo.mjs')),
      'the script AGENTS.md names must exist',
    );
  });

  test('names the policy module that owns the checks', () => {
    const text = readAgents();
    assert.match(text, /src\/media-policy\.mjs/);
    assert.ok(existsSync(join(ROOT, 'src', 'media-policy.mjs')));
  });

  test('quotes every allowed extension the policy enforces', () => {
    const text = readAgents();
    for (const extension of PHOTO_EXTENSIONS) {
      assert.ok(
        text.includes(extension),
        `AGENTS.md must mention the allowed extension ${extension}`,
      );
    }
  });

  test('quotes the real size cap', () => {
    const text = readAgents();
    const megabytes = MAX_PHOTO_BYTES / (1024 * 1024);
    assert.ok(
      text.includes(`${megabytes} MB`),
      `AGENTS.md must state the real cap of ${megabytes} MB`,
    );
  });

  test('never advertises a token or chat-id argument', () => {
    const text = readAgents();
    // The CLI accepts neither; an agent that reads otherwise would try to pass
    // one. Assert on the flags, since prose may legitimately discuss the token.
    assert.doesNotMatch(text, /--token\b/i, 'the CLI accepts no --token flag');
    assert.doesNotMatch(text, /--chat[_-]?id\b/i, 'the CLI accepts no chat-id flag');
  });

  test('keeps the caveat that the destination cannot be chosen', () => {
    const text = readAgents();
    assert.match(
      text,
      /destination is not a parameter|always goes to the enrolled/i,
      'AGENTS.md must keep telling the agent it cannot pick the chat',
    );
  });
});
