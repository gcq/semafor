// nextChange (predict/next.js): the countdown target when a light's whole cycle is known.
process.env.TZ = 'Europe/Madrid';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeModel } from '../src/inference/clock.js';
import { nextChange, predictMark, currentAspect } from '../src/predict/next.js';

const C = 90;
const T0 = 1000 * C * 1000; // a cycle start (epochMs = 0)
const at = (sec) => T0 + Math.round(sec * 1000); // `sec` into the cycle
const POS = { green: 0, amber: 45, red: 48 };

// A hand-made model: one light 'A', one all-day plan, cycle 90 s, steady clock (no tap needed).
function fakeModel(aspects, { hypothesis = 'steady', actuated = [], dayOffsets = {} } = {}) {
  const marks = {};
  for (const a of aspects) marks[`A|${a}`] = { posSec: POS[a] ?? 10, spreadSec: 0.5, n: 6, actuated: actuated.includes(a) };
  return {
    lag: { minSec: 0.2, medianSec: 0.35 },
    lights: { A: { intersectionId: 'i1', groupId: 'g', aspects, actuated } },
    groups: [{ id: 'g', plans: [{ id: 'p', windows: [{ fromMin: 0, toMin: 1440 }], cycleSec: C, cycleSigmaSec: 0, marks, clock: { hypothesis, epochMs: 0, days: 5, dayOffsets, residRmsSec: 1, nudgeSigmaSec: 2 } }] }],
  };
}
const GAR = fakeModel(['green', 'amber', 'red']);
const GR = fakeModel(['green', 'red']);

test('nextChange: three colours -> the soonest other colour, whatever is shown', () => {
  let c = nextChange(GAR, 'A', at(10), 'green');
  assert.equal(c.aspect, 'amber'); assert.equal(c.inSec, 35);
  c = nextChange(GAR, 'A', at(46), 'amber');
  assert.equal(c.aspect, 'red'); assert.equal(c.inSec, 2);
  c = nextChange(GAR, 'A', at(60), 'red');
  assert.equal(c.aspect, 'green'); assert.equal(c.inSec, 30);
  assert.match(c.basis, /^clock from 5 days/);
  assert.equal(c.guess, undefined);
  // without `shown` it uses the model's own colour
  assert.equal(nextChange(GAR, 'A', at(10)).aspect, 'amber');
  assert.equal(nextChange(GAR, 'A', at(46)).aspect, 'red');
});

test('nextChange: green + red only -> red after green (no amber invented), green after red', () => {
  assert.equal(currentAspect(GR, 'A', at(10)), 'green');
  let c = nextChange(GR, 'A', at(10), 'green');
  assert.equal(c.aspect, 'red'); assert.equal(c.inSec, 38);
  c = nextChange(GR, 'A', at(60), 'red');
  assert.equal(c.aspect, 'green'); assert.equal(c.inSec, 30);
});

test('nextChange: null when the whole cycle is not known (caller falls back to next green)', () => {
  assert.equal(nextChange(fakeModel(['green']), 'A', at(10)), null, 'one colour tapped');
  assert.equal(nextChange(fakeModel(['green']), 'A', at(10), 'green'), null, 'one colour, shown given');
  assert.equal(nextChange(GAR, 'nope', at(10), 'green'), null, 'unknown light');
  assert.equal(nextChange(fakeModel(['green', 'amber', 'red'], { actuated: ['amber'] }), 'A', at(10), 'green'), null, 'a mark is unpredictable');
  assert.equal(nextChange(fakeModel(['green', 'amber', 'red'], { actuated: ['amber'] }), 'A', at(10)), null, 'no shown colour, unpredictable');
});

test('nextChange: flash-amber / off lights are not counted down', () => {
  assert.equal(nextChange(fakeModel(['flash-amber']), 'A', at(10), 'flash-amber'), null);
  assert.equal(nextChange(fakeModel(['green', 'flash-amber']), 'A', at(10), 'green'), null);
  assert.equal(nextChange(fakeModel(['green', 'red', 'off']), 'A', at(10), 'off'), null);
});

test('nextChange: onset exactly at now, or rounding to 0, is never negative and never a whole cycle late', () => {
  // amber changes exactly now; green still shown
  let c = nextChange(GAR, 'A', at(45), 'green');
  assert.equal(c.aspect, 'amber'); assert.equal(c.inSec, 0);
  // once amber shows, the next change is red in 3 s — not amber again, not a cycle away
  c = nextChange(GAR, 'A', at(45), 'amber');
  assert.equal(c.aspect, 'red'); assert.equal(c.inSec, 3);
  // 40 ms before the onset rounds to 0.0
  c = nextChange(GAR, 'A', at(44.96), 'green');
  assert.equal(c.aspect, 'amber'); assert.equal(c.inSec, 0);
  // 40 ms after, with green still shown: the model has left green, amber is overdue — never green
  c = nextChange(GAR, 'A', at(45.04), 'green');
  assert.equal(c.aspect, 'amber'); assert.equal(c.inSec, 0);
  // green at cycle start exactly: shown red -> green in 0
  c = nextChange(GAR, 'A', at(0), 'red');
  assert.equal(c.aspect, 'green'); assert.equal(c.inSec, 0);
  for (let s = 0; s < C; s += 0.37) for (const shown of ['green', 'amber', 'red']) {
    const x = nextChange(GAR, 'A', at(s), shown);
    assert.ok(x.inSec >= 0 && x.inSec <= C && x.aspect !== shown, `${s} ${shown} -> ${JSON.stringify(x)}`);
  }
});

test('nextChange: the guard holds a colour the model already left -> its successor, now', () => {
  // model says red (50 s in), the display still holds green: amber is overdue
  let c = nextChange(GAR, 'A', at(50), 'green');
  assert.equal(c.aspect, 'amber'); assert.equal(c.inSec, 0);
  assert.equal(c.plusMinus, predictMark(GAR, 'A', 'red', at(50)).plusMinus); // the model's current mark
  // only green + red known: the successor of green is red
  c = nextChange(GR, 'A', at(60), 'green');
  assert.equal(c.aspect, 'red'); assert.equal(c.inSec, 0);
  // held on amber while the model is already at green: red is overdue
  c = nextChange(GAR, 'A', at(5), 'amber');
  assert.equal(c.aspect, 'red'); assert.equal(c.inSec, 0);
});

test('nextChange: plusMinus and basis are the picked mark\'s; a guess stays a guess', () => {
  const now = at(10);
  const c = nextChange(GAR, 'A', now, 'green');
  assert.equal(c.plusMinus, predictMark(GAR, 'A', 'amber', now).plusMinus);
  const ind = fakeModel(['green', 'amber', 'red'], { hypothesis: 'independent' });
  const g = nextChange(ind, 'A', now, 'green');
  assert.equal(g.aspect, 'amber'); assert.equal(g.guess, true); assert.equal(g.basis, 'guess · no tap today');
  assert.equal(g.plusMinus, predictMark(ind, 'A', 'amber', now).plusMinus);
  assert.equal(g.plusMinus, C / 2);
});

test('nextChange: on a model computed from taps', () => {
  const A = { id: 'i1', name: 'J', heads: [{ id: 'A' }] };
  const obs = []; let id = 0;
  const base = new Date(2026, 8, 21, 18, 0, 0).getTime();
  for (let k = 0; k < 8; k++) for (const [aspect, pos] of Object.entries(POS)) obs.push({ id: `o${id++}`, headId: 'A', aspect, kind: 'onset', t: base + k * C * 1000 + pos * 1000 + 300 });
  const model = computeModel({ observations: obs, intersections: [A] }, { now: 0 });
  const t = base + 8 * C * 1000 + 50 * 1000; // 50 s into the next cycle: red showing, green in ~40 s
  assert.equal(currentAspect(model, 'A', t), 'red');
  const c = nextChange(model, 'A', t, 'red');
  assert.equal(c.aspect, 'green');
  assert.ok(Math.abs(c.inSec - 40) < 1.5, `inSec ${c.inSec}`);
  const d = nextChange(model, 'A', base + 8 * C * 1000 + 10 * 1000, 'green');
  assert.equal(d.aspect, 'amber');
  assert.ok(Math.abs(d.inSec - 35) < 1.5, `inSec ${d.inSec}`);
});
