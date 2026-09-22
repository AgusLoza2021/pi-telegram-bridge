// Fake Pi RPC child process for adapter/host tests. Speaks the pi RPC
// protocol (strict LF JSONL) with a scripted scenario file passed as
// --scenario <path>. No network, no real Pi, no secrets.
//
// Scenario shape:
// {
//   "session": { "sessionId": "...", "sessionFile": "..." },
//   "prompts": [
//     {
//       "response": { "success": true, ... },   // RPC response for the prompt
//       "delayMs": 0,                            // delay before responding
//       "then": [                                // steps emitted after the response
//         { "kind": "event", "event": { "type": "agent_start" } },
//         { "kind": "ui", "request": {...}, "awaitResponse": true,
//           "afterResponse": [ { "kind": "event", ... } ] }
//       ],
//       "thenExit": true                         // exit after steps
//     }
//   ]
// }

import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';

const scenarioArg = process.argv.indexOf('--scenario');
const scenarioPath = scenarioArg === -1 ? null : process.argv[scenarioArg + 1];
const scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, 'utf8')) : { session: {}, prompts: [] };

let promptIndex = -1;
const pendingUi = new Map(); // ui id -> afterResponse steps

function send(record) {
  process.stdout.write(JSON.stringify(record) + '\n');
}

let uiCounter = 0;

function sendEventSplit(event, delayMs = 40) {
  // Emit one JSON record as two raw UTF-8 writes, split INSIDE a multibyte
  // character, to prove the consumer decodes chunk-boundary multibyte safely.
  const json = JSON.stringify(event);
  const marker = json.indexOf('\u{1F600}');
  const emojiBytes = Buffer.from('\u{1F600}', 'utf8');
  let head, tail;
  if (marker === -1) {
    const half = Math.floor(json.length / 2);
    head = Buffer.from(json.slice(0, half), 'utf8');
    tail = Buffer.from(json.slice(half), 'utf8');
  } else {
    head = Buffer.concat([Buffer.from(json.slice(0, marker), 'utf8'), emojiBytes.subarray(0, 2)]);
    tail = Buffer.concat([emojiBytes.subarray(2), Buffer.from(json.slice(marker + 2), 'utf8'), Buffer.from('\n', 'utf8')]);
  }
  process.stdout.write(head);
  setTimeout(() => process.stdout.write(tail), delayMs);
}

function runSteps(steps, ctx = {}, onSettled = null) {
  for (const step of steps ?? []) {
    if (step.kind === 'event') {
      send(step.event);
    } else if (step.kind === 'raw') {
      // Raw (possibly malformed) bytes on stdout, for framing tests.
      process.stdout.write(step.text);
    } else if (step.kind === 'eventsplit') {
      sendEventSplit(step.event, step.delayMs);
    } else if (step.kind === 'ui') {
      const request = { ...step.request };
      if (ctx.nonce && typeof request.message === 'string') {
        request.message = request.message.replaceAll('$NONCE', ctx.nonce);
      }
      if (ctx.choice && typeof request.message === 'string') {
        request.message = request.message.replaceAll('$CHOICE', ctx.choice);
      }
      const id = `ui-${++uiCounter}`;
      send({ type: 'extension_ui_request', id, ...request });
      if (step.awaitResponse) {
        pendingUi.set(id, { steps: step.afterResponse ?? [], ctx, onSettled });
      }
    }
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (line.length === 0) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  if (command.type === 'get_state') {
    const respondState = () => {
      send({
        type: 'response',
        command: 'get_state',
        success: scenario.failStartup === true ? false : true,
        ...(command.id ? { id: command.id } : {}),
        ...(scenario.failStartup === true
          ? { error: 'simulated startup failure' }
          : {
              data: {
                sessionId: scenario.session?.sessionId ?? 'fake-session',
                sessionFile: scenario.session?.sessionFile ?? null,
              },
            }),
      });
    };
    if (scenario.delayGetStateMs) setTimeout(respondState, scenario.delayGetStateMs);
    else respondState();
    return;
  }
  if (command.type === 'extension_ui_response') {
    const after = pendingUi.get(command.id);
    if (after) {
      pendingUi.delete(command.id);
      // Test-only response log: one line per dialog response write, so a
      // test can prove "at most one host response write per request".
      if (typeof scenario.responseLog === 'string' && scenario.responseLog.length > 0) {
        appendFileSync(scenario.responseLog, `${command.id}\n`, 'utf8');
      }
      // $CHOICE: the ACTUAL value the host responded with, so afterResponse
      // steps can echo the real decision instead of a canned one.
      const ctx2 = { ...after.ctx };
      if (typeof command.value === 'string') ctx2.choice = command.value;
      runSteps(after.steps, ctx2);
      // Real RPC contract: an awaited command resolves its prompt response
      // only AFTER the command dialog is answered (respondAfterUi).
      after.onSettled?.();
    }
    return;
  }
  if (command.type === 'prompt') {
    promptIndex += 1;
    const step = (scenario.prompts ?? [])[promptIndex] ?? { response: { success: true } };
    // Demo lifecycle support: the host sends the fixed command with a
    // host-generated nonce; steps can reference it as $NONCE.
    const demoMatch = /^\/bridge-demo ([0-9a-f]+)$/.exec(command.message ?? '');
    const ctx = demoMatch ? { nonce: demoMatch[1] } : {};
    const respond = () => {
      send({
        type: 'response',
        command: 'prompt',
        success: step.response?.success ?? true,
        ...(command.id ? { id: command.id } : {}),
        ...step.response,
      });
      runSteps(step.then, ctx);
      if (step.thenExit) process.exit(0);
    };
    if (step.respondAfterUi) {
      // The command stays pending while its awaited dialog is open.
      runSteps(step.then, ctx, respond);
      return;
    }
    if (step.delayMs) setTimeout(respond, step.delayMs);
    else respond();
    return;
  }
  if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true, ...(command.id ? { id: command.id } : {}) });
    send({ type: 'agent_settled' });
  }
});

process.on('SIGTERM', () => process.exit(0));
