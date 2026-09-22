import { test } from 'node:test';
import assert from 'node:assert/strict';
import { characterizeIntersection } from '../src/inference/characterize.js';

// One-head fixed cycle: green 0-40, red 40-80 (80s).
function events(ixId, headId, cycles, base = 0) {
  const evs = [];
  for (let c = 0; c < cycles; c++) {
    const t = base + c * 80000;
    evs.push({ id: `${ixId}${c}g`, intersectionId: ixId, headId, aspect: 'green', t });
    evs.push({ id: `${ixId}${c}r`, intersectionId: ixId, headId, aspect: 'red', t: t + 40000 });
  }
  return evs;
}

const mkIx = (id) => ({
  id, arms: [{ id: 'S' }, { id: 'N' }], heads: [{ id: 'h1' }],
  movements: [{ id: 'm1', from: 'S', to: 'N', headId: 'h1' }], plans: [],
});

test('characterizeIntersection reconstructs a plan from aspect observations', () => {
  const ix = mkIx('ix');
  const { rec, plan } = characterizeIntersection(ix, events('ix', 'h1', 6));
  assert.ok(rec.modelable);
  assert.equal(rec.cycleLengthSec, 80);
  assert.ok(plan.stages.length >= 2);
  assert.equal(plan.stages[0].states.h1, 'green');
});
