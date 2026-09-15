import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconstructPlan, reconstructionToPlan, estimateCycleSec } from '../src/inference/reconstruct.js';
import { predictHead } from '../src/predict/state.js';

// Two-head fixed-time cycle, 90s:
//  A: green 0-45, amber 45-50, red 50-90
//  B: red 0-50, green 50-85, amber 85-90
function genEvents(cycles, jitterA = null) {
  const evs = [];
  for (let c = 0; c < cycles; c++) {
    const base = c * 90000;
    const gA = jitterA ? jitterA[c % jitterA.length] : 0;
    evs.push({ headId: 'A', aspect: 'green', t: base });
    evs.push({ headId: 'A', aspect: 'amber', t: base + (45 + gA) * 1000 });
    evs.push({ headId: 'A', aspect: 'red', t: base + (50 + gA) * 1000 });
    evs.push({ headId: 'B', aspect: 'red', t: base });
    evs.push({ headId: 'B', aspect: 'green', t: base + 50000 });
    evs.push({ headId: 'B', aspect: 'amber', t: base + 85000 });
  }
  return evs;
}

test('estimateCycleSec finds the period', () => {
  assert.equal(estimateCycleSec({ A: genEvents(6).filter((e) => e.headId === 'A') }), 90);
});

test('reconstructs a clean fixed-time cycle into phases', () => {
  const rec = reconstructPlan(genEvents(6), ['A', 'B']);
  assert.ok(rec);
  assert.equal(rec.cycleLengthSec, 90);
  assert.equal(rec.modelable, true);
  assert.equal(rec.timeBasedRatio, 1);
  // boundaries 0,45,50,85 -> 4 phases
  assert.equal(rec.phases.length, 4);
  const p0 = rec.phases[0]; // 0-45
  assert.equal(p0.states.A, 'green');
  assert.equal(p0.states.B, 'red');
  const p2 = rec.phases[2]; // 50-85
  assert.equal(p2.states.A, 'red');
  assert.equal(p2.states.B, 'green');
  assert.equal(rec.confidence.level, 'high');
});

test('reconstructed plan predicts a head correctly', () => {
  const rec = reconstructPlan(genEvents(6), ['A', 'B']);
  const plan = reconstructionToPlan(rec);
  const p = predictHead(plan, 'A', rec.epoch + 20000); // 20s in -> A green
  assert.equal(p.aspect, 'green');
  const q = predictHead(plan, 'B', rec.epoch + 60000); // 60s in -> B green
  assert.equal(q.aspect, 'green');
});

test('coverage: an unobserved structural head is reported missing', () => {
  const rec = reconstructPlan(genEvents(4), ['A', 'B', 'C']);
  assert.deepEqual(rec.observedHeads.sort(), ['A', 'B']);
  assert.deepEqual(rec.missingHeads, ['C']);
});

test('a jittery head is flagged actuated (not fully time-based)', () => {
  // A's green length swings widely (actuated) -> its amber/red onsets wander.
  const rec = reconstructPlan(genEvents(8, [0, 22, -12, 28, -16, 20, -14, 25]), ['A', 'B']);
  assert.ok(rec);
  assert.ok(rec.timeBasedRatio < 1); // A's boundaries wander
  assert.ok(rec.phases.some((p) => p.type === 'actuated'));
});

test('returns null when there is no periodic signal', () => {
  assert.equal(reconstructPlan([{ headId: 'A', aspect: 'green', t: 1000 }], ['A']), null);
});
