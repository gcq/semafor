// Unit tests for the clock model core (inference/clock.js, predict/next.js)
// against small simulated controllers. Local time is Europe/Madrid.
process.env.TZ = 'Europe/Madrid';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeModel, partCycle, cleanTaps, sittingsOf, ALGO_VERSION } from '../src/inference/clock.js';
import { nextOnset, currentAspect, phaseTable, withTap } from '../src/predict/next.js';

const H = 3600e3, MIN = 60e3, DAY = 24 * H;
const D0 = new Date(2026, 8, 21, 18, 0, 0).getTime(); // 18:00 local on a Monday

// deterministic noise
let seed = Number(process.env.CLOCK_SEED ?? 7);
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const lagMs = () => 200 + -Math.log(1 - rnd()) * 300; // >= 0.2 s, mean 0.5 s

let n = 0;
const ix = (id, ...heads) => ({ id, name: `Junction ${id}`, heads: heads.map((h) => ({ id: h })) });
const tapOf = (headId, aspect, changeMs, extraMs = 0) => ({ id: `o${n++}`, headId, aspect, kind: 'onset', t: Math.round(changeMs + lagMs() + extraMs) });

// A light's marks: seconds into the cycle.
const GAR = { green: 0, amber: 45, red: 48 };
// A world: cycle C, a clock epoch, and a per-day shift (s) of the whole controller.
const world = (C, shift = () => 0) => ({ C, shift });
const dayIdx = (t) => Math.floor((t - D0) / DAY + 1e-9);
// All changes of one mark in [t0, t1].
function changes(w, pos, t0, t1) {
  const out = [];
  const Cms = w.C * 1000;
  for (let c = Math.floor((t0 - w.shift(dayIdx(t0)) * 1000) / Cms) - 1; ; c++) {
    const t = c * Cms + w.shift(dayIdx(t0)) * 1000 + pos * 1000;
    if (t > t1) break;
    if (t >= t0) out.push(t);
  }
  return out;
}
// A dense sitting: one light, all three colours, `cycles` cycles from t0.
function sitting(w, headId, t0, cycles, marks = GAR, headShift = 0) {
  const out = [];
  for (const [aspect, pos] of Object.entries(marks)) for (const t of changes(w, pos + headShift, t0, t0 + cycles * w.C * 1000)) out.push(tapOf(headId, aspect, t));
  return out.sort((a, b) => a.t - b.t);
}
// A lone green tap: the next green after t0.
const lone = (w, headId, t0, headShift = 0) => tapOf(headId, 'green', changes(w, GAR.green + headShift, t0, t0 + w.C * 1000 * 2)[0]);

const mark = (model, headId, aspect) => model.groups.flatMap((g) => g.plans).map((p) => p.marks[`${headId}|${aspect}`]).find(Boolean);
const planOf = (model, headId) => model.groups.flatMap((g) => g.plans).find((p) => Object.keys(p.marks).some((k) => k.startsWith(`${headId}|`)));

test('clean: reports what it drops and why', () => {
  const map = new Map([['A', 'ix1']]);
  const obs = [
    { id: '1', headId: 'A', aspect: 'green', kind: 'onset', t: 1000 },
    { id: '2', headId: 'A', aspect: 'green', kind: 'onset', t: 8000 },      // double tap
    { id: '3', headId: 'A', aspect: 'red', kind: 'presence', t: 9000 },     // not an onset
    { id: '4', headId: 'Z', aspect: 'green', kind: 'onset', t: 10000 },     // unknown light
    { id: '5', intersectionId: 'x', planId: 'p', phaseIndex: 1, t: 11000 }, // old format
    { id: '6', headId: 'A', aspect: 'green', kind: 'onset', t: 30000 },
  ];
  const { taps, dropped } = cleanTaps(obs, map);
  assert.deepEqual(taps.map((t) => t.id), ['1', '6']);
  assert.deepEqual(Object.fromEntries(dropped.map((d) => [d.tapId, d.reason])), { 2: 'repeat', 3: 'not an onset', 4: 'unknown light', 5: 'old format' });
});

test('cycle: fractional, and a missed tap (gap of 2 cycles) is not a different cycle', () => {
  const w = world(70.37);
  const taps = sittingsOf(sitting(w, 'A', D0, 10).map((o) => ({ ...o, mark: `${o.headId}|${o.aspect}`, ixId: 'x' })))[0].taps;
  const c = partCycle(taps);
  assert.ok(Math.abs(c.C - 70.37) < 0.08, `C=${c.C}`);
  assert.ok(c.strong);
  const dropOne = taps.filter((t, i) => !(t.aspect === 'green' && i === taps.findIndex((x) => x.aspect === 'green') + 3));
  const c2 = partCycle(dropOne.filter((t, i, a) => a.indexOf(t) === i));
  assert.ok(Math.abs(c2.C - 70.37) < 0.15, `C with a missed tap=${c2.C}`);
});

test('one sitting, one colour tapped: still "next green in X s"', () => {
  const w = world(80);
  const A = ix('i1', 'A');
  const t0 = D0;
  // a light tapped only on green: 6 greens in a row
  const obs = changes(w, 0, t0, t0 + 6 * 80e3).map((t) => tapOf('A', 'green', t));
  const model = computeModel({ observations: obs, intersections: [A] }, { now: 0 });
  assert.equal(model.algoVersion, ALGO_VERSION);
  assert.equal(model.groups.length, 1);
  assert.equal(currentAspect(model, 'A', t0 + 10 * MIN), null, 'one colour tapped: no current colour');
  const now = obs[obs.length - 1].t + 20e3;
  const p = nextOnset(model, 'A', 'green', now);
  assert.ok(!p.unpredictable, JSON.stringify(p));
  const truth = changes(w, 0, now, now + 100e3)[0];
  assert.ok(Math.abs(now + p.inSec * 1000 - truth) < 1.5e3, `off by ${(now + p.inSec * 1000 - truth) / 1000}`);
  assert.match(p.basis, /^tap /);
  assert.ok(p.plusMinus >= 0.5 && p.plusMinus < 3);
  // other colours were never tapped
  assert.equal(nextOnset(model, 'A', 'red', now).unpredictable, true);
});

test('steady clock over 4 days predicts a day with no tap', () => {
  const w = world(90.37);
  const A = ix('i1', 'A', 'B');
  const obs = [];
  for (let d = 0; d < 4; d++) {
    obs.push(...sitting(w, 'A', D0 + d * DAY + 30 * MIN, 6));
    obs.push(...sitting(w, 'B', D0 + d * DAY + 50 * MIN, 5, GAR, 20));
  }
  const model = computeModel({ observations: obs, intersections: [A] }, { now: 0 });
  const plan = planOf(model, 'A');
  assert.equal(plan.clock.hypothesis, 'steady');
  assert.ok(plan.clock.heldOutErrSec < 2, `held-out ${plan.clock.heldOutErrSec}`);
  assert.ok(Math.abs(plan.cycleSec - 90.37) < 0.01, `C=${plan.cycleSec}`);
  // day 6, nobody tapped yet
  const now = D0 + 5 * DAY + 25 * MIN;
  for (const [h, shift, aspect, pos] of [['A', 0, 'green', 0], ['B', 20, 'red', 48], ['A', 0, 'red', 48]]) {
    const p = nextOnset(model, h, aspect, now);
    assert.ok(!p.unpredictable, JSON.stringify(p));
    const truth = changes(w, pos + shift, now, now + 200e3)[0];
    assert.ok(Math.abs(now + p.inSec * 1000 - truth) < 2e3, `${h} ${aspect} off by ${(now + p.inSec * 1000 - truth) / 1000}`);
    assert.match(p.basis, /clock from 4 days/);
  }
  const ca = currentAspect(model, 'A', D0 + 5 * DAY + 30 * MIN + 10e3); // 10 s into some cycle
  assert.ok(['green', 'amber', 'red'].includes(ca));
});

test('days that jump around: independent; needs a tap today, then predicts', () => {
  const shifts = [0, 17, -23, 31, 9];
  const w = world(70, (d) => shifts[d] ?? 0);
  const A = ix('i1', 'A');
  const obs = [];
  for (let d = 0; d < 4; d++) obs.push(...sitting(w, 'A', D0 + d * DAY + 20 * MIN, 5));
  const model = computeModel({ observations: obs, intersections: [A] }, { now: 0 });
  const plan = planOf(model, 'A');
  assert.equal(plan.clock.hypothesis, 'independent');
  assert.equal(plan.clock.heldOutErrSec, null);
  const day5 = D0 + 4 * DAY;
  const q = nextOnset(model, 'A', 'green', day5 + 10 * MIN);
  assert.equal(q.unpredictable, true);
  assert.equal(q.reason, 'needs a tap today');
  // an old model plus today's tap through withTap
  const t = changes(w, 0, day5 + 12 * MIN, day5 + 14 * MIN)[0];
  const tap = { headId: 'A', aspect: 'green', t: Math.round(t + 400) };
  const m2 = withTap(model, tap);
  const now = tap.t + 25e3;
  const p = nextOnset(m2, 'A', 'green', now);
  assert.ok(!p.unpredictable, JSON.stringify(p));
  const truth = changes(w, 0, now, now + 100e3)[0];
  assert.ok(Math.abs(now + p.inSec * 1000 - truth) < 1.5e3);
  assert.ok(nextOnset(model, 'A', 'green', now).unpredictable, 'withTap does not mutate the model');
  // and the red, relative to that green
  const pr = nextOnset(m2, 'A', 'red', now);
  const truthR = changes(w, 48, now, now + 100e3)[0];
  assert.ok(Math.abs(now + pr.inSec * 1000 - truthR) < 1.5e3);
});

test('actuated: wandering marks are flagged, a missed tap is not', () => {
  const w = world(70);
  const A = ix('i1', 'S', 'X');
  const obs = [];
  for (let d = 0; d < 2; d++) {
    const t0 = D0 + d * DAY;
    obs.push(...sitting(w, 'S', t0, 8));
    // X's green wanders +-6 s from cycle to cycle
    for (const t of changes(w, 10, t0, t0 + 8 * 70e3)) obs.push(tapOf('X', 'green', t, (rnd() - 0.5) * 12e3));
  }
  const model = computeModel({ observations: obs, intersections: [A] }, { now: 0 });
  assert.deepEqual(model.lights.X.actuated, ['green']);
  assert.deepEqual(model.lights.S.actuated, []);
  assert.equal(nextOnset(model, 'X', 'green', D0 + 3 * DAY).reason, 'actuated');

  // the real bug: red 22 s, one missed green => a 92 s "red". Not a sensor.
  const B = ix('i2', 'R');
  const taps = [];
  const mk = (aspect, pos) => changes(w, pos, D0, D0 + 12 * 70e3).map((t) => ({ aspect, t }));
  const rg = [...mk('red', 48), ...mk('green', 0)].sort((a, b) => a.t - b.t);
  let g = 0;
  for (const o of rg) { if (o.aspect === 'green' && ++g === 4) continue; taps.push(tapOf('R', o.aspect, o.t)); }
  const m2 = computeModel({ observations: taps, intersections: [B] }, { now: 0 });
  assert.deepEqual(m2.lights.R.actuated, [], 'missed tap is not a sensor');
  assert.equal(m2.outliers.length, 0);
});

test('slips: a tap far from its own sitting is an outlier with a gain, and is excluded', () => {
  const w = world(70);
  const A = ix('i1', 'A');
  const obs = sitting(w, 'A', D0, 7);
  const greens = obs.filter((o) => o.aspect === 'green');
  const slip = greens[3];
  slip.t += 9000;
  const model = computeModel({ observations: obs, intersections: [A] }, { now: 0 });
  const o = model.outliers.find((x) => x.tapId === slip.id);
  assert.ok(o, JSON.stringify(model.outliers));
  assert.equal(o.kind, 'slip');
  assert.ok(o.gainSec > 5);
  assert.ok(mark(model, 'A', 'green').spreadSec < 1.5, 'the slip does not widen the mark');
  const p = nextOnset(model, 'A', 'green', obs[obs.length - 1].t + 10e3);
  const truth = changes(w, 0, obs[obs.length - 1].t + 10e3, obs[obs.length - 1].t + 100e3)[0];
  assert.ok(Math.abs(obs[obs.length - 1].t + 10e3 + p.inSec * 1000 - truth) < 2e3);
});

test('plans: a different cycle at another time of day is its own plan, taps inform only theirs', () => {
  const wDay = world(80), wNight = world(60);
  const A = ix('i1', 'A');
  const obs = [];
  for (let d = 0; d < 4; d++) { // times drift a little from day to day (same-minute sampling would alias the cycle)
    obs.push(...sitting(wDay, 'A', D0 - 8 * H + d * DAY + d * 13 * MIN, 6)); // ~10:00
    obs.push(...sitting(wNight, 'A', D0 + 4 * H + d * DAY - d * 7 * MIN, 6)); // ~22:00
  }
  const model = computeModel({ observations: obs, intersections: [A] }, { now: 0 });
  const plans = model.groups[0].plans;
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((p) => Math.round(p.cycleSec)).sort(), [60, 80]);
  const night = plans.find((p) => Math.round(p.cycleSec) === 60);
  const inNight = (min) => night.windows.some((w) => (w.fromMin <= w.toMin ? min >= w.fromMin && min < w.toMin : min >= w.fromMin || min < w.toMin));
  assert.ok(inNight(22 * 60));
  assert.ok(!inNight(10 * 60));
  const now = D0 + 5 * DAY + 4 * H + 30 * MIN; // night, no tap that day
  const p = nextOnset(model, 'A', 'green', now);
  assert.equal(p.planId, night.id);
});

test('corridor: cycles agree and the same-day phase difference repeats', () => {
  const sh = [0, 14, -9];
  const wA = world(60, (d) => sh[d] ?? 0);
  const wB = world(60, (d) => (sh[d] ?? 0) + 31); // B always 31 s behind A, whatever the day does
  const mapA = ix('iA', 'a1'), mapB = ix('iB', 'b1');
  const obs = [];
  for (let d = 0; d < 3; d++) {
    const t0 = D0 + d * DAY;
    obs.push(...sitting(wA, 'a1', t0, 3));
    obs.push(...sitting(wB, 'b1', t0 + 3.4 * 60e3, 3));
  }
  const model = computeModel({ observations: obs, intersections: [mapA, mapB] }, { now: 0 });
  assert.equal(model.groups.length, 1);
  assert.equal(model.groups[0].corridor, true);
  assert.deepEqual([...model.groups[0].intersectionIds].sort(), ['iA', 'iB']);
  // a tap at A anchors B (shared day offsets): day 4, A green seen, ask B
  const day = D0 + 3 * DAY;
  const wA4 = world(60, () => 22), wB4 = world(60, () => 53);
  const gA = changes(wA4, 0, day, day + 70e3)[0];
  let m = withTap(model, { headId: 'a1', aspect: 'green', t: Math.round(gA + 300) });
  const now = gA + 20e3;
  const p = nextOnset(m, 'b1', 'green', now);
  assert.ok(!p.unpredictable, JSON.stringify(p));
  const truth = changes(wB4, 0, now, now + 100e3)[0];
  assert.ok(Math.abs(now + p.inSec * 1000 - truth) < 2e3, `off by ${(now + p.inSec * 1000 - truth) / 1000}`);

  // phase difference that does not repeat => two groups
  const wB2 = world(60, (d) => [0, 25, 11][d] + 31 + [0, 20, -7][d]);
  const obs2 = [];
  for (let d = 0; d < 3; d++) {
    const t0 = D0 + d * DAY;
    obs2.push(...sitting(wA, 'a1', t0, 3));
    obs2.push(...sitting(wB2, 'b1', t0 + 3.4 * 60e3, 3));
  }
  const m3 = computeModel({ observations: obs2, intersections: [mapA, mapB] }, { now: 0 });
  assert.equal(m3.groups.length, 2);
  // different cycles => two groups
  const wC = world(75, (d) => sh[d] ?? 0);
  const obs3 = [];
  for (let d = 0; d < 3; d++) {
    const t0 = D0 + d * DAY;
    obs3.push(...sitting(wA, 'a1', t0, 3));
    obs3.push(...sitting(wC, 'b1', t0 + 3.4 * 60e3, 3));
  }
  assert.equal(computeModel({ observations: obs3, intersections: [mapA, mapB] }, { now: 0 }).groups.length, 2);
});

test('phaseTable: a legacy TimingPlan from mark positions', () => {
  const w = world(70);
  const A = ix('i1', 'A', 'B');
  const obs = [...sitting(w, 'A', D0, 5), ...sitting(w, 'B', D0 + 6 * MIN, 5, { green: 0, amber: 20, red: 23 }, 40)];
  const model = computeModel({ observations: obs, intersections: [A] }, { now: 0 });
  const now = D0 + 8 * MIN;
  const tp = phaseTable(model, 'i1', now);
  assert.ok(tp);
  assert.ok(Math.abs(tp.cycleLengthMs - 70000) < 300);
  assert.ok(Math.abs(tp.stages.reduce((a, s) => a + s.timing.sec, 0) - tp.cycleLengthMs / 1000) < 0.2);
  assert.ok(tp.stages.length >= 4);
  for (const s of tp.stages) assert.ok(['green', 'amber', 'red'].includes(s.states.A));
  assert.ok(tp.epoch <= now && now - tp.epoch < 80000);
  assert.equal(phaseTable(model, 'nope', now), null);
});

test('deterministic and cheap: a few hundred taps, same model twice, well under a second', () => {
  const w = world(90.37, () => 0);
  const A = ix('i1', 'A', 'B', 'C');
  const obs = [];
  for (let d = 0; d < 25; d++) {
    obs.push(...sitting(w, 'A', D0 + d * DAY + 10 * MIN, 3));
    obs.push(...sitting(w, 'B', D0 + d * DAY + 40 * MIN, 2, GAR, 30));
    obs.push(lone(w, 'C', D0 + d * DAY + 90 * MIN, 12));
  }
  assert.ok(obs.length > 300);
  const t0 = performance.now();
  const m1 = computeModel({ observations: obs, intersections: [A] }, { now: 5 });
  const ms = performance.now() - t0;
  const m2 = computeModel({ observations: [...obs].reverse(), intersections: [A] }, { now: 5 });
  assert.deepEqual(m1, m2);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  assert.equal(planOf(m1, 'A').clock.hypothesis, 'steady');
  assert.ok(!nextOnset(m1, 'C', 'green', D0 + 26 * DAY).unpredictable);
  assert.equal(JSON.stringify(m1).includes('NaN'), false);
});

test('empty / hostile input does not throw', () => {
  const m = computeModel({ observations: [], intersections: [] }, { now: 1 });
  assert.equal(m.groups.length, 0);
  assert.equal(nextOnset(m, 'A', 'green', 0).unpredictable, true);
  assert.equal(currentAspect(m, 'A', 0), null);
  assert.equal(phaseTable(m, 'x', 0), null);
  assert.equal(withTap(m, { headId: 'A', aspect: 'green', t: 5 }), m);
  const m2 = computeModel({ observations: [{ id: 'x', headId: 'A', aspect: 'green', kind: 'onset', t: 5 }, null, {}], intersections: [ix('i', 'A')] });
  assert.equal(m2.groups.length, 1);
  assert.equal(m2.groups[0].plans.length, 0);
});

// Real-data sanity, if the private fixture is on this machine. Nothing from it is stored here.
const FIX = new URL('../out/fixtures/real-taps.json', import.meta.url);
const EXP = new URL('../out/fixtures/real-expect.json', import.meta.url); // names, also private
test('real taps (skipped without out/fixtures/real-*.json)', { skip: !(fs.existsSync(FIX) && fs.existsSync(EXP)) }, () => {
  const data = JSON.parse(fs.readFileSync(FIX, 'utf8'));
  const X = JSON.parse(fs.readFileSync(EXP, 'utf8'));
  const model = computeModel(data, { now: 0 });
  const byName = (name) => data.intersections.find((i) => i.name === name);
  const plansOf = (name) => model.groups.find((g) => g.intersectionIds.includes(byName(name).id))?.plans ?? [];
  const verd = plansOf(X.independent);
  assert.ok(verd.some((p) => Math.abs(p.cycleSec - 70) < 0.3), JSON.stringify(verd.map((p) => p.cycleSec)));
  const straight = byName(X.independent).heads.find((h) => h.name === X.fixedLight).id;
  assert.deepEqual(model.lights[straight].actuated, []);
  const evening = plansOf(X.corridorMain).find((p) => Math.abs(p.cycleSec - 90.3) < 0.6);
  assert.ok(evening, 'evening plan near 90.3 s');
  assert.ok(plansOf(X.corridorMain).some((p) => Math.abs(p.cycleSec - 72) < 1.5), 'a ~72 s plan');
  const g = model.groups.find((x) => x.intersectionIds.includes(byName(X.corridorMain).id));
  assert.ok(g.corridor && g.intersectionIds.includes(byName(X.corridorOther).id));
});

test('windows: only around a plan\'s own sittings; one plan per group at a time; unplaced taps are asked about', () => {
  const w = world(90.37);
  const A = ix('i1', 'A', 'B');
  const obs = [];
  for (let d = 0; d < 4; d++) {
    obs.push(...sitting(w, 'A', D0 + d * DAY + 30 * MIN + d * 11 * MIN, 5));
    obs.push(...sitting(w, 'B', D0 + d * DAY + 50 * MIN + d * 11 * MIN, 4, GAR, 20));
  }
  // a lone green at ~08:00 on day 2 that does not sit on the evening clock
  const morning = D0 - 10 * H + 2 * DAY;
  obs.push(tapOf('A', 'green', changes(w, 0, morning, morning + 200e3)[0], 23000));
  const morning2 = D0 - 10 * H + 3 * DAY;
  obs.push(tapOf('A', 'green', changes(w, 0, morning2, morning2 + 200e3)[0], -27000));
  const model = computeModel({ observations: obs, intersections: [A] }, { now: 0 });
  const plans = model.groups[0].plans;
  assert.equal(plans.length, 1);
  const inWin = (min) => plans[0].windows.some((x) => (x.fromMin <= x.toMin ? min >= x.fromMin && min < x.toMin : min >= x.fromMin || min < x.toMin));
  assert.ok(inWin(18 * 60 + 40) && !inWin(8 * 60) && !inWin(13 * 60) && !inWin(2 * 60), JSON.stringify(plans[0].windows));
  const day = 5 * DAY;
  for (const [h, m] of [['A', 8 * 60], ['B', 13 * 60], ['A', 150]]) {
    const now = D0 - 10 * H + (m - 8 * 60) * MIN + day;
    const p = nextOnset(model, h, 'green', now);
    assert.equal(p.unpredictable, true);
    assert.equal(p.reason, 'no taps at this time of day yet');
    assert.equal(currentAspect(model, h, now), null);
  }
  assert.ok(!nextOnset(model, 'A', 'green', D0 + day + 40 * MIN).unpredictable);
  assert.ok(model.usefulTaps.some((u) => /around 0\d:00/.test(u.why)), JSON.stringify(model.usefulTaps));
});
