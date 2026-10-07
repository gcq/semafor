// Acceptance tests for the v2 clock model (docs/clock-model.md), driven by the
// simulator in test/sim.js. Written against the spec, not the implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeModel, ALGO_VERSION } from '../src/inference/clock.js';
import { nextOnset, currentAspect, withTap } from '../src/predict/next.js';
import { createSim, at, light, mulberry32 } from './sim.js';

const ALL = ['green', 'amber', 'red'];
const plansOf = (m, ixId) => m.groups.filter((g) => g.intersectionIds.includes(ixId)).flatMap((g) => g.plans);
const groupOf = (m, ixId) => m.groups.find((g) => g.intersectionIds.includes(ixId));
const wrap = (sec, C) => ((sec + C / 2) % C + C) % C - C / 2;
const strip = (m) => { const { computedAt, ...rest } = m; return rest; };

/** Signed error (s) of a prediction vs. the simulator's truth, or null if unpredictable. */
function predErr(sim, model, head, aspect, now) {
  const p = nextOnset(model, head, aspect, now);
  if (p.unpredictable) return null;
  const truth = sim.nextChange(head, aspect, now);
  return wrap((now + p.inSec * 1000 - truth) / 1000, sim.cycleAt(head, now));
}

// One controller, one intersection, two lights.
const simple = (clock = {}, cycleSec = 90.3, lights) => ({
  id: 'cA', cycleSec, clock,
  intersections: [{ id: 'ixA', name: 'A', lights: lights ?? [light('g', 10, 40), light('h', 55, 30)] }],
});

test('algo version is clock-2', () => assert.equal(ALGO_VERSION, 'clock-2'));

test('recovers the cycle within 0.05 s from dense sittings (fractional, steady and nudged)', () => {
  for (const [mode, C] of [['steady', 90.3], ['nudged', 87.35]]) {
    const sim = createSim({ seed: 11, controllers: [simple({ mode, sigmaSec: 1.5 }, C)] });
    for (let d = 0; d < 4; d++) for (const hm of ['08:30', '18:10'])
      sim.sit({ t: at(d, hm), watch: ['g', 'h'], aspects: ALL, cycles: 6 });
    const plans = plansOf(computeModel(sim.world()), 'ixA');
    assert.equal(plans.length, 1, mode);
    assert.ok(Math.abs(plans[0].cycleSec - C) < 0.05, `${mode}: cycle ${plans[0].cycleSec} vs ${C}`);
  }
});

test('a greens-only light predicts its next green and shows no current colour', () => {
  const sim = createSim({ seed: 12, controllers: [simple()] });
  for (let d = 0; d < 4; d++) for (const hm of ['09:00', '17:30'])
    sim.sit({ t: at(d, hm), watch: ['g'], aspects: ['green'], cycles: 4 });
  const m = computeModel(sim.world());
  assert.equal(currentAspect(m, 'g', at(2, '09:01')), null);
  assert.deepEqual(m.lights.g.aspects, ['green']);
  for (const hm of ['11:07', '13:42', '15:20']) { // day 4: no taps at all
    const e = predErr(sim, m, 'g', 'green', at(4, hm));
    assert.notEqual(e, null);
    assert.ok(Math.abs(e) <= 1.5, `green error ${e} at ${hm}`);
  }
});

test('steady controller over 4 days: steady/nudged, no-tap prediction on a held-out day within 1.5 s', () => {
  const sim = createSim({ seed: 13, controllers: [simple()] });
  for (let d = 0; d < 4; d++) for (const hm of ['08:00', '12:30', '19:00'])
    sim.sit({ t: at(d, hm), watch: ['g', 'h'], aspects: ALL, cycles: 4 });
  const m = computeModel(sim.world());
  const clock = plansOf(m, 'ixA')[0].clock;
  assert.ok(['steady', 'nudged'].includes(clock.hypothesis), clock.hypothesis);
  assert.equal(clock.days, 4);
  for (const [hd, a, hm] of [['g', 'green', '09:13'], ['h', 'red', '14:50'], ['g', 'amber', '21:05']]) {
    const e = predErr(sim, m, hd, a, at(4, hm));
    assert.notEqual(e, null, `${hd} ${a} unpredictable`);
    assert.ok(Math.abs(e) <= 1.5, `${hd} ${a} error ${e}`);
  }
  const p = nextOnset(m, 'g', 'green', at(4, '09:13'));
  assert.ok(p.plusMinus > 0 && /clock from 4 days/.test(p.basis), p.basis);
});

test('nudged controller (sigma 2 s): predicted from the clock, error about sigma', () => {
  const sim = createSim({ seed: 14, controllers: [simple({ mode: 'nudged', sigmaSec: 2 })] });
  for (let d = 0; d < 8; d++) for (const hm of ['08:00', '18:00'])
    sim.sit({ t: at(d, hm), watch: ['g', 'h'], aspects: ALL, cycles: 4 });
  const m = computeModel(sim.world());
  const clock = plansOf(m, 'ixA')[0].clock;
  assert.ok(['nudged', 'steady'].includes(clock.hypothesis), clock.hypothesis);
  if (clock.nudgeSigmaSec != null) assert.ok(clock.nudgeSigmaSec > 0.7 && clock.nudgeSigmaSec < 4, `sigma ${clock.nudgeSigmaSec}`);
  const errs = [];
  for (let d = 8; d < 16; d++) { const e = predErr(sim, m, 'g', 'green', at(d, '12:00')); assert.notEqual(e, null); errs.push(Math.abs(e)); }
  errs.sort((a, b) => a - b);
  assert.ok(errs[4] <= 3.5, `median error ${errs[4]}`);
});

test('independent days: unpredictable without a tap today, accurate right after one (also via withTap)', () => {
  const sim = createSim({ seed: 15, controllers: [simple({ mode: 'independent' })] });
  for (let d = 0; d < 5; d++) for (const hm of ['08:30', '17:45'])
    sim.sit({ t: at(d, hm), watch: ['g', 'h'], aspects: ['green', 'red'], cycles: 4 });
  const m = computeModel(sim.world());
  assert.equal(plansOf(m, 'ixA')[0].clock.hypothesis, 'independent');
  const cold = nextOnset(m, 'g', 'green', at(6, '10:00'));
  assert.equal(cold.unpredictable, true);
  assert.match(cold.reason, /tap/);

  // A single green tap today, near-minimum lag so the tolerance is about the model, not the thumb.
  const tap = sim.sit({ t: at(6, '10:00'), watch: ['g'], aspects: ['green'], maxTaps: 1, lag: { extraMeanSec: 0.05 } })[0];
  const now = tap.t + 4 * 60e3;
  const e1 = predErr(sim, withTap(m, tap), 'g', 'green', now);
  assert.notEqual(e1, null);
  assert.ok(Math.abs(e1) <= 1.5, `withTap error ${e1}`);
  const e2 = predErr(sim, computeModel(sim.world()), 'g', 'green', now);
  assert.notEqual(e2, null);
  assert.ok(Math.abs(e2) <= 1.5, `recomputed error ${e2}`);
  const p = nextOnset(withTap(m, tap), 'g', 'green', now);
  assert.match(p.basis, /tap/);
  // Another colour of the same light is anchored by the same tap (needs it tapped before).
  const eh = predErr(sim, withTap(m, tap), 'g', 'red', now);
  assert.notEqual(eh, null);
  assert.ok(Math.abs(eh) <= 1.5, `red via green tap ${eh}`);
});

test('fewer than 3 days never claims steady or nudged', () => {
  for (const days of [1, 2]) {
    const sim = createSim({ seed: 16, controllers: [simple()] }); // truly steady, but only 1-2 days seen
    for (let d = 0; d < days; d++) for (const hm of ['08:00', '13:00', '19:00'])
      sim.sit({ t: at(d, hm), watch: ['g', 'h'], aspects: ALL, cycles: 5 });
    const clock = plansOf(computeModel(sim.world()), 'ixA')[0].clock;
    assert.equal(clock.hypothesis, 'independent', `${days} days`);
    assert.equal(clock.days, days);
  }
});

test('corridor: a tap today at A anchors predictions at B', () => {
  const sim = createSim({ seed: 17, controllers: [{
    id: 'cC', cycleSec: 100.4, clock: { mode: 'independent' },
    intersections: [
      { id: 'ixA', name: 'A', lights: [light('ga', 0, 40)] },
      { id: 'ixB', name: 'B', offsetSec: 17, lights: [light('gb', 0, 45)] },
    ] }] });
  for (let d = 0; d < 4; d++) for (const hm of ['08:00', '18:00'])
    sim.sit({ t: at(d, hm), watch: ['ga', 'gb'], aspects: ['green', 'red'], cycles: 4 });
  const m0 = computeModel(sim.world());
  const g = groupOf(m0, 'ixA');
  assert.ok(g.corridor, 'A and B form a corridor');
  assert.ok(g.intersectionIds.includes('ixB'));
  const tap = sim.sit({ t: at(5, '10:00'), watch: ['ga'], aspects: ['green'], maxTaps: 1, lag: { extraMeanSec: 0.05 } })[0];
  const now = tap.t + 3 * 60e3;
  for (const model of [computeModel(sim.world()), withTap(m0, tap)]) {
    const e = predErr(sim, model, 'gb', 'green', now);
    assert.notEqual(e, null, 'B predictable from a tap at A');
    assert.ok(Math.abs(e) <= 1.5, `B error ${e}`);
    assert.match(nextOnset(model, 'gb', 'green', now).basis, /tap/);
  }
  assert.equal(nextOnset(m0, 'gb', 'green', now).unpredictable, true, 'but not without the tap');
});

test('time-of-day plans: two windows, different cycles, separate plans, no cross-contamination', () => {
  const mk = (clock) => createSim({ seed: 18, controllers: [{
    id: 'cT', clock, plans: [{ fromMin: 420, toMin: 960, cycleSec: 80.2 }, { fromMin: 960, toMin: 420, cycleSec: 70.5 }],
    intersections: [{ id: 'ixT', name: 'T', lights: [light('t', 5, 30), light('u', 40, 25)] }] }] });
  const sim = mk({ mode: 'steady' });
  for (let d = 0; d < 4; d++) for (const hm of ['09:00', '12:00', '20:00', '22:30'])
    sim.sit({ t: at(d, hm), watch: ['t', 'u'], aspects: ALL, cycles: 5 });
  const m = computeModel(sim.world());
  const plans = plansOf(m, 'ixT');
  assert.equal(plans.length, 2);
  const inWin = (p, min) => p.windows.some((w) => (w.fromMin <= w.toMin ? min >= w.fromMin && min < w.toMin : min >= w.fromMin || min < w.toMin));
  const morning = plans.find((p) => inWin(p, 9 * 60)), evening = plans.find((p) => inWin(p, 20 * 60));
  assert.ok(morning && evening && morning !== evening, 'distinct plans');
  assert.ok(!inWin(morning, 20 * 60) && !inWin(evening, 9 * 60));
  assert.ok(Math.abs(morning.cycleSec - 80.2) < 0.1, `morning ${morning.cycleSec}`);
  assert.ok(Math.abs(evening.cycleSec - 70.5) < 0.1, `evening ${evening.cycleSec}`);
  for (const hm of ['10:20', '21:40']) {
    const e = predErr(sim, m, 't', 'green', at(4, hm));
    assert.ok(e != null && Math.abs(e) <= 1.5, `${hm} error ${e}`);
  }
  assert.equal(nextOnset(m, 't', 'green', at(4, '10:20')).planId, morning.id);
  assert.equal(nextOnset(m, 't', 'green', at(4, '21:40')).planId, evening.id);

  // Independent days: a morning tap today must not anchor the evening plan.
  const ind = mk({ mode: 'independent' });
  for (let d = 0; d < 4; d++) for (const hm of ['09:00', '12:00', '20:00', '22:30'])
    ind.sit({ t: at(d, hm), watch: ['t'], aspects: ['green', 'red'], cycles: 5 });
  ind.sit({ t: at(5, '09:00'), watch: ['t'], aspects: ['green'], cycles: 4 });
  const mi = computeModel(ind.world());
  const am = predErr(ind, mi, 't', 'green', at(5, '10:30'));
  assert.ok(am != null && Math.abs(am) <= 1.5, `morning anchored ${am}`);
  assert.equal(nextOnset(mi, 't', 'green', at(5, '20:30')).unpredictable, true, 'evening not anchored by a morning tap');
});

test('a missed tap does not make a light actuated; a truly actuated light is flagged and unpredictable', () => {
  // Fixed light, red tap missed (a green->red duration one cycle too long).
  const sim = createSim({ seed: 19, controllers: [simple()] });
  for (let d = 0; d < 4; d++) for (const hm of ['08:00', '13:00', '18:30'])
    sim.sit({ t: at(d, hm), watch: ['g'], aspects: ALL, cycles: 6, missAt: d === 1 && hm === '13:00' ? [7, 14] : [] });
  const m = computeModel(sim.world());
  assert.deepEqual(m.lights.g.actuated, [], 'missed tap is not a sensor');
  for (const mk of Object.values(plansOf(m, 'ixA')[0].marks)) assert.equal(mk.actuated, false);
  assert.ok(!nextOnset(m, 'g', 'red', at(4, '10:00')).unpredictable);

  // Actuated light: green length varies by up to 12 s per cycle.
  const act = createSim({ seed: 20, controllers: [simple({}, 90.3, [light('g', 10, 40, { actuatedSec: 6 }), light('h', 55, 30)])] });
  for (let d = 0; d < 4; d++) for (const hm of ['08:00', '13:00', '18:30'])
    act.sit({ t: at(d, hm), watch: ['g', 'h'], aspects: ALL, cycles: 8 });
  const ma = computeModel(act.world());
  assert.ok(ma.lights.g.actuated.length > 0, 'actuated flagged');
  assert.deepEqual(ma.lights.h.actuated, [], 'the fixed light next to it is not');
  for (const a of ma.lights.g.actuated) {
    const p = nextOnset(ma, 'g', a, at(4, '10:00'));
    assert.equal(p.unpredictable, true);
    assert.match(p.reason, /actuated/);
  }
});

test('a slip tap is an outlier with gain > 0 and does not move the fit; a lone tap on another day is not', () => {
  const build = (slip) => {
    const sim = createSim({ seed: 21, controllers: [simple({ mode: 'nudged', sigmaSec: 1.5 })] });
    const out = {};
    for (let d = 0; d < 5; d++) for (const hm of ['08:00', '18:00']) {
      const slipAt = slip && d === 2 && hm === '18:00' ? { 3: { kind: 'late', delaySec: 6 } } : {};
      const taps = sim.sit({ t: at(d, hm), watch: ['g'], aspects: ['green'], cycles: 8, slipAt });
      if (Object.keys(slipAt).length) out.slipId = taps[3].id;
    }
    // One lone tap on a sixth day: the clock was just nudged that day.
    out.lone = sim.sit({ t: at(6, '09:30'), watch: ['g'], aspects: ['green'], maxTaps: 1 })[0];
    return { sim, ...out };
  };
  const slipped = build(true), clean = build(false);
  const ms = computeModel(slipped.sim.world()), mc = computeModel(clean.sim.world());
  const o = ms.outliers.find((x) => x.tapId === slipped.slipId);
  assert.ok(o, 'slip detected');
  assert.equal(o.kind, 'slip');
  assert.ok(o.gainSec > 0);
  assert.ok(!ms.outliers.some((x) => x.tapId === slipped.lone.id), 'lone tap from another day is a nudge, not an outlier');
  assert.equal(mc.outliers.length, 0, 'clean data has no outliers: ' + JSON.stringify(mc.outliers));
  const ps = plansOf(ms, 'ixA')[0], pc = plansOf(mc, 'ixA')[0];
  assert.ok(Math.abs(ps.cycleSec - pc.cycleSec) < 0.02, `cycle ${ps.cycleSec} vs ${pc.cycleSec}`);
  assert.ok(Math.abs(wrap(ps.marks['g|green'].posSec - pc.marks['g|green'].posSec, 90.3)) < 0.3, 'mark position unaffected');
});

test('same input in any order gives the same model (except computedAt)', () => {
  const sim = createSim({ seed: 22, controllers: [simple({ mode: 'nudged', sigmaSec: 1 })] });
  for (let d = 0; d < 4; d++) for (const hm of ['08:00', '19:00'])
    sim.sit({ t: at(d, hm), watch: ['g', 'h'], aspects: ALL, cycles: 4, slipProb: 0.03, missProb: 0.03 });
  const w = sim.world();
  const rng = mulberry32(5);
  const shuffled = { ...w, observations: [...w.observations].sort(() => rng() - 0.5), intersections: [...w.intersections].reverse() };
  const a = computeModel(w), b = computeModel(shuffled);
  assert.deepEqual(strip(a), strip(b));
  assert.deepEqual(strip(computeModel(w)), strip(a), 'repeatable');
});

test('legacy plans / headPositions on intersections are ignored', () => {
  const sim = createSim({ seed: 23, controllers: [simple()] });
  for (let d = 0; d < 3; d++) sim.sit({ t: at(d, '09:00'), watch: ['g', 'h'], aspects: ALL, cycles: 4 });
  const w = sim.world();
  const dirty = structuredClone(w);
  dirty.intersections[0].plans = [{ id: 'old', cycleLengthMs: 55000, epoch: 12345, stages: [] }];
  dirty.intersections[0].headPositions = { g: { green: 3, red: 9 } };
  assert.deepEqual(strip(computeModel(dirty)), strip(computeModel(w)));
});

test('dropped taps are reported: non-onset, unknown light, double tap', () => {
  const sim = createSim({ seed: 24, controllers: [simple()] });
  const taps = sim.sit({ t: at(0, '09:00'), watch: ['g'], aspects: ['green'], cycles: 4 });
  const obs = [...taps,
    { id: 'p1', intersectionId: 'ixA', headId: 'g', aspect: 'green', kind: 'presence', t: taps[0].t + 500 },
    { id: 'u1', intersectionId: 'ixA', headId: 'nope', aspect: 'green', kind: 'onset', t: taps[0].t + 900 },
    { id: 'd1', intersectionId: 'ixA', headId: 'g', aspect: 'green', kind: 'onset', t: taps[1].t + 4000 }];
  const m = computeModel({ intersections: sim.intersections, observations: obs });
  const ids = m.dropped.map((d) => d.tapId);
  for (const id of ['p1', 'u1', 'd1']) assert.ok(ids.includes(id), id + ' dropped');
  assert.ok(m.dropped.every((d) => typeof d.reason === 'string' && d.reason));
});

test('perf: ~500 taps over 30 days, 6 intersections compute in < 1 s', () => {
  const mkC = (id, ixs, clock) => ({ id, cycleSec: 0, clock, intersections: ixs });
  const c1 = { ...mkC('c1', [{ id: 'i1', lights: [light('a1', 0, 35)] }, { id: 'i2', offsetSec: 12, lights: [light('a2', 0, 35)] }], { mode: 'nudged', sigmaSec: 1 }), cycleSec: 92.1 };
  const c2 = { ...mkC('c2', [{ id: 'i3', lights: [light('a3', 5, 30)] }, { id: 'i4', offsetSec: 20, lights: [light('a4', 5, 30)] }], { mode: 'independent' }), cycleSec: 78.7 };
  const c3 = { ...mkC('c3', [{ id: 'i5', lights: [light('a5', 3, 40)] }], { mode: 'steady' }), cycleSec: 100.2 };
  const c4 = { ...mkC('c4', [{ id: 'i6', lights: [light('a6', 3, 25, { actuatedSec: 5 })] }], { mode: 'steady' }), cycleSec: 66.6 };
  const sim = createSim({ seed: 25, controllers: [c1, c2, c3, c4] });
  const heads = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], rng = mulberry32(9);
  for (let d = 0; d < 30; d++) for (const hm of ['08:15', '18:40'])
    sim.sit({ t: at(d, hm), watch: [heads[Math.floor(rng() * 6)]], aspects: ALL, cycles: 3, slipProb: 0.02, missProb: 0.02 });
  const w = sim.world();
  assert.ok(w.observations.length > 400 && w.observations.length < 700, `${w.observations.length} taps`);
  const t0 = performance.now();
  const m = computeModel(w);
  const ms = performance.now() - t0;
  console.log(`perf: ${w.observations.length} taps, ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1000, `computeModel took ${ms.toFixed(0)} ms`);
  assert.ok(m.groups.length >= 1);
});
