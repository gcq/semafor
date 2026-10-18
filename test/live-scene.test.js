import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneScale, compactLights } from '../src/ui/live-scene.js';

const base = { W: 400, H: 300, jy: 180, fitScale: 2, tall: false };
const roomBelow = base.H - base.jy - 44; // 76 px
const minScale = roomBelow / 200; // MAX_FOLLOW_M

test('compactLights has hysteresis between 0.55 and 0.65 of fitScale', () => {
  assert.equal(compactLights(false, 2, 2), false);
  assert.equal(compactLights(false, 1.2, 2), false); // 0.6: not yet entering
  assert.equal(compactLights(false, 1.0, 2), true); // 0.5: enter
  assert.equal(compactLights(true, 1.2, 2), true); // 0.6: stay compact
  assert.equal(compactLights(true, 1.4, 2), false); // 0.7: leave
});

test('no ego -> fitScale', () => {
  assert.deepEqual(sceneScale(base), { target: 2, pinned: false });
  assert.deepEqual(sceneScale({ ...base, egoF: null, egoL: null }), { target: 2, pinned: false });
});

test('ego close never zooms in beyond fitScale', () => {
  assert.deepEqual(sceneScale({ ...base, egoF: -10, egoL: 2 }), { target: 2, pinned: false });
});

test('ego 150 m behind -> zooms out and ego fits', () => {
  const { target, pinned } = sceneScale({ ...base, egoF: -150, egoL: 0 });
  assert.equal(pinned, false);
  assert.ok(target < 2 && target > minScale);
  assert.ok(base.jy + 150 * target <= base.H - 44 + 1e-9);
});

test('ego 1 km behind -> minScale and pinned', () => {
  const { target, pinned } = sceneScale({ ...base, egoF: -1000, egoL: 0 });
  assert.ok(Math.abs(target - minScale) < 1e-9);
  assert.equal(pinned, true);
});

test('ego slightly ahead uses the room above', () => {
  const { target, pinned } = sceneScale({ ...base, egoF: 100, egoL: 0 });
  assert.equal(pinned, false);
  assert.ok(Math.abs(target - (180 - 70) / 100) < 1e-9);
  assert.ok(sceneScale({ ...base, tall: true, egoF: 100, egoL: 0 }).target < target);
});

test('lateral offset constrains too, and zero distance is safe', () => {
  const { target } = sceneScale({ ...base, egoF: -5, egoL: 300 });
  assert.ok(Math.abs(target - (200 - 24) / 300) < 1e-9);
  assert.equal(sceneScale({ ...base, egoF: 0, egoL: 0 }).target, 2);
});
