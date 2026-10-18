import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streetsStale, createStreetFeed, clusterIntersections, STREETS_FORMAT, RETRY_MS, retryDelay, MAX_AGE_MS, MOVED_M, CLUSTER_LINK_M, CLUSTER_MAX_SPAN_M } from '../src/osm/lanes-cache.js';

const NOW = 1_800_000_000_000;
const loc = { lat: 41.4143, lon: 2.0121 };
// ~1e-5° lat ≈ 1.11 m
const north = (m, from = loc) => ({ lat: from.lat + m / 111195, lon: from.lon });
const ix = { id: 'ix1', location: loc };
const at = (id, m) => ({ id, location: north(m) });
const cluster = (...ixs) => clusterIntersections(ixs)[0];
const entry = (over = {}) => ({ id: 'ix1', v: STREETS_FORMAT, members: [{ id: 'ix1', ...loc }], center: { ...loc }, computedAt: NOW - 1000, kind: 'lanes', data: { layers: [{ z: 0 }] }, ...over });

test('clusterIntersections: single linkage within CLUSTER_LINK_M, chains join, far ones stay apart', () => {
  // a-b 200 m, b-c 250 m (a-c 450 m > link, joined through b); d 350 m from c; e has no location
  const cs = clusterIntersections([at('d', 800), at('b', 200), at('a', 0), at('c', 450), { id: 'e' }, { id: 'z', location: { lat: 0, lon: 0 } }]);
  assert.deepEqual(cs.map((c) => c.key), ['a|b|c', 'd']);
  assert.deepEqual(cs[0].members.map((m) => m.id), ['a', 'b', 'c']);
  assert.ok(CLUSTER_LINK_M >= 250);
  assert.deepEqual(clusterIntersections([at('a', 0), at('b', CLUSTER_LINK_M + 20)]).map((c) => c.key), ['a', 'b']);
  assert.deepEqual(clusterIntersections([]), []);
});

test('clusterIntersections: deterministic whatever the input order', () => {
  const list = [at('a', 0), at('b', 100), at('c', 900), at('d', 1000)];
  assert.deepEqual(clusterIntersections(list), clusterIntersections([...list].reverse()));
});

test('clusterIntersections: a chain longer than the span cap is split greedily, every member in exactly one cluster', () => {
  const chain = Array.from({ length: 14 }, (_, i) => at(`n${String(i).padStart(2, '0')}`, i * 250)); // 3.25 km of links
  const cs = clusterIntersections(chain);
  assert.ok(cs.length >= 3);
  assert.equal(cs.flatMap((c) => c.members).length, 14);
  assert.equal(new Set(cs.flatMap((c) => c.members.map((m) => m.id))).size, 14);
  for (const c of cs) {
    const ys = c.members.map((m) => m.lat);
    assert.ok((Math.max(...ys) - Math.min(...ys)) * 111195 <= CLUSTER_MAX_SPAN_M + 1);
  }
});

test('streetsStale: fresh entry is fine', () => {
  assert.equal(streetsStale(entry(), cluster(ix), NOW), null);
});

test('streetsStale: missing, wrong format, members changed, moved, old', () => {
  const c = cluster(ix);
  assert.equal(streetsStale(undefined, c, NOW), 'missing');
  assert.equal(streetsStale(entry({ v: STREETS_FORMAT - 1 }), c, NOW), 'format');
  assert.equal(streetsStale(entry({ members: [{ id: 'ix1', ...north(MOVED_M - 1) }] }), c, NOW), null);
  assert.equal(streetsStale(entry({ members: [{ id: 'ix1', ...north(MOVED_M + 1) }] }), c, NOW), 'moved');
  assert.equal(streetsStale(entry({ members: [] }), c, NOW), 'members');
  assert.equal(streetsStale(entry({ members: undefined }), c, NOW), 'members');
  assert.equal(streetsStale(entry(), cluster(ix, at('ix2', 100)), NOW), 'members');
  assert.equal(streetsStale(entry({ computedAt: NOW - MAX_AGE_MS }), c, NOW), null);
  assert.equal(streetsStale(entry({ computedAt: NOW - MAX_AGE_MS - 1 }), c, NOW), 'old');
  assert.equal(streetsStale(entry({ computedAt: undefined }), c, NOW), 'old');
});

// A feed with scripted deps; sleeps are recorded, not waited.
function harness(over = {}) {
  const h = { stored: [], saved: [], removed: [], sleeps: [], calls: [], logs: [], timers: [], cleared: [] };
  h.deps = {
    loadAll: async () => h.stored,
    save: async (e) => { h.saved.push(e); },
    remove: async (id) => { h.removed.push(id); },
    fetchXml: async (c) => { h.calls.push('xml'); return new Uint8Array([1]); },
    computeLanes: async () => { h.calls.push('lanes'); return { layers: [{ z: 0 }] }; },
    fetchPlain: async () => { h.calls.push('plain'); return { ways: [{}] }; },
    setTimer: (fn, ms) => { const t = { fn, ms }; h.timers.push(t); return t; }, clearTimer: (t) => { h.cleared.push(t); t.dead = true; },
    now: () => NOW, sleep: async (ms) => { h.sleeps.push(ms); }, log: (...a) => h.logs.push(a.join(' ')),
    ...over,
  };
  h.feed = createStreetFeed(h.deps);
  return h;
}
// check() returns once queued; wait for the background pump to drain
const settle = () => new Promise((r) => setTimeout(r, 10));

test('feed: builds missing entries, caches in memory + store, skips fresh ones', async () => {
  const h = harness();
  const far = at('fresh', 2000);
  h.stored = [entry({ id: 'fresh', members: [{ id: 'fresh', ...far.location }], center: far.location })];
  await h.feed.check([ix, far]);
  await settle();
  assert.equal(h.feed.get('ix1').kind, 'lanes');
  assert.equal(h.feed.get('ix1').computedAt, NOW);
  assert.deepEqual(h.feed.get('ix1').members, [{ id: 'ix1', ...loc }]);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].id, 'ix1');
  assert.equal(h.feed.get('fresh').computedAt, NOW - 1000); // untouched, loaded from the store
  assert.deepEqual(h.calls, ['xml', 'lanes']);
});

test('feed: nearby junctions share ONE fetch, ONE build and ONE entry over the expanded bbox', async () => {
  const bboxes = [];
  const h = harness({
    fetchXml: async (bbox) => { h.calls.push('xml'); bboxes.push(bbox); return new Uint8Array([1]); },
    computeLanes: async (xml, bbox) => { h.calls.push('lanes'); bboxes.push(bbox); return { layers: [{ z: 0 }] }; },
  });
  await h.feed.check([at('b', 120), ix, at('c', 60)]);
  await settle();
  assert.deepEqual(h.calls, ['xml', 'lanes']);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].id, 'b|c|ix1');
  assert.deepEqual(bboxes[0], bboxes[1]);
  const [s, , n] = bboxes[0];
  assert.ok(Math.abs((n - s) * 111195 - (120 + 400)) < 1); // member span + 200 m each side
  assert.ok(Math.abs(h.saved[0].center.lat - (s + n) / 2) < 1e-9);
  assert.strictEqual(h.feed.get('b'), h.feed.get('ix1'));
  assert.deepEqual(h.feed.neighborIds('c').sort(), ['b', 'ix1']);
  assert.deepEqual(h.feed.neighborIds('nobody'), []);
});

test('feed: one at a time, spaced ~2 s apart', async () => {
  const h = harness();
  await h.feed.check([ix, at('b', 2500), at('c', 5000)]);
  await settle();
  assert.deepEqual(h.sleeps, [2000, 2000]);
  assert.equal(h.saved.length, 3);
});

test('feed: osm2streets failure falls back to plain lines (per cluster, with its bbox)', async () => {
  let plainArgs;
  const h = harness({
    computeLanes: async () => { throw new Error('wasm boom'); },
    fetchPlain: async (center, opts) => { h.calls.push('plain'); plainArgs = [center, opts]; return { ways: [{}] }; },
  });
  await h.feed.check([ix, at('b', 100)]);
  await settle();
  assert.equal(h.feed.get('ix1').kind, 'plain');
  assert.deepEqual(h.calls, ['xml', 'plain']);
  assert.equal(h.saved[0].kind, 'plain');
  assert.equal(plainArgs[1].bbox.length, 4);
  assert.deepEqual(plainArgs[0], h.saved[0].center);
});

test('feed: empty lanes also fall back', async () => {
  const h = harness({ computeLanes: async () => ({ layers: [] }) });
  await h.feed.check([ix]);
  await settle();
  assert.equal(h.feed.get('ix1').kind, 'plain');
});

test('retryDelay: 10 s, 30 s, 2 min, then every 5 min', () => {
  assert.deepEqual(RETRY_MS, [10000, 30000, 120000, 300000]);
  assert.deepEqual([1, 2, 3, 4, 5, 50].map(retryDelay), [10000, 30000, 120000, 300000, 300000, 300000]);
  assert.equal(retryDelay(0), 10000);
});

test('feed: a failed cluster is retried in the background on the backoff schedule, never given up', async () => {
  let n = 0;
  const h = harness({ fetchXml: async () => { n++; throw new Error('HTTP 500'); } });
  await h.feed.check([ix]);
  assert.equal(h.feed.status('ix1'), 'loading');
  await settle();
  assert.equal(n, 1);
  assert.equal(h.feed.status('ix1'), 'failed');
  assert.equal(h.feed.get('ix1'), null);
  assert.deepEqual(h.timers.map((t) => t.ms), [10000]);
  await h.feed.check([ix]); // checking again while waiting does not hammer the network
  await settle();
  assert.equal(n, 1);
  for (const want of [30000, 120000, 300000, 300000, 300000]) {
    h.timers.at(-1).fn(); // the retry timer fires
    await settle();
    assert.equal(h.feed.status('ix1'), 'failed');
    assert.equal(h.timers.at(-1).ms, want);
  }
  assert.equal(n, 6);
  assert.equal(h.saved.length, 0);
});

test('feed: a retry that succeeds clears the failure state and the next failure starts the schedule over', async () => {
  let fail = true;
  const h = harness({ fetchXml: async () => { if (fail) throw new Error('timeout'); return new Uint8Array([1]); } });
  await h.feed.check([ix]); await settle();
  h.timers.at(-1).fn(); await settle();
  assert.deepEqual(h.timers.map((t) => t.ms), [10000, 30000]);
  fail = false;
  h.timers.at(-1).fn(); await settle();
  assert.equal(h.feed.status('ix1'), 'ready');
  assert.equal(h.feed.get('ix1').kind, 'lanes');
  assert.equal(h.saved.length, 1);
  assert.equal(h.timers.length, 2); // nothing further scheduled
});

test('feed: online() cancels the waits and retries immediately', async () => {
  let n = 0;
  const h = harness({ fetchXml: async () => { n++; if (n === 1) throw new Error('offline'); return new Uint8Array([1]); } });
  await h.feed.check([ix]); await settle();
  assert.equal(h.feed.status('ix1'), 'failed');
  const t = h.timers[0];
  await h.feed.online(); await settle();
  assert.ok(t.dead && h.cleared.includes(t));
  assert.equal(n, 2);
  assert.equal(h.feed.status('ix1'), 'ready');
});

test('feed: never two requests in flight, however many clusters fail and retry', async () => {
  let inflight = 0, max = 0;
  const h = harness({ fetchXml: async () => { inflight++; max = Math.max(max, inflight); await new Promise((r) => setTimeout(r, 3)); inflight--; throw new Error('x'); } });
  await h.feed.check([ix, at('b', 2500), at('c', 5000)]); await settle(); await settle();
  assert.equal(h.timers.length, 3);
  for (const t of [...h.timers]) t.fn(); // all three retry timers fire together
  await settle(); await settle(); await settle();
  assert.equal(max, 1);
});

test('feed.status: loading while queued/building, ready once cached, null for unknown or when idle with nothing to do', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ fetchXml: async () => { await gate; return new Uint8Array([1]); } });
  assert.equal(h.feed.status('ix1'), null); // before the first check
  await h.feed.check([ix, at('b', 2500)]);
  assert.equal(h.feed.status('ix1'), 'loading');
  assert.equal(h.feed.status('b'), 'loading'); // queued behind it
  assert.equal(h.feed.status('nobody'), null);
  release(); await settle();
  assert.equal(h.feed.status('ix1'), 'ready');
  assert.equal(h.feed.status('b'), 'ready');
});

test('feed.status: a cached entry stays ready even when its refresh fails', async () => {
  const h = harness({ fetchXml: async () => { throw new Error('x'); } });
  h.stored = [entry({ computedAt: NOW - MAX_AGE_MS - 1 })];
  await h.feed.check([ix]); await settle();
  assert.equal(h.feed.status('ix1'), 'ready');
  assert.equal(h.timers.length, 1); // still retried
});

test('feed: a cluster that disappears cancels its retry', async () => {
  const h = harness({ fetchXml: async () => { throw new Error('x'); } });
  await h.feed.check([ix]); await settle();
  await h.feed.check([at('other', 4000)]); await settle();
  assert.ok(h.timers[0].dead);
});

test('feed: a cluster that is already queued is not queued twice; a moved member is rebuilt', async () => {
  const h = harness();
  await Promise.all([h.feed.check([ix]), h.feed.check([ix])]);
  await settle();
  assert.equal(h.saved.length, 1);
  await h.feed.check([{ id: 'ix1', location: north(50) }]);
  await settle();
  assert.equal(h.saved.length, 2);
});

test('feed: membership change rebuilds under the new key and drops the old, unreferenced entry', async () => {
  const h = harness();
  h.stored = [entry({ id: 'gone', members: [{ id: 'gone', ...north(3000) }], center: north(3000) })];
  await h.feed.check([ix]);
  await settle();
  assert.deepEqual(h.removed, ['gone']);
  assert.equal(h.feed.get('gone'), null);
  await h.feed.check([ix, at('ix2', 100)]); // ix2 appears next door
  await settle();
  assert.equal(h.saved.at(-1).id, 'ix1|ix2');
  assert.deepEqual(h.removed, ['gone', 'ix1']);
  assert.equal(h.feed.get('ix2').id, 'ix1|ix2');
});

test('feed: ignores intersections without a real location; a failing store never blocks', async () => {
  const h = harness({ loadAll: async () => { throw new Error('idb down'); }, save: async () => { throw new Error('quota'); } });
  await h.feed.check([{ id: 'z', location: { lat: 0, lon: 0 } }, { id: 'n' }, ix]);
  await settle();
  assert.deepEqual([...h.feed.entries.keys()], ['ix1']); // still served from memory
});

test('feed: an empty intersection list never wipes the cache', async () => {
  const h = harness();
  h.stored = [entry()];
  await h.feed.check([]);
  await settle();
  assert.deepEqual(h.removed, []);
});
