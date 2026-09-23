// Strict LF JSONL framing for the Pi RPC protocol (see pi docs rpc.md).
// - Split records on \n ONLY; strip one optional trailing \r.
// - Node readline is NOT protocol-compliant (it also splits on U+2028/U+2029).
// - Malformed or oversized records are reported and dropped, never fatal and
//   never echoed unbounded: stdout may contain sensitive transcript content.

export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024; // 1 MiB per record

/** Serialize one RPC record: single-line JSON (newlines escaped by JSON). */
export function encodeRpcLine(value) {
  return JSON.stringify(value);
}

export class LfJsonReader {
  /**
   * @param {object} [options]
   * @param {(value: object) => void} [options.onLine] parsed record
   * @param {(info: {reason: string, raw: string}) => void} [options.onError]
   * @param {number} [options.maxLineBytes] drop lines longer than this
   */
  constructor({ onLine = () => {}, onError = () => {}, maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
    this.#onLine = onLine;
    this.#onError = onError;
    this.#maxLineBytes = maxLineBytes;
  }

  #onLine;
  #onError;
  #maxLineBytes;
  #buffer = '';
  #oversized = false;

  /** Feed a decoded text chunk (any split points are fine). */
  push(text) {
    this.#buffer += text;
    let index;
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const raw = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      this.#handleRawLine(raw);
    }
    // Bound memory when a stream never sends LF: drop and report once the
    // accumulated buffer exceeds the limit; resume at the next LF.
    if (this.#buffer.length > this.#maxLineBytes) {
      this.#oversized = true;
      this.#buffer = '';
      this.#onError({ reason: 'line_too_long', raw: '' });
    }
  }

  /** Flush a trailing record that was not newline-terminated. */
  end() {
    if (this.#oversized) {
      this.#oversized = false;
      this.#buffer = '';
      return;
    }
    const raw = this.#buffer;
    this.#buffer = '';
    if (raw.length > 0) this.#handleRawLine(raw);
  }

  #handleRawLine(raw) {
    let line = raw;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) return;
    if (line.length > this.#maxLineBytes) {
      this.#onError({ reason: 'line_too_long', raw: '' });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Never echo the raw line: child stdout may contain sensitive
      // transcript content. Only the reason and the length go out.
      this.#onError({ reason: 'bad_json', length: line.length });
      return;
    }
    try {
      this.#onLine(parsed);
    } catch {
      // A handler defect is not malformed input: report it under its own
      // fixed reason. Still swallowed (stream errors are never fatal) and
      // never echoing content: the exception message may embed the raw line.
      this.#onError({ reason: 'handler_error' });
    }
  }
}
