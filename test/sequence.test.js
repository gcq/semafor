import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardAspect, tapped } from '../src/predict/sequence.js';

const ALL = ['green', 'amber', 'red'];
// feed the model's colour each second; returns the shown colours
const run = (start, feed, known = ALL) => {
  let st = start; const out = [];
  for (const [t, m] of feed) { st = guardAspect(st, m, t, known); out.push(st?.aspect ?? null); }
  return { st, out };
};
const secs = (m, from, to) => Array.from({ length: to - from + 1 }, (_, i) => [(from + i) * 1000, m]);

test('legal transitions are immediate', () => {
  let st = guardAspect(null, 'green', 0, ALL);
  for (const [m, t] of [['amber', 1], ['red', 2], ['green', 3]]) { st = guardAspect(st, m, t * 1000, ALL); assert.equal(st.aspect, m); }
});

test('red then model says amber: held, then red -> green -> amber, never red -> amber', () => {
  const { out } = run({ aspect: 'red', sinceMs: 0 }, secs('amber', 1, 12));
  assert.deepEqual(out.slice(0, 3), ['red', 'red', 'red']);
  assert.equal(out[3], 'green'); // 3 s after the mismatch began (t=1 s)
  assert.equal(out.at(-1), 'amber');
  const seq = out.filter((a, i) => a !== out[i - 1]);
  assert.deepEqual(seq, ['red', 'green', 'amber']);
});

test('amber then model green: held 3 s, steps to red, then green', () => {
  const { out } = run({ aspect: 'amber', sinceMs: 0 }, secs('green', 1, 8));
  assert.deepEqual(out, ['amber', 'amber', 'amber', 'red', 'green', 'green', 'green', 'green']);
});

test('a stepped colour shows at least 1 s before the next step', () => {
  // mismatch lasted 10 s already, then the colour changes under us: step 1 now, step 2 only after 1 s
  let st = { aspect: 'green', sinceMs: 0, stepAt: 0 };
  st = guardAspect(st, 'red', 10000, ALL); // legal? green -> amber is the successor; red is not
  assert.deepEqual([st.aspect, st.sinceMs], ['amber', 10000]);
  st = guardAspect(st, 'green', 10500, ALL);
  assert.equal(st.aspect, 'amber');
  st = guardAspect(st, 'green', 11000, ALL);
  assert.equal(st.aspect, 'red');
});

test('a head without amber: green and red are each other\'s successor', () => {
  let st = guardAspect({ aspect: 'green', sinceMs: 0 }, 'red', 1000, ['green', 'red']);
  assert.equal(st.aspect, 'red');
  st = guardAspect(st, 'green', 2000, ['green', 'red']);
  assert.equal(st.aspect, 'green');
});

test('off and flash-amber pass through, both ways', () => {
  let st = guardAspect({ aspect: 'red', sinceMs: 0 }, 'off', 1000, ALL);
  assert.equal(st.aspect, 'off');
  st = guardAspect(st, 'amber', 2000, ALL);
  assert.equal(st.aspect, 'amber');
  st = guardAspect(st, 'flash-amber', 3000, ALL);
  assert.equal(st.aspect, 'flash-amber');
  assert.equal(guardAspect(st, null, 4000, ALL), null);
});

test('a tap overrides the guard', () => {
  const st = tapped('green', 5000);
  assert.deepEqual(guardAspect(st, 'green', 6000, ALL), { aspect: 'green', sinceMs: 5000 });
  assert.equal(guardAspect({ aspect: 'red', sinceMs: 0 }, 'amber', 1000, ALL).aspect, 'red');
  assert.equal(tapped('amber', 1000).aspect, 'amber');
});
