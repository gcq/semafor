import { test } from 'node:test';
import assert from 'node:assert/strict';

import { predictHead, cycleTimeMs, activePlan } from '../src/predict/state.js';
import { rankNext, distanceM, angularDiff, headForApproach } from '../src/nav/proximity.js';
import { withCycleLength } from '../src/domain/model.js';

// Head h1: red 30s, green 25s, amber 5s (aspects observed directly).
const plan = withCycleLength({
  id: 'p1', epoch: 0,
  stages: [
    { states: { h1: 'red' }, timing: { type: 'fixed', sec: 30 } },
    { states: { h1: 'green' }, timing: { type: 'fixed', sec: 25 } },
    { states: { h1: 'amber' }, timing: { type: 'fixed', sec: 5 } },
  ],
});

test('cycle length is summed and cached', () => {
  assert.equal(plan.cycleLengthMs, 60000);
});

test('predict lands in the right phase and counts down (red)', () => {
  const p = predictHead(plan, 'h1', 10_000); // 10s in -> red, 20 left
  assert.equal(p.aspect, 'red');
  assert.equal(p.go, false);
  assert.equal(p.secToChange, 20);
  assert.equal(p.next, 'green');
});

test('predict wraps across cycle boundary', () => {
  const p = predictHead(plan, 'h1', 65_000); // 5s into next cycle -> red, 25 left
  assert.equal(p.aspect, 'red');
  assert.equal(p.secToChange, 25);
});

test('green window counts down to its end', () => {
  const p = predictHead(plan, 'h1', 40_000); // 10s into 25s green
  assert.equal(p.aspect, 'green');
  assert.equal(p.secToChange, 15);
});

test('amber is its own observed phase', () => {
  const p = predictHead(plan, 'h1', 57_000); // 2s into the 5s amber (starts at 55)
  assert.equal(p.aspect, 'amber');
  assert.equal(p.secToChange, 3);
});

test('flashing amber is a go aspect', () => {
  const yp = withCycleLength({ id: 'y', epoch: 0, stages: [
    { states: { h1: 'flash-amber' }, timing: { type: 'fixed', sec: 20 } },
    { states: { h1: 'red' }, timing: { type: 'fixed', sec: 20 } },
  ] });
  const p = predictHead(yp, 'h1', 5_000);
  assert.equal(p.aspect, 'flash-amber');
  assert.equal(p.go, true);
  assert.equal(p.secToChange, 15);
});

test('an actuated boundary is not predicted (imported/legacy plans mark phases)', () => {
  const act = withCycleLength({ id: 'p2', epoch: 0, stages: [
    { states: { h1: 'red' }, timing: { type: 'fixed', sec: 20 } },
    { states: { h1: 'green' }, timing: { type: 'actuated', sec: 20 } },
  ] });
  const g = predictHead(act, 'h1', 25_000); // in green, whose end is actuated
  assert.equal(g.unpredictable, true);
  assert.equal(g.secToChange, null);
  assert.equal(g.aspect, null);
  const r = predictHead(act, 'h1', 10_000); // in red, whose end is a fixed boundary
  assert.equal(r.unpredictable, false);
  assert.equal(r.secToChange, 10);
});
test('activePlan honours time-of-day windows (incl. wrap past midnight)', () => {
  const plans = [
    { id: 'night', schedule: { fromMin: 22 * 60, toMin: 6 * 60 }, epoch: 0, stages: plan.stages },
    { id: 'day', epoch: 0, stages: plan.stages }, // fallback
  ];
  const at = (h, m) => new Date(2026, 0, 1, h, m).getTime();
  assert.equal(activePlan(plans, at(23, 0)).id, 'night');
  assert.equal(activePlan(plans, at(3, 0)).id, 'night');
  assert.equal(activePlan(plans, at(12, 0)).id, 'day');
});

test('rankNext prefers soonest ETA inside the forward cone', () => {
  const pos = { lat: 0, lon: 0 };
  // heading due north (0deg). Two ahead, one behind.
  const ixs = [
    { id: 'behind', location: { lat: -0.01, lon: 0 } },
    { id: 'far-ahead', location: { lat: 0.02, lon: 0 } },
    { id: 'near-ahead', location: { lat: 0.005, lon: 0 } },
  ];
  const ranked = rankNext(pos, 0, 15, ixs);
  assert.equal(ranked[0].intersection.id, 'near-ahead');
  assert.ok(!ranked.find((r) => r.intersection.id === 'behind')); // cone excludes it
  assert.ok(ranked[0].etaSec > 0);
});

test('rankNext falls back to nearest when stationary', () => {
  const pos = { lat: 0, lon: 0 };
  const ixs = [
    { id: 'a', location: { lat: 0.02, lon: 0 } },
    { id: 'b', location: { lat: -0.001, lon: 0 } },
  ];
  const ranked = rankNext(pos, null, 0, ixs);
  assert.equal(ranked[0].intersection.id, 'b'); // nearest regardless of direction
});

test('geo helpers are sane', () => {
  assert.ok(Math.abs(distanceM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111195) < 500);
  assert.equal(angularDiff(350, 10), 20);
});

test('headForApproach picks the near-side mast facing the approach (Spain)', () => {
  const c = { lat: 41.4143, lon: 2.0121 };
  const d = 0.0002; // ~20 m
  const ix = { location: c, masts: [
    { id: 'mS', pos: { lat: c.lat - d, lon: c.lon }, headIds: ['hNorthbound'] }, // south side
    { id: 'mN', pos: { lat: c.lat + d, lon: c.lon }, headIds: ['hSouthbound'] },
    { id: 'mW', pos: { lat: c.lat, lon: c.lon - d }, headIds: ['hEastbound'] },
  ] };
  assert.equal(headForApproach(ix, 0), 'hNorthbound');   // driving north -> mast on the south side
  assert.equal(headForApproach(ix, 180), 'hSouthbound');
  assert.equal(headForApproach(ix, 95), 'hEastbound');
  assert.equal(headForApproach(ix, 270), null);          // nothing on the east side within tolerance
  assert.equal(headForApproach(ix, null), null);
});
