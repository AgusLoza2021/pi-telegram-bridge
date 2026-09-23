// T02 WU1: strict LF JSONL framing for the Pi RPC protocol.
// rpc.md: "Split records on \n only"; Node readline is NOT protocol-compliant
// because it also splits on U+2028/U+2029 (valid inside JSON strings).

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { LfJsonReader, encodeRpcLine } from '../src/rpc-framing.mjs';

describe('rpc-framing: strict LF JSONL', () => {
  let lines;
  let errors;
  let reader;

  beforeEach(() => {
    lines = [];
    errors = [];
    reader = new LfJsonReader({
      onLine: (value) => lines.push(value),
      onError: (info) => errors.push(info),
    });
  });

  test('splits records on LF only', () => {
    reader.push('{"a":1}\n{"b":2}\n');
    assert.deepEqual(lines, [{ a: 1 }, { b: 2 }]);
    assert.equal(errors.length, 0);
  });

  test('U+2028 and U+2029 inside JSON strings do NOT split records (readline trap)', () => {
    // A single JSON record whose string value contains U+2028/U+2029.
    const record = JSON.stringify({ text: 'line\u2028sep\u2029end' });
    reader.push(record + '\n' + '{"after":true}\n');
    assert.deepEqual(lines, [{ text: 'line\u2028sep\u2029end' }, { after: true }]);
  });

  test('accepts CRLF by stripping a single trailing CR', () => {
    reader.push('{"a":1}\r\n{"b":2}\r\n');
    assert.deepEqual(lines, [{ a: 1 }, { b: 2 }]);
  });

  test('handles records split across chunks', () => {
    reader.push('{"a":');
    reader.push('1}\n{"b"');
    reader.push(':2}\n');
    assert.deepEqual(lines, [{ a: 1 }, { b: 2 }]);
  });

  test('flushes a trailing record without newline on end()', () => {
    reader.push('{"a":1}\n{"tail":true}');
    reader.end();
    assert.deepEqual(lines, [{ a: 1 }, { tail: true }]);
  });

  test('empty lines are skipped without errors', () => {
    reader.push('\n\n{"a":1}\n\n');
    assert.deepEqual(lines, [{ a: 1 }]);
    assert.equal(errors.length, 0);
  });

  test('malformed JSON reports a bounded error WITHOUT echoing raw content and keeps reading', () => {
    const secretish = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.sig';
    reader.push(`{bad:${secretish}}\n{"ok":true}\n`);
    assert.equal(errors.length, 1);
    const serialized = JSON.stringify(errors);
    assert.ok(!serialized.includes('Bearer'), 'error must never echo raw line content');
    assert.ok(!serialized.includes('eyJ'), 'error must never echo raw line content');
    assert.equal(typeof errors[0].length, 'number', 'error carries the offending length instead');
    assert.deepEqual(lines, [{ ok: true }]);
  });

  test('oversized line (no LF within bound) is dropped with an error, stream continues', () => {
    const tiny = new LfJsonReader({
      onLine: (value) => lines.push(value),
      onError: (info) => errors.push(info),
      maxLineBytes: 16,
    });
    tiny.push('{"this-line-is-way-too-long"}\n{"ok":1}\n');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].reason, 'line_too_long');
    assert.deepEqual(lines, [{ ok: 1 }]);
    assert.ok(JSON.stringify(lines).length < 100, 'no oversized payload retained');
  });

  test('end() with leftover malformed fragment reports an error, not a throw', () => {
    reader.push('{oops');
    reader.end();
    assert.equal(errors.length, 1);
    assert.equal(lines.length, 0);
  });

  test('a throwing handler reports handler_error, not bad_json, and never throws', () => {
    const handlerErrors = [];
    const throwing = new LfJsonReader({
      onLine: () => {
        throw new Error('handler defect');
      },
      onError: (info) => handlerErrors.push(info),
    });
    assert.doesNotThrow(() => throwing.push('{"valid":"json"}\n'));
    assert.deepEqual(handlerErrors, [{ reason: 'handler_error' }]);
  });

  test('encodeRpcLine produces single-line JSON with no control newlines', () => {
    const line = encodeRpcLine({ type: 'prompt', message: 'two\nlines' });
    assert.ok(!line.includes('\n'));
    assert.deepEqual(JSON.parse(line), { type: 'prompt', message: 'two\nlines' });
  });
});
