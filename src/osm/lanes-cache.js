// On-device cache of derived street geometry, one entry per CLUSTER of nearby
// intersections:
//   { id: clusterKey, v, members: [{id,lat,lon}], center, computedAt, kind: 'lanes' | 'plain', data }
// Junctions a few hundred metres apart would otherwise each fetch, compute and
// store ~the same OSM area (each entry reaches CLIP_HALF_M past its centre) and
// the Live view would draw overlapping copies. So nearby intersections share ONE
// Overpass fetch + ONE osm2streets run over the bbox of the members' centres
// expanded by CLIP_HALF_M; `center` is that bbox's centre, and the renderer
// offsets it against the junction being shown. An isolated junction is a cluster
// of one. It is DERIVED data: never on the intersection record, never synced or
// exported, safe to drop at any time (it just gets rebuilt). The feed below keeps
// it fresh in the background and hands the Live tab an in-memory Map, so drawing
// never waits on IndexedDB, the network or the wasm.
// Pure + DOM-free: every side effect (store, network, worker, clock, sleep) is injected.

import { areaBbox, bboxCenter } from './lanes.js';

export const STREETS_FORMAT = 3; // bump when the compact `data` format, the covered area or the keying changes (3: approach linkage; 2: ±200 m clusters; 1: per-intersection ±80 m)
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
export const MOVED_M = 5; // a member moved further than this from where the entry was built -> rebuild
// Single-linkage distance between junction centres. Each junction's street area
// reaches ~200 m (CLIP_HALF_M) every way, so two junctions within ~300 m share most
// of their area; further apart, a shared box would mostly be empty space between them.
export const CLUSTER_LINK_M = 300;
// Cap on the span of a cluster's member centres per axis. The fetched bbox adds
// CLIP_HALF_M (200 m) on every side, so 1100 m of centres = a 1.5 km box at most,
// which keeps the Overpass answer and the cache entry bounded for a long chain.
export const CLUSTER_MAX_SPAN_M = 1100;

const R = 6371000;
const RAD = Math.PI / 180;
const distM = (a, b) => Math.hypot((a.lon - b.lon) * Math.cos(a.lat * RAD) * R * RAD, (a.lat - b.lat) * R * RAD);

const validLoc = (l) => l && Number.isFinite(l.lat) && Number.isFinite(l.lon) && !(l.lat === 0 && l.lon === 0);

// East/north extent (m) of a set of points.
function extentM(pts) {
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  return {
    x: (Math.max(...lons) - Math.min(...lons)) * Math.cos(midLat * RAD) * R * RAD,
    y: (Math.max(...lats) - Math.min(...lats)) * R * RAD,
  };
}

/**
 * Group intersections into clusters by single linkage on centre distance (two
 * join when within `linkM`, directly or through a chain), then split any cluster
 * wider than `maxSpanM` greedily along its longer axis. Intersections without a
 * real location are ignored. Deterministic: members sorted by id, clusters by key.
 * @param {Array<{id:string, location:{lat:number,lon:number}}>} ixs
 * @returns {Array<{key:string, members:Array<{id:string,lat:number,lon:number}>}>}
 */
export function clusterIntersections(ixs, { linkM = CLUSTER_LINK_M, maxSpanM = CLUSTER_MAX_SPAN_M } = {}) {
  const pts = (ixs ?? []).filter((ix) => validLoc(ix?.location))
    .map((ix) => ({ id: ix.id, lat: ix.location.lat, lon: ix.location.lon }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const parent = pts.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    if (distM(pts[i], pts[j]) <= linkM) parent[find(i)] = find(j);
  }
  const groups = new Map();
  pts.forEach((p, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), p]); });

  const out = [];
  for (const g of groups.values()) {
    let parts = [g];
    const e = extentM(g);
    if (e.x > maxSpanM || e.y > maxSpanM) {
      const axis = e.x >= e.y ? 'lon' : 'lat';
      const sorted = [...g].sort((a, b) => a[axis] - b[axis] || (a.id < b.id ? -1 : 1));
      parts = [];
      let cur = [];
      for (const p of sorted) {
        const ext = cur.length ? extentM([...cur, p]) : { x: 0, y: 0 };
        if (cur.length && (ext.x > maxSpanM || ext.y > maxSpanM)) { parts.push(cur); cur = []; }
        cur.push(p);
      }
      parts.push(cur);
    }
    for (const members of parts) {
      const m = [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      out.push({ key: m.map((x) => x.id).join('|'), members: m });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Why `entry` needs (re)building for `cluster`, or null when it is fine. */
export function streetsStale(entry, cluster, now = Date.now()) {
  if (!entry) return 'missing';
  if (entry.v !== STREETS_FORMAT) return 'format';
  const had = new Map((entry.members ?? []).map((m) => [m.id, m]));
  if (had.size !== cluster.members.length || cluster.members.some((m) => !had.has(m.id))) return 'members';
  if (cluster.members.some((m) => distM(had.get(m.id), m) > MOVED_M)) return 'moved';
  if (!(now - entry.computedAt <= MAX_AGE_MS)) return 'old';
  return null;
}

/**
 * Background street loader. `check(intersections)` clusters them, queues whichever
 * clusters are stale and works through them one at a time, spaced out, with
 * exponential backoff on failure and a quiet give-up (for this session) after
 * `maxTries`. Entries no cluster refers to any more are dropped.
 * @param {Object} deps
 * @param {() => Promise<Object[]>} deps.loadAll         stored entries
 * @param {(entry:Object) => Promise<void>} deps.save
 * @param {(key:string) => Promise<void>} deps.remove     delete a stored entry
 * @param {(bbox:number[]) => Promise<Uint8Array>} deps.fetchXml  Overpass OSM XML for [s,w,n,e]
 * @param {(xml:Uint8Array, bbox:number[]) => Promise<Object>} deps.computeLanes  osm2streets (worker) -> compact data
 * @param {(center, bbox:number[]) => Promise<Object>} deps.fetchPlain    plain-line fallback data
 */
export function createStreetFeed({
  loadAll, save, remove = async () => {}, fetchXml, computeLanes, fetchPlain,
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = (...a) => console.log('[streets]', ...a),
  spacingMs = 2000, backoffMs = 4000, maxTries = 3,
}) {
  const entries = new Map();
  const clusterOf = new Map(), membersOf = new Map(); // intersection id -> cluster key; cluster key -> member ids
  const queue = [], queued = new Set(), gaveUp = new Set();
  let loaded = null, pumping = false, lastIxs = [];

  const load = () => (loaded ??= loadAll()
    .then((list) => { for (const e of list ?? []) entries.set(e.id, e); })
    .catch((e) => log('cache load failed', e?.message ?? e)));

  async function attempt({ key, members }) {
    const bbox = areaBbox(members), center = bboxCenter(bbox);
    const xml = await fetchXml(bbox); // network trouble throws -> retried with backoff
    let kind = 'lanes', data;
    try {
      data = await computeLanes(xml, bbox);
      if (!data?.layers?.length) throw new Error('no lanes');
    } catch (e) {
      log(`${key}: osm2streets failed (${e?.message ?? e}), falling back to plain lines`);
      kind = 'plain';
      data = await fetchPlain(center, { bbox });
    }
    const entry = { id: key, v: STREETS_FORMAT, members: members.map((m) => ({ ...m })), center, computedAt: now(), kind, data };
    entries.set(key, entry);
    await save(entry).catch((e) => log(`${key}: couldn't persist`, e?.message ?? e)); // still usable this session
    log(`${key}: cached ${kind}`);
  }

  async function run(job) {
    for (let t = 0; t < maxTries; t++) {
      try { await attempt(job); return; } catch (e) {
        log(`${job.key}: try ${t + 1}/${maxTries} failed: ${e?.message ?? e}`);
        if (t < maxTries - 1) await sleep(backoffMs * 2 ** t);
      }
    }
    gaveUp.add(job.gaveUpKey);
    log(`${job.key}: giving up for this session`);
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try { await run(job); } finally { queued.delete(job.key); }
        if (queue.length) await sleep(spacingMs);
      }
    } finally { pumping = false; }
  }

  return {
    entries,
    /** The shared street entry of the cluster `ixId` belongs to (null until built). */
    get: (ixId) => entries.get(clusterOf.get(ixId)) ?? null,
    /** Ids of the other intersections in `ixId`'s cluster. */
    neighborIds: (ixId) => (membersOf.get(clusterOf.get(ixId)) ?? []).filter((id) => id !== ixId),
    /** Cluster the intersections and queue every stale cluster (resolves once the stored cache is loaded; work continues in the background). */
    async check(intersections) {
      lastIxs = intersections ?? [];
      await load();
      const clusters = clusterIntersections(lastIxs);
      clusterOf.clear(); membersOf.clear();
      for (const c of clusters) { membersOf.set(c.key, c.members.map((m) => m.id)); for (const m of c.members) clusterOf.set(m.id, c.key); }
      for (const c of clusters) {
        const gaveUpKey = `${c.key}@${c.members.map((m) => `${m.lat},${m.lon}`).join(';')}`;
        if (queued.has(c.key) || gaveUp.has(gaveUpKey) || !streetsStale(entries.get(c.key), c, now())) continue;
        queued.add(c.key);
        queue.push({ key: c.key, gaveUpKey, members: c.members });
      }
      if (clusters.length) { // unreferenced entries (membership changed, intersection deleted, old per-junction format)
        for (const id of [...entries.keys()]) {
          if (membersOf.has(id) || queued.has(id)) continue;
          entries.delete(id);
          Promise.resolve(remove(id)).catch((e) => log(`${id}: couldn't delete`, e?.message ?? e));
        }
      }
      pump().catch((e) => log('pump failed', e?.message ?? e));
    },
    /** Back online: forget this session's give-ups and look again. */
    online() { gaveUp.clear(); return this.check(lastIxs); },
  };
}
