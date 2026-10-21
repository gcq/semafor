import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder, encodeTrack, decodeTrack, TRACK } from '../src/nav/trackrec.js';
import { distanceM } from '../src/nav/proximity.js';

const J = { id: 'ixA', lat: 41.4, lon: 2.0 }, K = { id: 'ixB', lat: 41.4009, lon: 2.0 }; // K: 100 m north of J
const M = 111195; // metres per degree of latitude
const T0 = 1_800_000_000_000;
// a fix `north` metres north of J, `sec` seconds after T0
const fx = (sec, north, extra = {}) => ({ t: T0 + sec * 1000, lat: J.lat + north / M, lon: J.lon, heading: 0, speed: 10, acc: 5, ...extra });
const rec = (junctions = [J]) => {
  const done = [];
  const r = createRecorder({ junctions: () => junctions, onDone: (t, why) => done.push({ t, why }) });
  return { r, done };
};
const drive = (r, fromS, toS, northAt) => { for (let s = fromS; s <= toS; s++) r.fix(fx(s, northAt(s))); };

test('encode/decode: a 1 Hz track round-trips to 1e-6° / 0.1 s / 1° / 0.1 m/s and stays small', () => {
  const fixes = Array.from({ length: 120 }, (_, i) => ({ t: T0 + i * 1000 + (i % 3) * 7, lat: 41.4 + i * 9e-5 + 1.23456789e-7, lon: 2 + i * 3e-5, heading: i % 360, speed: i / 7, acc: 4 + (i % 5) }));
  const r = encodeTrack(['obs_a', 'obs_b'], fixes);
  assert.equal(r.id, 'trk_obs_a');
  assert.deepEqual(r.obsIds, ['obs_a', 'obs_b']);
  const back = decodeTrack(r);
  assert.equal(back.length, 120);
  back.forEach((b, i) => {
    assert.ok(Math.abs(b.lat - fixes[i].lat) < 1e-6 && Math.abs(b.lon - fixes[i].lon) < 1e-6);
    assert.ok(Math.abs(b.t - fixes[i].t) <= 100, `t drifted at ${i}`);
    assert.equal(b.heading, fixes[i].heading); assert.ok(Math.abs(b.speed - fixes[i].speed) <= 0.05); assert.equal(b.acc, fixes[i].acc);
  });
  assert.ok(JSON.stringify(r).length < 120 * 32, `${JSON.stringify(r).length} bytes for 120 fixes`);
});

test('encode: unknown heading/speed/accuracy survive as null; track length is capped', () => {
  const r = encodeTrack(['o'], [{ t: T0, lat: 41.4, lon: 2 }, { t: T0 + 1000, lat: 41.4001, lon: 2, heading: null, speed: null, acc: null }]);
  assert.deepEqual(decodeTrack(r).map((f) => [f.heading, f.speed, f.acc]), [[null, null, null], [null, null, null]]);
  assert.equal(decodeTrack(encodeTrack(['o'], Array.from({ length: TRACK.maxFixes + 50 }, (_, i) => fx(i, i)))).length, TRACK.maxFixes);
});

test('a tap opens a track from 30 s before it and closes it once the junction is 85 m behind', () => {
  const { r, done } = rec();
  drive(r, -50, 0, (s) => s * 10);              // approach: 500 m out ... at J at s=0
  r.tap({ id: 'obs_1', t: T0 + 0, intersectionId: 'ixA' });
  drive(r, 1, 7, (s) => s * 10);                // 70 m past: not yet
  assert.equal(done.length, 0);
  assert.deepEqual(r.pending, { obsIds: ['obs_1'], fixes: 31 + 7 });
  drive(r, 8, 12, (s) => s * 10);               // 85 m past
  assert.equal(done.length, 1);
  assert.equal(done[0].why, 'cleared');
  const t = decodeTrack(done[0].t);
  assert.equal(t[0].t, T0 - 30000);
  assert.ok(distanceM(t.at(-1), J) >= TRACK.clearM && distanceM(t.at(-1), J) < TRACK.clearM + 12);
  assert.equal(r.pending, null);
});

test('taps at the same stop share one track (by tap id list)', () => {
  const { r, done } = rec();
  drive(r, -40, -5, (s) => s * 10);
  r.tap({ id: 'obs_1', t: T0 - 5000, intersectionId: 'ixA' });
  r.fix(fx(-4, -40)); r.fix(fx(-3, -30));
  r.tap({ id: 'obs_2', t: T0 - 3000, intersectionId: 'ixA' });
  drive(r, -2, 14, (s) => s * 10);
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].t.obsIds, ['obs_1', 'obs_2']);
  assert.equal(done[0].t.id, 'trk_obs_1');
});

test('a long red: the track keeps recording while you wait, up to the 6 min cap', () => {
  const { r, done } = rec();
  drive(r, -30, 0, (s) => -3 + s * 3); // creeping up to 3 m short of the junction, then standing there
  r.tap({ id: 'obs_1', t: T0, intersectionId: 'ixA' });
  for (let s = 1; s < 340; s++) r.fix(fx(s, -3, { speed: 0 }));
  assert.equal(done.length, 0, 'still waiting at the light');
  for (let s = 340; s <= 361; s++) r.fix(fx(s, -3, { speed: 0 }));
  assert.equal(done.length, 1); assert.equal(done[0].why, 'cap');
  assert.ok(decodeTrack(done[0].t).length <= TRACK.maxFixes);
});

test('the cap also fires from poll() when GPS goes quiet', () => {
  const { r, done } = rec();
  drive(r, -10, 0, (s) => s * 10);
  r.tap({ id: 'obs_1', t: T0, intersectionId: 'ixA' });
  r.poll(T0 + TRACK.capMs - 1000); assert.equal(done.length, 0);
  r.poll(T0 + TRACK.capMs); assert.equal(done.length, 1);
});

test('app hidden / closed: flush() saves what there is; nothing pending = nothing saved', () => {
  const { r, done } = rec();
  r.flush(); assert.equal(done.length, 0);
  drive(r, -10, 0, (s) => s * 10);
  r.tap({ id: 'obs_1', t: T0, intersectionId: 'ixA' });
  r.fix(fx(1, 10));
  r.flush();
  assert.equal(done.length, 1); assert.equal(done[0].why, 'hidden');
  assert.equal(decodeTrack(done[0].t).length, 12);
  r.flush(); assert.equal(done.length, 1);
});

test('a junction passed within 40 m extends the track until it is cleared too', () => {
  const { r, done } = rec([J, K]);
  drive(r, -20, 0, (s) => s * 10);              // J at s=0; K at 100 m (s=10) is 100 m ahead
  r.tap({ id: 'obs_1', t: T0, intersectionId: 'ixA' });
  drive(r, 1, 18, (s) => s * 10);               // 80 m past K ... K cleared only at 85 m (s=18.5)
  assert.equal(done.length, 0, 'J is cleared but K was passed within 40 m');
  drive(r, 19, 20, (s) => s * 10);
  assert.equal(done.length, 1); assert.equal(done[0].why, 'cleared');
});

test('a tap far from every junction closes after 20 s (nothing to clear)', () => {
  const { r, done } = rec();
  for (let s = -30; s <= 0; s++) r.fix(fx(s, 2000 + s * 10));
  r.tap({ id: 'obs_1', t: T0, intersectionId: 'ixA' });
  for (let s = 1; s <= 25; s++) r.fix(fx(s, 2000 + s * 10));
  assert.equal(done.length, 1); assert.equal(done[0].why, 'far');
});

test('fixes are kept at ~1 Hz (faster ones dropped), garbage is ignored, and the ring is 60 s deep', () => {
  const { r, done } = rec();
  for (let i = 0; i < 400; i++) r.fix({ ...fx(0, 0), t: T0 + i * 250, lat: J.lat + i * 1e-5 }); // 4 Hz for 100 s
  r.fix({ t: NaN, lat: 1, lon: 1 }); r.fix(null); r.fix({ t: T0, lat: 'x', lon: 1 });
  r.tap({ id: 'obs_1', t: T0 + 99750, intersectionId: 'ixA' });
  const p = r.pending.fixes;
  assert.ok(p >= 28 && p <= 31, `${p} fixes in the 30 s before the tap`);
  r.flush();
  const t = decodeTrack(done[0].t);
  assert.ok(t.every((f, i) => !i || f.t - t[i - 1].t >= 900));
});

test('the tap is never touched: the recorder only reads taps', () => {
  const { r } = rec();
  const tap = Object.freeze({ id: 'obs_1', t: T0, intersectionId: 'ixA' });
  assert.doesNotThrow(() => r.tap(tap));
});
