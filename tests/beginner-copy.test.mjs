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
  displayLabel,
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
    assert.equal(cbAck('abort', 'g'), 'Stopping the current task...');
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
    for (const command of ['/help', '/sessions', '/use', '/status', '/send', '/steer', '/followup', '/abort', '/disconnect']) {
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

// --- setup.ps1 beginner-path copy (static bytes, never executed) -----------

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SETUP_SOURCE = readFileSync(join(MODULE_ROOT, 'scripts', 'setup.ps1'), 'utf8');
const DOC_SOURCE = readFileSync(join(MODULE_ROOT, 'docs', 'BEGINNER_UX.md'), 'utf8');

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
