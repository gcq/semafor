import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, JsStreetNetwork } from '../vendor/osm2streets/osm2streets_js.js';
import { areaBbox, bboxCenter, buildLanes } from '../src/osm/lanes.js';
import { matchApproaches, APPROACH_RADIUS_M } from '../src/osm/approaches.js';

const C = { lat: 41.4, lon: 2.0 };
const LAT = 6371000 * Math.PI / 180; // metres per degree of latitude
const ll = (e, n, c = C) => ({ lat: c.lat + n / LAT, lon: c.lon + e / (LAT * Math.cos(c.lat * Math.PI / 180)) });
const mast = (id, e, n, headIds = [`h_${id}`]) => ({ id, pos: ll(e, n), headIds });
const ix = (id, e, n, masts) => ({ id, location: ll(e, n), masts });
// inbound approach: stop point (e, n) m, travel compass bearing b, `lanes` lane rings in layer 0
const data = (apprs) => {
  const lanes = [], appr = [];
  apprs.forEach(([e, n, b, count = 1], a) => {
    appr.push([e * 100, n * 100, b, 1000 + a]);
    for (let i = 0; i < count; i++) lanes.push({ k: 'drive', r: [0, 0, 100, 0, 100, 100], a });
  });
  lanes.push({ k: 'drive', r: [0, 0, 100, 0, 100, 100] }); // a lane that belongs to no approach
  return { layers: [{ z: 0, lanes, appr }] };
};
// four arms of a crossroads: stop points 18 m out, heading at the centre
const ARMS = [[0, -18, 0], [0, 18, 180], [-18, 0, 90], [18, 0, 270]]; // from S, N, W, E

test('four approaches, masts on the matching (near) sides -> each head gets its own approach', () => {
  const masts = [mast('mS', 4, -14), mast('mN', -4, 14), mast('mW', -14, -4), mast('mE', 14, 4)];
  const { matches, unmatched } = matchApproaches(data(ARMS), C, [ix('x', 0, 0, masts)]);
  assert.equal(unmatched.length, 0);
  assert.deepEqual(matches.map((m) => [m.appr, m.mastId, m.headId]), [[0, 'mS', 'h_mS'], [1, 'mN', 'h_mN'], [2, 'mW', 'h_mW'], [3, 'mE', 'h_mE']]);
  assert.equal(matches[0].lanes.length, 1);
  assert.deepEqual([matches[0].x, matches[0].y], [0, -18]);
});

test('a mast with no matching approach just gets nothing; an approach with no mast is unmatched', () => {
  const masts = [mast('mS', 4, -14), mast('mN', -4, 14), mast('mE', 14, 4)]; // no west mast
  const { matches, unmatched } = matchApproaches(data(ARMS.slice(0, 3)), C, [ix('x', 0, 0, masts)]);
  assert.deepEqual(matches.map((m) => m.mastId), ['mS', 'mN']);
  assert.deepEqual(unmatched.map((u) => u.appr), [2]); // west arm: nearest mast (S/N) is 90° off
  assert.ok(!matches.some((m) => m.mastId === 'mE'));
});

test('multi-lane approach keeps all its lanes; a multi-head mast stands in with its first head', () => {
  const { matches } = matchApproaches(data([[0, -18, 0, 3]]), C, [ix('x', 0, 0, [mast('m', 3, -15, ['first', 'second'])])]);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].lanes, [0, 1, 2]);
  assert.equal(matches[0].headId, 'first');
});

test('ignores outbound lanes, approaches beyond the radius, and masts without positions/heads', () => {
  const masts = [mast('mS', 4, -14), { id: 'nopos', headIds: ['x'] }, { id: 'nohead', pos: ll(4, -14), headIds: [] }];
  const far = [0, -(APPROACH_RADIUS_M + 5), 0];
  const away = [0, -18, 180]; // same place, heading away from the centre (inside a junction)
  const { matches, unmatched } = matchApproaches(data([far, away, [0, -18, 0]]), C, [ix('x', 0, 0, masts)]);
  assert.deepEqual(matches.map((m) => m.appr), [2]);
  assert.equal(unmatched.length, 0);
});

test('with two intersections an approach belongs to the nearer centre; edited masts re-match', () => {
  const a = ix('A', 0, 0, [mast('mA', 4, -14)]), b = ix('B', 0, -60, [mast('mB', 4, -45)]);
  const d = data([[0, -18, 0]]); // 18 m from A, 42 m from B
  assert.deepEqual(matchApproaches(d, C, [a, b]).matches.map((m) => m.ixId), ['A']);
  const edited = { ...a, masts: [mast('mA', -14, 0)] }; // mast moved to the west side
  const r = matchApproaches(d, C, [edited, b]);
  assert.equal(r.matches.length, 0);
  assert.equal(r.unmatched.length, 1);
});

// ---- real data: Pont (test/data/pont.osm.xml + its real masts) ----
initSync({ module: readFileSync(new URL('../vendor/osm2streets/osm2streets_js_bg.wasm', import.meta.url)) });
const BBOX = areaBbox([{ lat: 41.4143, lon: 2.0121 }]);
const xml = readFileSync(new URL('./data/pont.osm.xml', import.meta.url));
const pont = JSON.parse(readFileSync(new URL('./data/pont-masts.json', import.meta.url), 'utf8'));
const { data: lanes } = buildLanes(JsStreetNetwork, new Uint8Array(xml), BBOX);
const wayName = (id) => new RegExp(`<way id="${id}"[^>]*>[\\s\\S]*?</way>`).exec(xml.toString())?.[0].match(/k="name" v="([^"]*)"/)?.[1];

test('Pont: compaction links incoming driving lanes to approaches', () => {
  const l0 = lanes.layers.find((l) => l.z === 0);
  assert.ok(l0.appr.length >= 5);
  for (const [x, y, b, w] of l0.appr) assert.ok(Number.isInteger(x) && Number.isInteger(y) && b >= 0 && b < 360 && w > 0);
  const tagged = l0.lanes.filter((l) => l.a != null);
  assert.ok(tagged.length >= l0.appr.length && tagged.every((l) => l.k === 'drive' && l.a < l0.appr.length));
});

test('Pont: every mast gets an approach; heading 335° along Carretera de Molins de Rei a Caldes maps to the south mast', () => {
  const { matches } = matchApproaches(lanes, bboxCenter(BBOX), [pont]);
  for (const m of pont.masts) assert.ok(matches.some((x) => x.mastId === m.id), `mast ${m.id} has no approach`);
  const south = pont.masts.reduce((s, m) => (m.pos.lat < s.pos.lat ? m : s)); // the mast on the SSE side, facing traffic from there
  const carretera = matches.filter((m) => wayName(m.way) === 'Carretera de Molins de Rei a Caldes' && Math.abs(m.bearing - 335) <= 10);
  assert.ok(carretera.length >= 1);
  for (const m of carretera) assert.equal(m.mastId, south.id);
});
