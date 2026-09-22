import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBundles, newer } from '../src/sync/merge.js';

const ix = (id, rev, updatedAt, extra = {}) => ({ id, name: id, rev, updatedAt, ...extra });
const ob = (id, t) => ({ id, intersectionId: 'x', headId: 'h', aspect: 'green', t });

test('newer picks higher rev, then newer updatedAt', () => {
  assert.equal(newer(ix('a', 2, 100), ix('a', 1, 999)).rev, 2);
  assert.equal(newer(ix('a', 1, 100), ix('a', 1, 200)).updatedAt, 200);
});

test('observations union — nothing lost, oldest survives', () => {
  const local = { intersections: [], observations: [ob('o1', 10), ob('o2', 20)] };
  const remote = { intersections: [], observations: [ob('o2', 20), ob('o3', 5)] };
  const { merged, stats } = mergeBundles(local, remote);
  assert.deepEqual(merged.observations.map((o) => o.id).sort(), ['o1', 'o2', 'o3']);
  assert.equal(stats.obsAdded, 1);
  assert.ok(merged.observations.find((o) => o.id === 'o3').t === 5); // oldest kept
});

test('intersection: newer rev wins, missing ones are added', () => {
  const local = { intersections: [ix('a', 1, 100, { name: 'old' })], observations: [] };
  const remote = { intersections: [ix('a', 2, 90, { name: 'new' }), ix('b', 1, 1)], observations: [] };
  const { merged, stats } = mergeBundles(local, remote);
  const a = merged.intersections.find((i) => i.id === 'a');
  assert.equal(a.name, 'new'); // rev 2 beats rev 1 even with older updatedAt
  assert.ok(merged.intersections.find((i) => i.id === 'b'));
  assert.equal(stats.ixAdded, 1);
  assert.equal(stats.ixUpdated, 1);
});

test('a newer tombstone deletes; an older one does not resurrect-block', () => {
  const local = { intersections: [ix('a', 3, 300)], observations: [] };
  const remoteDeletes = { intersections: [], observations: [], tombstones: [{ id: 'a', rev: 4, deletedAt: 400 }] };
  assert.ok(!mergeBundles(local, remoteDeletes).merged.intersections.find((i) => i.id === 'a'));

  const staleDelete = { intersections: [], observations: [], tombstones: [{ id: 'a', rev: 1, deletedAt: 50 }] };
  assert.ok(mergeBundles(local, staleDelete).merged.intersections.find((i) => i.id === 'a')); // edit newer -> kept
});

test('merge is symmetric — both sides converge', () => {
  const A = { intersections: [ix('a', 2, 200), ix('b', 1, 10)], observations: [ob('o1', 1)] };
  const B = { intersections: [ix('a', 1, 999), ix('c', 1, 5)], observations: [ob('o2', 2)] };
  const m1 = mergeBundles(A, B).merged;
  const m2 = mergeBundles(B, A).merged;
  const key = (m) => ({ ix: m.intersections.map((i) => `${i.id}:${i.rev}`).sort(), obs: m.observations.map((o) => o.id).sort() });
  assert.deepEqual(key(m1), key(m2));
  assert.equal(key(m1).ix.length, 3); // a,b,c
});

test('an undone tap (obs tombstone) is removed on the other side and never comes back', () => {
  const tap = { id: 'o9', intersectionId: 'a', headId: 'h', aspect: 'red', t: 5 };
  const phone = { intersections: [], observations: [tap], tombstones: [] };            // still has it
  const car = { intersections: [], observations: [], tombstones: [{ id: 'o9', kind: 'obs', deletedAt: 9 }] }; // undid it
  const onPhone = mergeBundles(phone, car);
  assert.equal(onPhone.merged.observations.length, 0);
  assert.equal(onPhone.stats.obsRemoved, 1);
  const onCar = mergeBundles(car, phone);                                               // phone's copy can't resurrect it
  assert.equal(onCar.merged.observations.length, 0);
  assert.equal(onCar.stats.obsAdded, 0);
  // an obs tombstone never deletes an intersection that happens to share nothing with it
  const withIx = mergeBundles({ intersections: [{ id: 'a', rev: 1 }], observations: [], tombstones: [] }, car);
  assert.equal(withIx.merged.intersections.length, 1);
});
