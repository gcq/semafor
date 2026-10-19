import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approachCandidates, pickHead, nextApproachAhead, ringDist, PICK } from '../src/osm/approaches.js';
import { pickIntersection } from '../src/nav/proximity.js';

const C = { lat: 41.4, lon: 2.0 };
const LAT = 6371000 * Math.PI / 180;
const ll = (e, n) => ({ lat: C.lat + n / LAT, lon: C.lon + e / (LAT * Math.cos(C.lat * Math.PI / 180)) });
const mast = (id, e, n) => ({ id, pos: ll(e, n), headIds: [`h_${id}`] });
const ixAt = (id, e, n, masts) => ({ id, location: ll(e, n), masts });
// lane rectangle (4 m wide) from `back` m before the stop point to it, heading north, in cm
const lane = (x, y, back = 140, a) => ({ k: 'drive', a, r: [x - 2, y - back, x + 2, y - back, x + 2, y, x - 2, y].map((v) => Math.round(v * 100)) });
// entry with approaches [x, y, bearing=0] (one lane each, stop point (x, y))
const entry = (apprs) => ({
  kind: 'lanes', center: C,
  data: { layers: [{ z: 0, lanes: apprs.map(([x, y], a) => lane(x, y, 140, a)), appr: apprs.map(([x, y, b = 0], a) => [x * 100, y * 100, b, 1000 + a]) }] },
});
// junction X at (10, 0): two parallel one-way roads 20 m apart arrive from the south, stop points at n = -10
const X = ixAt('X', 10, 0, [mast('mA', -3, -12), mast('mB', 23, -12)]);
const streets = entry([[0, -10], [20, -10]]);
const set = approachCandidates(streets, [X]);
let fix = 0;
const step = (prev, e, n, course = 0, ixId = 'X', s = set) => pickHead({ set: s, ixId, ego: { e, n }, course, prev, fixId: ++fix });

test('two parallel approaches 20 m apart: ego on each picks its own mast', () => {
  assert.equal(set.cands.length, 2);
  const a = step(null, 0.5, -60), b = step(null, 19.5, -60);
  assert.deepEqual([a.headId, a.reason], ['h_mA', 'lane']);
  assert.deepEqual([b.headId, b.reason], ['h_mB', 'lane']);
  // between the roads (not inside either lane) the nearer one wins
  assert.equal(step(null, 6, -60).headId, 'h_mA');
  assert.equal(step(null, 14, -60).headId, 'h_mB');
});

test('one noisy fix towards the other road does not flip the head; two consecutive fixes do', () => {
  let s = step(null, 0, -80);
  s = step(s, 0.2, -70); assert.equal(s.headId, 'h_mA');
  s = step(s, 15, -60); assert.equal(s.headId, 'h_mA'); // lanes: A 13 m away, B 13 m... inside? B is 5 m away -> strike 1
  s = step(s, 0.3, -50); assert.equal(s.headId, 'h_mA'); // back: strike reset
  s = step(s, 15, -40); assert.equal(s.headId, 'h_mA');
  s = step(s, 15.5, -30); assert.equal(s.headId, 'h_mB'); // really changed lane/road
});

test('no fix yet (fixId undefined) and no previous state: bearing fallback, no throw', () => {
  assert.equal(pickHead({ set, ixId: 'X', ego: null, course: null, prev: null, fixId: undefined }).reason, 'bearing');
});

test('same fix id is idempotent', () => {
  const s = step(null, 0, -60);
  assert.equal(pickHead({ set, ixId: 'X', ego: { e: 20, n: -60 }, course: 0, prev: s, fixId: s.fixId }), s);
});

test('latch: frozen near the stop line, then passed once crossed', () => {
  let s = step(null, 0, -40);
  assert.equal(s.reason, 'lane');
  s = step(s, 0, -25); assert.equal(s.reason, 'lane');
  s = step(s, 14, -9); // 9 m before the line, GPS jumps toward B: no re-pick
  assert.deepEqual([s.headId, s.reason], ['h_mA', 'latched']);
  s = step(s, 20, -9.5); assert.deepEqual([s.headId, s.reason], ['h_mA', 'latched']);
  s = step(s, 0, 1); // crossed A's stop line (past by 11 m)
  assert.deepEqual([s.headId, s.reason, s.nextIxId], ['h_mA', 'passed', null]); // nothing ahead: keep, no flicker
  s = step(s, 20, 3); assert.deepEqual([s.headId, s.reason], ['h_mA', 'passed']); // and no re-pick from the junction box
});

test('passed: far past the junction the head stays until a real approach takes over', () => {
  let s = step(null, 0, -40);
  s = step(s, 0, -9); s = step(s, 0, 1);
  assert.equal(s.reason, 'passed');
  s = step(s, 0, 90); // > 60 m past the centre, no approach anywhere near: no fall back to bearings
  assert.deepEqual([s.headId, s.reason], ['h_mA', 'passed']);
  s = step(s, 20, -60, 0); // driving there again, now on the other road
  assert.deepEqual([s.headId, s.reason], ['h_mB', 'lane']);
});

test('crossing hands over to the next approach ahead: same junction -> its head, other junction -> nextIxId', () => {
  // X has a second stop line 20 m beyond the first; junction Y 85 m further
  const Y = ixAt('Y', 0, 110, [mast('mY', -3, 98)]);
  const x2 = ixAt('X', 10, 25, [mast('mA', -3, -7), mast('mB', 23, -7), mast('mA2', -3, 13)]);
  const s2 = approachCandidates(entry([[0, -5], [20, -5], [0, 15], [0, 100]]), [x2, Y]);
  const go = (p, n) => step(p, 0, n, 0, 'X', s2);
  let s = go(null, -30);
  assert.equal(s.headId, 'h_mA');
  s = go(s, 0); // 5 m past the first line; next ahead: X's second line, 15 m on
  assert.deepEqual([s.headId, s.reason], ['h_mA2', 'lane']);
  s = go(s, 8); assert.deepEqual([s.headId, s.reason], ['h_mA2', 'latched']);
  s = go(s, 20); // crossed the second line: the next approach ahead is Y's (80 m on)
  assert.deepEqual([s.headId, s.reason, s.nextIxId], ['h_mA2', 'passed', 'Y']);
  assert.equal(go(null, 40).headId, null); // joined late: both X lines already behind -> bearing fallback
});

test('fallbacks: no data, no course, nobody within 20 m, or only approaches already crossed', () => {
  assert.equal(pickHead({ set: null, ixId: 'X', ego: { e: 0, n: -60 }, course: 0, prev: null, fixId: 1 }).reason, 'bearing');
  assert.equal(approachCandidates({ kind: 'plain', center: C, data: { ways: [] } }, [X]), null);
  assert.equal(step(null, 0, -60, null).headId, null);
  const far = step(null, 60, -60); assert.deepEqual([far.reason, far.headId], ['bearing', null]);
  assert.equal(step(null, 0, -60, 90).reason, 'bearing'); // travelling east: neither approach points that way
  assert.equal(step(null, 0, 5).reason, 'bearing'); // already past both stop lines
});

test('nextApproachAhead: nearest ahead within the lateral limit; not behind, not skipped', () => {
  // one junction per approach, 5 m / 15 m beyond its stop point; (0,-40) is behind, (25,20) too far to the side
  const apprs = [[0, 10], [25, 20], [0, 150], [0, -40]];
  const ixs = apprs.map(([x, y], i) => ixAt(`I${i}`, x + 5, y + 15, [mast(`m${i}`, x - 3, y - 2)]));
  const s = approachCandidates(entry(apprs), ixs);
  assert.equal(s.cands.length, 4);
  const at = (e, n, skip) => nextApproachAhead(s, { e, n }, 0, skip)?.headId ?? null;
  assert.equal(at(0, 0), 'h_m0');
  assert.equal(at(0, 0, s.cands[0].key), null); // (25,20) is 25 m to the side, (0,150) 150 m away
  assert.equal(at(0, 12), null); // everything left is behind, too far or to the side
  assert.equal(at(22, 0), 'h_m1');
  assert.equal(nextApproachAhead(null, { e: 0, n: 0 }, 0), null);
});

test('ringDist: inside 0, outside perpendicular distance', () => {
  const sq = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.equal(ringDist(sq, 5, 5), 0);
  assert.equal(ringDist(sq, 13, 5), 3);
  assert.ok(Math.abs(ringDist(sq, 13, 14) - 5) < 1e-9);
});

// ---- pickIntersection: passed junction ----
const A = { id: 'A', location: ll(0, 0) }, B = { id: 'B', location: ll(0, 60) };
const ranked = (...xs) => xs.map((intersection) => ({ intersection }));
test('pickIntersection: a passed junction is skipped while another is ahead, kept when none is', () => {
  const base = { intersections: [A, B], pos: ll(0, 3), lastId: 'A', moving: true };
  assert.equal(pickIntersection({ ...base, ranked: ranked(A, B) }).id, 'A'); // v43 behaviour without a pass
  assert.equal(pickIntersection({ ...base, ranked: ranked(A, B), passedId: 'A' }).id, 'B');
  assert.equal(pickIntersection({ ...base, ranked: ranked(A), passedId: 'A' }).id, 'A'); // nothing else ahead
  assert.equal(pickIntersection({ ...base, ranked: [], passedId: 'A' }).id, 'A');
  assert.equal(pickIntersection({ ...base, ranked: ranked(A, B), passedId: 'A', moving: false }).id, 'A'); // stationary: ignore
});

test('PICK constants are what the docs say', () => assert.deepEqual([PICK.courseTol, PICK.maxDist, PICK.switchFixes], [45, 20, 2]));
