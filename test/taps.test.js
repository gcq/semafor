import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tapKind, TAP_MEMORY_MS } from '../src/inference/taps.js';

const tap = (headId, aspect, t) => ({ headId, aspect, t });

test('first tap ever only records what the light shows', () => {
  assert.equal(tapKind(null, 'A', 'red', 1000), 'presence');
});

test('a color change on the light you are watching is a transition', () => {
  assert.equal(tapKind(tap('A', 'red', 0), 'A', 'green', 30000), 'onset');
});

test('the first tap after switching lights sets its current state, not a transition', () => {
  assert.equal(tapKind(tap('A', 'red', 0), 'B', 'green', 5000), 'presence');
});

test('switching back to a light also starts fresh (its change happened unseen)', () => {
  // watched A (red), switched to B, came back to A which is now green
  assert.equal(tapKind(tap('B', 'red', 20000), 'A', 'green', 40000), 'presence');
});

test('repeating the same color is presence', () => {
  assert.equal(tapKind(tap('A', 'red', 0), 'A', 'red', 10000), 'presence');
});

test('after a long gap you were not watching, so no transition', () => {
  assert.equal(tapKind(tap('A', 'red', 0), 'A', 'green', TAP_MEMORY_MS + 1), 'presence');
});
