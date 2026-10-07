// Backtest comparison logic with a hand-made model (no real data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareOnsets, backtestReport } from '../tools/teslamate/backtest.js';

const C = 90, EPOCH = Date.UTC(2026, 0, 5, 12, 0, 0); // green starts at EPOCH + k*90 s
const plan = (hyp = 'steady', pm = 1) => ({
  id: 'p1', windows: [{ fromMin: 0, toMin: 1440 }], dayClass: 'all', cycleSec: C, cycleSigmaSec: 0,
  marks: { 'h|green': { posSec: 0, spreadSec: pm, n: 5, actuated: false } },
  clock: { hypothesis: hyp, epochMs: EPOCH, dayOffsets: {}, days: 5, residRmsSec: pm, driftSecPerHour: 0 },
});
const model = (p = plan()) => ({ lag: { minSec: 0.2, medianSec: 0.4 }, groups: [{ id: 'g', plans: [p] }], lights: { h: { intersectionId: 'i', groupId: 'g', aspects: ['green'] } } });
const dep = (k, lagSec, headId = 'h') => ({ headId, t: EPOCH + (k * C + lagSec) * 1000 });

test('departures a few seconds after predicted green fit; median/front lags reported', () => {
  const r = compareOnsets(model(), [dep(10, 3), dep(11, 5), dep(12, 9), dep(13, 4)]);
  assert.equal(r.totals.fit, 4);
  assert.equal(r.totals.contradict, 0);
  assert.equal(r.rows[0].medianLagSec, 4.5);
  assert.equal(r.rows[0].frontLagSec, 3);
});

test('a departure mid-cycle (model says red, high confidence) is a contradiction', () => {
  const r = compareOnsets(model(), [dep(10, 3), dep(11, 30)]);
  assert.equal(r.totals.fit, 1);
  assert.equal(r.totals.inconsistent, 1);
  assert.equal(r.totals.contradict, 1);
  assert.equal(r.contradictions[0].lagSec, 30);
});

test('just before predicted green counts as early, not as a +85 s lag', () => {
  const r = compareOnsets(model(plan('steady', 1)), [dep(10, -0.5), dep(11, -20)]);
  assert.equal(r.totals.fit, 1);
  assert.equal(r.contradictions[0].lagSec, -20);
});

test('low-confidence misses are inconsistent but not contradictions', () => {
  const r = compareOnsets(model(plan('nudged', 10)), [dep(10, 50)]);
  assert.equal(r.totals.inconsistent, 1);
  assert.equal(r.totals.contradict, 0);
});

test('unpredictable lights/times are counted separately, never as failures', () => {
  const r = compareOnsets(model(plan('independent')), [dep(10, 3)]);
  assert.equal(r.totals.unpredictable, 1);
  assert.equal(r.totals.fit + r.totals.inconsistent, 0);
  const r2 = compareOnsets(model(), [dep(10, 3, 'unknown')]);
  assert.equal(r2.totals.unpredictable, 1);
  assert.match(backtestReport(r2), /not predictable/i);
});
