import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { decideControlTick, parseBrokerControl } from '../src/runtime-broker.mjs';

const INSTANCE = 'a'.repeat(32);

describe('runtime broker control marker', () => {
  test('consumed marker is terminal and is not reset again', () => {
    const raw = JSON.stringify({ consumedAt: 123 });
    assert.equal(parseBrokerControl(raw, INSTANCE), 'consumed');
    assert.deepEqual(decideControlTick(raw, INSTANCE), { verdict: 'consumed', consume: false });
  });

  test('fresh stop command is consumed before it is applied', () => {
    const raw = JSON.stringify({ instanceId: INSTANCE, command: 'stop-broker', issuedAt: 123 });
    assert.deepEqual(decideControlTick(raw, INSTANCE), { verdict: 'stop', consume: true });
  });

  test('empty, invalid, foreign and unknown controls preserve their verdicts', () => {
    assert.deepEqual(decideControlTick('', INSTANCE), { verdict: 'empty', consume: false });
    assert.deepEqual(decideControlTick('{', INSTANCE), { verdict: 'invalid', consume: true });
    assert.deepEqual(decideControlTick(JSON.stringify({ instanceId: 'b'.repeat(32), command: 'stop-broker' }), INSTANCE), { verdict: 'foreign', consume: true });
    assert.deepEqual(decideControlTick(JSON.stringify({ instanceId: INSTANCE, command: 'unknown' }), INSTANCE), { verdict: 'unknown', consume: true });
  });
});
