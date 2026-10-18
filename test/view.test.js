import { test } from 'node:test';
import assert from 'node:assert/strict';

import { viewBearing, pickIntersection, rankNext } from '../src/nav/proximity.js';

const pos = { lat: 41.4143, lon: 2.0121 };
const target = { lat: 41.4153, lon: 2.0121 }; // due north of pos

test('viewBearing: live course while moving, even past the junction', () => {
  assert.equal(viewBearing({ heading: 335, headingFrozen: 10, speed: 8, pos, target }), 335);
  // junction behind you (target south): still the course, not the bearing to it
  assert.equal(viewBearing({ heading: 335, headingFrozen: 335, speed: 8, pos: target, target: pos }), 335);
});

test('viewBearing: frozen course when slow or course null', () => {
  assert.equal(viewBearing({ heading: 200, headingFrozen: 335, speed: 0.5, pos, target }), 335);
  assert.equal(viewBearing({ heading: null, headingFrozen: 335, speed: 0, pos, target }), 335);
});

test('viewBearing: bearing to centre only when no course was ever known', () => {
  assert.ok(Math.abs(viewBearing({ heading: null, headingFrozen: null, speed: 0, pos, target })) < 1e-6);
  assert.equal(viewBearing({ heading: null, headingFrozen: null, speed: 0, pos: null, target }), null);
});

const A = { id: 'A', location: { lat: 41.4143, lon: 2.0121 } };
const B = { id: 'B', location: { lat: 41.4100, lon: 2.0121 } }; // ~480 m south
const ixs = [B, A];
const at = (lat) => ({ lat, lon: 2.0121 });
const run = (p, heading, lastId) => {
  const speed = 10;
  const ranked = rankNext(p, heading, speed, ixs);
  return pickIntersection({ ranked, intersections: ixs, pos: p, lastId, moving: true })?.id;
};

test('pickIntersection: ranked[0] wins; after passing, keep the last one within 300 m', () => {
  assert.equal(run(at(41.4130), 0, null), 'A'); // A ahead
  assert.equal(run(at(41.4160), 0, 'A'), 'A'); // passed A (~190 m), nothing ahead: keep A
});

test('pickIntersection: beyond 300 m falls back to the nearest, not ixs[0]', () => {
  assert.equal(run(at(41.4190), 0, 'A'), 'A'); // 400+ m past A, A still nearest
  assert.equal(run(at(41.4105), 180, 'B'), 'B');
  // far past A with B nearer and last=A -> nearest (B is behind A by 480 m; here pos near B, heading away north)
  assert.equal(run(at(41.4097), 180, 'A'), 'B');
});

test('pickIntersection: stationary and no-position cases', () => {
  const ranked = rankNext(at(41.4142), null, 0, ixs);
  assert.equal(pickIntersection({ ranked, intersections: ixs, pos: at(41.4142), lastId: null, moving: false }).id, 'A');
  assert.equal(pickIntersection({ ranked: [], intersections: ixs, pos: null, lastId: null, moving: false }).id, 'B');
  assert.equal(pickIntersection({ ranked: [], intersections: [], pos: null, lastId: null, moving: false }), null);
});
