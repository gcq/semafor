import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movementsOfHead, headLabel, ensureHeadsForMovements, reconcileMasts } from '../src/inference/heads.js';

const mkIx = () => ({
  arms: [{ id: 'N', name: 'N' }, { id: 'S', name: 'S' }, { id: 'W', name: 'W' }],
  heads: [{ id: 'h1', name: 'Main' }],
  movements: [
    { id: 'thru', from: 'S', to: 'N', headId: 'h1' },
    { id: 'left', from: 'S', to: 'W', headId: 'h1' },
    { id: 'free', from: 'S', to: 'W', unsignalized: true },
  ],
});

test('movementsOfHead ignores unsignalized', () => {
  const ix = mkIx();
  assert.deepEqual(movementsOfHead(ix, 'h1').map((m) => m.id), ['thru', 'left']);
});

test('headLabel uses the head name, else its movements', () => {
  const ix = mkIx();
  assert.equal(headLabel(ix, 'h1'), 'Main');
  ix.heads[0].name = '';
  assert.equal(headLabel(ix, 'h1'), 'S→N, S→W');
});

test('ensureHeadsForMovements gives each unassigned movement its own head, prunes orphans', () => {
  const ix = { arms: [{ id: 'S' }, { id: 'N' }], heads: [{ id: 'dead' }], movements: [
    { id: 'm1', from: 'S', to: 'N' }, { id: 'm2', from: 'N', to: 'S' },
  ] };
  let n = 0;
  ensureHeadsForMovements(ix, () => `h${n++}`, (i) => `Head ${i + 1}`);
  assert.equal(ix.movements[0].headId, 'h0');
  assert.equal(ix.movements[1].headId, 'h1');
  assert.ok(!ix.heads.find((h) => h.id === 'dead')); // orphan pruned
  assert.equal(ix.heads.length, 2);
});

test('splitting a movement onto its own head is a plain headId reassignment', () => {
  const ix = mkIx();
  ix.heads.push({ id: 'h2', name: 'Left arrow' });
  ix.movements.find((m) => m.id === 'left').headId = 'h2';
  assert.deepEqual(movementsOfHead(ix, 'h1').map((m) => m.id), ['thru']);
  assert.deepEqual(movementsOfHead(ix, 'h2').map((m) => m.id), ['left']);
});

test('reconcileMasts seeds one mast per head, keeps duplicates, prunes dead heads', () => {
  let n = 0; const mkId = () => `m${n++}`; const seed = () => ({ lat: 0, lon: 0 });
  let masts = reconcileMasts([], ['a', 'b'], seed, mkId);
  assert.equal(masts.length, 2);
  masts.push({ id: 'dup', pos: { lat: 1, lon: 1 }, headIds: ['a'] }); // median duplicate
  masts = reconcileMasts(masts, ['a', 'b'], seed, mkId);
  assert.equal(masts.filter((m) => m.headIds.includes('a')).length, 2);
  masts = reconcileMasts(masts, ['a'], seed, mkId); // b removed
  assert.ok(masts.every((m) => !m.headIds.includes('b')));
});
