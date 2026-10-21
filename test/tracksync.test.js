// Sync of the track + dismissal records, and of an accepted re-file (new obs + tombstone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBundles } from '../src/sync/merge.js';
import { sealBundle, openBundle, deriveKey, makeRoomCode } from '../src/sync/net.js';
import { SCENARIOS, run, ixs, set, center } from './trackscen.js';
import { pendingSuggestions, refileOf } from '../src/osm/suggest.js';
import { decodeTrack } from '../src/nav/trackrec.js';

const ob = (id, t = 1, extra = {}) => ({ id, intersectionId: 'x', headId: 'h', aspect: 'green', kind: 'onset', t, ...extra });
const trk = (obsIds, extra = {}) => ({ id: `trk_${obsIds[0]}`, obsIds, t0: 1000, v: 1, p: [0, 1, 1, -1, -1, -1, 10, 1, 1, -1, -1, -1], ...extra });
const dis = (obsId) => ({ id: `dis_${obsId}`, obsId, at: 5 });
const B = (o) => ({ intersections: [], observations: [], tombstones: [], tracks: [], dismissals: [], ...o });

test('tracks and dismissals survive a merge round-trip in both directions', () => {
  const a = B({ observations: [ob('o1')], tracks: [trk(['o1'])], dismissals: [dis('o1')] });
  const b = B({ observations: [ob('o2')], tracks: [trk(['o2'], { p: [0, 5, 5, -1, -1, -1] })] });
  const ab = mergeBundles(a, b), ba = mergeBundles(b, a);
  for (const { merged } of [ab, ba]) {
    assert.deepEqual(merged.tracks.map((r) => r.id).sort(), ['trk_o1', 'trk_o2']);
    assert.deepEqual(merged.dismissals.map((d) => d.id), ['dis_o1']);
  }
  assert.equal(ab.stats.trkAdded, 1); assert.equal(ab.stats.disAdded, 0);
  assert.equal(ba.stats.trkAdded, 1); assert.equal(ba.stats.disAdded, 1);
  // idempotent: merging the merged result again changes nothing
  const again = mergeBundles(ab.merged, ba.merged);
  assert.equal(again.stats.trkAdded + again.stats.disAdded + again.stats.obsAdded, 0);
});

test('records are immutable: a track present on both sides is not overwritten', () => {
  const mine = trk(['o1']), theirs = trk(['o1'], { p: [0, 9, 9, -1, -1, -1] });
  assert.deepEqual(mergeBundles(B({ tracks: [mine], observations: [ob('o1')] }), B({ tracks: [theirs], observations: [ob('o1')] })).merged.tracks, [mine]);
});

test('an old bundle without tracks / dismissals merges fine, both ways, and keeps ours', () => {
  const old = { intersections: [], observations: [ob('o9')], tombstones: [] }; // what an old client sends
  const mine = B({ observations: [ob('o1')], tracks: [trk(['o1'])], dismissals: [dis('o1')] });
  const m1 = mergeBundles(mine, old), m2 = mergeBundles(old, mine);
  assert.equal(m1.merged.tracks.length, 1); assert.equal(m1.merged.dismissals.length, 1);
  assert.equal(m2.merged.tracks.length, 1); assert.equal(m2.merged.dismissals.length, 1);
  assert.deepEqual(m1.merged.observations.map((o) => o.id).sort(), ['o1', 'o9']);
  const none = mergeBundles({ intersections: [], observations: [] }, { intersections: [], observations: [] }).merged; // neither side knows them
  assert.deepEqual([none.tracks, none.dismissals], [[], []]);
  // and a new client's bundle given to an old client's merge: extra fields are simply not looked at
  assert.doesNotThrow(() => mergeBundles(old, mine));
});

test('a track whose taps are all undone / re-filed is dropped; one with a tap left stays', () => {
  const tomb = { id: 'o1', kind: 'obs', deletedAt: 9 };
  const m = mergeBundles(B({ observations: [ob('o1'), ob('o2'), ob('o3')], tracks: [trk(['o1']), trk(['o2', 'o3'])] }), B({ tombstones: [tomb, { id: 'o2', kind: 'obs', deletedAt: 9 }] })).merged;
  assert.deepEqual(m.tracks.map((r) => r.id), ['trk_o2'], 'o3 is still alive');
  assert.ok(!mergeBundles(B({}), B({ tracks: [trk(['o1'])], tombstones: [tomb] })).merged.tracks.length, 'a tombstoned tap\'s track does not come in either');
});

test('sealed bundles carry tracks + dismissals through the encrypted relay format', async () => {
  const key = await deriveKey(makeRoomCode());
  const b = B({ observations: [ob('o1')], tracks: [trk(['o1'])], dismissals: [dis('o1')] });
  assert.deepEqual(await openBundle(await sealBundle(b, key), key), b);
});

// ---- the whole loop on two devices, with a real suggestion ----
const sc = SCENARIOS.find((s) => s.id === 'vt-turn-tapStraight');
function scenario() {
  const r = run(sc, { sigma: 3, seed: 4 });
  const tap = { ...r.tap, where: { lat: 41.4144, lon: 2.0132 }, heading: 261 };
  return { tap, rec: r.rec };
}
const ctx = () => ({ set, center, intersections: ixs });

test('the suggestion is recomputed on the peer from the synced track + tap; accepting there syncs back as new obs + tombstone', () => {
  const { tap, rec } = scenario();
  // the car recorded the tap and its track; the phone has neither yet
  const car = B({ intersections: ixs, observations: [tap], tracks: [rec] }), phone = B({ intersections: ixs });
  const phoneNow = mergeBundles(phone, car).merged;
  const sugg = (bundle, dismissed = []) => pendingSuggestions({ obs: bundle.observations, tracks: bundle.tracks, dismissed, contextOf: () => ctx() });
  const s1 = sugg(phoneNow);
  assert.equal(s1.length, 1);
  assert.equal(s1[0].toHeadId, sc.expect);
  // accept on the phone
  const { newObs, tombstone } = refileOf(phoneNow.observations[0], s1[0], 1234);
  assert.equal(newObs.id, `${tap.id}_rf`); assert.equal(newObs.headId, sc.expect); assert.equal(newObs.intersectionId, s1[0].toIxId);
  assert.deepEqual(newObs.refiledFrom, { intersectionId: tap.intersectionId, headId: tap.headId });
  assert.equal(newObs.t, tap.t); assert.deepEqual(newObs.where, tap.where); assert.equal(newObs.aspect, tap.aspect);
  assert.deepEqual(tombstone, { id: tap.id, kind: 'obs', deletedAt: 1234 });
  const phoneAfter = { ...phoneNow, observations: [newObs], tombstones: [...phoneNow.tombstones, tombstone] };
  // the car merges the phone's bundle: old id gone, new one in, the old track dropped, nothing left to suggest
  const carNow = mergeBundles(car, phoneAfter);
  assert.deepEqual(carNow.merged.observations.map((o) => o.id), [`${tap.id}_rf`]);
  assert.equal(carNow.stats.obsRemoved, 1); assert.equal(carNow.stats.obsAdded, 1);
  assert.deepEqual(carNow.merged.tracks, []);
  assert.deepEqual(sugg(carNow.merged), []);
  // ... and the other way round gives the same result (convergence)
  const phoneBack = mergeBundles(phoneAfter, car).merged;
  assert.deepEqual(phoneBack.observations.map((o) => o.id), [`${tap.id}_rf`]);
  assert.deepEqual(phoneBack.tombstones.map((t) => t.id), [tap.id]);
});

test('a dismissal syncs: the other device stops suggesting it', () => {
  const { tap, rec } = scenario();
  const car = B({ intersections: ixs, observations: [tap], tracks: [rec] });
  const phone = B({ intersections: ixs, observations: [tap], tracks: [rec], dismissals: [dis(tap.id)] });
  const merged = mergeBundles(car, phone).merged;
  assert.equal(merged.dismissals.length, 1);
  const list = (b) => pendingSuggestions({ obs: b.observations, tracks: b.tracks, dismissed: b.dismissals.map((d) => d.obsId), contextOf: () => ctx() });
  assert.equal(list(car).length, 1, 'before: pending on the car');
  assert.equal(list(merged).length, 0, 'after: dismissed everywhere');
});

test('a re-filed tap (_rf) is not suggested again, and a decoded record is the track the matcher saw', () => {
  const { tap, rec } = scenario();
  const { newObs } = refileOf(tap, { toIxId: tap.intersectionId, toHeadId: sc.expect });
  assert.deepEqual(pendingSuggestions({ obs: [newObs], tracks: [rec], contextOf: () => ctx() }), [], 'the new id has no track; its refiledFrom blocks it anyway');
  assert.equal(decodeTrack(rec).length, rec.p.length / 6);
  assert.ok(JSON.stringify(rec).length < 4500, `${JSON.stringify(rec).length} bytes`);
});
