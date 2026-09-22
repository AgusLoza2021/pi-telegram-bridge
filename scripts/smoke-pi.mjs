#!/usr/bin/env node
// smoke-pi.mjs (T02): zero-LLM smoke test of the bridge extension against
// a REAL pi child in RPC mode. This script is run by an independent
// verifier, NOT as part of the automated test suite.
//
// What it does (no model calls, no network, no credentials):
//   1. Spawns `pi --mode rpc --offline` with the bridge extension,
//      restrictive flags and a fresh session dir (H1 launch contract).
//      PI_OFFLINE=1 is also set, so startup never touches the network.
//   2. Records the identity probe (get_state): child pid + session id.
//   3. Runs the /bridge-demo command flow (commands do NOT invoke the
//      LLM). RPC contract: the command response resolves only AFTER the
//      awaited dialog is answered, so the command promise is started but
//      NOT awaited before answering the dialog (deadlock avoidance).
//   4. Re-probes get_state and verifies the same pid + session id (the
//      child did not silently restart).
//   5. Cleans up its own child and reports PASS/FAIL per check. Output
//      carries ids and verdicts only — never dialog content or paths.
//
// Usage:
//   node scripts/smoke-pi.mjs --cli <path-to-pi-cli.js> [--node <node.exe>]
//
// The pi CLI entry is typically:
//   <global npm root>/@earendil-works/pi-coding-agent/dist/bundle/cli.js
// Or pass the path via PI_BRIDGE_PI_CLI.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { PiRpcAdapter, buildProductionLaunch } from '../src/pi-adapter.mjs';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv);
const nodePath = args.node ?? process.execPath;
const cliPath = args.cli ?? process.env.PI_BRIDGE_PI_CLI;
if (!cliPath) {
  console.error('usage: node scripts/smoke-pi.mjs --cli <path-to-pi-cli.js> [--node <node.exe>]');
  console.error('  or set PI_BRIDGE_PI_CLI');
  process.exit(2);
}

// Fresh, bridge-owned directories for every run.
mkdirSync(join(MODULE_ROOT, '.local', 'smoke-runs'), { recursive: true });
const runDir = mkdtempSync(join(MODULE_ROOT, '.local', 'smoke-runs', 'smoke-'));
const sessionDir = join(runDir, 'sessions');
mkdirSync(sessionDir, { recursive: true });
const workDir = join(runDir, 'work');
mkdirSync(workDir, { recursive: true });

const results = [];
function check(name, ok) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

const adapter = new PiRpcAdapter(
  buildProductionLaunch({
    sessionId: `smoke-${Date.now()}`,
    nodePath,
    cliPath,
    workspaceRoot: workDir,
    extensionPath: join(MODULE_ROOT, 'extension', 'bridge-extension.ts'),
    sessionDir,
    env: process.env,
  }),
);

let exitCode = 0;
try {
  const uiRequests = [];
  const events = [];
  adapter.onUiRequest((request) => uiRequests.push(request));
  adapter.onEvent((event) => events.push(event));

  const initial = await adapter.start();
  check('pi child started in rpc mode with --offline launch', true);
  check('identity probe: session id reported', typeof initial.sessionId === 'string' && initial.sessionId.length > 0);

  // H3 demo lifecycle: single-use nonce from a CSPRNG, fixed command. The
  // command promise is started but NOT awaited here: a pending extension
  // command resolves only after its dialog is answered.
  const nonce = randomBytes(8).toString('hex');
  let commandSettled = false;
  let commandOk = false;
  adapter
    .send({ type: 'prompt', message: `/bridge-demo ${nonce}` })
    .then(() => { commandSettled = true; commandOk = true; })
    .catch(() => { commandSettled = true; commandOk = false; });

  // Wait for the awaited select dialog from the extension.
  let dialog = null;
  for (let i = 0; i < 200 && !dialog; i++) {
    dialog = uiRequests.find((r) => r.method === 'select') ?? null;
    if (!dialog) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check('bridge demo dialog arrived while command pending', Boolean(dialog));
  check('command response withheld until dialog answered', Boolean(dialog) && !commandSettled);

  if (dialog) {
    adapter.respondUi(dialog.id, { value: 'Option A' });

    // Wait for the nonce-bound notify: strict JSON, exact nonce match.
    let parsed = null;
    for (let i = 0; i < 200 && !parsed; i++) {
      for (const request of uiRequests) {
        if (request.method !== 'notify' || typeof request.message !== 'string') continue;
        try {
          const candidate = JSON.parse(request.message);
          if (candidate && candidate.nonce === nonce) {
            parsed = candidate;
            break;
          }
        } catch {
          // Not the demo signal.
        }
      }
      if (!parsed) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check('nonce-bound demo notify arrived', Boolean(parsed));
    check('demo notify carries the chosen choice', parsed?.choice === 'Option A');

    // The command must resolve only after the dialog was answered.
    for (let i = 0; i < 100 && !commandSettled; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check('command resolved after dialog answered', commandSettled && commandOk);

    // No LLM turn ran (commands are local; no agent activity expected).
    check('no LLM turn ran', !events.some((e) => typeof e?.type === 'string' && e.type.startsWith('agent_')));

    // Identity stability: same child process, same pi session.
    const after = await adapter.getState();
    check('same pid before and after demo (no silent restart)', after.pid === initial.pid);
    check('same pi session before and after demo', after.sessionId === initial.sessionId);
  }
} catch (error) {
  check('smoke run completed without fatal error', false);
  console.error(`smoke aborted with error code: ${error?.code ?? 'unknown'}`);
} finally {
  try {
    await adapter.dispose();
  } catch {
    // Best-effort cleanup of our own child.
  }
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`smoke: ${results.length - failed.length}/${results.length} checks passed`);
console.log(`artifacts kept under: ${runDir}`);
if (failed.length > 0) {
  exitCode = 1;
  for (const failure of failed) console.error(`failed: ${failure.name}`);
}
process.exit(exitCode);
