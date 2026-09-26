// Local voice transcription for the Pi Telegram bridge (T3).
//
// Security and reliability invariants:
// - No network anywhere in this module: both external tools run from
//   absolute, config-provided paths. There is no PATH lookup and no
//   download at runtime; a missing artifact is a typed fail-closed
//   condition (`transcriber_unavailable`), never a crash or a fallback.
// - Subprocesses are spawned with argv ARRAYS and `shell: false`, always.
//   No string is ever interpolated into a command line: paths with
//   spaces, `&`, quotes or unicode must arrive as single argv elements.
// - The whisper exit code carries zero information (it exits 0 on
//   decoder failure). Success is judged ONLY by the `-otxt -of <base>`
//   output file: missing -> decoder failure; empty -> silence (not a
//   failure); non-empty -> the transcript.
// - ffmpeg exit codes ARE trustworthy; conversion failure is detected
//   the normal way (non-zero exit, timeout, or missing output.wav).
// - Everything is bounded: per-process timeout, max audio bytes, max
//   measured WAV duration, and a hard cap on captured stderr/stdout.
//   Captured streams are used only internally and NEVER surfaced.
// - Audio lives only in a fresh temp directory that is removed in a
//   `finally` on success, failure and timeout alike. No audio outside
//   the temp dir, ever.
// - Errors are fixed credential-free, path-free, content-free codes:
//   the message is exactly the code and nothing else.

import { spawn } from 'node:child_process';
import { stat, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));

const ERROR_CODES = Object.freeze([
  'transcriber_unavailable',
  'audio_too_large',
  'audio_too_long',
  'conversion_failed',
  'transcription_failed',
  'transcription_timeout',
  'aborted',
]);

/** Fixed leak-free failure. The message is only the code. */
export class TranscriptionError extends Error {
  constructor(code) {
    if (!ERROR_CODES.includes(code)) {
      throw new TypeError('unknown transcription error code');
    }
    super(code);
    this.name = 'TranscriptionError';
    this.code = code;
  }
}

const defaultFs = {
  stat,
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  rm,
};

/**
 * Resolve a config path at use time: absolute paths pass through;
 * relative paths resolve against the module root (the same state root
 * the rest of the bridge uses, e.g. `.local/tools/...`).
 */
function resolveToolPath(pathValue) {
  return isAbsolute(pathValue) ? pathValue : resolve(MODULE_ROOT, pathValue);
}

/**
 * Collect a byte stream into `sink` with a hard cap; once the cap is
 * reached, further chunks are dropped (never accumulated unbounded).
 */
function collectBounded(stream, cap, sink) {
  if (!stream || typeof stream.on !== 'function') return;
  let total = 0;
  stream.on('data', (chunk) => {
    if (total >= cap) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const take = Math.min(buf.length, cap - total);
    sink.push(buf.subarray(0, take));
    total += take;
  });
}

/**
 * Run one child process to completion under a timeout and an external
 * abort signal. Resolves with the exit code; rejects with a typed error
 * on timeout (`timeoutCode`), spawn error or abort (`aborted`).
 * stderr/stdout are collected up to `stderrCap` and used only
 * internally (e.g. distinguishing kill vs exit); never surfaced.
 */
function runProcess({ spawnImpl, file, argv, cwd, timeoutMs, stderrCap, signal, timeoutCode }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    let spawnError = null;
    const stdoutChunks = [];
    const stderrChunks = [];

    const finish = (settle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      settle();
    };

    const onAbort = () => {
      try { child.kill(); } catch { /* already gone */ }
      finish(() => rejectPromise(new TranscriptionError('aborted')));
    };

    const child = spawnImpl(file, argv, { cwd, shell: false });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* already gone */ }
      finish(() => rejectPromise(new TranscriptionError(timeoutCode)));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    collectBounded(child.stdout, stderrCap, stdoutChunks);
    collectBounded(child.stderr, stderrCap, stderrChunks);

    if (typeof child.on === 'function') {
      child.on('error', (err) => {
        // Keep the error only to distinguish kill vs exit; never surface it.
        spawnError = err;
      });
      child.on('close', (code) => {
        finish(() => {
          if (timedOut) {
            rejectPromise(new TranscriptionError(timeoutCode));
            return;
          }
          if (spawnError) {
            rejectPromise(new TranscriptionError(timeoutCode));
            return;
          }
          resolvePromise({ code });
        });
      });
    } else {
      // Degenerate fake without event support cannot report completion.
      finish(() => rejectPromise(new TranscriptionError(timeoutCode)));
    }
  });
}

/**
 * Parse a RIFF WAVE header and return the duration in seconds from the
 * fmt `byteRate` and the `data` chunk size — measured evidence, never a
 * claimed value. Returns null on any malformed header.
 */
export function parseWavDurationSec(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') {
    return null;
  }
  let offset = 12;
  let byteRate = null;
  let dataSize = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      if (size < 16 || offset + 8 + size > bytes.length) return null;
      byteRate = bytes.readUInt32LE(offset + 8 + 8);
    } else if (id === 'data') {
      dataSize = size;
      break;
    }
    // Chunks are word-aligned; advance past id+size+payload.
    offset += 8 + size + (size % 2);
    if (offset <= 12 + 8) return null; // overflow guard against absurd sizes
  }
  if (byteRate === null || dataSize === null || byteRate <= 0) return null;
  const seconds = dataSize / byteRate;
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Create a local transcriber around the two external tools.
 * @param {object} deps
 * @param {typeof import('node:child_process').spawn} [deps.spawnImpl]
 *   injected spawn (test seam); defaults to the real node:child_process
 * @param {object} [deps.fsImpl] injected async fs with `stat`, `mkdir`,
 *   `mkdtemp`, `writeFile`, `readFile`, `rm`; defaults to node:fs/promises
 * @param {string} [deps.tmpRoot] base directory for mkdtemp; created
 *   recursively if missing, so no caller ordering can break transcription
 * @param {string} deps.ffmpegPath absolute or state-root-relative path
 * @param {string} deps.whisperCliPath absolute or state-root-relative path
 * @param {string} deps.modelPath absolute or state-root-relative path
 * @param {string} deps.language ISO language code passed as `-l`
 * @param {number} deps.threads CPU threads passed as `-t`
 * @param {string} deps.prompt initial prompt passed as `--prompt`
 * @param {number} deps.maxAudioBytes input size cap in bytes
 * @param {number} deps.maxDurationSec measured WAV duration cap
 * @param {number} deps.processTimeoutMs per-subprocess timeout
 * @param {number} deps.maxStderrBytes captured stream cap per process
 * @returns {{ transcribe: (input: { bytes: Uint8Array, signal?: AbortSignal }) => Promise<{ text: string }> }}
 */
export function createTranscriber({
  spawnImpl = spawn,
  fsImpl = defaultFs,
  tmpRoot = resolve(MODULE_ROOT, '.local', 'tmp'),
  ffmpegPath,
  whisperCliPath,
  modelPath,
  language,
  threads,
  prompt,
  maxAudioBytes,
  maxDurationSec,
  processTimeoutMs,
  maxStderrBytes,
} = {}) {
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
  for (const name of ['stat', 'mkdir', 'mkdtemp', 'writeFile', 'readFile', 'rm']) {
    if (typeof fsImpl?.[name] !== 'function') {
      throw new TypeError(`fsImpl.${name} must be a function`);
    }
  }
  if (typeof tmpRoot !== 'string' || tmpRoot.length === 0) {
    throw new TypeError('tmpRoot must be a non-empty string');
  }
  for (const pathValue of [ffmpegPath, whisperCliPath, modelPath]) {
    if (typeof pathValue !== 'string' || pathValue.length === 0) {
      throw new TypeError('tool paths must be non-empty strings');
    }
  }
  for (const textValue of [language, prompt]) {
    if (typeof textValue !== 'string' || textValue.length === 0) {
      throw new TypeError('language and prompt must be non-empty strings');
    }
  }
  for (const numberValue of [threads, maxAudioBytes, maxDurationSec, processTimeoutMs, maxStderrBytes]) {
    if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
      throw new TypeError('numeric options must be positive integers');
    }
  }

  /**
   * Transcribe raw audio bytes into text. Throws TranscriptionError
   * with a fixed code on every failure path; the message is the code.
   */
  async function transcribe({ bytes, signal } = {}) {
    if (signal?.aborted) throw new TranscriptionError('aborted');

    // 1. Availability, per call, fail closed: all three artifacts must
    //    exist and be files. Nothing is spawned or written otherwise.
    for (const pathValue of [ffmpegPath, whisperCliPath, modelPath]) {
      const absolute = resolveToolPath(pathValue);
      let stats;
      try {
        stats = await fsImpl.stat(absolute);
      } catch {
        throw new TranscriptionError('transcriber_unavailable');
      }
      if (typeof stats?.isFile !== 'function' || !stats.isFile()) {
        throw new TranscriptionError('transcriber_unavailable');
      }
    }

    // 2. Size pre-check before any I/O.
    if (bytes.byteLength > maxAudioBytes) {
      throw new TranscriptionError('audio_too_large');
    }

    // 3. Fresh temp dir; the whole directory is removed in the finally
    //    below on success, failure and timeout alike.
    let dir;
    try {
      // tmpRoot is created, not assumed: a fresh checkout or a wiped state
      // root must not surface as a confusing transcription failure.
      await fsImpl.mkdir(tmpRoot, { recursive: true });
      dir = await fsImpl.mkdtemp(join(tmpRoot, 'bridge-audio-'));
    } catch {
      throw new TranscriptionError('transcription_failed');
    }
    const wavPath = join(dir, 'output.wav');
    const transcriptBase = join(dir, 'transcript');

    try {
      try {
        await fsImpl.writeFile(join(dir, 'input.bin'), Buffer.from(bytes));
      } catch {
        throw new TranscriptionError('transcription_failed');
      }

      // 4. Convert to 16 kHz mono PCM WAV. ffmpeg exit codes are
      //    trustworthy; a timeout or a spawn error also fails here.
      let conversion;
      try {
        conversion = await runProcess({
          spawnImpl,
          file: resolveToolPath(ffmpegPath),
          argv: ['-y', '-i', 'input.bin', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', 'output.wav'],
          cwd: dir,
          timeoutMs: processTimeoutMs,
          stderrCap: maxStderrBytes,
          signal,
          timeoutCode: 'conversion_failed',
        });
      } catch (err) {
        if (err instanceof TranscriptionError) throw err;
        throw new TranscriptionError('conversion_failed');
      }
      if (conversion.code !== 0) {
        throw new TranscriptionError('conversion_failed');
      }

      // 5. Duration from evidence: parse the converted WAV header.
      let wavBytes;
      try {
        wavBytes = await fsImpl.readFile(wavPath);
      } catch {
        throw new TranscriptionError('conversion_failed');
      }
      const durationSec = parseWavDurationSec(wavBytes);
      if (durationSec === null) {
        throw new TranscriptionError('conversion_failed');
      }
      if (durationSec > maxDurationSec) {
        throw new TranscriptionError('audio_too_long');
      }

      if (signal?.aborted) throw new TranscriptionError('aborted');

      // 6. Transcribe. The exit code carries zero information: success
      //    is judged only by the .txt output file below.
      try {
        await runProcess({
          spawnImpl,
          file: resolveToolPath(whisperCliPath),
          argv: [
            '-m', resolveToolPath(modelPath),
            '-f', wavPath,
            '-l', language,
            '-t', String(threads),
            '--prompt', prompt,
            '-otxt', '-of', transcriptBase,
          ],
          cwd: dir,
          timeoutMs: processTimeoutMs,
          stderrCap: maxStderrBytes,
          signal,
          timeoutCode: 'transcription_timeout',
        });
      } catch (err) {
        if (err instanceof TranscriptionError) throw err;
        throw new TranscriptionError('transcription_failed');
      }

      let txt;
      try {
        txt = await fsImpl.readFile(`${transcriptBase}.txt`);
      } catch {
        // Missing output file means the decoder failed (finding 2).
        throw new TranscriptionError('transcription_failed');
      }
      // An empty file is silence, not failure.
      return { text: txt.toString('utf8').trim() };
    } finally {
      try {
        await fsImpl.rm(dir, { recursive: true, force: true });
      } catch {
        // Cleanup failure must not mask the primary outcome.
      }
    }
  }

  return { transcribe };
}
