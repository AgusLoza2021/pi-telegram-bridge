// T04r2 smoke-runtime.mjs - smoke of the REAL production lifecycle
// (real Pi child, host-only mode, typed local decision).
//
// Run by the authorized verifier (the human owner or the independent
// verification agent). It spawns a real pi process.
//
// Usage:
//   node scripts/smoke-runtime.mjs --pi-cli <abs path to pi cli.js> \
//        --pi-workspace <abs path to a scratch workspace>
//
// Design notes (T04r2 review fixes):
//   - phases THROW typed errors; a single outer try/finally performs a
//     graceful stop of OUR OWN host (control channel bound to the
//     instance id we observed), closes the Store, and reports an
//     explicit cleanup failure. It never signals a foreign PID and
//     never leaves an orphan Pi behind.
//   - process output is never concatenated raw into error messages:
//     diagnostics pass through sanitizeDiagnostic (paths and long
//     token-like values redacted, bounded length).
//   - the state directory is created with mkdtemp (unique, no
//     collision with a concurrent run) strictly under the module's
//     .local; nothing is ever deleted - artifacts stay for inspection.
//
// The decision simulated in phase 5 is EXACTLY what the worker writes
// when a human types an answer on the phone; no credentials and no
// Telegram are involved anywhere in this smoke.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(MODULE_ROOT, 'scripts');

/** Typed, fixed-code harness error (safe messages only). */
export class HarnessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested against REAL SessionHost shapes)
// ---------------------------------------------------------------------------

/**
 * Validate the CLI inputs: absolute, existing, canonicalized paths.
 * Throws HarnessError with fixed codes; never process.exit.
 */
export function parseSmokeArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pi-cli') out.piCli = argv[i + 1];
    else if (argv[i] === '--pi-workspace') out.piWorkspace = argv[i + 1];
  }
  const check = (value, name) => {
    if (value === undefined) {
      throw new HarnessError('args_missing', `missing --${name} (existing absolute path required)`);
    }
    if (!isAbsolute(value)) {
      throw new HarnessError('args_not_absolute', `--${name} must be an absolute path`);
    }
    const canonical = resolve(value);
    if (!existsSync(canonical)) {
      throw new HarnessError('args_not_found', `--${name} does not exist: ${canonical}`);
    }
    // Canonicalize through realpath so links/aliases cannot smuggle a
    // non-canonical target past the caller's expectations.
    return realpathSync(canonical);
  };
  return {
    piCli: check(out.piCli, 'pi-cli'),
    piWorkspace: check(out.piWorkspace, 'pi-workspace'),
  };
}

/** Unique scratch state dir strictly under the module .local (no collisions). */
export function makeStateDir(smokeRoot) {
  mkdirSync(smokeRoot, { recursive: true });
  return mkdtempSync(join(smokeRoot, 'run-'));
}

/**
 * Read the pending demo dialog from REAL outbox rows.
 * Real SessionHost row shape: { requestId, kind, payload: {..., options} }
 * - options are NESTED in payload; the flat fallback is defensive only.
 */
export function extractPendingDialog(outboxRows) {
  const rows = Array.isArray(outboxRows) ? outboxRows : [];
  const candidates = rows.filter((row) => (row.payload?.kind ?? row.kind) === 'approval_request');
  if (candidates.length === 0) {
    throw new HarnessError('no_pending_dialog', 'no pending approval_request found in the outbox');
  }
  const row = candidates[candidates.length - 1];
  const options = row.payload?.options ?? row.options;
  const requestId = row.payload?.requestId ?? row.requestId;
  if (!Array.isArray(options) || options.length === 0 || typeof options[0] !== 'string') {
    throw new HarnessError('dialog_missing_options', 'pending dialog has no renderable options');
  }
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new HarnessError('dialog_missing_options', 'pending dialog has no requestId');
  }
  return { requestId, options, kind: 'approval_request' };
}

/**
 * Assert a REAL request row reached completed AND the applied choice
 * equals the option the simulated human chose. The real row field is
 * `.state` (NOT `.status`). The choice lives in `.decision.value` for
 * real tool dialogs and in `.result.choice` for demo dialogs completed
 * through the nonce-bound notify; both are accepted, one MUST match.
 */
export function assertCompletedDecision(requestRow, chosenOption) {
  const row = requestRow ?? {};
  if (row.state === 'failed') {
    throw new HarnessError('decision_failed', 'the typed decision was rejected (request failed)');
  }
  if (row.state !== 'completed') {
    throw new HarnessError('decision_not_completed', `request did not complete (state=${row.state ?? 'unknown'})`);
  }
  const appliedChoice = row.decision?.value ?? row.result?.choice;
  if (appliedChoice !== chosenOption) {
    throw new HarnessError('decision_choice_mismatch', 'the recorded decision does not match the chosen option');
  }
}

/** The host must present the real-Pi host-only identity before continuing. */
export function assertMetaIdentity(meta) {
  if (!meta || meta.mode !== 'host_only_real') {
    throw new HarnessError('meta_wrong_mode', `expected mode host_only_real (got ${meta?.mode ?? 'none'})`);
  }
  if (typeof meta.piPid !== 'number' || meta.piPid <= 0
    || typeof meta.piSessionId !== 'string' || meta.piSessionId.length === 0) {
    throw new HarnessError('meta_missing_pi_identity', 'host meta lacks a real Pi identity (piPid/piSessionId)');
  }
  if (meta.piPid === meta.pid) {
    throw new HarnessError('meta_pi_pid_is_host_pid', 'piPid must never equal the host pid');
  }
}

/** Pi identity (child pid AND session) must survive the whole demo. */
export function assertSamePiChild(before, after) {
  if (!after || after.piPid !== before.piPid || after.piSessionId !== before.piSessionId
    || !after.piSessionId) {
    throw new HarnessError('pi_child_changed', 'the Pi child or its session changed during the demo');
  }
}

/**
 * Bounded, sanitized diagnostic: absolute paths and token-like values
 * are redacted, whitespace collapsed, length capped. Raw child
 * stdout/stderr NEVER flows into logs or error messages unsanitized.
 */
export function sanitizeDiagnostic(text, limit = 800) {
  const cleaned = String(text ?? '')
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>')
    .replace(/[A-Za-z]:\/[^\s'"]+/g, '<path>')
    .replace(/(token|secret|key)([=:])\S+/gi, '$1$2<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  const suffix = '...<truncated>';
  return cleaned.length > limit
    ? cleaned.slice(0, Math.max(0, limit - suffix.length)) + suffix
    : cleaned;
}

// ---------------------------------------------------------------------------
// Graceful cleanup: control-channel stop of OUR OWN host only
// ---------------------------------------------------------------------------

/**
 * Ask OUR OWN host (bound to the exact instance id we observed) for a
 * graceful shutdown through the control channel and wait, bounded, for
 * the confirmation in host-meta.json. Never signals any PID directly;
 * a timeout returns { ok: false, reason: 'stop_unconfirmed' } without
 * forcing anything. An instance mismatch fails closed.
 */
export async function gracefulStopOwnHost({
  stateRoot,
  instanceId,
  pollMs = 500,
  waitMs = 30_000,
  afterCommand = null,
  metaReader = readMetaOrDefault,
}) {
  if (!/^[0-9a-f]{32}$/.test(instanceId)) {
    throw new HarnessError('stop_instance_mismatch', 'refusing to stop: missing a valid observed instance id');
  }
  // Read the CURRENT meta: the instance we stop must be the one we saw.
  const current = metaReader(stateRoot);
  if (!current || current.instanceId !== instanceId) {
    throw new HarnessError('stop_instance_mismatch', 'refusing to stop: live instance id does not match the observed one');
  }
  const { writeControlCommand } = await import('../src/bridge-control.mjs');
  writeControlCommand({ stateRoot, instanceId, command: 'stop-host' });
  if (afterCommand) afterCommand();

  const deadline = Date.now() + waitMs;
  for (;;) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
    const meta = metaReader(stateRoot);
    // Positive confirmation only: the host itself records shutdownAt.
    // A process that vanished without recording it is NOT a graceful
    // stop, so the harness reports stop_unconfirmed (fail closed).
    if (meta && meta.shutdownAt) return { ok: true };
    if (Date.now() > deadline) {
      return { ok: false, reason: 'stop_unconfirmed' };
    }
  }
}

function readMetaOrDefault(stateRoot) {
  return readHostMeta(stateRoot);
}

function readHostMeta(stateDir) {
  try { return JSON.parse(readFileSync(join(stateDir, 'host-meta.json'), 'utf8')); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function runPowerShellDefault(script, psArgs) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive',
    '-File', join(SCRIPTS, script), ...psArgs,
  ], { cwd: MODULE_ROOT, encoding: 'utf8', timeout: 120_000 });
}

function expectOk(result, phase) {
  if (result.status !== 0) {
    throw new HarnessError(`phase_${phase}_failed`, sanitizeDiagnostic(
      `phase ${phase} exited ${result.status} stderr=${result.stderr} stdout=${result.stdout}`));
  }
  return result;
}

async function waitFor(description, timeoutMs, probe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new HarnessError('wait_timeout', `${description} not observed within ${timeoutMs}ms`);
    }
    await sleep(500);
  }
}

/**
 * Full smoke. Every failure path lands in the SAME finally: graceful
 * stop of our own host (only if we started one), Store closed, cleanup
 * failures reported explicitly, sanitized diagnostics only.
 */
export async function runSmoke(argv, deps = {}) {
  const runPowerShell = deps.runPowerShell ?? runPowerShellDefault;
  const sleepFn = deps.sleep ?? sleep;
  const smokeRoot = join(MODULE_ROOT, '.local', 'smoke-runtime');

  let store = null;
  let startedInstanceId = null;
  let stateDir = null;
  let exitCode = 0;

  try {
    const args = parseSmokeArgs(argv);

    // --- 1. fresh confined state via setup -PrepareOnly -------------------
    stateDir = deps.makeStateDir ? deps.makeStateDir(smokeRoot) : makeStateDir(smokeRoot);
    console.log(`smoke-runtime: state dir ${stateDir}`);
    const setupResult = expectOk(runPowerShell('setup.ps1', [
      '-PrepareOnly', '-StateDirectory', stateDir,
      '-PiCliPath', args.piCli, '-PiWorkspace', args.piWorkspace,
    ]), 'setup');
    if (!/PREPARE OK/.test(setupResult.stdout)) {
      throw new HarnessError('phase_setup_failed', 'prepare-only did not print PREPARE OK');
    }
    if (existsSync(join(stateDir, 'credentials.bin'))) {
      throw new HarnessError('phase_setup_failed', 'prepare-only must never create a credential blob');
    }
    console.log('smoke-runtime: phase 1 OK (prepare-only, ACL-locked, credential-free)');

    // --- 2. start -HostOnly: launcher exits, the real-Pi host survives ---
    expectOk(runPowerShell('start.ps1', ['-HostOnly', '-StateDirectory', stateDir]), 'start');
    console.log('smoke-runtime: phase 2 OK (start launcher exited; host detached)');

    // --- 3. the real-Pi host comes alive ---------------------------------
    const meta = await waitFor('live host meta with a real pi identity', 60_000, () => {
      const m = readHostMeta(stateDir);
      if (!m || m.shutdownAt || typeof m.pid !== 'number') return null;
      assertMetaIdentity(m);
      return m;
    });
    startedInstanceId = meta.instanceId;
    console.log(`smoke-runtime: phase 3 OK (host pid=${meta.pid}, real Pi pid=${meta.piPid}, session=${meta.piSessionId})`);

    // --- 4. the demo dialog arrives and stays PENDING ---------------------
    const { Store: StoreCtor } = await import('../src/store.mjs');
    store = new StoreCtor(join(stateDir, 'bridge.sqlite'));
    const dialog = await waitFor('pending demo dialog in the outbox', 60_000, () => {
      try {
        return extractPendingDialog(store.listPendingOutbox());
      } catch (error) {
        if (error instanceof HarnessError && error.code === 'no_pending_dialog') return null;
        throw error;
      }
    });
    console.log(`smoke-runtime: phase 4 OK (pending dialog requestId=${dialog.requestId}, options=${JSON.stringify(dialog.options)})`);

    // --- 5. simulate the typed local decision -----------------------------
    const identityBefore = { piPid: meta.piPid, piSessionId: meta.piSessionId };
    store.enqueueAction({
      actionId: `smoke-decision-${Date.now()}`,
      type: 'decision',
      payload: { requestId: dialog.requestId, decision: { value: dialog.options[0] } },
    });
    await waitFor('demo dialog completed after the typed decision', 90_000, () => {
      const row = store.getRequest(dialog.requestId);
      if (row && row.state === 'failed') {
        throw new HarnessError('decision_failed', 'the typed decision was rejected (request failed)');
      }
      return row && row.state === 'completed' ? row : null;
    });
    const rowAfter = store.getRequest(dialog.requestId);
    assertCompletedDecision(rowAfter, dialog.options[0]);
    const metaAfterDecision = readHostMeta(stateDir);
    if (!metaAfterDecision || metaAfterDecision.lastDemoResult !== 'completed') {
      throw new HarnessError('demo_result_missing', `expected lastDemoResult=completed (got ${metaAfterDecision?.lastDemoResult ?? 'none'})`);
    }
    assertSamePiChild(identityBefore, metaAfterDecision);
    console.log('smoke-runtime: phase 5 OK (typed decision applied and recorded; same Pi child and session)');

    // --- 6. status, then a graceful stop of OUR OWN host + Pi -------------
    expectOk(runPowerShell('status.ps1', ['-StateDirectory', stateDir]), 'status');
    expectOk(runPowerShell('stop.ps1', ['-StateDirectory', stateDir]), 'stop');
    await waitFor('host shutdown recorded', 30_000, () => {
      const m = readHostMeta(stateDir);
      return m && m.shutdownAt ? m : null;
    });
    console.log('smoke-runtime: phase 6 OK (graceful stop confirmed)');

    console.log('SMOKE-RUNTIME PASS: real-Pi host-only lifecycle completed end to end.');
    console.log(`Artifacts preserved under ${stateDir}`);
  } catch (error) {
    exitCode = 1;
    const reason = error instanceof HarnessError ? error.code : 'unexpected_error';
    console.error(`SMOKE-RUNTIME FAIL: reason=${reason}: ${sanitizeDiagnostic(error?.message)}`);

    // Cleanup in the failure path: graceful stop of ONLY the host we
    // started, then close the store. Failures here are reported
    // explicitly and never hide silently.
    if (startedInstanceId) {
      try {
        const report = await gracefulStopOwnHost({
          stateRoot: stateDir,
          instanceId: startedInstanceId,
        });
        if (report.ok) {
          console.error('SMOKE-RUNTIME CLEANUP: graceful stop confirmed.');
        } else {
          console.error(`SMOKE-RUNTIME CLEANUP FAILED: reason=${report.reason} (no force applied; inspect host-meta.json)`);
        }
      } catch (cleanupError) {
        console.error(`SMOKE-RUNTIME CLEANUP FAILED: ${sanitizeDiagnostic(cleanupError?.message)}`);
      }
    }
  } finally {
    if (store) {
      try { store.close(); } catch { /* already closed */ }
    }
  }
  return exitCode;
}

// Module entry: only when executed directly (never on import).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runSmoke(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
