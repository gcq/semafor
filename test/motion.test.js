import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deadReckon, offsetBetween, decayOffset, applyOffset, easeAngle } from '../src/nav/motion.js';
import { distanceM, bearingDeg } from '../src/nav/proximity.js';

const fix = { lat: 41.4, lon: 2.0, speed: 10, course: 335, t: 1000 };

test('deadReckon moves along the course at speed, capped at 1.5 s', () => {
  const p = deadReckon(fix, 1500);
  assert.ok(Math.abs(distanceM(fix, p) - 5) < 0.05);
  assert.ok(Math.abs(bearingDeg(fix, p) - 335) < 0.1);
  assert.ok(Math.abs(distanceM(fix, deadReckon(fix, 9000)) - 15) < 0.1); // capped
  assert.deepEqual(deadReckon(fix, 500), { lat: fix.lat, lon: fix.lon }); // clock before the fix: no backwards
});

test('deadReckon holds when stopped, course unknown or no fix', () => {
  assert.deepEqual(deadReckon({ ...fix, speed: 0.2 }, 2000), { lat: 41.4, lon: 2.0 });
  assert.deepEqual(deadReckon({ ...fix, course: null }, 2000), { lat: 41.4, lon: 2.0 });
  assert.equal(deadReckon(null, 0), null);
});

test('blend offset: starts at the old displayed point, decays to the target without overshoot', () => {
  const target = { lat: 41.4, lon: 2.0 }, shown = { lat: 41.4001, lon: 2.0002 };
  let off = offsetBetween(shown, target);
  assert.deepEqual(applyOffset(target, off), shown);
  const a = decayOffset(off, 0.15, 0.15), b = decayOffset(a, 0.45, 0.15);
  assert.ok(Math.abs(a.dlat) < Math.abs(off.dlat) && Math.abs(b.dlat) < Math.abs(a.dlat));
  assert.ok(Math.sign(b.dlat) === Math.sign(off.dlat)); // monotonic, same side
  assert.ok(Math.abs(b.dlat) < Math.abs(off.dlat) * 0.03);
});

test('easeAngle takes the shortest arc and converges', () => {
  assert.ok(easeAngle(350, 10, 0.1) > 350 || easeAngle(350, 10, 0.1) < 10); // via 0, not via 180
  const next = easeAngle(350, 10, 0.5);
  assert.ok(next >= 350 || next < 10);
  assert.ok(Math.abs(easeAngle(100, 100, 1) - 100) < 1e-9);
  let a = 0; for (let i = 0; i < 100; i++) a = easeAngle(a, 180, 0.033);
  assert.ok(Math.abs(a - 180) < 1);
  assert.equal(easeAngle(10, 200, 0), 10);
});
