// Plans from a sparse, many-day tap log (inference/plans.js), against a
// simulated controller. Times are UTC so time-of-day expectations are fixed.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, cleanTaps, lockTest } from '../src/inference/plans.js';
import { predictHead } from '../src/predict/state.js';

const H = 3600e3, MIN = 60e3, DAY = 24 * H;
const MON = Date.UTC(2026, 8, 7); // Monday 7 Sep 2026

// Deterministic jitter (your thumb vs the real change), ±0.5 s.
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const jitter = () => (rnd() - 0.5) * 1000;

// A plan: cycle C (s), clock offset (s), one head's onsets within the cycle.
const plan = (C, off, green, amber) => ({ C, off, onsets: [['green', 0], ['amber', green], ['red', green + amber]] });
const MORNING = plan(80, 17, 35, 3);   // 07:00–16:00: green 35, red 42
const EVENING = plan(70, 5, 45, 3);    // otherwise:   green 45, red 22
const byHour = (t) => { const h = new Date(t).getUTCHours(); return h >= 7 && h < 16 ? MORNING : EVENING; };

// The truth: the head's aspect at t (clock-locked: position = t mod C).
function truth(t, pick = byHour) {
  const p = pick(t), pos = ((t / 1000 - p.off) % p.C + p.C) % p.C;
  let a = p.onsets[p.onsets.length - 1][0];
  for (const [asp, at] of p.onsets) if (pos >= at) a = asp;
  return a;
}
// The next onset of `aspect` after t.
function nextOnset(t, aspect, pick = byHour) {
  const p = pick(t), at = p.onsets.find(([a]) => a === aspect)[1];
  const cycStart = Math.floor((t / 1000 - p.off - at) / p.C) * p.C + p.off + at;
  let x = cycStart * 1000;
  while (x <= t) x += p.C * 1000;
  return x;
}
let n = 0;
const tap = (aspect, t, headId = 'A') => ({ id: `o${n++}`, intersectionId: 'ix', headId, aspect, t: Math.round(t + jitter()) });

// Watch one head for `cycles` cycles from t (a Capture sitting).
function sitting(t, cycles, pick = byHour, headId = 'A') {
  const out = [];
  let x = t;
  const end = t + cycles * pick(t).C * 1000;
  while (true) {
    const next = ['green', 'amber', 'red'].map((a) => [a, nextOnset(x, a, pick)]).sort((a, b) => a[1] - b[1])[0];
    if (next[1] > end) break;
    out.push(tap(next[0], next[1], headId)); x = next[1];
  }
  return out;
}
// Drive-by: arrive at t, stop at the red, tap green when it comes (sometimes you
// also caught the red coming on).
function driveBy(t, pair, pick = byHour) {
  if (!pair) return [tap('green', nextOnset(t, 'green', pick))];
  const r = nextOnset(t, 'red', pick);
  return [tap('red', r), tap('green', nextOnset(r, 'green', pick))];
}

// Day 0: one Capture sitting per plan; days 1–10: one or two drive-bys a day.
function history(days = 10) {
  const evs = [...sitting(MON + 9 * H, 5), ...sitting(MON + 20 * H, 5)];
  for (let d = 1; d <= days; d++) {
    evs.push(...driveBy(MON + d * DAY + 8 * H + rnd() * 90 * MIN, d % 3 === 0));
    if (d % 2) evs.push(...driveBy(MON + d * DAY + 18 * H + rnd() * 90 * MIN, d % 4 === 1));
  }
  return evs;
}

// Fraction of probe times where the model's aspect matches the truth.
function accuracy(evs, probes, pick = byHour) {
  let ok = 0;
  for (const t of probes) {
    const m = buildModel(evs.filter((e) => e.t <= t), ['A'], t);
    if (m.plan && predictHead(m.plan, 'A', t)?.aspect === truth(t, pick)) ok++;
  }
  return ok / probes.length;
}

test('cleaning drops slips, double taps and old formats, and says why', () => {
  const { kept, dropped } = cleanTaps([
    { headId: 'A', aspect: 'red', t: 0 },
    { headId: 'A', aspect: 'green', t: 50000 },
    { headId: 'A', aspect: 'green', t: 52000 },    // double tap
    { headId: 'A', aspect: 'amber', t: 90000 },    // slip: amber for 1.4 s…
    { headId: 'A', aspect: 'red', t: 91400 },      // …then red: the amber was a slip
    { headId: 'A', aspect: 'green', t: 120000, kind: 'presence' },
    { id: 'x', intersectionId: 'ix', planId: 'p', phaseIndex: 0, t: 5 }, // old format
    { headId: 'gone', aspect: 'red', t: 1 },
  ], ['A']);
  assert.deepEqual(kept.map((e) => e.aspect), ['red', 'green', 'red']);
  assert.deepEqual(dropped.map((d) => d.reason).sort(),
    ['light no longer exists', 'old "what it shows" tap', 'old format', 'repeat', 'too short to be real']);
});

test('finds the morning and evening plans from two sittings and sparse drive-bys', () => {
  const m = buildModel(history(), ['A'], MON + 11 * DAY + 8 * H);
  const withTaps = m.plans.filter((p) => p.sittings);
  assert.equal(withTaps.length, 2);
  assert.deepEqual(withTaps.map((p) => Math.round(p.cycleSec)).sort(), [70, 80]);
  const am = withTaps.find((p) => Math.round(p.cycleSec) === 80);
  assert.ok(Math.abs(am.durations['A|red'] - 42) < 1.5);
});

test('drive-by taps across days lock a clock-coordinated plan: exact with no tap today', () => {
  const evs = history();
  const t = MON + 12 * DAY + 8.5 * H; // no taps on day 12
  const m = buildModel(evs, ['A'], t);
  assert.equal(m.plan.reliability.locked, true);
  assert.equal(m.plan.reliability.level, 'high');
  const probes = Array.from({ length: 60 }, (_, i) => t + i * 7300); // morning, ~2 h
  assert.ok(accuracy(evs, probes) >= 0.9);
});

test('a few taps cannot fake a lock', () => {
  // three sittings a day apart line up on SOME fine-grid cycle by chance
  const anchors = [0, DAY + 12345, 2 * DAY + 54321].map((s) => ({ start: s, t: s }));
  assert.equal(lockTest(anchors, 70.13, 0.05), null);
});

test('free-running controller: drifts after a day, snaps back on your next tap', () => {
  const FREE = plan(70.13, 0, 45, 3);                     // not clock-locked, not whole seconds
  const pick = () => FREE;
  const evs = sitting(MON + 20 * H, 5, pick);
  const nextDay = MON + DAY + 20 * H;
  const stale = buildModel(evs, ['A'], nextDay);
  assert.equal(stale.plan.reliability.locked, false);
  assert.equal(stale.plan.reliability.level, 'low');     // ± has grown past a cycle
  assert.ok(stale.plan.reliability.sigmaSec > 20);
  // one drive-by green tap re-anchors at once
  const g = nextOnset(nextDay, 'green', pick);
  const after = [...evs, tap('green', g)];
  const m = buildModel(after, ['A'], g + 5000);
  assert.equal(m.plan.reliability.level, 'high');
  assert.match(m.plan.reliability.reasons.join(' '), /just now/);
  const probes = Array.from({ length: 30 }, (_, i) => g + 2000 + i * 2300); // the next ~70 s
  assert.ok(accuracy(after, probes, pick) >= 0.9);
});

test('a drive-by red→green that disagrees with the learned hour is a new plan, flagged', () => {
  const evs = sitting(MON + 20 * H, 5); // evening only: red 22 s
  const r = nextOnset(MON + DAY + 9 * H, 'red');
  evs.push(tap('red', r), tap('green', nextOnset(r, 'green'))); // morning: red 42 s
  const m = buildModel(evs, ['A'], r + 45000);
  assert.equal(m.plans.filter((p) => p.sittings).length, 2);
  assert.equal(m.plan.reliability.borrowed, true);
  assert.equal(m.plan.reliability.level, 'low');
  assert.match(m.plan.reliability.reasons.join(' '), /timing differs at this hour \(red 42s vs 22s/);
  assert.equal(predictHead(m.plan, 'A', r + 45000).aspect, 'green'); // anchored on the green you just tapped
});

test('a green that swings within one sitting is a sensor, and sensors are not predicted', () => {
  const evs = [];
  let t = MON + 20 * H;
  for (const g of [12, 30, 18, 34, 15, 28]) {             // actuated green, fixed 3 s amber + 40 s red
    evs.push(tap('green', t), tap('amber', t + g * 1000), tap('red', t + (g + 3) * 1000));
    t += (g + 43) * 1000;
  }
  const m = buildModel(evs, ['A'], t + 10000);
  assert.ok(m.variable.includes('A|green'));
  assert.equal(predictHead(m.plan, 'A', t + 10000).unpredictable, true);
});

test('weekday and weekend plans at the same hour are split by day type', () => {
  const WEEKEND = plan(90, 3, 50, 3);
  const pick = (t) => ([0, 6].includes(new Date(t).getUTCDay()) ? WEEKEND : EVENING);
  const evs = [
    ...sitting(MON + 18 * H, 4, pick),              // Monday
    ...sitting(MON + 5 * DAY + 18 * H, 4, pick),    // Saturday, same hour
    ...sitting(MON + 2 * DAY + 18.2 * H, 4, pick),  // Wednesday
  ];
  const m = buildModel(evs, ['A'], MON + 6 * DAY + 18 * H); // Sunday
  const classes = m.plans.filter((p) => p.sittings).map((p) => p.dayClass).sort();
  assert.deepEqual(classes, ['weekday', 'weekend']);
  assert.equal(Math.round(m.plan.cycleLengthMs / 1000), 90);
});

test('no cycle yet: no plan, but your last tap is there for Live to echo', () => {
  const m = buildModel([tap('green', MON)], ['A'], MON + 3000);
  assert.equal(m.plan, null);
  assert.equal(m.lastTap.aspect, 'green');
});

test('a controller whose phase jumps every day never locks', () => {
  const offs = Array.from({ length: 30 }, () => rnd() * 60);
  const pick = (t) => { const p = byHour(t); return { ...p, off: p.off + offs[Math.floor((t - MON) / DAY)] }; };
  const evs = [...sitting(MON + 9 * H, 5, pick), ...sitting(MON + 20 * H, 5, pick)];
  for (let d = 1; d <= 20; d++) evs.push(...driveBy(MON + d * DAY + 8 * H + rnd() * 90 * MIN, false, pick));
  const m = buildModel(evs, ['A'], MON + 21 * DAY + 8.5 * H);
  assert.equal(m.plan.reliability.locked, false);
  assert.equal(m.plan.reliability.level, 'low');
});
