// T04: permanent pure unit tests for the centralized beginner copy.
//
// No store, no network, no broker: these tests pin the exact English V1
// strings from docs/BEGINNER_UX.md (sections 2, 5-11), the readable
// `Pi · <label>` display-label builder (no double prefix, bounded for one
// Telegram button) and the guarantee that no beginner-visible builder can
// leak short ids, tracking ids, cwd, pid or jargon — even from a hostile
// label.
//
// The setup.ps1 beginner-path copy (Pi-missing warning, unsafe-folder
// refusals) is pinned as STATIC SOURCE bytes: the beginner setup flow is
// interactive by design and must never be executed by a test, so these
// assertions follow the windows-launcher.test.mjs convention of reading the
// script bytes instead of spawning PowerShell.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_BUTTON_TEXT_CHARS,
  MAX_IDENTITY_HEADER_CODE_POINTS,
  PROJECT_COLOR_FALLBACK,
  PROJECT_COLOR_SLOTS,
  displayLabel,
  identityHeader,
  homeNoLive,
  homeOne,
  homeMultiple,
  noLiveGuidance,
  plainNoLive,
  pendingSaved,
  pendingSent,
  sessionGone,
  busyCard,
  busyDiscard,
  cbAck,
  disconnectAsk,
  sessionNotice,
  eventConnected,
  eventDisconnected,
  eventStatus,
  eventCommandResult,
  HELP_TEXT,
  unknownCommand,
} from '../src/beginner-copy.mjs';
import * as copyModule from '../src/beginner-copy.mjs';

/** Every beginner-visible builder, fed the same hostile label. */
function everyBuilderOutput(label) {
  return [
    homeOne(label),
    pendingSent(label),
    sessionGone(label),
    busyCard(label),
    cbAck('followup', label),
    cbAck('steer', label),
    cbAck('prompt_after_abort', label),
    cbAck('prompt', label),
    cbAck('stop', label),
    cbAck('status', label),
    cbAck('disconnect', label),
    disconnectAsk(label),
    sessionNotice(label, 'Prompt queued.'),
    eventConnected(label),
    eventDisconnected(label),
    eventStatus(label, { state: 'busy', model: 'm' }),
    eventCommandResult(label, false, 'input_refused'),
  ];
}

const JARGON = [
  'dpapi', 'broker', 'scheduled task', 'acl', 'argv', 'sqlite', 'long poll', 'pid',
];

describe('beginner copy: displayLabel builder', () => {
  test('composes `Pi · <label>` from a plain project label', () => {
    assert.equal(displayLabel('demo-project'), 'Pi · demo-project');
    assert.equal(displayLabel('notes-app'), 'Pi · notes-app');
  });

  test('never doubles an existing readable prefix, in any of its shapes', () => {
    assert.equal(displayLabel('Pi · demo-project'), 'Pi · demo-project');
    assert.equal(displayLabel('PI - demo-project'), 'PI - demo-project');
    assert.equal(displayLabel('pi: demo-project'), 'pi: demo-project');
    assert.equal(displayLabel('Pi'), 'Pi');
    assert.equal(displayLabel('pi'), 'Pi');
  });

  test('falls back to plain `Pi` for empty, blank or non-string labels', () => {
    assert.equal(displayLabel(''), 'Pi');
    assert.equal(displayLabel('   '), 'Pi');
    assert.equal(displayLabel(undefined), 'Pi');
    assert.equal(displayLabel(null), 'Pi');
    assert.equal(displayLabel(42), 'Pi');
  });

  test('always fits one Telegram button (bounded clip)', () => {
    const long = 'x'.repeat(500);
    const composed = displayLabel(long);
    assert.equal(composed.length, MAX_BUTTON_TEXT_CHARS);
    assert.ok(composed.startsWith('Pi · '));
  });

  test('strips tg short ids, tracking hex, pid mentions and filesystem paths', () => {
    const hostile = 'tg:abc123 · aaaaaaaaaaaaaaaa1111 · pid=4242 · C:/Users/me/secret · /var/tmp · demo-project';
    const rendered = displayLabel(hostile);
    assert.equal(rendered, 'Pi · demo-project');
    assert.doesNotMatch(rendered, /abc123|aaaaaaaa|4242|Users|var/);
  });

  test('strips jargon words wherever they appear in the label', () => {
    const rendered = displayLabel('demo-project broker DPAPI acl sqlite argv');
    assert.equal(rendered, 'Pi · demo-project');
  });

  test('collapses repeated standalone separators orphaned by sanitization', () => {
    assert.equal(displayLabel(' · · · · · demo-project'), 'Pi · demo-project');
    assert.equal(displayLabel('Pi · · · · · demo-project'), 'Pi · demo-project');
    assert.equal(displayLabel('alpha · · beta'), 'Pi · alpha · beta');
    assert.equal(displayLabel('demo-project · · '), 'Pi · demo-project');
  });
});

describe('beginner copy: /start home builders (BEGINNER_UX.md section 6)', () => {
  test('homeNoLive is the exact MSG-T2 line pointing at /tg', () => {
    assert.equal(
      homeNoLive,
      "You're linked, but no Pi window is connected right now. Open Pi on your PC and type /tg.",
    );
  });

  test('homeOne names the auto-selected Pi as `Pi · <label>` (MSG-T3)', () => {
    assert.equal(
      homeOne('demo-project'),
      'Connected to Pi · demo-project. Just type a message and it goes to that Pi.',
    );
  });

  test('homeMultiple is the exact MSG-T4 question', () => {
    assert.equal(homeMultiple, 'Which Pi should I talk to?');
  });
});

describe('beginner copy: plain-text routing builders (BEGINNER_UX.md section 7)', () => {
  test('noLiveGuidance is friendly and points at /tg', () => {
    assert.match(noLiveGuidance, /^There's no Pi connected right now\./);
    assert.match(noLiveGuidance, /type \/tg/);
  });

  test('plainNoLive explicitly says the message was NOT sent', () => {
    assert.match(plainNoLive, /was not sent/);
    assert.match(plainNoLive, /type \/tg/);
  });

  test('pendingSaved is the exact MSG-P1 hold line', () => {
    assert.equal(pendingSaved, 'Your message is saved. Choose which Pi should get it:');
  });

  test('pendingSent uses `Pi · <label>` (MSG-P2)', () => {
    assert.equal(pendingSent('notes-app'), 'Sent to Pi · notes-app.');
  });

  test('sessionGone says the named Pi closed or disconnected (MSG-T5)', () => {
    assert.equal(sessionGone('demo-project'), 'Pi · demo-project just closed or disconnected. Pick another:');
  });
});

describe('beginner copy: busy and action builders (BEGINNER_UX.md sections 8-9)', () => {
  test('busyCard names the working Pi without echoing the prompt', () => {
    assert.equal(
      busyCard('demo-project'),
      'Pi · demo-project is still working on the current task. What should I do with your message?',
    );
  });

  test('cbAck maps every operation to its contract line', () => {
    assert.equal(
      cbAck('followup', 'g'),
      'Got it — Pi · g will see your message right after the current task.',
    );
    assert.equal(
      cbAck('steer', 'g'),
      "Done — Pi · g got your message and will adjust what it's doing.",
    );
    assert.equal(cbAck('abort', 'g'), 'Pi · g — Stopping the current task...');
    assert.equal(
      cbAck('prompt_after_abort', 'g'),
      'Stopped. Your message is on its way to Pi · g.',
    );
    assert.equal(cbAck('prompt', 'g'), 'Sent to Pi · g.');
    assert.equal(cbAck('stop', 'g'), 'Stopped. Pi · g is idle now.');
    assert.equal(cbAck('status', 'g'), 'Status requested for Pi · g.');
    assert.equal(cbAck('disconnect', 'g'), 'Unlinking Pi · g.');
  });

  test('busyDiscard is a fixed friendly line with no jargon', () => {
    assert.equal(
      busyDiscard,
      'Okay — the current task keeps running. Your saved message was discarded.',
    );
  });

  test('disconnectAsk is the MSG-O1 confirmation', () => {
    assert.equal(disconnectAsk('g'), 'Unlink Pi · g? You can relink it any time from the PC.');
  });

  test('sessionNotice renders `Pi · <label> — <message>`', () => {
    assert.equal(sessionNotice('alpha', 'Prompt queued.'), 'Pi · alpha — Prompt queued.');
  });
});

describe('beginner copy: event presentation (BEGINNER_UX.md sections 9 and 2)', () => {
  test('connected and disconnected events use the readable label', () => {
    assert.equal(eventConnected('alpha'), 'Pi · alpha is connected.');
    assert.equal(eventDisconnected('alpha'), 'Pi · alpha disconnected.');
  });

  test('status events show state and model but never cwd, pid or session ids', () => {
    const rendered = eventStatus('alpha', {
      state: 'busy', model: 'test-model', cwd: 'C:/proj/alpha', pid: 42, piSessionId: 'sess9',
    });
    assert.equal(rendered, 'Pi · alpha status\nstate: busy · model: test-model');
    assert.doesNotMatch(rendered, /C:|proj|42|sess9|pid|cwd|session=/);
  });

  test('status events without usable fields degrade to a fixed line', () => {
    assert.equal(eventStatus('alpha', {}), 'Pi · alpha status\nno status details');
    assert.equal(eventStatus('alpha', undefined), 'Pi · alpha status\nno status details');
  });

  test('command-result events are friendly and bounded', () => {
    assert.equal(eventCommandResult('alpha', true, null), 'Pi · alpha — command finished.');
    assert.equal(
      eventCommandResult('alpha', false, 'input_refused'),
      'Pi · alpha — command failed (input_refused).',
    );
    assert.equal(eventCommandResult('alpha', false, undefined), 'Pi · alpha — command failed (failed).');
  });
});

describe('beginner copy: /help structure and friendly errors (BEGINNER_UX.md section 11)', () => {
  test('/help opens with the three beginner sentences, then a labeled Advanced block', () => {
    const lines = HELP_TEXT.split('\n');
    assert.equal(lines[0], 'You can talk to Pi by just typing a message here.');
    assert.equal(lines[1], 'To link a Pi window, open Pi on your PC and type /tg.');
    assert.equal(lines[2], 'This private chat only accepts you — the enrolled owner.');
    assert.ok(lines.includes('Advanced commands:'), 'the advanced block must be explicitly labeled');
  });

  test('/help keeps every existing advanced slash command listed', () => {
    for (const command of ['/help', '/sessions', '/use', '/alias', '/status', '/send', '/steer', '/followup', '/abort', '/disconnect']) {
      assert.ok(HELP_TEXT.includes(command), `the advanced help must keep ${command}`);
    }
  });

  test('an unknown slash command gets the friendly MSG-E4 guidance', () => {
    assert.equal(unknownCommand, "I didn't understand that. Send /help to see what I can do.");
  });
});

describe('beginner copy: no builder ever leaks internals or jargon', () => {
  test('a hostile label full of ids, paths and jargon renders clean everywhere', () => {
    const hostile = 'tg:abc123 aaaaaaaaaaaaaaaa9999 pid=7 C:/Users/me DPAPI broker '
      + 'scheduled task ACL SQLite argv long poll C:\\Windows\\system32';
    for (const rendered of everyBuilderOutput(hostile)) {
      for (const word of JARGON) {
        assert.doesNotMatch(rendered, new RegExp(word.replace(' ', '\\s+'), 'i'),
          `jargon "${word}" leaked into: ${rendered}`);
      }
      assert.doesNotMatch(rendered, /abc123|aaaaaaaa|Users|Windows|system32|tg:/);
      assert.ok(rendered.length > 0);
    }
  });

  test('fixed strings contain no jargon at all', () => {
    for (const rendered of [homeNoLive, homeMultiple, noLiveGuidance, plainNoLive,
      pendingSaved, busyDiscard, unknownCommand]) {
      for (const word of JARGON) {
        assert.doesNotMatch(rendered, new RegExp(word.replace(' ', '\\s+'), 'i'),
          `jargon "${word}" leaked into fixed copy`);
      }
    }
  });

  test('HELP_TEXT carries jargon only inside the explicitly labeled Advanced block', () => {
    const labelIndex = HELP_TEXT.indexOf('Advanced commands:');
    assert.ok(labelIndex >= 0, 'the advanced block must be explicitly labeled');
    const beginnerPortion = HELP_TEXT.slice(0, labelIndex);
    const advancedPortion = HELP_TEXT.slice(labelIndex);
    for (const word of JARGON) {
      assert.doesNotMatch(beginnerPortion, new RegExp(word.replace(' ', '\\s+'), 'i'),
        `jargon "${word}" leaked into the beginner portion of /help`);
    }
    // "broker" is an advanced-layer word: allowed only after the label.
    assert.doesNotMatch(beginnerPortion, /broker/i);
    assert.match(advancedPortion, /broker/i);
  });
});

// --- T4B2 identity headers ---------------------------------------------------

/** Real Unicode code point count (a surrogate pair is ONE code point). */
const codePoints = (text) => [...text].length;

/** Any unpaired surrogate — must never survive into a header. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('beginner copy: identityHeader (T4B2)', () => {
  test('renders `<square> Pi · <name>` with exact alias precedence', () => {
    assert.equal(
      identityHeader({ colorSlot: 0, sessionAlias: 'win-a', projectAlias: 'proj-a', label: 'alpha' }),
      '🟦 Pi · win-a',
    );
    assert.equal(
      identityHeader({ colorSlot: 0, sessionAlias: null, projectAlias: 'proj-a', label: 'alpha' }),
      '🟦 Pi · proj-a',
    );
    assert.equal(
      identityHeader({ colorSlot: 0, sessionAlias: null, projectAlias: null, label: 'alpha' }),
      '🟦 Pi · alpha',
    );
  });

  test('appends the branch only when its ENTIRE sanitized form fits, never clipped', () => {
    assert.equal(
      identityHeader({ colorSlot: 0, label: 'alpha', branch: 'feature/one' }),
      '🟦 Pi · alpha · feature/one',
    );
    // Exactly at the 64-code-point budget: prefix(7) + name(5) + ' · '(3) + 49.
    assert.equal(
      identityHeader({ colorSlot: 0, label: 'alpha', branch: 'z'.repeat(49) }),
      `🟦 Pi · alpha · ${'z'.repeat(49)}`,
    );
    // One code point over: the branch is dropped whole, never half-shown.
    assert.equal(
      identityHeader({ colorSlot: 0, label: 'alpha', branch: 'z'.repeat(50) }),
      '🟦 Pi · alpha',
    );
    assert.equal(
      identityHeader({ colorSlot: 0, label: 'alpha', branch: '  ' }),
      '🟦 Pi · alpha',
    );
  });

  test('falls back to the neutral `⬜ Pi` on bad or missing metadata', () => {
    assert.equal(identityHeader({}), '⬜ Pi');
    assert.equal(identityHeader(), '⬜ Pi');
    assert.equal(identityHeader({ colorSlot: 3 }), '⬜ Pi');
    assert.equal(
      identityHeader({ sessionAlias: null, projectAlias: undefined, label: null }),
      '⬜ Pi',
    );
    assert.equal(identityHeader({ sessionAlias: '  ·  ·  ', label: 42 }), '⬜ Pi');
    // A bare `Pi` is not an identity: the header must never read `Pi · Pi`.
    assert.equal(identityHeader({ sessionAlias: 'Pi', label: 'Pi' }), '⬜ Pi');
  });

  test('a name that sanitizes empty falls through to the next candidate', () => {
    assert.equal(
      identityHeader({ colorSlot: 1, sessionAlias: 'tg:abc123', projectAlias: 'proj-b', label: 'alpha' }),
      '🟪 Pi · proj-b',
    );
    assert.equal(
      identityHeader({ colorSlot: 1, sessionAlias: 'tg:abc123', projectAlias: ' · · ', label: 'alpha' }),
      '🟪 Pi · alpha',
    );
  });

  test('strips ids, paths, pid mentions and jargon from every name candidate', () => {
    const header = identityHeader({
      colorSlot: 0,
      sessionAlias: 'aaaaaaaaaaaaaaaa1111 pid=7 C:/Users/me broker win',
      label: 'alpha',
    });
    assert.equal(header, '🟦 Pi · win');
    assert.doesNotMatch(header, /aaaaaaaa|pid|Users|broker/i);
    const fallback = identityHeader({
      colorSlot: 0,
      sessionAlias: 'tg:abc123 aaaaaaaaaaaaaaaa2222 C:/Windows',
    });
    assert.equal(fallback, '⬜ Pi');
  });

  test(`is bounded to ${MAX_IDENTITY_HEADER_CODE_POINTS} code points and never splits a surrogate pair`, () => {
    assert.equal(MAX_IDENTITY_HEADER_CODE_POINTS, 64);
    const long = identityHeader({ colorSlot: 0, label: 'x'.repeat(500) });
    assert.ok(codePoints(long) <= MAX_IDENTITY_HEADER_CODE_POINTS);
    assert.equal(codePoints(long), MAX_IDENTITY_HEADER_CODE_POINTS);
    assert.ok(long.startsWith('🟦 Pi · '));
    const astral = identityHeader({ colorSlot: 0, label: '😀'.repeat(100) });
    assert.ok(codePoints(astral) <= MAX_IDENTITY_HEADER_CODE_POINTS);
    assert.doesNotMatch(astral, LONE_SURROGATE_RE);
    assert.ok(astral.includes('😀'));
    // The header budget holds with a branch present too.
    const withBranch = identityHeader({ colorSlot: 0, label: 'x'.repeat(500), branch: 'y'.repeat(500) });
    assert.ok(codePoints(withBranch) <= MAX_IDENTITY_HEADER_CODE_POINTS);
    assert.doesNotMatch(withBranch, LONE_SURROGATE_RE);
  });

  test('carries identity only: never a state or liveness word', () => {
    const header = identityHeader({ colorSlot: 2, label: 'alpha', branch: 'main' });
    assert.doesNotMatch(
      header,
      /connected|disconnect|offline|available|working|waiting|busy|live|idle/i,
    );
  });

  test('never carries a model name or state: only identity fields are inputs', () => {
    const header = identityHeader({
      colorSlot: 0,
      label: 'alpha',
      model: 'secret-model',
      state: 'busy',
      pid: 4242,
    });
    assert.equal(header, '🟦 Pi · alpha');
  });

  test('uses the project palette square and the neutral fallback square', () => {
    for (let slot = 0; slot < PROJECT_COLOR_SLOTS.length; slot++) {
      assert.match(
        identityHeader({ colorSlot: slot, label: 'alpha' }),
        new RegExp(`^${PROJECT_COLOR_SLOTS[slot]} Pi · alpha$`, 'u'),
      );
    }
    assert.match(
      identityHeader({ colorSlot: 99, label: 'alpha' }),
      new RegExp(`^${PROJECT_COLOR_FALLBACK} Pi · alpha$`, 'u'),
    );
  });

  test('the first abort acknowledgement names the session instead of staying anonymous', () => {
    assert.equal(cbAck('abort', 'alpha'), 'Pi · alpha — Stopping the current task...');
    assert.equal(
      cbAck('abort', '⬜ Pi · alpha'),
      '⬜ Pi · alpha — Stopping the current task...',
    );
    assert.doesNotMatch(cbAck('abort', 'alpha'), /^Stopping/,
      'the first abort ack must never be anonymous');
  });

  test('displayLabel is idempotent for a valid prebuilt identity header', () => {
    const headers = [
      identityHeader({ colorSlot: 0, sessionAlias: 'win-a', branch: 'main' }),
      identityHeader({ colorSlot: 7, label: 'alpha' }),
      '⬜ Pi',
      '⬜ Pi · alpha',
      '🟫 Pi · alpha · feature/one',
      '🟪 Pi · beta',
    ];
    for (const header of headers) {
      assert.equal(displayLabel(header), header, `displayLabel must not rewrap: ${header}`);
    }
    assert.doesNotMatch(displayLabel('⬜ Pi · alpha'), /Pi · Pi/);
    assert.doesNotMatch(displayLabel('⬜ Pi'), /Pi · /);
    // A plain label still composes exactly as before.
    assert.equal(displayLabel('plain-name'), 'Pi · plain-name');
    assert.equal(displayLabel('Pi · plain-name'), 'Pi · plain-name');
  });
});

// --- Correction round: identity header astral safety, normalization, spoof rejection ---

describe('beginner copy: identity header correction round (F1-F6)', () => {
  /** Five astral code points (mathematical italic letters), 10 UTF-16 units. */
  const ASTRAL = '𝕒𝕝𝕡𝕙𝕒';
  const hasLoneSurrogate = (text) => LONE_SURROGATE_RE.test(text);

  test('F1: displayLabel re-renders every identity header byte-for-byte, astral-safe, all slots', () => {
    const slots = [0, 1, 2, 3, 4, 5, 6, 7, null, 99, 'x'];
    for (const colorSlot of slots) {
      const header = identityHeader({
        colorSlot,
        sessionAlias: `${ASTRAL} ${'w'.repeat(50)}`,
        branch: 'main',
      });
      assert.ok(codePoints(header) <= MAX_IDENTITY_HEADER_CODE_POINTS,
        `slot ${colorSlot}: header exceeded 64 code points`);
      assert.ok(!hasLoneSurrogate(header), `slot ${colorSlot}: lone surrogate in header`);
      const rendered = displayLabel(header);
      assert.equal(rendered, header,
        `slot ${colorSlot}: displayLabel must re-render the header unchanged`);
      assert.ok(!hasLoneSurrogate(rendered),
        `slot ${colorSlot}: displayLabel introduced a lone surrogate`);
    }
    // A crafted header whose UTF-16 length exceeds 64 units while sitting at
    // the 64-code-point boundary: the clip must never split a pair.
    const boundary = identityHeader({
      colorSlot: 0,
      label: `${'x'.repeat(55)}${'𝕒'.repeat(10)}`,
    });
    assert.equal(codePoints(boundary), MAX_IDENTITY_HEADER_CODE_POINTS);
    assert.ok(boundary.length > MAX_IDENTITY_HEADER_CODE_POINTS,
      'the fixture must exceed 64 UTF-16 units for this probe to be meaningful');
    const renderedBoundary = displayLabel(boundary);
    assert.equal(renderedBoundary, boundary);
    assert.ok(!hasLoneSurrogate(renderedBoundary));
  });

  test('F1: the neutral fallback header keeps its exact passthrough contract', () => {
    assert.equal(displayLabel(identityHeader({})), '⬜ Pi');
    assert.equal(displayLabel('⬜ Pi'), '⬜ Pi');
    assert.equal(displayLabel(identityHeader({ colorSlot: 8, label: ASTRAL })),
      identityHeader({ colorSlot: 8, label: ASTRAL }));
  });

  test('F2: branch math counts code points, so an astral name can keep a whole branch', () => {
    const name50 = '𝕒'.repeat(50); // 50 code points, 100 UTF-16 units
    const fits = identityHeader({ colorSlot: 0, label: name50, branch: 'main' });
    assert.equal(fits, `🟦 Pi · ${name50} · main`,
      '7 + 50 + 7 = 64 code points: the branch must survive an astral name');
    assert.equal(codePoints(fits), MAX_IDENTITY_HEADER_CODE_POINTS);
    const name51 = '𝕒'.repeat(51);
    const dropped = identityHeader({ colorSlot: 0, label: name51, branch: 'main' });
    assert.equal(dropped, `🟦 Pi · ${name51}`,
      'one code point over: the branch is dropped whole, never half-shown');
    // The branch survives the final displayLabel whole or not at all.
    assert.equal(displayLabel(fits), fits);
    assert.doesNotMatch(displayLabel(dropped), /main/);
  });

  test('F3: a candidate that is itself prefixed or a header normalizes to ONE prefix', () => {
    assert.equal(
      identityHeader({ colorSlot: 0, sessionAlias: 'Pi · alpha' }),
      '🟦 Pi · alpha',
    );
    assert.equal(
      identityHeader({ colorSlot: 0, sessionAlias: 'Pi - alpha' }),
      '🟦 Pi · alpha',
    );
    assert.equal(
      identityHeader({ colorSlot: 0, sessionAlias: 'Pi · Pi · alpha' }),
      '🟦 Pi · alpha',
    );
    assert.equal(
      identityHeader({ colorSlot: 0, label: '🟫 Pi · alpha' }),
      '🟦 Pi · alpha',
      'a candidate carrying another slot square must not nest squares',
    );
    assert.equal(
      identityHeader({ colorSlot: 5, sessionAlias: '⬜ Pi · alpha', label: 'beta' }),
      '🟫 Pi · alpha',
    );
    for (const candidate of ['Pi · alpha', 'Pi - alpha', '🟫 Pi · alpha']) {
      const header = identityHeader({ colorSlot: 0, sessionAlias: candidate });
      assert.doesNotMatch(header, /Pi · Pi/, `doubled prefix from: ${candidate}`);
      assert.doesNotMatch(header, /[🟦🟪🟧🟩🟨🟫⬛⬜].*[🟦🟪🟧🟩🟨🟫⬛⬜]/u,
        `nested squares from: ${candidate}`);
    }
    // Sanitization/path stripping still applies to the normalized remainder.
    assert.equal(
      identityHeader({ colorSlot: 0, sessionAlias: 'Pi · C:/Users/me alpha' }),
      '🟦 Pi · alpha',
    );
  });

  test('F5: state circles never gain prebuilt passthrough privilege', () => {
    for (const circle of ['🟢', '🟡', '⚪', '🔴', '⚫']) {
      const spoofed = `${circle} Pi · alpha`;
      const rendered = displayLabel(spoofed);
      assert.notEqual(rendered, spoofed,
        `${circle} must not pass through as a prebuilt header`);
      assert.ok(!rendered.includes(circle),
        `${circle} must be stripped from identity presentation`);
      assert.equal(rendered, 'Pi · alpha');
      assert.doesNotMatch(rendered, /Pi · Pi/);
    }
    assert.equal(eventConnected('🟢 Pi · alpha'), 'Pi · alpha is connected.');
    assert.equal(
      identityHeader({ colorSlot: 3, sessionAlias: '🟡 Pi · gamma' }),
      '🟩 Pi · gamma',
    );
    // Project squares keep their passthrough privilege.
    assert.equal(displayLabel('🟪 Pi · beta'), '🟪 Pi · beta');
  });

  test('F6: full copy consumers render the astral header verbatim; fallback intact', () => {
    const header = identityHeader({ colorSlot: 6, sessionAlias: `${ASTRAL} win`, branch: 'main' });
    assert.equal(sessionNotice(header, 'Prompt queued.'), `${header} — Prompt queued.`);
    assert.equal(eventConnected(header), `${header} is connected.`);
    assert.equal(
      eventStatus(header, { state: 'busy', model: 'm' }).split('\n')[0],
      `${header} status`,
    );
    assert.equal(
      busyCard(header),
      `${header} is still working on the current task. What should I do with your message?`,
    );
    for (const text of [
      sessionNotice(header, 'Prompt queued.'),
      eventConnected(header),
      busyCard(header),
    ]) {
      assert.ok(!hasLoneSurrogate(text));
    }
  });
});

// --- setup.ps1 beginner-path copy (static bytes, never executed) -----------

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));
// Normalise once so multi-line literal searches work on CRLF checkouts too.
const SETUP_SOURCE = readFileSync(join(MODULE_ROOT, 'scripts', 'setup.ps1'), 'utf8').replaceAll('\r\n', '\n');
const DOC_SOURCE = readFileSync(join(MODULE_ROOT, 'docs', 'BEGINNER_UX.md'), 'utf8');
const ADVANCED_DOC_SOURCE = readFileSync(join(MODULE_ROOT, 'docs', 'ADVANCED.md'), 'utf8');

/** MSG-S12: a missing Pi is a warning with the next action, never a blocker. */
const PI_MISSING_LINES = [
  'Pi is not on this computer yet. Your private link is safe and will wait.',
  'Install Pi on this PC, then open it and type /tg to connect.',
];

/** MSG-E5/MSG-E6: the state root cannot be kept local-only there. */
const ONEDRIVE_REFUSAL = 'This folder is inside OneDrive, so your private link cannot stay only on this PC.';
const PROTECTED_FOLDER_REFUSAL = 'This folder is inside a protected Windows folder, so setup cannot keep your private link safe here.';
const UNSAFE_FOLDER_ACTION = 'Move the setup folder to a normal folder on this PC (for example C:\\pi-telegram-bridge), then run setup again.';

/** MSG-S12..MSG-E6 must be marked implemented in the document, not design. */
const NEW_IMPLEMENTED_IDS = ['MSG-S12', 'MSG-E5', 'MSG-E6'];

function beginnerPlanSlice() {
  const start = SETUP_SOURCE.indexOf("if ($Beginner) {\n    Write-Host ''\n    Write-Host 'Finishing setup...'");
  assert.ok(start >= 0, 'the beginner component plan must exist');
  const end = SETUP_SOURCE.indexOf('# --- post-enrollment offers', start);
  assert.ok(end > start, 'the beginner plan must be bounded');
  return SETUP_SOURCE.slice(start, end);
}

describe('beginner copy: setup.ps1 missing-Pi warning (MSG-S12)', () => {
  test('the exact warning lines exist on the beginner path', () => {
    for (const line of PI_MISSING_LINES) {
      assert.ok(SETUP_SOURCE.includes(line), `missing exact copy: ${line}`);
    }
  });

  test('the warning is conditional, so a Pi-present run prints none of it', () => {
    const firstWarning = SETUP_SOURCE.indexOf(PI_MISSING_LINES[0]);
    assert.ok(firstWarning >= 0);
    const guard = SETUP_SOURCE.lastIndexOf('if ($beginnerPiMissing) {', firstWarning);
    assert.ok(guard >= 0 && guard < firstWarning,
      'the warning lines must sit inside an explicit Pi-missing conditional');
  });

  test('a missing Pi never fails the install: the warning branch cannot exit nonzero', () => {
    const plan = beginnerPlanSlice();
    assert.equal(plan.match(/exit [1-9]/g), null,
      'no hardcoded nonzero exit may exist in the beginner plan; only exit $code and exit 0');
    assert.ok(plan.includes('exit 0'), 'the beginner plan must still complete successfully');
    assert.ok(plan.includes(PI_MISSING_LINES[0]),
      'the warning must live inside the plan, after enrollment');
  });

  test('Pi detection happens before the extension installer creates the Pi directory', () => {
    const detection = SETUP_SOURCE.indexOf('$beginnerPiMissing = ($null -eq $piCommand');
    const plan = beginnerPlanSlice();
    const planStart = SETUP_SOURCE.indexOf(plan);
    const extensionInstall = plan.indexOf("'install-selective-extension.ps1'");
    assert.ok(detection >= 0, 'the Pi presence detection must exist');
    assert.ok(extensionInstall >= 0, 'the plan must install the extension');
    assert.ok(detection < planStart + extensionInstall,
      'the detection must run before the extension install, which creates the Pi directory itself');
  });

  test('the warning copy is jargon-free', () => {
    for (const line of PI_MISSING_LINES) {
      for (const word of JARGON) {
        assert.doesNotMatch(line, new RegExp(word.replace(' ', '\\s+'), 'i'),
          `jargon "${word}" leaked into setup warning`);
      }
    }
  });

  test('the document marks MSG-S12 as implemented', () => {
    assert.ok(DOC_SOURCE.includes('MSG-S12'), 'the document must define MSG-S12');
    const marker = DOC_SOURCE.indexOf('MSG-S12');
    const statusArea = DOC_SOURCE.slice(marker, marker + 400);
    assert.match(statusArea, /implemented/i, 'MSG-S12 must be marked implemented');
  });
});

describe('beginner copy: setup.ps1 unsafe-folder refusals (MSG-E5, MSG-E6)', () => {
  test('the exact refusal lines exist', () => {
    assert.ok(SETUP_SOURCE.includes(ONEDRIVE_REFUSAL), 'missing the OneDrive refusal');
    assert.ok(SETUP_SOURCE.includes(PROTECTED_FOLDER_REFUSAL), 'missing the protected-folder refusal');
    assert.ok(SETUP_SOURCE.includes(UNSAFE_FOLDER_ACTION), 'missing the next action');
  });

  test('the refusal fires BEFORE the state root is locked or any secret is captured', () => {
    const refusal = SETUP_SOURCE.indexOf(ONEDRIVE_REFUSAL);
    const lock = SETUP_SOURCE.indexOf('$capabilitySid = Lock-BridgeStateRoot -Path $stateRoot');
    const tokenPrompt = SETUP_SOURCE.indexOf("Read-Host -Prompt 'Bot token (masked)'");
    assert.ok(lock > refusal, 'the ACL lock must happen after the refusal gate');
    assert.ok(tokenPrompt > refusal, 'the token prompt must happen after the refusal gate');
  });

  test('the refusal only fires on the flagged condition and exits 1 for beginners', () => {
    const gate = SETUP_SOURCE.indexOf('if ($null -ne $unsafeRootReason) {');
    assert.ok(gate >= 0, 'the refusal must be conditional on the detected unsafe location');
    const blockEnd = SETUP_SOURCE.indexOf('New-Item -ItemType Directory -Path $stateRoot', gate);
    const block = SETUP_SOURCE.slice(gate, blockEnd);
    assert.match(block, /if \(\$Beginner\) \{/, 'the beginner refusal branch must exist');
    assert.match(block, /exit 1/, 'the beginner refusal must exit nonzero');
    assert.match(block, /throw /, 'the advanced path must still throw a technical error');
  });

  test('the healthy path keeps its original behavior: resolve, create, lock, unchanged', () => {
    const resolveIndex = SETUP_SOURCE.indexOf('$stateRoot = Resolve-BridgeStateDirectory -StateDirectory $StateDirectory');
    assert.ok(resolveIndex >= 0);
    const createLine = SETUP_SOURCE.indexOf('New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null', resolveIndex);
    const lockLine = SETUP_SOURCE.indexOf('$capabilitySid = Lock-BridgeStateRoot -Path $stateRoot', resolveIndex);
    assert.ok(createLine > resolveIndex && lockLine > createLine,
      'resolve -> create -> lock must stay in the original order on the healthy path');
  });

  test('the refusal copy is jargon-free and names no real absolute user path', () => {
    const lines = [ONEDRIVE_REFUSAL, PROTECTED_FOLDER_REFUSAL, UNSAFE_FOLDER_ACTION];
    for (const line of lines) {
      for (const word of JARGON) {
        assert.doesNotMatch(line, new RegExp(word.replace(' ', '\\s+'), 'i'),
          `jargon "${word}" leaked into setup refusal`);
      }
      assert.doesNotMatch(line, /C:\\Users\\/, 'no real absolute user path may appear');
    }
  });

  test('the document marks MSG-E5 and MSG-E6 as implemented', () => {
    for (const id of ['MSG-E5', 'MSG-E6']) {
      assert.ok(DOC_SOURCE.includes(id), `the document must define ${id}`);
      const marker = DOC_SOURCE.indexOf(id);
      const statusArea = DOC_SOURCE.slice(marker, marker + 400);
      assert.match(statusArea, /implemented/i, `${id} must be marked implemented`);
    }
  });
});

describe('beginner copy: per-session /alias (T4C2)', () => {
  test('the fixed /alias replies are stable and jargon-free', () => {
    assert.equal(copyModule.aliasSaved, 'Alias saved.');
    assert.equal(copyModule.aliasCleared, 'Alias cleared.');
    assert.equal(
      copyModule.aliasNoSelection,
      'No Pi window is selected. Send /projects, pick one, then try /alias <name> again.',
    );
    assert.equal(
      copyModule.aliasInvalid,
      "That name can't be used. Use up to 64 normal characters and try again.",
    );
    assert.equal(
      copyModule.aliasFailed,
      'The alias could not be saved right now. Try again in a moment.',
    );
    const lines = [
      copyModule.aliasSaved,
      copyModule.aliasCleared,
      copyModule.aliasNoSelection,
      copyModule.aliasInvalid,
      copyModule.aliasFailed,
    ];
    for (const line of lines) {
      for (const word of JARGON) {
        assert.doesNotMatch(line, new RegExp(word.replace(' ', '\\s+'), 'i'),
          `jargon "${word}" leaked into /alias copy`);
      }
    }
  });

  test('advanced help documents /alias <name>', () => {
    assert.ok(HELP_TEXT.includes('/alias <name>'), 'the advanced help must list /alias <name>');
  });

  test('docs/ADVANCED.md documents the /alias command', () => {
    assert.match(ADVANCED_DOC_SOURCE, /`\/alias <name>`/,
      'the advanced command table must list /alias <name>');
  });
});
