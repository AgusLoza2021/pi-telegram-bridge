// T3 local audio transcription contract tests.
// Everything runs against injected fakes: an in-memory fs, a fake spawn
// returning child-like objects whose stdout/stderr emitters, kill() and
// close event the test controls. No network, no real binaries, no real
// audio. The discipline under test:
// - Success is judged ONLY by the `-otxt -of <base>` output file; the
//   whisper exit code carries zero information (it exits 0 on failure).
// - ffmpeg exit codes are trustworthy.
// - argv arrays only, `shell: false` — hostile paths must arrive as
//   single argv elements, never split through a shell.
// - Temp directory cleanup in a `finally` on success, failure and timeout.
// - Errors carry message === code and never echo paths, stderr or
//   transcript content.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTranscriber, TranscriptionError } from '../src/audio-transcription.mjs';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Fake absolute bases — these paths are never touched on disk; the fake
// fs maps are plain objects keyed by these strings.
const TMP_ROOT = 'X:\\bridge-test\\tmp';
const FFMPEG = 'X:\\bridge-test\\tools\\ffmpeg.exe';
const WHISPER = 'X:\\bridge-test\\tools\\whisper-cli.exe';
const MODEL = 'X:\\bridge-test\\tools\\models\\ggml-small.bin';

const CFG = {
  ffmpegPath: FFMPEG,
  whisperCliPath: WHISPER,
  modelPath: MODEL,
  language: 'es',
  threads: 8,
  prompt: 'tests, git',
  maxAudioBytes: 1024 * 1024,
  maxDurationSec: 300,
  processTimeoutMs: 5000,
  maxStderrBytes: 65536,
};

const AUDIO_BYTES = Buffer.from([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]);

// --- fake infrastructure ----------------------------------------------------

function emitter() {
  const listeners = {};
  return {
    on(ev, fn) { (listeners[ev] ??= []).push(fn); },
    emit(ev, ...args) { for (const fn of listeners[ev] ?? []) fn(...args); },
  };
}

function makeChild() {
  const child = {
    stdout: emitter(),
    stderr: emitter(),
    killed: false,
    kill() { child.killed = true; },
    _listeners: {},
    on(ev, fn) { (child._listeners[ev] ??= []).push(fn); },
    emit(ev, ...args) { for (const fn of child._listeners[ev] ?? []) fn(...args); },
  };
  return child;
}

/**
 * Fake spawn: each call takes the next handler. A handler receives
 * (child, argv, options) and decides what happens — typically writing
 * output files into the shared fake fs and emitting 'close'.
 */
function makeFakeSpawn(handlers = []) {
  const calls = [];
  const spawnImpl = (file, argv, options) => {
    const child = makeChild();
    calls.push({ file, argv, options, child });
    const handler = handlers[calls.length - 1];
    if (handler) queueMicrotask(() => handler(child, argv, options));
    return child;
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

function createFakeFs({ tmpRoot, files = {} } = {}) {
  const dirs = new Set(tmpRoot ? [tmpRoot] : []);
  const calls = { stat: [], mkdir: [], mkdtemp: [], writeFile: [], readFile: [], rm: [] };
  const fs = {
    async stat(path) {
      calls.stat.push(path);
      if (Object.hasOwn(files, path)) {
        return { isFile: () => true, isDirectory: () => false };
      }
      if (dirs.has(path)) {
        return { isFile: () => false, isDirectory: () => true };
      }
      throw new Error(`ENOENT: ${path}`);
    },
    async mkdir(path, options) {
      calls.mkdir.push([path, options]);
      dirs.add(path);
    },
    async mkdtemp(prefix) {
      calls.mkdtemp.push(prefix);
      const dir = `${prefix}abc123`;
      dirs.add(dir);
      calls.mkdtempReturn = dir;
      return dir;
    },
    async writeFile(path, data) {
      calls.writeFile.push([path, data]);
      files[path] = Buffer.isBuffer(data) ? data : Buffer.from(data);
    },
    async readFile(path) {
      calls.readFile.push(path);
      if (!Object.hasOwn(files, path)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
    async rm(path, options) {
      calls.rm.push([path, options]);
      dirs.delete(path);
      for (const key of Object.keys(files)) {
        if (key === path || key.startsWith(path + '\\') || key.startsWith(path + '/')) {
          delete files[key];
        }
      }
    },
  };
  fs.calls = calls;
  fs.files = files;
  fs.mkdtempReturn = () => calls.mkdtempReturn;
  fs.mkdirCalls = () => calls.mkdir;
  return fs;
}

/** Minimal RIFF WAVE: 16 kHz mono 16-bit PCM with a data chunk of dataMs ms. */
function wavBytes({ dataMs = 2000, sampleRate = 16000, channels = 1, bits = 16 } = {}) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const dataBytes = Math.round((byteRate * dataMs) / 1000);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(byteRate, 8);
  fmt.writeUInt16LE((channels * bits) / 8, 12);
  fmt.writeUInt16LE(bits, 14);
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; };
  return Buffer.concat([
    Buffer.from('RIFF'), u32(4 + 8 + 16 + 8 + dataBytes), Buffer.from('WAVE'),
    Buffer.from('fmt '), u32(16), fmt,
    Buffer.from('data'), u32(dataBytes),
    Buffer.alloc(dataBytes),
  ]);
}

const WAV_2S = wavBytes({ dataMs: 2000 });

// Shared wiring: handlers write into the harness's in-memory files map.
// makeHarness sets this; tests that build their own fs set it too.
let currentFiles = null;

/** Standard harness: artifacts exist, happy fs, spawn per handlers. */
function makeHarness({ handlers = [], files = {}, cfg = {} } = {}) {
  const fake = createFakeFs({
    tmpRoot: TMP_ROOT,
    files: { [FFMPEG]: Buffer.alloc(8), [WHISPER]: Buffer.alloc(8), [MODEL]: Buffer.alloc(8), ...files },
  });
  currentFiles = fake.files;
  const spawnImpl = makeFakeSpawn(handlers);
  const transcriber = createTranscriber({
    spawnImpl,
    fsImpl: fake,
    tmpRoot: TMP_ROOT,
    ...CFG,
    ...cfg,
  });
  return { fake, spawnImpl, transcriber };
}

// The ffmpeg handler writes output.wav into the shared fake fs.
function ffmpegWrites(wav) {
  return (child, _argv, options) => {
    currentFiles[join(options.cwd, 'output.wav')] = wav;
    child.emit('close', 0);
  };
}

/** Standard whisper handler: writes the transcript txt and exits. */
function whisperWrites(text, exitCode = 0) {
  return (child, argv, options) => {
    const base = argv[argv.indexOf('-of') + 1];
    if (text !== undefined) currentFiles[`${base}.txt`] = Buffer.from(text, 'utf8');
    child.emit('close', exitCode);
  };
}

function happyHandlers(transcript = '  un retry con backoff, corré la suite de tests\n') {
  return [ffmpegWrites(WAV_2S), whisperWrites(transcript)];
}

// --- error shape ------------------------------------------------------------

describe('transcription error shape', () => {
  test('message is exactly the closed code set', () => {
    const codes = [
      'transcriber_unavailable', 'audio_too_large', 'audio_too_long',
      'conversion_failed', 'transcription_failed', 'transcription_timeout', 'aborted',
    ];
    for (const code of codes) {
      const err = new TranscriptionError(code);
      assert.equal(err.message, code);
      assert.equal(err.code, code);
      assert.equal(err.name, 'TranscriptionError');
      assert.ok(err instanceof Error);
    }
  });

  test('unknown codes are rejected at construction', () => {
    assert.throws(() => new TranscriptionError('not_a_code'), TypeError);
    assert.throws(() => new TranscriptionError(undefined), TypeError);
  });
});

// --- happy path -------------------------------------------------------------

describe('transcription happy path', () => {
  test('exact argv arrays and shell:false for both spawns; trimmed text; temp dir removed', async () => {
    const harness = makeHarness({ handlers: happyHandlers() });
    const result = await harness.transcriber.transcribe({ bytes: AUDIO_BYTES });

    assert.deepEqual(result, { text: 'un retry con backoff, corré la suite de tests' });
    const calls = harness.spawnImpl.calls;
    assert.equal(calls.length, 2);

    // Both spawns: argv arrays only, shell explicitly false.
    for (const call of calls) {
      assert.equal(Array.isArray(call.argv), true);
      assert.equal(call.options.shell, false);
    }

    const dir = harness.fake.mkdtempReturn();
    assert.ok(
      dir.startsWith(join(TMP_ROOT, 'bridge-audio-')),
      'mkdtemp must run under tmpRoot with a bridge-audio- prefix',
    );

    // tmpRoot is created, never assumed: no caller ordering dependency.
    assert.deepEqual(
      harness.fake.mkdirCalls(),
      [[TMP_ROOT, { recursive: true }]],
      'mkdir(tmpRoot, recursive) must run exactly once before mkdtemp',
    );

    assert.deepEqual(calls[0].argv, [
      '-y', '-i', 'input.bin', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'pcm_s16le', 'output.wav',
    ]);
    assert.equal(calls[0].options.cwd, dir);

    assert.deepEqual(calls[1].argv, [
      '-m', MODEL, '-f', join(dir, 'output.wav'), '-l', 'es', '-t', '8',
      '--prompt', 'tests, git', '-otxt', '-of', join(dir, 'transcript'),
    ]);
    assert.equal(calls[1].options.cwd, dir);

    // The audio bytes were written as input.bin, content probed by ffmpeg.
    const write = harness.fake.calls.writeFile[0];
    assert.equal(write[0], join(dir, 'input.bin'));
    assert.deepEqual(write[1], AUDIO_BYTES);

    // finally cleanup: whole temp directory removed.
    assert.deepEqual(harness.fake.calls.rm, [[dir, { recursive: true, force: true }]]);
  });

  test('oversized stderr beyond the cap is bounded and never surfaced', async () => {
    const noisy = (child) => {
      const big = Buffer.alloc(128, 0x41);
      child.stdout.emit('data', big);
      child.stdout.emit('data', big);
      child.stderr.emit('data', big);
      child.stderr.emit('data', big);
    };
    const harness = makeHarness({
      handlers: [
        (child, _a, o) => { noisy(child); ffmpegWrites(WAV_2S)(child, undefined, o); },
        (child, argv, o) => { noisy(child); whisperWrites('hola')(child, argv, o); },
      ],
      cfg: { maxStderrBytes: 8 },
    });
    const result = await harness.transcriber.transcribe({ bytes: AUDIO_BYTES });
    assert.deepEqual(result, { text: 'hola' });
  });
});

// --- finding 2: the exit code carries zero information -----------------------

describe('transcription success is judged only by the txt file', () => {
  test('whisper exits 1 with a valid non-empty txt: SUCCESS', async () => {
    const harness = makeHarness({ handlers: [ffmpegWrites(WAV_2S), whisperWrites('texto real', 1)] });
    const result = await harness.transcriber.transcribe({ bytes: AUDIO_BYTES });
    assert.deepEqual(result, { text: 'texto real' });
  });

  test('whisper exits 0 without a txt file: transcription_failed', async () => {
    const harness = makeHarness({ handlers: [ffmpegWrites(WAV_2S), whisperWrites(undefined, 0)] });
    await assert.rejects(
      harness.transcriber.transcribe({ bytes: AUDIO_BYTES }),
      (err) => err instanceof TranscriptionError && err.code === 'transcription_failed',
    );
  });

  test('empty txt file: silence resolves to { text: \'\' }, not failure', async () => {
    const harness = makeHarness({ handlers: [ffmpegWrites(WAV_2S), whisperWrites('', 0)] });
    const result = await harness.transcriber.transcribe({ bytes: AUDIO_BYTES });
    assert.deepEqual(result, { text: '' });
  });
});

// --- fail closed: availability and size ---------------------------------------

describe('transcription availability fails closed per call', () => {
  for (const missing of ['ffmpegPath', 'whisperCliPath', 'modelPath']) {
    test(`missing ${missing} -> transcriber_unavailable with zero spawns and zero temp I/O`, async () => {
      const harness = makeHarness({ handlers: [whisperWrites('x')] });
      delete harness.fake.files[CFG[missing]];
      await assert.rejects(
        harness.transcriber.transcribe({ bytes: AUDIO_BYTES }),
        (err) => err instanceof TranscriptionError && err.code === 'transcriber_unavailable',
      );
      assert.equal(harness.spawnImpl.calls.length, 0);
      assert.equal(harness.fake.calls.mkdtemp.length, 0);
      assert.equal(harness.fake.calls.writeFile.length, 0);
    });

    test(`${missing} that is a directory -> transcriber_unavailable`, async () => {
      const harness = makeHarness({});
      const target = CFG[missing];
      // Resurface the same path as a directory-shaped stat result.
      delete harness.fake.files[target];
      const realStat = harness.fake.stat.bind(harness.fake);
      harness.fake.stat = async (path) => {
        if (path === target) return { isFile: () => false, isDirectory: () => true };
        return realStat(path);
      };
      await assert.rejects(
        harness.transcriber.transcribe({ bytes: AUDIO_BYTES }),
        (err) => err instanceof TranscriptionError && err.code === 'transcriber_unavailable',
      );
      assert.equal(harness.spawnImpl.calls.length, 0);
    });
  }

  test('relative config paths are resolved against the module root', async () => {
    const rel = {
      ffmpegPath: '.local/test-runs/fake/ffmpeg.exe',
      whisperCliPath: '.local/test-runs/fake/whisper-cli.exe',
      modelPath: '.local/test-runs/fake/model.bin',
    };
    const abs = Object.fromEntries(
      Object.entries(rel).map(([k, v]) => [k, resolve(MODULE_ROOT, v)]),
    );
    const fake = createFakeFs({
      tmpRoot: TMP_ROOT,
      files: Object.fromEntries(
        Object.values(abs).map((p) => [p, Buffer.alloc(4)]),
      ),
    });
    currentFiles = fake.files;
    const spawnImpl = makeFakeSpawn();
    const transcriber = createTranscriber({ spawnImpl, fsImpl: fake, tmpRoot: TMP_ROOT, ...CFG, ...rel });
    // Availability passes (the resolved absolute paths were statted), then
    // the size pre-check fires — proving resolution happened at use time.
    await assert.rejects(
      transcriber.transcribe({ bytes: Buffer.alloc(2 * 1024 * 1024) }),
      (err) => err instanceof TranscriptionError && err.code === 'audio_too_large',
    );
    assert.equal(spawnImpl.calls.length, 0);
  });
});

describe('transcription size pre-check', () => {
  test('audio_too_large before any write or spawn', async () => {
    const harness = makeHarness({ handlers: [ffmpegWrites(WAV_2S), whisperWrites('x')] });
    await assert.rejects(
      harness.transcriber.transcribe({ bytes: Buffer.alloc(CFG.maxAudioBytes + 1) }),
      (err) => err instanceof TranscriptionError && err.code === 'audio_too_large',
    );
    assert.equal(harness.spawnImpl.calls.length, 0);
    assert.equal(harness.fake.calls.mkdtemp.length, 0);
    assert.equal(harness.fake.calls.writeFile.length, 0);
  });
});

// --- conversion -----------------------------------------------------------------

describe('ffmpeg conversion failures', () => {
  test('ffmpeg exit 1 -> conversion_failed', async () => {
    const harness = makeHarness({
      handlers: [(child) => child.emit('close', 1), whisperWrites('x')],
    });
    await assert.rejects(
      harness.transcriber.transcribe({ bytes: AUDIO_BYTES }),
      (err) => err instanceof TranscriptionError && err.code === 'conversion_failed',
    );
    assert.equal(harness.fake.calls.rm.length, 1, 'cleanup still runs on failure');
  });

  test('ffmpeg timeout kills the child and fails with conversion_failed', async () => {
    const harness = makeHarness({
      handlers: [() => { /* never closes */ }, whisperWrites('x')],
      cfg: { processTimeoutMs: 15 },
    });
    await assert.rejects(
      harness.transcriber.transcribe({ bytes: AUDIO_BYTES }),
      (err) => err instanceof TranscriptionError && err.code === 'conversion_failed',
    );
    assert.equal(harness.spawnImpl.calls[0].child.killed, true, 'ffmpeg child must be killed');
    assert.equal(harness.fake.calls.rm.length, 1, 'cleanup still runs on timeout');
  });

  test('ffmpeg exits 0 but output.wav is missing -> conversion_failed', async () => {
    const harness = makeHarness({
      handlers: [(child) => child.emit('close', 0), whisperWrites('x')],
    });
    await assert.rejects(
      harness.transcriber.transcribe({ bytes: AUDIO_BYTES }),
      (err) => err instanceof TranscriptionError && err.code === 'conversion_failed',
    );
    assert.equal(harness.spawnImpl.calls.length, 1, 'whisper must never run');
  });
});

// --- duration from evidence, not trust -------------------------------------------

describe('WAV duration parsing', () => {
  test('a hand-built RIFF under the cap passes (happy path, 2s of audio)', async () => {
    const harness = makeHarness({ handlers: happyHandlers() });
    const result = await harness.transcriber.transcribe({ bytes: AUDIO_BYTES });
    assert.deepEqual(result, { text: 'un retry con backoff, corré la suite de tests' });
  });

  test('duration over maxDurationSec -> audio_too_long', async () => {
    const harness = makeHarness({
      handlers: [ffmpegWrites(wavBytes({ dataMs: 4000 })), whisperWrites('x')],
      cfg: { maxDurationSec: 3 },
    });
    await assert.rejects(
      harness.transcriber.transcribe({ bytes: AUDIO_BYTES }),
      (err) => err instanceof TranscriptionError && err.code === 'audio_too_long',
    );
    assert.equal(harness.spawnImpl.calls.length, 1, 'whisper must never run');
  });

  test('malformed WAV header -> conversion_failed', async () => {
    const harness = makeHarness({
      handlers: [ffmpegWrites(Buffer.from('this is definitely not a riff wave file')), whisperWrites('x')],
    });
    await assert.rejects(
      harness.transcriber.transcribe({ bytes: AUDIO_BYTES }),
      (err) => err instanceof TranscriptionError && err.code === 'conversion_failed',
    );
  });

  test('wav file missing entirely -> conversion_failed', async () => {
    const harness = makeHarness({
      handlers: [(child) => child.emit('close', 0), whisperWrites('x')],
    });
    await assert.rejects(
      harness.transcriber.transcribe({ bytes: AUDIO_BYTES }),
      (err) => err instanceof TranscriptionError && err.code === 'conversion_failed',
    );
  });
});

// --- whisper timeout ----------------------------------------------------------------

describe('whisper timeout', () => {
  test('timeout kills the child and fails with transcription_timeout', async () => {
    const harness = makeHarness({
      handlers: [ffmpegWrites(WAV_2S), () => { /* never closes */ }],
      cfg: { processTimeoutMs: 15 },
    });
    await assert.rejects(
      harness.transcriber.transcribe({ bytes: AUDIO_BYTES }),
      (err) => err instanceof TranscriptionError && err.code === 'transcription_timeout',
    );
    assert.equal(harness.spawnImpl.calls[1].child.killed, true, 'whisper child must be killed');
    assert.equal(harness.fake.calls.rm.length, 1, 'cleanup still runs on timeout');
  });
});

// --- hostile config paths --------------------------------------------------------------

describe('hostile config paths arrive as single argv elements', () => {
  test('spaces, &, quotes, .. and unicode never go through a shell', async () => {
    const hostileWhisper = 'X:\\fake tools & "quotes"\\whis..per\\clï-üni (v1).exe';
    const hostileModel = 'X:\\módel path\'s & more\\ggml..smäll.bin';
    const hostileFfmpeg = 'X:\\ff & mpeg "dir"\\ffm..peg.exe';
    const fake = createFakeFs({
      tmpRoot: TMP_ROOT,
      files: {
        [hostileWhisper]: Buffer.alloc(4),
        [hostileModel]: Buffer.alloc(4),
        [hostileFfmpeg]: Buffer.alloc(4),
      },
    });
    currentFiles = fake.files;
    const spawnImpl = makeFakeSpawn([ffmpegWrites(WAV_2S), whisperWrites('hola')]);
    const transcriber = createTranscriber({
      spawnImpl,
      fsImpl: fake,
      tmpRoot: TMP_ROOT,
      ...CFG,
      ffmpegPath: hostileFfmpeg,
      whisperCliPath: hostileWhisper,
      modelPath: hostileModel,
    });
    const result = await transcriber.transcribe({ bytes: AUDIO_BYTES });
    assert.deepEqual(result, { text: 'hola' });

    const calls = spawnImpl.calls;
    assert.equal(calls[0].file, hostileFfmpeg);
    assert.equal(calls[1].file, hostileWhisper);
    assert.ok(calls[1].argv.includes(hostileModel), 'model path must be one whole argv element');
    for (const call of calls) {
      assert.equal(call.options.shell, false, 'shell:false is explicit, never a shell');
    }
  });
});

// --- cleanup in finally ------------------------------------------------------------------

describe('temp dir cleanup happens in finally on every outcome', () => {
  test('success removes the temp dir', async () => {
    const harness = makeHarness({ handlers: happyHandlers() });
    await harness.transcriber.transcribe({ bytes: AUDIO_BYTES });
    assert.equal(harness.fake.calls.rm.length, 1);
    assert.equal(harness.fake.calls.rm[0][1].recursive, true);
  });

  test('failure removes the temp dir even though it threw', async () => {
    const harness = makeHarness({
      handlers: [ffmpegWrites(WAV_2S), whisperWrites(undefined, 0)], // no txt -> failure
    });
    await assert.rejects(harness.transcriber.transcribe({ bytes: AUDIO_BYTES }));
    assert.equal(harness.fake.calls.rm.length, 1);
  });

  test('timeout removes the temp dir even though it threw', async () => {
    const harness = makeHarness({
      handlers: [ffmpegWrites(WAV_2S), () => {}],
      cfg: { processTimeoutMs: 15 },
    });
    await assert.rejects(harness.transcriber.transcribe({ bytes: AUDIO_BYTES }));
    assert.equal(harness.fake.calls.rm.length, 1);
  });
});

// --- error discipline ----------------------------------------------------------------------

describe('error privacy', () => {
  test('errors never echo paths, stderr or transcript content', async () => {
    const secretPath = 'X:\\secret-dir-should-never-appear\\whisper-cli.exe';
    const fake = createFakeFs({
      tmpRoot: TMP_ROOT,
      files: {
        [secretPath]: Buffer.alloc(4),
        [CFG.ffmpegPath]: Buffer.alloc(4),
        [CFG.modelPath]: Buffer.alloc(4),
      },
    });
    currentFiles = fake.files;
    const spawnImpl = makeFakeSpawn([
      ffmpegWrites(WAV_2S),
      (child, argv, options) => {
        child.stderr.emit('data', Buffer.from('SECRET-STDERR-CONTENT leaked token'));
        whisperWrites(undefined, 0)(child, argv, options);
      },
    ]);
    const transcriber = createTranscriber({
      spawnImpl,
      fsImpl: fake,
      tmpRoot: TMP_ROOT,
      ...CFG,
      whisperCliPath: secretPath,
    });
    let captured;
    await assert.rejects(
      transcriber.transcribe({ bytes: AUDIO_BYTES }),
      (e) => { captured = e; return e instanceof TranscriptionError; },
    );
    const err = captured;
    assert.ok(err, 'the rejection reason must be captured');
    assert.equal(err.message, 'transcription_failed');
    assert.ok(!err.message.includes('secret-dir-should-never-appear'));
    assert.ok(!err.message.includes('SECRET-STDERR-CONTENT'));
    assert.ok(!err.message.includes('whisper-cli'));
    assert.ok(!('stderr' in err) && !('path' in err));
    assert.equal(String(err), 'TranscriptionError: transcription_failed');
  });
});

// --- external abort ---------------------------------------------------------------------------

describe('external abort', () => {
  test('abort mid-whisper -> aborted, child killed, cleanup still ran', async () => {
    const controller = new AbortController();
    const harness = makeHarness({
      handlers: [
        ffmpegWrites(WAV_2S),
        // The whisper child never closes; the abort fires while it runs.
        () => { queueMicrotask(() => controller.abort()); },
      ],
    });
    await assert.rejects(
      harness.transcriber.transcribe({ bytes: AUDIO_BYTES, signal: controller.signal }),
      (err) => err instanceof TranscriptionError && err.code === 'aborted',
    );
    assert.equal(harness.spawnImpl.calls[1].child.killed, true, 'whisper child must be killed on abort');
    assert.equal(harness.fake.calls.rm.length, 1, 'finally cleanup still ran');
  });

  test('abort before the call -> aborted with zero spawns and zero I/O', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = makeHarness({ handlers: happyHandlers() });
    await assert.rejects(
      harness.transcriber.transcribe({ bytes: AUDIO_BYTES, signal: controller.signal }),
      (err) => err instanceof TranscriptionError && err.code === 'aborted',
    );
    assert.equal(harness.spawnImpl.calls.length, 0);
    assert.equal(harness.fake.calls.mkdtemp.length, 0);
  });
});
