// Track matcher + suggestion rule on the REAL Molins de Rei street geometry and the user's real junctions
// (test/data: pont.osm.xml, molins-ixs.json), with simulated drives (test/trackscen.js, trackfix.js):
// white Gaussian GPS noise, dropped fixes, garbage heading at a standstill, the real recorder in between.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, KEY, run, ixs, set, center } from './trackscen.js';
import { armBearings, matchTrack, MATCH } from '../src/osm/trackmatch.js';
import { suggestRefile } from '../src/osm/suggest.js';
import { armId, ixNamed, headId } from './trackfix.js';
import { angularDiff } from '../src/nav/proximity.js';

const sc = (id) => SCENARIOS.find((s) => s.id === id);
const nameOf = (hid) => { for (const ix of ixs) { const h = ix.heads.find((x) => x.id === hid); if (h) return `${ix.name.split(' ')[0]}/${h.name}`; } return hid; };
const VT = 'Verdaguer - Terraple';

test('fixture: the approaches the scenarios wait at exist, with the heads and ways the tests assume', () => {
  const at = (key) => set.cands.find((c) => c.key === key);
  assert.equal(at(KEY.vtN).headId, headId(VT, 'Verdaguer N Left'), 'Verdaguer N mast: first head is Left (the mast carries Left + Straight)');
  assert.equal(at(KEY.vtN).way, 361648185);
  assert.equal(at(KEY.pcCarretera).way, 1410456370); assert.equal(at(KEY.pcAvinguda).way, 296913512);
  assert.equal(at(KEY.pontCarretera).way, 1410456371); assert.equal(at(KEY.pontAvinguda).way, 296913512);
  assert.equal(at(KEY.pontVerd).way, 547228336);
  for (const k of Object.values(KEY)) assert.ok(at(k), k);
});

test('arms get bearings from the approaches that start at them (no arm has a position in the data)', () => {
  const { bearing, fromArm } = armBearings(set, ixs);
  const vt = bearing.get(ixNamed(VT).id), arm = (n) => vt.get(armId(VT, n));
  // Verdaguer runs east-west here, Terraple north-west / south-east; "N"/"S" are the user's labels
  assert.ok(angularDiff(arm('Verdaguer N'), 85) < 12, `Verdaguer N ${arm('Verdaguer N')}`);
  assert.ok(angularDiff(arm('Verdaguer S'), 263) < 12, `Verdaguer S ${arm('Verdaguer S')}`);
  assert.ok(angularDiff(arm('Terraple N'), 335) < 25, `Terraple N ${arm('Terraple N')}`);
  assert.ok(angularDiff(arm('Terraple S'), 152) < 12, `Terraple S ${arm('Terraple S')}`);
  assert.equal(fromArm.get(KEY.vtN), armId(VT, 'Verdaguer N'));
  // Pont's Nacional and Lateral arms are the two parallel roads: the same bearing, so a way out towards them can't be told apart
  const pont = bearing.get(ixNamed('Pont').id);
  assert.ok(angularDiff(pont.get(armId('Pont', 'Nacional')), pont.get(armId('Pont', 'Lateral'))) < 10);
  // ... and the Nacional -> Nacional movement hung on the Verdaguer head does not make that head serve the Nacional arm
  assert.equal(fromArm.get(KEY.pontCarretera), armId('Pont', 'Nacional'));
});

test('Verdaguer N, straight on: entry Verdaguer N, exit Verdaguer S, head Straight (heading garbage while stopped)', () => {
  const r = run(sc('vt-straight-tapLeft'), { sigma: 3, seed: 1 });
  assert.equal(r.match.confidence, 'high');
  assert.equal(r.match.approachKey, KEY.vtN);
  assert.equal(r.match.fromArmId, armId(VT, 'Verdaguer N')); assert.equal(r.match.toArmId, armId(VT, 'Verdaguer S'));
  assert.equal(r.match.headId, headId(VT, 'Verdaguer N Straight'));
  assert.equal(r.match.turn, 'straight');
  assert.ok(r.track.some((f) => f.speed < 1 && f.heading != null && angularDiff(f.heading, 261) > 60), 'the simulated heading really is garbage at the standstill');
});

test('Verdaguer N, off to Terraple N: head Left, and the why says which way (the map puts Terraple N on the right of Verdaguer N)', () => {
  const r = run(sc('vt-turn-tapStraight'), { sigma: 3, seed: 1 });
  assert.equal(r.match.confidence, 'high');
  assert.equal(r.match.toArmId, armId(VT, 'Terraple N'));
  assert.equal(r.match.headId, headId(VT, 'Verdaguer N Left'));
  assert.equal(r.match.turn, 'right');
  assert.match(r.sugg.why, /^you came from Verdaguer N and turned right$/);
  assert.equal(r.sugg.kind, 'head');
  assert.equal(r.sugg.fromLabel, 'Verdaguer - Terraple · Verdaguer N Straight'); assert.equal(r.sugg.toLabel, 'Verdaguer - Terraple · Verdaguer N Left');
});

test('both directions of the Straight / Left decision, over many noisy runs', () => {
  for (const [id, want] of [['vt-straight-tapLeft', 'Verdaguer N Straight'], ['vt-turn-tapStraight', 'Verdaguer N Left'], ['vt-straight-tapStraight', null], ['vt-turn-tapLeft', null]]) {
    for (let seed = 1; seed <= 10; seed++) {
      const r = run(sc(id), { sigma: 6, seed });
      assert.equal(r.sugg ? nameOf(r.sugg.toHeadId) : null, want ? `Verdaguer/${want}` : null, `${id} seed ${seed}`);
    }
  }
});

test('parallel roads: Carretera and Avinguda (11 m apart) are told apart by the run-in, at Pere Calders and at Pont', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const a = run(sc('pc-carretera-tapPontNacional'), { sigma: 3, seed }), b = run(sc('pc-avinguda-tapPontLateral'), { sigma: 3, seed });
    assert.equal(a.match.approachKey, KEY.pcCarretera, `Carretera seed ${seed}`);
    assert.equal(b.match.approachKey, KEY.pcAvinguda, `Avinguda seed ${seed}`);
    assert.equal(a.sugg?.toHeadId, sc('pc-carretera-tapPontNacional').expect); assert.equal(b.sugg?.toHeadId, sc('pc-avinguda-tapPontLateral').expect);
    assert.equal(run(sc('pc-carretera-tapPcNacional'), { sigma: 3, seed }).sugg, null, 'filed on the right light: nothing');
    assert.equal(run(sc('pc-avinguda-tapPcLateral'), { sigma: 3, seed }).sugg, null);
  }
});

test('wrong junction: Pont light tapped at Pere Calders (kind junction); Pere Calders light tapped at Pont; a junction off the path', () => {
  const a = run(sc('pc-carretera-tapPontNacional'), { sigma: 3, seed: 2 }).sugg;
  assert.equal(a.kind, 'junction'); assert.equal(a.toIxId, ixNamed('Nacional - Pere Calders').id); assert.equal(a.fromIxId, ixNamed('Pont').id);
  assert.match(a.why, /you were at Nacional - Pere Calders, coming from Nacional; the tap was filed under Pont - Nacional/);
  const b = run(sc('pont-carretera-tapPcNacional'), { sigma: 3, seed: 2 }).sugg;
  assert.equal(b.toIxId, ixNamed('Pont').id); assert.equal(nameOf(b.toHeadId), 'Pont/Nacional');
  const c = run(sc('pc-carretera-tapVtStraight'), { sigma: 3, seed: 2 }).sugg;
  assert.equal(c.toIxId, ixNamed('Nacional - Pere Calders').id, 'Verdaguer - Terraple is ~100 m off the Carretera: not on the path');
});

test('cross-traffic watch: a light that does not serve your arm at the junction you are at is never moved', () => {
  for (const id of ['cross-pont-verdaguer', 'cross-vt-terraple', 'cross-pont-lateral']) {
    for (let seed = 1; seed <= 12; seed++) for (const sigma of [3, 6, 10]) assert.equal(run(sc(id), { sigma, seed }).sugg, null, `${id} σ=${sigma} seed ${seed}`);
  }
  // the match itself is confident and right; it is the rule that refuses
  const r = run(sc('cross-vt-terraple'), { sigma: 3, seed: 1 });
  assert.equal(r.match.confidence, 'high'); assert.equal(nameOf(r.match.headId), 'Verdaguer/Verdaguer N Straight');
});

test('two junctions in a row: the tap belongs to the one you were approaching', () => {
  const atVt = run(sc('vt-straight-tapLeft'), { sigma: 3, seed: 1 }), atPont = run(sc('row-vt-tapped-at-pont'), { sigma: 3, seed: 1 });
  assert.equal(atVt.match.ixId, ixNamed(VT).id);
  assert.equal(atPont.match.ixId, ixNamed('Pont').id);
  assert.equal(atPont.sugg.toHeadId, sc('row-vt-tapped-at-pont').expect);
  assert.equal(atPont.sugg.kind, 'junction');
  assert.equal(run(sc('row-pont-tapped-at-pont'), { sigma: 3, seed: 1 }).sugg, null);
  // the same track judged at the two taps: the recorder's track covers both junctions
  const t = atPont.track;
  const early = matchTrack({ track: t, t: atPont.d.tAt(0) + 0, set, center, intersections: ixs });
  assert.notEqual(early.ixId, ixNamed('Pont').id, 'at the start of the run the light you are about to reach is not Pont');
});

test('a long red with a frozen, wrong heading (90° off, never updates) changes nothing', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const r = run(sc('vt-turn-tapStraight'), { sigma: 6, seed, dwell: 150, frozenHeading: 180 });
    assert.equal(r.sugg?.toHeadId, sc('vt-turn-tapStraight').expect, `seed ${seed}`);
  }
});

test('heading is ignored at a standstill and vetoes an approach only while moving fast the other way', () => {
  const r = run(sc('vt-straight-tapLeft'), { sigma: 3, seed: 1 });
  const flipped = r.track.map((f) => ({ ...f, heading: f.speed >= MATCH.hdgMinSpeed ? (f.heading + 180) % 360 : f.heading }));
  assert.notEqual(matchTrack({ track: flipped, t: r.tapT, set, center, intersections: ixs }).confidence, 'high', 'driving 180° against the approach');
  const noHeading = r.track.map((f) => ({ ...f, heading: null, speed: null }));
  assert.equal(matchTrack({ track: noHeading, t: r.tapT, set, center, intersections: ixs }).headId, headId(VT, 'Verdaguer N Straight'), 'no heading and no speed at all: the geometry alone does it');
});

test('U-turn: the way out is the way in (same arm); there is no such movement, so no head and no suggestion', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const r = run(sc('uturn-vt'), { sigma: 3, seed });
    if (r.match.toArmId) { assert.equal(r.match.toArmId, r.match.fromArmId); assert.equal(r.match.turn, 'u-turn'); }
    assert.equal(r.match.headId, null);
    assert.notEqual(r.match.confidence, 'high');
    assert.equal(r.sugg, null);
  }
  assert.ok([1, 2, 3, 4, 5, 6].some((seed) => run(sc('uturn-vt'), { sigma: 3, seed }).match.turn === 'u-turn'), 'the U-turn is recognised');
});

test('a U-turn is not suggested even where the map has a U-turn movement (it is often on a neighbour head)', () => {
  const vt = JSON.parse(JSON.stringify(ixNamed(VT)));
  const n = armId(VT, 'Verdaguer N');
  vt.movements.push({ id: 'mv_u', from: n, to: n, headId: headId(VT, 'Verdaguer N Left') });
  const r = run(sc('uturn-vt'), { sigma: 3, seed: 3 });
  const m = matchTrack({ track: r.track, t: r.tapT, set, center, intersections: ixs.map((i) => (i.id === vt.id ? vt : i)) });
  if (m.turn === 'u-turn') {
    assert.equal(m.headId, headId(VT, 'Verdaguer N Left'));
    assert.equal(suggestRefile({ tap: { ...r.tap, headId: headId(VT, 'Verdaguer N Straight') }, track: r.track, set, center, intersections: ixs.map((i) => (i.id === vt.id ? vt : i)) }), null);
  }
});

test('track too short, or ending before the junction: no suggestion', () => {
  const s = sc('vt-turn-tapStraight');
  for (const cut of [30, 60]) { // the track stops 30 / 60 m before the stop line
    for (let seed = 1; seed <= 6; seed++) {
      const r = run(s, { sigma: 3, seed, cutBefore: cut });
      assert.equal(r.sugg, null, `cut ${cut} m seed ${seed}`);
      assert.notEqual(r.match.confidence, 'high');
    }
  }
  // stopped at the line and the app closed: you never got through
  const w = run(s, { sigma: 3, seed: 1, cutBefore: 0 });
  assert.equal(w.sugg, null); assert.match(w.match.reason, /ends before the junction|follow/);
  // only the last 8 s before the tap
  const r = run(s, { sigma: 3, seed: 1 });
  const short = r.track.filter((f) => f.t >= r.tapT - 8000);
  assert.equal(suggestRefile({ tap: r.tap, track: short, set, center, intersections: ixs }), null);
  // no track at all
  assert.equal(suggestRefile({ tap: r.tap, track: [], set, center, intersections: ixs }), null);
  assert.equal(matchTrack({ track: [], t: r.tapT, set, center, intersections: ixs }).confidence, 'none');
});

test('a tap without a recorded position, a non-onset tap, or one already re-filed: no suggestion', () => {
  const r = run(sc('vt-turn-tapStraight'), { sigma: 3, seed: 1 });
  const base = { track: r.track, set, center, intersections: ixs };
  assert.ok(suggestRefile({ tap: r.tap, ...base }));
  assert.equal(suggestRefile({ tap: { ...r.tap, where: undefined }, ...base }), null);
  assert.equal(run(sc('vt-turn-tapStraight'), { sigma: 3, seed: 1, noWhere: true }).sugg, null);
  assert.equal(suggestRefile({ tap: { ...r.tap, kind: 'current' }, ...base }), null);
  assert.equal(suggestRefile({ tap: { ...r.tap, refiledFrom: { headId: 'x' } }, ...base }), null);
  assert.equal(suggestRefile({ tap: { ...r.tap, headId: 'head_gone' }, ...base }), null);
});

test('a track from somewhere else (no mapped approach near it) matches nothing', () => {
  const r = run(sc('vt-turn-tapStraight'), { sigma: 3, seed: 1 });
  const far = r.track.map((f) => ({ ...f, lat: f.lat + 0.01 }));
  assert.equal(matchTrack({ track: far, t: r.tapT, set, center, intersections: ixs }).confidence, 'none');
  assert.equal(matchTrack({ track: r.track, t: r.tapT + 3600e3, set, center, intersections: ixs }).confidence, 'none', 'no fixes around that time');
});

// ---------- the noise sweep ----------
const SEEDS = 40, SIGMAS = [3, 6, 10];
function sweep(opts, label, t) {
  const table = [];
  for (const sigma of SIGMAS) {
    let wrong = 0, hit = 0, want = 0, runs = 0; const per = {}, bad = [];
    for (const s of SCENARIOS) {
      let h = 0, n = 0;
      for (let seed = 100; seed < 100 + SEEDS; seed++) {
        const r = run(s, { sigma, seed, ...opts }), got = r.sugg?.toHeadId ?? null; runs++;
        if (got && got !== s.expect) { wrong++; bad.push(`${s.id} seed ${seed}: ${nameOf(got)} (${r.sugg.why})`); }
        if (s.expect) { n++; if (got === s.expect) h++; }
      }
      per[s.id] = n ? h / n : null; want += n; hit += h;
    }
    table.push({ sigma, runs, wrong, recall: hit / want, per, bad });
    t.diagnostic(`${label} σ=${sigma} m: ${runs} runs, wrong suggestions ${wrong}, recall ${hit}/${want} = ${(100 * hit / want).toFixed(1)}%`);
  }
  return table;
}

test('noise sweep: white Gaussian GPS noise σ = 3, 6, 10 m, 1 Hz, ~12% dropped fixes + a 4 s gap: ZERO wrong suggestions', (t) => {
  const table = sweep({}, 'white', t);
  for (const row of table) {
    assert.deepEqual(row.bad, [], `σ=${row.sigma}`);
    t.diagnostic(`  σ=${row.sigma} recall by scenario: ${Object.entries(row.per).filter(([, v]) => v != null).map(([k, v]) => `${k} ${(100 * v).toFixed(0)}%`).join(', ')}`);
  }
  const at = (s) => table.find((r) => r.sigma === s);
  assert.ok(at(3).recall >= 0.95, `σ=3 recall ${at(3).recall}`);
  assert.ok(at(6).recall >= 0.85, `σ=6 recall ${at(6).recall}`);
  assert.ok(at(10).recall >= 0.4, `σ=10 recall ${at(10).recall}`);
  for (const id of ['vt-straight-tapLeft', 'vt-turn-tapStraight', 'row-vt-tapped-at-pont']) assert.ok(at(6).per[id] >= 0.9, `clear case ${id} at σ=6: ${at(6).per[id]}`);
});

test('noise sweep: errors that drift (AR(1), 0.85 per second) and 30% dropped fixes: still ZERO wrong suggestions (fewer made)', (t) => {
  for (const [opts, label] of [[{ corr: 0.85 }, 'drifting'], [{ drop: 0.3 }, 'heavy dropout']]) {
    for (const row of sweep(opts, label, t)) assert.deepEqual(row.bad, [], `${label} σ=${row.sigma}`);
  }
});

test('noise sweep: other waiting patterns (tap right after arriving, long red, taps while rolling in): ZERO wrong', (t) => {
  for (const [opts, label] of [[{ tapAfter: 1 }, 'tap 1 s into the wait'], [{ dwell: 150, frozenHeading: 90 }, 'long red, frozen heading']]) {
    for (const row of sweep(opts, label, t)) assert.deepEqual(row.bad, [], `${label} σ=${row.sigma}`);
  }
});
