import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, JsStreetNetwork } from '../vendor/osm2streets/osm2streets_js.js';
import { areaBbox, bboxCenter, buildLanes } from '../src/osm/lanes.js';
import { approachCandidates, pickHead, toLocal, ringDist } from '../src/osm/approaches.js';
import { snapToLane, SNAP } from '../src/osm/lanesnap.js';
import { angularDiff } from '../src/nav/proximity.js';

// Verdaguer - Terraplè on the public Pont extract: Terraplè (north-bound arm from the SSE) meets Verdaguer
// (west arm one-way pair + east arm). The junction is the OSM node they share; Pont is the neighbour in the cluster.
const VT = { id: 'ix_vt', location: { lat: 41.4144141, lon: 2.013214 } };
const PONT = JSON.parse(readFileSync(new URL('./data/pont-masts.json', import.meta.url)));
initSync({ module: readFileSync(new URL('../vendor/osm2streets/osm2streets_js_bg.wasm', import.meta.url)) });
const bbox = areaBbox([VT.location, PONT.location]), center = bboxCenter(bbox);
const { data } = buildLanes(JsStreetNetwork, new Uint8Array(readFileSync(new URL('./data/pont.osm.xml', import.meta.url))), bbox);
const streets = { kind: 'lanes', center, data };
const l0 = data.layers.find((l) => l.z === 0);

const LAT = 6371000 * Math.PI / 180;
const ll = (e, n) => ({ lat: center.lat + n / LAT, lon: center.lon + e / (LAT * Math.cos(center.lat * Math.PI / 180)) });
const ring = (ln) => ln.r.map((v) => v / 100);
const inKind = (p, kind) => l0.lanes.some((ln) => ln.k === kind && ringDist(ring(ln), p.e, p.n) === 0);

// Near-side mast for every approach heading at the junction (synthetic: 4 m behind the stop point, 3 m to the right).
const vtE = toLocal(VT.location, center);
VT.masts = l0.appr.flatMap(([x, y, b], i) => {
  x /= 100; y /= 100;
  const toC = Math.hypot(vtE.e - x, vtE.n - y), dir = [Math.sin(b * Math.PI / 180), Math.cos(b * Math.PI / 180)];
  if (toC > 40 || angularDiff(b, (Math.atan2(vtE.e - x, vtE.n - y) * 180 / Math.PI + 360) % 360) > 60) return [];
  return [{ id: `m${i}`, pos: ll(x - dir[0] * 4 + dir[1] * 3, y - dir[1] * 4 - dir[0] * 3), headIds: [`h${i}`] }];
});
const ixs = [VT, PONT];
const set = approachCandidates(streets, ixs);
// the Terraplè north-bound approach (bearing ~334): its stop line is the furthest of the ones heading at the junction
const north = set.cands.filter((c) => c.ixId === VT.id && angularDiff(c.bearing, 334) < 15)
  .sort((a, b) => Math.hypot(b.x - vtE.e, b.y - vtE.n) - Math.hypot(a.x - vtE.e, a.y - vtE.n))[0];

test('driving lanes carry their travel bearing; the north-bound Terraplè lane runs ~334°', () => {
  const lane = l0.lanes.find((ln) => ln.k === 'drive' && ring(ln).every((v, i) => v === north.rings[0][i]));
  assert.ok(angularDiff(lane.b, north.bearing) < 25, `lane ${lane.b}° vs approach ${north.bearing}°`);
  assert.ok(l0.lanes.filter((ln) => ln.k === 'drive').every((ln) => ln.b == null || (ln.b >= 0 && ln.b < 360)));
});

test('snapToLane: a fix on the Terraplè sidewalk is drawn on the driving lane going your way', () => {
  // 2.3 m right of the north-bound lane's axis, 25 m before its stop line = on the pavement beside it
  const dir = [north.dx, north.dy], right = [dir[1], -dir[0]];
  const p = { e: north.x - dir[0] * 25 + right[0] * 2.3, n: north.y - dir[1] * 25 + right[1] * 2.3 };
  assert.ok(inKind(p, 'walk') && !inKind(p, 'drive'), 'precondition: the raw fix is on the sidewalk');
  const snapped = snapToLane(streets, ll(p.e, p.n), north.bearing);
  const q = toLocal(snapped, center);
  assert.ok(inKind(q, 'drive'), 'snapped onto a driving lane');
  assert.ok(Math.hypot(q.e - p.e, q.n - p.n) < SNAP.maxM);
  // never onto the oncoming lane: with the opposite course it picks a lane running that way instead
  const opp = (north.bearing + 180) % 360, back = toLocal(snapToLane(streets, ll(p.e, p.n), opp), center);
  assert.ok(l0.lanes.some((ln) => ln.k === 'drive' && ln.b != null && angularDiff(ln.b, opp) <= SNAP.courseTol && ringDist(ring(ln), back.e, back.n) === 0), 'the other way: a lane running the other way');
});

test('snapToLane: raw GPS when already on a lane, no course, no streets, or nothing within reach', () => {
  const on = ll(north.x - north.dx * 20, north.y - north.dy * 20);
  assert.ok(inKind(toLocal(on, center), 'drive'));
  assert.equal(snapToLane(streets, on, north.bearing), on); // already on a lane going your way
  const off = ll(north.x + 400, north.y);
  assert.equal(snapToLane(streets, off, north.bearing), off); // 400 m from any lane
  assert.equal(snapToLane(streets, on, null), on);
  assert.equal(snapToLane(null, on, 10), on);
  assert.equal(snapToLane({ kind: 'plain', center, data: {} }, on, 10), on);
  assert.equal(snapToLane(streets, null, 10), null);
});

test('snapToLane never lands on a sidewalk, bike or parking lane', () => {
  let n = 0;
  for (let i = 0; i < 400; i++) { // a grid of fixes around the junction, every course
    const p = { e: vtE.e - 30 + (i % 20) * 3, n: vtE.n - 30 + Math.floor(i / 20) * 3 }, course = (i * 47) % 360;
    const q = toLocal(snapToLane(streets, ll(p.e, p.n), course), center);
    if (Math.hypot(q.e - p.e, q.n - p.n) > 0.01) { n++; assert.ok(inKind(q, 'drive'), `fix ${i} snapped off the driving lanes: ${JSON.stringify({p,q,course})}`); }
  }
  assert.ok(n > 20, `only ${n} fixes were snapped`);
});

// ---- the junction must not be dropped on a noisy fix ----
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

test('creeping up to the stop line with 6 m of GPS noise never marks the approach passed before the line', () => {
  let falsePassed = 0, fixes = 0;
  for (let run = 0; run < 150; run++) {
    let hp = null;
    for (let d = 60, k = 0; d > -10; d -= 2.5, k++) { // 2.5 m/s, 1 Hz, from 60 m before the line to 10 m past it
      const e = north.x - north.dx * d + gauss() * 6, n = north.y - north.dy * d + gauss() * 6;
      hp = pickHead({ set, ixId: VT.id, ego: { e, n }, course: north.bearing, prev: hp, fixId: k });
      if (d >= 8) { fixes++; if (hp.reason === 'passed') falsePassed++; }
    }
  }
  assert.equal(falsePassed, 0, `${falsePassed} of ${fixes} fixes marked the approach passed 8+ m before its stop line`);
});
test('snapToLane follows the car\'s own course: on Verdaguer it snaps to the Verdaguer lane, never back onto Terraplè', () => {
  // beside the corner: a Verdaguer (west-bound) lane 3.5 m away and a Terraplè lane 2.8 m away, both inside the 5 m reach
  const p = { e: vtE.e - 6, n: vtE.n + 6 };
  const laneAt = (q) => l0.lanes.find((ln) => ln.k === 'drive' && ln.b != null && ringDist(ring(ln), q.e, q.n) === 0);
  const west = laneAt(toLocal(snapToLane(streets, ll(p.e, p.n), 270), center));
  assert.ok(west && angularDiff(west.b, 270) <= SNAP.courseTol, `course 270 should land on a Verdaguer lane, got ${west && west.b}`);
  const onTerraple = laneAt(toLocal(snapToLane(streets, ll(p.e, p.n), north.bearing), center));
  assert.ok(onTerraple && angularDiff(onTerraple.b, north.bearing) <= SNAP.courseTol, 'the Terraplè course still lands on Terraplè');
  assert.notEqual(west, onTerraple);
});

test('snapToLane: a fix more than 5 m from every lane running your way stays raw', () => {
  const course = north.bearing, runs = (ln) => ln.k === 'drive' && ln.b != null && angularDiff(ln.b, course) <= SNAP.courseTol;
  const nearest = (p) => Math.min(...l0.lanes.filter(runs).map((ln) => ringDist(ring(ln), p.e, p.n)));
  const inInt = (p) => l0.ints.some((r) => ringDist(r.map((v) => v / 100), p.e, p.n) === 0);
  let n = 0;
  for (let de = -40; de <= 40; de += 2) for (let dn = -40; dn <= 40; dn += 2) {
    const p = { e: vtE.e + de, n: vtE.n + dn }, d = nearest(p);
    if (inInt(p) || d <= SNAP.maxM || d > 12) continue; // a lane would have caught it at the old 15 m reach, not at 5 m
    n++; const raw = ll(p.e, p.n);
    assert.equal(snapToLane(streets, raw, course), raw, `fix ${d.toFixed(1)} m from the nearest matching lane was snapped`);
  }
  assert.ok(n > 10, `only ${n} fixes tested`);
});
