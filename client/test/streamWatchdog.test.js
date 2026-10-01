import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchdogVerdict } from '../src/streamWatchdog.js';

test('failed health probes do not cancel a stream that is still receiving bytes', () => {
  assert.equal(watchdogVerdict({ now: 50_000, lastByteAt: 35_000, probeFailures: 3 }), null);
});

test('failed health probes end a stream after its bytes stop', () => {
  const verdict = watchdogVerdict({ now: 50_000, lastByteAt: 0, probeFailures: 3 });
  assert.equal(verdict.reason, 'unreachable');
});
