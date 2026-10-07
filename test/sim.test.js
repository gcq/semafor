// The simulator itself must be trustworthy before it judges the clock model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, mulberry32, at, dayKey, light } from './sim.js';

const A = (extra = {}) => ({
  id: 'cA', cycleSec: 90.3,
  intersections: [{ id: 'ixA', lights: [light('g', 10, 40), light('h', 55, 30)] }],
  ...extra,
});

test('mulberry32 is deterministic and in [0,1)', () => {
  const a = mulberry32(5), b = mulberry32(5);
  for (let i = 0; i < 100; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
});

test('changes: spaced by the cycle, in order, colours offset by green/amber length', () => {
  const s = createSim({ controllers: [A()] });
  const t0 = at(0, '09:00'), t1 = t0 + 3600e3;
  const g = s.changes('g', 'green', t0, t1);
  assert.ok(g.length > 38);
  for (let i = 1; i < g.length; i++) assert.ok(Math.abs((g[i] - g[i - 1]) / 1000 - 90.3) < 1e-6);
  const am = s.changes('g', 'amber', t0, t1), r = s.changes('g', 'red', t0, t1);
  const ga = g.find((x) => am.includes(am.find((y) => y > x)));
  const nextAm = am.find((y) => y > g[0]);
  assert.ok(Math.abs((nextAm - g[0]) / 1000 - 40) < 1e-6);
  assert.ok(Math.abs((r.find((y) => y > g[0]) - nextAm) / 1000 - 3) < 1e-6);
  assert.ok(ga > 0);
});

test('steady clock: same phase every day; independent: different phase per day', () => {
  const phase = (sim, d) => (sim.nextChange('g', 'green', at(d, '10:00')) / 1000) % 90.3;
  const st = createSim({ controllers: [A()] });
  // steady: every green sits on epoch 0 + 10 s + n * 90.3 s, on any day
  for (const d of [0, 3, 11]) {
    const k = (st.nextChange('g', 'green', at(d, '10:00')) / 1000 - 10) / 90.3;
    assert.ok(Math.abs(k - Math.round(k)) < 1e-6);
  }
  const ind = createSim({ controllers: [A({ clock: { mode: 'independent' } })] });
  const ph = [0, 1, 2, 3].map((d) => phase(ind, d));
  assert.ok(new Set(ph.map((x) => Math.round(x))).size > 1);
  const same = createSim({ controllers: [A({ clock: { mode: 'independent' } })] });
  assert.equal(phase(same, 2), ph[2], 'reproducible per seed');
});

test('nudged clock: day offsets are N(0, sigma) around the steady phase', () => {
  const st = createSim({ controllers: [A()] }), nu = createSim({ controllers: [A({ clock: { mode: 'nudged', sigmaSec: 2 } })] });
  const d = [];
  for (let day = 0; day < 40; day++) {
    const t = at(day, '10:00');
    let e = nu.nextChange('g', 'green', t) - st.nextChange('g', 'green', t);
    e = ((e / 1000 + 45.15) % 90.3 + 90.3) % 90.3 - 45.15;
    d.push(e);
  }
  const sd = Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length);
  assert.ok(sd > 1 && sd < 3.2, `sd ${sd}`);
});

test('drift moves the phase within a day', () => {
  const st = createSim({ controllers: [A()] }), dr = createSim({ controllers: [A({ clock: { driftSecPerHour: 0.5 } })] });
  const e = (t) => dr.nextChange('g', 'green', t) - st.nextChange('g', 'green', t);
  const w = (ms) => ((ms / 1000 + 45.15) % 90.3 + 90.3) % 90.3 - 45.15;
  assert.ok(Math.abs(w(e(at(0, '14:00'))) - w(e(at(0, '08:00'))) - 3) < 0.2);
});

test('plans: different cycle per window; no events outside windows', () => {
  const s = createSim({ controllers: [{
    id: 'c', plans: [{ fromMin: 420, toMin: 960, cycleSec: 80 }, { fromMin: 960, toMin: 420, cycleSec: 70 }],
    intersections: [{ id: 'i', lights: [light('g', 5, 30)] }] }] });
  const m = s.changes('g', 'green', at(1, '09:00'), at(1, '10:00'));
  assert.ok(Math.abs((m[1] - m[0]) / 1000 - 80) < 1e-6);
  const e = s.changes('g', 'green', at(1, '20:00'), at(1, '21:00'));
  assert.ok(Math.abs((e[1] - e[0]) / 1000 - 70) < 1e-6);
  assert.equal(s.cycleAt('g', at(1, '23:30')), 70);
  assert.equal(s.cycleAt('g', at(1, '03:00')), 70);
});

test('corridor: second intersection is a fixed offset from the first, every day', () => {
  const s = createSim({ controllers: [{ id: 'c', cycleSec: 100, clock: { mode: 'independent' }, intersections: [
    { id: 'a', lights: [light('ga', 0, 40)] }, { id: 'b', offsetSec: 17, lights: [light('gb', 0, 40)] }] }] });
  for (const d of [0, 3, 9]) {
    const t = at(d, '12:00'), ta = s.nextChange('ga', 'green', t), tb = s.nextChange('gb', 'green', ta - 1e3);
    assert.ok(Math.abs((tb - ta) / 1000 - 17) < 1e-6);
  }
});

test('actuated light: green length varies per cycle, cycle stays fixed', () => {
  const s = createSim({ controllers: [{ id: 'c', cycleSec: 100, intersections: [{ id: 'i', lights: [light('g', 0, 40, { actuatedSec: 6 })] }] }] });
  const t0 = at(0, '10:00'), t1 = t0 + 3600e3;
  const gr = s.changes('g', 'green', t0, t1), am = s.changes('g', 'amber', t0, t1);
  for (let i = 1; i < gr.length; i++) assert.ok(Math.abs((gr[i] - gr[i - 1]) / 1000 - 100) < 1e-6);
  const dur = gr.map((g) => (am.find((a) => a > g) - g) / 1000);
  assert.ok(Math.max(...dur) - Math.min(...dur) > 6);
  assert.ok(dur.every((d) => d >= 34 - 1e-6 && d <= 46 + 1e-6));
});

test('sittings: one-sided lag, only chosen colours, real-looking observations', () => {
  const s = createSim({ seed: 7, controllers: [A()] });
  const taps = s.sit({ t: at(0, '09:00'), watch: ['g'], aspects: ['green'], cycles: 40 });
  assert.ok(taps.length >= 39);
  const lags = taps.map((o) => {
    const tr = s.changes('g', 'green', o.t - 20e3, o.t + 1);
    return o.t - tr[tr.length - 1];
  });
  assert.ok(Math.min(...lags) >= 200 - 1, 'lag >= 0.2 s');
  const mean = lags.reduce((a, b) => a + b) / lags.length;
  assert.ok(mean > 250 && mean < 500, `mean lag ${mean}`);
  for (const o of taps) {
    assert.deepEqual(Object.keys(o).sort(), ['aspect', 'headId', 'id', 'intersectionId', 'kind', 't']);
    assert.equal(o.aspect, 'green'); assert.equal(o.kind, 'onset'); assert.equal(o.intersectionId, 'ixA');
    assert.ok(Number.isInteger(o.t));
  }
  assert.equal(new Set(s.observations.map((o) => o.id)).size, s.observations.length);
});

test('sittings: maxTaps, missAt, slipAt late/wrong, seeded repeatability', () => {
  const run = (opts) => createSim({ seed: 3, controllers: [A()] }).sit({ t: at(0, '09:00'), watch: ['g'], aspects: ['green', 'red'], cycles: 4, ...opts });
  const base = run({});
  assert.equal(base.length, 8);
  assert.deepEqual(run({}), base);
  assert.equal(run({ maxTaps: 1 }).length, 1);
  const miss = run({ missAt: [3] });
  assert.equal(miss.length, 7);
  assert.ok(!miss.some((o) => o.t === base[3].t));
  const late = run({ slipAt: { 2: { kind: 'late', delaySec: 6 } } });
  assert.equal(late.length, 8);
  assert.ok(Math.abs(late[2].t - base[2].t - 6000) < 1);
  assert.deepEqual(late.filter((_, i) => i !== 2).map((o) => o.t), base.filter((_, i) => i !== 2).map((o) => o.t));
  const wrong = run({ slipAt: { 1: { kind: 'wrong' } } });
  assert.notEqual(wrong[1].aspect, base[1].aspect);
  assert.equal(wrong[1].t, base[1].t);
  const rnd = run({ slipProb: 1 });
  assert.ok(rnd.every((o, i) => o.t - base[i].t >= 3000 - 1 && o.t - base[i].t <= 10000 + 1000));
});

test('dayKey uses the 04:00 boundary', () => {
  assert.equal(dayKey(at(0, '03:59')), dayKey(at(-1, '12:00')));
  assert.notEqual(dayKey(at(0, '04:01')), dayKey(at(-1, '12:00')));
});
