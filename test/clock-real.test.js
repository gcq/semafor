// Replay on real taps. Reads out/fixtures/real-taps.json ({intersections,
// observations}), which is gitignored and must NEVER be copied into a tracked
// file. Skipped when absent. For each tap, the model is built from strictly
// earlier taps only and asked when that tap's mark changes next.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { computeModel } from '../src/inference/clock.js';
import { nextOnset } from '../src/predict/next.js';

const FIXTURE = new URL('../out/fixtures/real-taps.json', import.meta.url);
const EXPECT = new URL('../out/fixtures/real-expect.json', import.meta.url); // names, also private
const have = existsSync(FIXTURE) && existsSync(EXPECT);
const SITTING_MS = 30 * 60e3;
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : NaN);
const wrap = (sec, C) => ((sec + C / 2) % C + C) % C - C / 2;
const usable = (o) => o.kind === 'onset' && o.headId && o.aspect && Number.isFinite(o.t);
const bin = (age) => (age == null ? 'no anchor' : age <= SITTING_MS ? '<= 30 min' : age <= 6 * 3600e3 ? '30 min - 6 h' : age <= 24 * 3600e3 ? '6 - 24 h' : '> 1 day');
const BINS = ['<= 30 min', '30 min - 6 h', '6 - 24 h', '> 1 day', 'no anchor'];

test('real taps: replay predictions, actuated and plan checks', { skip: !have && 'out/fixtures/real-taps.json / real-expect.json not present' }, () => {
  const { intersections, observations } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const X = JSON.parse(readFileSync(EXPECT, 'utf8'));
  const taps = observations.filter(usable).sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  const full = computeModel({ intersections, observations });
  const groupIx = (headId) => {
    const g = full.groups.find((x) => x.headIds.includes(headId));
    return g ? new Set(g.intersectionIds) : new Set();
  };

  const rows = []; // { bin, err|null }
  taps.forEach((tap, i) => {
    const earlier = taps.slice(0, i).filter((o) => o.t < tap.t);
    const ixs = groupIx(tap.headId);
    const anchor = earlier.filter((o) => ixs.has(o.intersectionId)).at(-1);
    const age = anchor ? tap.t - anchor.t : null;
    const m = computeModel({ intersections, observations: earlier });
    const now = tap.t - 1;
    const p = nextOnset(m, tap.headId, tap.aspect, now);
    if (p.unpredictable) { rows.push({ bin: bin(age), err: null }); return; }
    const C = m.groups.flatMap((g) => g.plans).find((pl) => pl.id === p.planId)?.cycleSec ?? 90;
    rows.push({ bin: bin(age), err: wrap((now + p.inSec * 1000 - tap.t) / 1000, C) });
  });

  const table = BINS.map((b) => {
    const r = rows.filter((x) => x.bin === b), e = r.filter((x) => x.err != null).map((x) => Math.abs(x.err));
    return { 'anchor age': b, taps: r.length, predicted: e.length, 'median |err| s': +median(e).toFixed(2),
      'p90 |err| s': e.length ? +[...e].sort((x, y) => x - y)[Math.floor(0.9 * (e.length - 1))].toFixed(2) : NaN };
  });
  console.log('real-data replay (error of predicted vs actual tap time):');
  console.table(table);

  const same = rows.filter((x) => x.bin === '<= 30 min' && x.err != null).map((x) => Math.abs(x.err));
  assert.ok(same.length >= 10, `need within-sitting samples, got ${same.length}`);
  assert.ok(median(same) <= 1, `within-sitting median |error| ${median(same).toFixed(2)} s`);

  // Named lights/plans in the full model.
  const ix = intersections.find((x) => x.name === X.independent);
  const head = ix?.heads.find((h) => h.name === X.fixedLight);
  assert.ok(head, 'fixture has the fixed light');
  assert.ok(full.lights[head.id], 'light is in the model');
  assert.deepEqual(full.lights[head.id].actuated, [], 'the fixed light is not actuated');

  const pont = intersections.find((x) => x.name === X.corridorMain);
  assert.ok(pont, 'fixture has the corridor junction');
  const inWin = (p, min) => p.windows.some((w) => (w.fromMin <= w.toMin ? min >= w.fromMin && min < w.toMin : min >= w.fromMin || min < w.toMin));
  const evening = full.groups.filter((g) => g.intersectionIds.includes(pont.id)).flatMap((g) => g.plans).find((p) => inWin(p, 20 * 60));
  assert.ok(evening, 'the corridor junction has an evening plan');
  assert.ok(evening.cycleSec >= 90.0 && evening.cycleSec <= 90.6, `evening cycle ${evening.cycleSec}`);
});
