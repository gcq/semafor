import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareIntersections, findCorridors } from '../src/inference/linkage.js';

const est = (cycleLengthSec, epoch) => ({
  stages: [], cycleLengthSec, cycleStdevSec: 0, cyclesObserved: 10, epoch,
  confidence: { cycles: 10, stdevSec: 0, level: 'high' },
});

test('different cycle lengths => independent, high confidence', () => {
  const v = compareIntersections('a', est(90, 0), 'b', est(60, 0));
  assert.equal(v.linked, false);
  assert.equal(v.confidence, 'high');
});

test('same cycle + stable offset across sessions => linked', () => {
  // B consistently starts 12s after A, three sessions.
  const a = [est(90, 0), est(90, 90_000), est(90, 180_000)];
  const b = [est(90, 12_000), est(90, 102_000), est(90, 192_000)];
  const v = compareIntersections('a', a, 'b', b);
  assert.equal(v.linked, true);
  assert.equal(v.confidence, 'high');
  assert.ok(Math.abs(v.offsetSec - 12) < 1);
});

test('same cycle but wandering offset => not coordinated', () => {
  const a = [est(90, 0), est(90, 90_000), est(90, 180_000)];
  const b = [est(90, 5_000), est(90, 130_000), est(90, 205_000)]; // offset jumps around
  const v = compareIntersections('a', a, 'b', b);
  assert.equal(v.linked, false);
  assert.match(v.reason, /drifts|actuated/);
});

test('single session each, authoritative inputs => linked, medium confidence', () => {
  const v = compareIntersections('a', est(90, 0), 'b', est(90, 12_000));
  assert.equal(v.linked, true);
  assert.equal(v.confidence, 'medium'); // both inputs high-confidence
});

test('single session each, noisy inputs => linked but low confidence', () => {
  const lo = (c, e) => ({ ...est(c, e), confidence: { cycles: 2, stdevSec: 5, level: 'low' } });
  const v = compareIntersections('a', lo(90, 0), 'b', lo(90, 12_000));
  assert.equal(v.linked, true);
  assert.equal(v.confidence, 'low');
});

test('findCorridors groups transitively', () => {
  const a = [est(90, 0), est(90, 90_000), est(90, 180_000)];
  const b = [est(90, 12_000), est(90, 102_000), est(90, 192_000)];
  const c = [est(90, 24_000), est(90, 114_000), est(90, 204_000)];
  const lone = [est(60, 0)];
  const { corridors } = findCorridors({ a, b, c, lone });
  assert.equal(corridors.length, 1);
  assert.deepEqual(corridors[0].sort(), ['a', 'b', 'c']);
});
