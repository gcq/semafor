import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findPasses, analyzePass, assignHead, estimateCycle, summarizeHead, buildPlan, inferIntersection,
  boundingBox, buildFetchSql, characterizeHead, estimateCycleJoint, resultant, inSegment,
} from '../tools/teslamate/gps.js';
import { predictHead } from '../src/predict/state.js';

// A junction at (40.4300, -3.7000). North arm ~120 m up, south arm ~120 m down.
// A car drives S->N (from south arm, through, to north arm) again and again.
const C = { lat: 40.43, lon: -3.7 };
const dLat = 0.0011; // ~120 m
const ix = {
  id: 'ix1', name: 'Test', location: C,
  arms: [
    { id: 'S', pos: { lat: C.lat - dLat, lon: C.lon } },
    { id: 'N', pos: { lat: C.lat + dLat, lon: C.lon } },
  ],
  heads: [{ id: 'hN', name: 'Northbound' }],
  movements: [{ id: 'm1', from: 'S', to: 'N', headId: 'hN' }],
  masts: [], plans: [], rev: 0,
};

// Build a northbound pass arriving at `arriveT`, waiting `waitS` (0 = through),
// with a fix every `dt` s. Positions run from south to north through the centre.
function pass(arriveT, waitS, dt = 2) {
  const fixes = [];
  const lats = [C.lat - 0.0009, C.lat - 0.0004, C.lat, C.lat + 0.0004, C.lat + 0.0009];
  let t = arriveT;
  // approach + stop at the second point (~45 m south)
  fixes.push({ t: (t += 0), lat: lats[0], lon: C.lon, speed: 8 });
  fixes.push({ t: (t += dt * 1000), lat: lats[1], lon: C.lon, speed: 0 });
  for (let w = 0; w < waitS; w += dt) fixes.push({ t: (t += dt * 1000), lat: lats[1], lon: C.lon, speed: 0 });
  fixes.push({ t: (t += dt * 1000), lat: lats[2], lon: C.lon, speed: 6 });
  fixes.push({ t: (t += dt * 1000), lat: lats[3], lon: C.lon, speed: 9 });
  fixes.push({ t: (t += dt * 1000), lat: lats[4], lon: C.lon, speed: 10 });
  return fixes;
}

test('findPasses groups fixes into distinct traversals', () => {
  const day = 24 * 3600 * 1000;
  const fixes = [...pass(0, 20), ...pass(day, 20), ...pass(2 * day, 0)];
  const passes = findPasses(fixes, C);
  assert.equal(passes.length, 3);
});

test('analyzePass detects the stop, departure and travel bearing', () => {
  const a = analyzePass(pass(0, 30), C);
  assert.equal(a.stopped, true);
  assert.ok(a.waitMs >= 28000 && a.waitMs <= 40000);
  assert.ok(a.approachBearing < 20 || a.approachBearing > 340); // heading ~north
  const b = analyzePass(pass(0, 0), C);
  assert.equal(b.stopped, false);
});

test('assignHead maps a northbound pass to the northbound head', () => {
  const a = assignHead(analyzePass(pass(0, 20), C), ix);
  assert.equal(a.headId, 'hN');
  assert.equal(a.fromArm, 'S');
  assert.equal(a.toArm, 'N');
});

test('assignHead falls back to mast direction when arms lack positions', () => {
  // masts placed ~40 m out on N/E/S/W; a northbound car (came from the south)
  // should match the SOUTH mast (bearing centre->mast ≈ 180 ≈ approach+180).
  const ixM = {
    id: 'ixm', location: C,
    arms: [{ id: 'S' }, { id: 'N' }], // no positions
    heads: [{ id: 'hS' }, { id: 'hN' }, { id: 'hE' }, { id: 'hW' }],
    movements: [{ id: 'm1', from: 'S', to: 'N', headId: 'hS' }],
    masts: [
      { id: 'mS', pos: { lat: C.lat - 0.0004, lon: C.lon }, headIds: ['hS'] },
      { id: 'mN', pos: { lat: C.lat + 0.0004, lon: C.lon }, headIds: ['hN'] },
      { id: 'mE', pos: { lat: C.lat, lon: C.lon + 0.0005 }, headIds: ['hE'] },
      { id: 'mW', pos: { lat: C.lat, lon: C.lon - 0.0005 }, headIds: ['hW'] },
    ],
  };
  const a = assignHead(analyzePass(pass(0, 20), C), ixM);
  assert.equal(a.headId, 'hS');
  assert.equal(a.basis, 'mast');
});

test('boundingBox and buildFetchSql produce a padded box and valid-looking SQL', () => {
  const ixs = [{ name: 'Pont', location: { lat: 41.414314, lon: 2.012107 } }];
  const bbox = boundingBox(ixs, 350);
  assert.ok(bbox.minLat < 41.414314 && bbox.maxLat > 41.414314);
  assert.ok(bbox.minLon < 2.012107 && bbox.maxLon > 2.012107);
  // ~350 m in latitude ≈ 0.00315 deg on each side
  assert.ok(Math.abs((41.414314 - bbox.minLat) - 0.00315) < 0.0003);
  const sql = buildFetchSql(bbox, ixs, 350);
  assert.match(sql, /FROM positions/);
  assert.match(sql, /latitude\s+BETWEEN/);
  assert.match(sql, /Pont/);
});

test('estimateCycle recovers a 90s period from folded onsets', () => {
  // green onsets every ~90s across many days, small jitter
  const onsets = [];
  const day = 24 * 3600 * 1000;
  for (let i = 0; i < 30; i++) {
    const k = Math.floor(i / 3) * day; // clustered on different days
    onsets.push(k + (i % 3) * 90000 + 42000 + (Math.random() * 2 - 1) * 500);
  }
  const r = estimateCycle(onsets);
  assert.ok(r.cycleSec >= 88 && r.cycleSec <= 92, `got ${r.cycleSec}`);
  assert.ok(r.strength > 0.8);
});

test('summarizeHead brackets green/red and calls it fixed', () => {
  // cycle 90s: green 0..40 (onset at phase 42), red 40..90.
  const C90 = 90000, onset = 42000;
  const greenOnsets = [], passThroughs = [], stopArrivals = [];
  for (let i = 0; i < 24; i++) {
    const k = i * 137000; // arbitrary spacing across cycles
    greenOnsets.push(Math.floor(k / C90) * C90 + onset);
    passThroughs.push(Math.floor(k / C90) * C90 + onset + 10000); // 10s into green
    stopArrivals.push(Math.floor(k / C90) * C90 + onset + 55000); // during red
  }
  const h = summarizeHead({ greenOnsets, passThroughs, stopArrivals });
  assert.equal(h.verdict, 'reconstructed');
  assert.ok(Math.abs(h.cycleSec - 90) <= 1, `cycle ${h.cycleSec}`);
  assert.equal(h.type, 'fixed');
  assert.ok(h.greenSec >= 10 && h.greenSec <= 55);
});

test('summarizeHead corrects for queue: onset from the early edge, stays fixed', () => {
  // True onset at phase 20s of a 90s fixed cycle. Each trip ego sits behind a
  // random 0..5 cars, so departures lag by 0..~12s (a late tail). The estimate
  // must recover ~20s, not the queue-inflated mean, and still read fixed.
  const C90 = 90000, onset = 20000;
  const greenOnsets = [], passThroughs = [], stopArrivals = [];
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 40; i++) {
    const k = i * 213000;
    const base = Math.floor(k / C90) * C90;
    const carsAhead = Math.floor(rand() * 6);          // 0..5 cars
    const lag = 2000 + carsAhead * 2000 + rand() * 600; // startup + discharge
    greenOnsets.push(base + onset + lag);
    stopArrivals.push(base + onset + 50000);           // arrived ~30s into red
  }
  const h = summarizeHead({ greenOnsets, passThroughs, stopArrivals });
  assert.equal(h.verdict, 'reconstructed');
  assert.ok(Math.abs(h.cycleSec - 90) <= 1, `cycle ${h.cycleSec}`);
  assert.ok(Math.abs(h.onsetPhaseSec - 20) <= 4, `onset ${h.onsetPhaseSec} (should be ~20, not the ~28 mean)`);
  assert.equal(h.type, 'fixed', 'queue variance must not look actuated');
  assert.ok(h.queueLagSec >= 3, `queue lag surfaced (${h.queueLagSec}s)`);
});

test('buildPlan yields a predictor-consumable plan', () => {
  const heads = {
    hN: { verdict: 'reconstructed', cycleSec: 90, cycleStrength: 0.9, greenSec: 40, onsetPhaseSec: 0,
      onsetSpreadSec: 1, type: 'fixed', samples: { greenOnsets: 10, passThroughs: 5, stopArrivals: 5 } },
  };
  const { plan, headsUsed } = buildPlan(heads);
  assert.ok(plan);
  assert.deepEqual(headsUsed, ['hN']);
  // green at t=0 (onset), red at t=60s into the 90s cycle
  assert.equal(predictHead(plan, 'hN', 5000).aspect, 'green');
  assert.equal(predictHead(plan, 'hN', 60000).aspect, 'red');
});

test('characterizeHead: stable offset = predictable, drift = drifting, wander = unstable', () => {
  const C = 80000, day = 86400000, now = Date.parse('2026-09-15T12:00:00Z');
  const mk = (phaseAt) => { // phaseAt(dayIdx)->onset phase ms; returns obs over 40 recent days
    const on = []; for (let i = 0; i < 40; i++) { const base = now - i * day; on.push(base - (base % C) + phaseAt(i)); }
    return { greenOnsets: on, passThroughs: [], stopArrivals: [] };
  };
  const stable = characterizeHead(mk(() => 20000 + (Math.random() * 2 - 1) * 1000), 80, now);
  assert.equal(stable.verdict, 'predictable', `stable -> ${stable.verdict}`);
  const drift = characterizeHead(mk((i) => 20000 + i * 800), 80, now); // 0.8 s/day
  assert.equal(drift.verdict, 'drifting', `drift -> ${drift.verdict}`);
  assert.ok(Math.abs(drift.driftSecPerDay) > 0.5);
  const wander = characterizeHead(mk(() => Math.random() * C), 80, now);
  assert.equal(wander.verdict, 'unstable', `wander -> ${wander.verdict}`);
});

test('estimateCycleJoint pools heads to one cycle', () => {
  const C = 90000, day = 86400000, now = Date.parse('2026-09-15T12:00:00Z');
  // varied absolute arrival times (not day-aligned, which would alias); onset
  // snapped to the nearest cycle boundary + phase, with small jitter.
  const on = (phase) => { const a = []; for (let i = 0; i < 30; i++) { const b = now - Math.random() * 40 * day; a.push(Math.round((b - phase) / C) * C + phase + (Math.random() * 2 - 1) * 900); } return a; };
  const jc = estimateCycleJoint({ a: on(10000), b: on(55000) });
  assert.ok(Math.abs(jc.cycleSec - 90) <= 1, `joint cycle ${jc.cycleSec}`);
  assert.ok(jc.strength > 0.7);
});

test('inSegment filters by recency, weekday and local hour', () => {
  const now = Date.parse('2026-09-16T12:00:00Z'); // Wed
  const seg = { from: 7, to: 20, weekday: true };
  const opt = { sinceDays: 150, tzOffsetH: 2 };
  assert.equal(inSegment(Date.parse('2026-09-14T09:00:00Z'), seg, now, opt), true);  // Mon 11:00 local
  assert.equal(inSegment(Date.parse('2026-09-14T22:00:00Z'), seg, now, opt), false); // Mon 00:00 local (next day, out of hours)
  assert.equal(inSegment(Date.parse('2026-09-13T09:00:00Z'), seg, now, opt), false); // Sunday
  assert.equal(inSegment(Date.parse('2026-01-01T09:00:00Z'), seg, now, opt), false); // too old
});

test('inferIntersection end-to-end recovers a predictable head + a scheduled plan', () => {
  const CYC = 80000, PHI = 20000, day = 86400000;
  const START = Date.parse('2026-08-03T08:00:00Z'); // a Monday
  const nbPass = (onset, waitS) => {
    const f = []; const push = (t, lat, sp) => f.push({ t, lat, lon: C.lon, speed: sp });
    const arr = onset - waitS * 1000;
    push(arr - 4000, C.lat - 0.0009, 8);
    push(arr, C.lat - 0.0004, 0);
    for (let t = arr + 2000; t < onset; t += 2000) push(t, C.lat - 0.0004, 0);
    push(onset, C.lat - 0.0004, 3);
    push(onset + 3000, C.lat, 8);
    push(onset + 6000, C.lat + 0.0009, 10);
    return f;
  };
  const fixes = [];
  for (let d = 0; d < 45; d++) for (let k = 0; k < 4; k++) {
    const base = START + d * day + k * 1500000 + Math.random() * 900000;
    const onset = Math.ceil((base - PHI) / CYC) * CYC + PHI + (Math.random() * 2 - 1) * 1500;
    fixes.push(...nbPass(onset, 8 + Math.floor(Math.random() * 12)));
  }
  const r = inferIntersection(ix, fixes);
  assert.equal(r.armsHavePos, true);
  assert.ok(r.heads.hN, 'northbound head recovered');
  assert.ok(['predictable', 'drifting', 'noisy'].includes(r.heads.hN.verdict), `verdict ${r.heads.hN.verdict}`);
  assert.ok(Math.abs(r.heads.hN.cycleSec - 80) <= 2, `cycle ${r.heads.hN.cycleSec}`);
  assert.ok(r.plans.length >= 1, 'produced at least one plan');
  assert.ok(r.observations.length > 20);
});
