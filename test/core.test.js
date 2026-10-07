import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rankNext, distanceM, angularDiff, headForApproach } from '../src/nav/proximity.js';
import { makeIntersection } from '../src/domain/model.js';

test('rankNext prefers soonest ETA inside the forward cone', () => {
  const pos = { lat: 0, lon: 0 };
  // heading due north (0deg). Two ahead, one behind.
  const ixs = [
    { id: 'behind', location: { lat: -0.01, lon: 0 } },
    { id: 'far-ahead', location: { lat: 0.02, lon: 0 } },
    { id: 'near-ahead', location: { lat: 0.005, lon: 0 } },
  ];
  const ranked = rankNext(pos, 0, 15, ixs);
  assert.equal(ranked[0].intersection.id, 'near-ahead');
  assert.ok(!ranked.find((r) => r.intersection.id === 'behind')); // cone excludes it
  assert.ok(ranked[0].etaSec > 0);
});

test('rankNext falls back to nearest when stationary', () => {
  const pos = { lat: 0, lon: 0 };
  const ixs = [
    { id: 'a', location: { lat: 0.02, lon: 0 } },
    { id: 'b', location: { lat: -0.001, lon: 0 } },
  ];
  const ranked = rankNext(pos, null, 0, ixs);
  assert.equal(ranked[0].intersection.id, 'b'); // nearest regardless of direction
});

test('geo helpers are sane', () => {
  assert.ok(Math.abs(distanceM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111195) < 500);
  assert.equal(angularDiff(350, 10), 20);
});

test('headForApproach picks the near-side mast facing the approach (Spain)', () => {
  const c = { lat: 41.4143, lon: 2.0121 };
  const d = 0.0002; // ~20 m
  const ix = { location: c, masts: [
    { id: 'mS', pos: { lat: c.lat - d, lon: c.lon }, headIds: ['hNorthbound'] }, // south side
    { id: 'mN', pos: { lat: c.lat + d, lon: c.lon }, headIds: ['hSouthbound'] },
    { id: 'mW', pos: { lat: c.lat, lon: c.lon - d }, headIds: ['hEastbound'] },
  ] };
  assert.equal(headForApproach(ix, 0), 'hNorthbound');   // driving north -> mast on the south side
  assert.equal(headForApproach(ix, 180), 'hSouthbound');
  assert.equal(headForApproach(ix, 95), 'hEastbound');
  assert.equal(headForApproach(ix, 270), null);          // nothing on the east side within tolerance
  assert.equal(headForApproach(ix, null), null);
});

test('makeIntersection carries structure only (no derived timing fields)', () => {
  const ix = makeIntersection({ name: 'X', plans: [{ id: 'old' }] });
  assert.equal(ix.name, 'X');
  assert.ok(!('plans' in ix));
});
