import { test } from 'node:test';
import assert from 'node:assert/strict';
import { characterizeIntersection, planToEstimate, characterizeNetwork } from '../src/inference/characterize.js';

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

test('planToEstimate round-trips a saved plan for linkage', () => {
  const plan = { id: 'p', epoch: 5000, confidence: { cycles: 10, stdevSec: 1, level: 'high' },
    stages: [{ states: { h1: 'green' }, timing: { type: 'fixed', sec: 40 } }, { states: { h1: 'red' }, timing: { type: 'fixed', sec: 40 } }] };
  const est = planToEstimate(plan);
  assert.equal(est.cycleLengthSec, 80);
  assert.equal(est.epoch, 5000);
});

test('characterizeNetwork finds a coordinated corridor from observations', () => {
  const a = mkIx('a'), b = mkIx('b'), c = mkIx('c');
  const obs = {
    a: events('a', 'h1', 8, 0),
    b: events('b', 'h1', 8, 12000),   // 12s offset, same 80s cycle
    c: events('c', 'h1', 8, 24000),   // 24s offset
  };
  const { corridors } = characterizeNetwork([a, b, c], obs, (ix) => ix.plans[0]);
  const big = corridors.find((g) => g.length >= 3);
  assert.ok(big);
  assert.deepEqual(big.sort(), ['a', 'b', 'c']);
});
