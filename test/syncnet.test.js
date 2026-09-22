import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoomCode, normalizeCode, formatCode, isValidCode, topicFor, deriveKey, sealBundle, openBundle } from '../src/sync/net.js';

const bundle = {
  version: 2,
  intersections: [{ id: 'ix1', name: 'Pont', location: { lat: 41.41, lon: 2.01 }, rev: 3 }],
  observations: Array.from({ length: 50 }, (_, i) => ({ id: `o${i}`, intersectionId: 'ix1', headId: 'h1', aspect: 'red', t: 1_790_000_000_000 + i * 1000 })),
  tombstones: [],
};

test('room codes are 16 chars from the unambiguous alphabet and survive formatting', () => {
  const c = makeRoomCode();
  assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{16}$/);
  assert.equal(formatCode(c).length, 19); // XXXX-XXXX-XXXX-XXXX
  assert.equal(normalizeCode(formatCode(c).toLowerCase()), c);
  assert.ok(isValidCode(formatCode(c)));
  assert.ok(!isValidCode('ABC123'));
});

test('topic is a deterministic hash that does not reveal the code', async () => {
  const c = makeRoomCode();
  const t1 = await topicFor(c), t2 = await topicFor(formatCode(c));
  assert.equal(t1, t2);
  assert.match(t1, /^onda-[0-9a-f]{40}$/);
  assert.ok(!t1.includes(c.toLowerCase()));
  assert.notEqual(t1, await topicFor(makeRoomCode()));
});

test('seal/open round-trips a bundle, compressed', async () => {
  const c = makeRoomCode();
  const sealed = await sealBundle(bundle, await deriveKey(c));
  assert.ok(sealed.length < JSON.stringify(bundle).length); // gzip did its job
  assert.deepEqual(await openBundle(sealed, await deriveKey(formatCode(c))), bundle);
});

test('a different code cannot open it, and tampering is detected', async () => {
  const c = makeRoomCode();
  const sealed = await sealBundle(bundle, await deriveKey(c));
  await assert.rejects(openBundle(sealed, await deriveKey(makeRoomCode())));
  const bad = sealed.slice(); bad[bad.length - 1] ^= 1;
  await assert.rejects(openBundle(bad, await deriveKey(c)));
});
