import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconstructPlan, reconstructionToPlan, estimateCycleSec } from '../src/inference/reconstruct.js';
import { predictHead, timeToAspect } from '../src/predict/state.js';

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

// --- gap-robust solver (Stage 1) ---

test('estimateCycleSec recovers the fundamental from missed cycles (integer-multiple gaps)', () => {
  // green onsets at 0, 90, 270, 360 -> gaps 90, 180, 90 (a cycle was missed once)
  const evs = [0, 90000, 270000, 360000].map((t) => ({ headId: 'A', aspect: 'green', t }));
  assert.equal(estimateCycleSec({ A: evs }), 90);
});

test('presence taps never create a boundary or shift the cycle', () => {
  const onsets = genEvents(4).filter((e) => e.headId === 'A'); // green/amber/red onsets
  const withPresence = [...onsets,
    { headId: 'A', aspect: 'green', t: 12345, kind: 'presence' },
    { headId: 'A', aspect: 'red', t: 99999, kind: 'presence' }];
  assert.equal(estimateCycleSec({ A: withPresence }), 90);
  const rec = reconstructPlan(withPresence, ['A']);
  assert.equal(rec.cycleLengthSec, 90);
  // 3 onset aspects -> boundaries {0,45,50} -> 3 phases; presence adds none
  assert.equal(rec.phases.length, 3);
});

test('a missed phase is flagged, not fabricated (tap green then red, amber unseen)', () => {
  const evs = [];
  for (let c = 0; c < 6; c++) {
    evs.push({ headId: 'A', aspect: 'green', t: c * 90000 });
    evs.push({ headId: 'A', aspect: 'red', t: c * 90000 + 50000 }); // amber skipped
  }
  const rec = reconstructPlan(evs, ['A']);
  assert.equal(rec.cycleLengthSec, 90);
  assert.ok(rec.impliedGaps >= 1); // green->red is illegal in Spain: amber went unseen
  // the green arc is marked partial (uncertain), the red arc is not
  const greenPhase = rec.phases.find((p) => p.states.A === 'green');
  assert.equal(greenPhase.partial, true);
});

test('a single fat-finger onset does not move a boundary', () => {
  const evs = genEvents(6).filter((e) => e.headId === 'A');
  evs.push({ headId: 'A', aspect: 'green', t: 2 * 90000 + 30000 }); // stray green at pos 30
  const rec = reconstructPlan(evs, ['A']);
  const green = rec.headWindows.find((h) => h.headId === 'A').onsets.find((o) => o.aspect === 'green');
  assert.ok(green.pos <= 1, `green onset should stay near 0, got ${green.pos}`);
});

test('per-head verdicts: fixed, actuated, insufficient', () => {
  const fixed = reconstructPlan(genEvents(6), ['A', 'B']);
  assert.equal(fixed.headVerdicts.A, 'fixed');
  assert.equal(fixed.headVerdicts.B, 'fixed');

  const act = reconstructPlan(genEvents(8, [0, 22, -12, 28, -16, 20, -14, 25]), ['A', 'B']);
  assert.equal(act.headVerdicts.A, 'actuated');

  // B fixes the cycle; A has only 2 onsets -> can't be judged
  const evs = [];
  for (let c = 0; c < 6; c++) evs.push({ headId: 'B', aspect: 'green', t: c * 90000 });
  evs.push({ headId: 'A', aspect: 'green', t: 1000 }, { headId: 'A', aspect: 'amber', t: 46000 });
  const rec = reconstructPlan(evs, ['A', 'B']);
  assert.equal(rec.headVerdicts.A, 'insufficient');
});

test('timeToAspect gives seconds until a head next turns green', () => {
  const plan = reconstructionToPlan(reconstructPlan(genEvents(6), ['A', 'B']));
  const epoch = plan.epoch;
  // A is green 0-45; at 20s in it's already green
  assert.deepEqual(timeToAspect(plan, 'A', epoch + 20000, 'green'), { secToAspect: 0, current: true, unpredictable: false });
  // at 60s in, A is red (50-90); next green onset wraps at 90 -> 30s away
  assert.equal(timeToAspect(plan, 'A', epoch + 60000, 'green').secToAspect, 30);
  // B is red 0-50; green starts at 50 -> 30s away at 20s in
  assert.equal(timeToAspect(plan, 'B', epoch + 20000, 'green').secToAspect, 30);
});

test('recent-window re-anchor folds only recent events', () => {
  // old drifted junk far in the past + a clean recent run; window keeps the run
  const old = [{ headId: 'A', aspect: 'green', t: 0 }, { headId: 'A', aspect: 'green', t: 37000 }];
  const recent = [];
  const base = 10_000_000;
  for (let c = 0; c < 6; c++) recent.push({ headId: 'A', aspect: 'green', t: base + c * 90000 });
  const rec = reconstructPlan([...old, ...recent], ['A'], { recentWindowMs: 700000, now: base + 5 * 90000 });
  assert.equal(rec.cycleLengthSec, 90);
  assert.ok(rec.epoch >= base); // re-anchored to the recent run
});

test('countdown runs to the head\'s own color change, across other heads\' boundaries', () => {
  // boundaries at 0,45,50,85; A is red 50-90 (spans the 85 boundary, which is B's)
  const plan = reconstructionToPlan(reconstructPlan(genEvents(6), ['A', 'B']));
  assert.equal(predictHead(plan, 'A', plan.epoch + 60000).secToChange, 30); // to 90, not to 85
  assert.equal(predictHead(plan, 'B', plan.epoch + 20000).secToChange, 30); // red 0-50 spans the 45 boundary
});

test('actuated heads are never predicted; a fixed head next to one stays exact', () => {
  const rec = reconstructPlan(genEvents(8, [0, 22, -12, 28, -16, 20, -14, 25]), ['A', 'B']);
  const plan = reconstructionToPlan(rec);
  assert.deepEqual(plan.unpredictableHeads, ['A']);
  const t = plan.epoch + 10000;                  // B red (0-50), A green
  const b = predictHead(plan, 'B', t);
  assert.equal(b.unpredictable, false);
  assert.equal(b.uncertain, false);
  assert.equal(b.secToChange, 40);              // exact: to B's green at 50
  assert.equal(timeToAspect(plan, 'B', t, 'green').secToAspect, 40);
  const a = predictHead(plan, 'A', t);
  assert.equal(a.unpredictable, true);
  assert.equal(a.secToChange, null);
  assert.equal(timeToAspect(plan, 'A', t + 50000, 'green').unpredictable, true);
});