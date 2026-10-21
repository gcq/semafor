// Storage: everything lives in the browser. IndexedDB holds intersections and
// the raw observation log (which can grow large); localStorage holds tiny prefs.
// No server, ever. Import/export is plain JSON so a model can be shared as a
// file, a QR, or a URL hash without any backend.
//
// One connection is opened lazily and reused (it used to open a new one per
// operation), and bulk writes (sync/import) go through a single transaction that
// only writes what's actually new — sync runs every few seconds in the car.

import { mergeBundles } from '../sync/merge.js';

const DB_NAME = 'onda';
const DB_VERSION = 6;

// `plans` / `headPositions` on an intersection are derived data from old
// versions (the clock model recomputes timing from taps alone). Strip them
// wherever intersections enter or leave storage. rev/updatedAt are left alone
// on purpose: stripping is not an edit, so it must never win or lose a sync
// compare (sync decisions look at rev/updatedAt/ids, never at content). Returns
// the same object when there is nothing to strip.
const LEGACY_FIELDS = ['plans', 'headPositions'];
const stripLegacy = (ix) => {
  if (!ix || !LEGACY_FIELDS.some((f) => f in ix)) return ix;
  const { plans, headPositions, ...rest } = ix;
  return rest;
};

let _db = null;
/** @returns {Promise<IDBDatabase>} */
function open() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('intersections'))
        db.createObjectStore('intersections', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('observations')) {
        const os = db.createObjectStore('observations', { keyPath: 'id' });
        os.createIndex('byIntersection', 'intersectionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('tombstones'))
        db.createObjectStore('tombstones', { keyPath: 'id' }); // deleted intersection + observation ids
      // Derived data only: never exported, never synced, safe to drop at any time.
      if (!db.objectStoreNames.contains('modelCache'))
        db.createObjectStore('modelCache', { keyPath: 'key' });
      // v5: street geometry (osm2streets lanes / plain lines) per junction cluster. Derived, same rules.
      if (!db.objectStoreNames.contains('streets'))
        db.createObjectStore('streets', { keyPath: 'id' });
      // v6: GPS tracks around taps and dismissed re-file suggestions. Both sync (immutable records, union by id).
      if (!db.objectStoreNames.contains('tracks'))
        db.createObjectStore('tracks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('dismissals'))
        db.createObjectStore('dismissals', { keyPath: 'id' });
      // v4: one-time cleanup of legacy derived fields already stored
      if (ev.oldVersion > 0 && ev.oldVersion < 4) {
        const cur = req.transaction.objectStore('intersections').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          if (stripLegacy(c.value) !== c.value) c.update(stripLegacy(c.value));
          c.continue();
        };
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // another tab upgrading, or the browser closing it: reopen on next use
      db.onversionchange = () => { db.close(); _db = null; };
      db.onclose = () => { _db = null; };
      resolve(db);
    };
    req.onerror = () => { _db = null; reject(req.error); };
  });
  return _db;
}

// Run `fn(stores)` in one transaction over `names`; resolves with fn's box value
// once the transaction commits.
async function tx(names, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = Object.fromEntries([].concat(names).map((n) => [n, t.objectStore(n)]));
    const out = fn(stores);
    t.oncomplete = () => resolve(out?._result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqValue = (request) => {
  const box = {};
  request.onsuccess = () => { box._result = request.result; };
  return box;
};

export const allIntersections = () => tx('intersections', 'readonly', (s) => reqValue(s.intersections.getAll()));
// Saves always outrank what's stored: if sync brought in a newer rev while the
// editor was open, bumping the draft's stale rev would lose to it on next sync.
export const putIntersection = (ix) => tx('intersections', 'readwrite', (s) => {
  const cur = s.intersections.get(ix.id);
  cur.onsuccess = () => s.intersections.put({ ...stripLegacy(ix), rev: Math.max(ix.rev ?? 0, (cur.result?.rev ?? 0) + 1) });
});
export const allTombstones = () => tx('tombstones', 'readonly', (s) => reqValue(s.tombstones.getAll()));

export async function deleteIntersection(id) {
  const existing = await tx('intersections', 'readonly', (s) => reqValue(s.intersections.get(id)));
  // leave a tombstone so the delete propagates through sync instead of being
  // undone by an older copy on another device
  await tx(['intersections', 'tombstones'], 'readwrite', (s) => {
    s.intersections.delete(id);
    s.tombstones.put({ id, rev: (existing?.rev ?? 0) + 1, deletedAt: Date.now() });
  });
}

export const addObservation = (obs) => tx('observations', 'readwrite', (s) => { s.observations.add(obs); });

/** Remove an observation (undo) and tombstone it so sync doesn't bring it back. */
export const deleteObservation = (id) => tx(['observations', 'tombstones'], 'readwrite', (s) => {
  s.observations.delete(id);
  s.tombstones.put({ id, kind: 'obs', deletedAt: Date.now() });
});

/**
 * Re-file a tap (an accepted suggestion, same as tools/refile.mjs): the new observation is added and the
 * old id removed + tombstoned in ONE transaction, so there is never a moment with both or neither.
 */
export const refileObservation = (oldId, newObs, tombstone) => tx(['observations', 'tombstones'], 'readwrite', (s) => {
  s.observations.put(newObs);
  s.observations.delete(oldId);
  s.tombstones.put(tombstone);
});

// --- GPS tracks and dismissals (synced; see sync/merge.js) ---
export const putTrack = (rec) => tx('tracks', 'readwrite', (s) => { s.tracks.put(rec); });
export const allTracks = () => tx('tracks', 'readonly', (s) => reqValue(s.tracks.getAll()));
export const putDismissal = (d) => tx('dismissals', 'readwrite', (s) => { s.dismissals.put(d); });
export const allDismissals = () => tx('dismissals', 'readonly', (s) => reqValue(s.dismissals.getAll()));

/** Every observation as one flat list (the clock model is global). */
export const allObservations = () => tx('observations', 'readonly', (s) => reqValue(s.observations.getAll()));

// --- model cache (derived; one entry kept) ---
// FNV-1a fallback for non-secure contexts, where crypto.subtle is undefined.
function fnv1a(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0xabcdef;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Stable key over exactly the inputs the model reads: taps, map heads, algo version. */
export async function modelKey(observations, intersections, algoVersion) {
  const taps = [...observations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((o) => `${o.id},${o.t},${o.headId ?? ''},${o.aspect ?? ''}`).join(';');
  const map = [...intersections].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((i) => `${i.id}:${(i.heads ?? []).map((h) => h.id).sort().join(',')}`).join(';');
  const text = `${algoVersion}|${taps}|${map}`;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return 'sha256-' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return 'fnv-' + fnv1a(text) + text.length.toString(16); }
}

/** The cached { key, model } (at most one entry), or null. */
export const loadModelCache = async () => (await tx('modelCache', 'readonly', (s) => reqValue(s.modelCache.getAll())))?.[0] ?? null;
export const saveModelCache = (key, model) => tx('modelCache', 'readwrite', (s) => { s.modelCache.clear(); s.modelCache.put({ key, model }); });

// --- street geometry cache (derived; one entry per junction cluster, see osm/lanes-cache.js) ---
export const allStreets = () => tx('streets', 'readonly', (s) => reqValue(s.streets.getAll()));
export const putStreets = (entry) => tx('streets', 'readwrite', (s) => { s.streets.put(entry); });
export const deleteStreets = (id) => tx('streets', 'readwrite', (s) => { s.streets.delete(id); });

// --- prefs (localStorage, best-effort) ---
export function getPref(key, fallback = null) {
  try { const v = localStorage.getItem(`onda.${key}`); return v == null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}
export function setPref(key, value) {
  try { localStorage.setItem(`onda.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
}

// --- portability ---
export async function exportAll() {
  const [intersections, observations, tombstones, tracks, dismissals] = await tx(['intersections', 'observations', 'tombstones', 'tracks', 'dismissals'], 'readonly', (s) => {
    const rs = ['intersections', 'observations', 'tombstones', 'tracks', 'dismissals'].map((n) => reqValue(s[n].getAll()));
    const box = {};
    Object.defineProperty(box, '_result', { get: () => rs.map((r) => r._result) });
    return box;
  });
  const dead = new Set(tombstones.filter((t) => t.kind === 'obs').map((t) => t.id));
  return {
    version: 2, exportedAt: Date.now(), intersections: intersections.map(stripLegacy), observations, tombstones,
    tracks: tracks.filter((r) => !(r.obsIds ?? []).every((id) => dead.has(id))), // a track of undone / re-filed taps is not worth sending
    dismissals,
  };
}

/**
 * Import a bundle. Default merges exactly like sync (newest edit wins,
 * tombstones honored); `merge:false` replaces everything with the bundle.
 */
export async function importAll(bundle, { merge = true } = {}) {
  if (merge) return applyMerged(mergeBundles(await exportAll(), bundle).merged);
  await tx(['intersections', 'observations', 'tombstones', 'tracks', 'dismissals'], 'readwrite', (s) => {
    s.intersections.clear(); s.observations.clear(); s.tombstones.clear(); s.tracks.clear(); s.dismissals.clear();
  });
  return applyMerged({ intersections: bundle.intersections ?? [], observations: bundle.observations ?? [], tombstones: bundle.tombstones ?? [], tracks: bundle.tracks ?? [], dismissals: bundle.dismissals ?? [] });
}

/**
 * Write an already-reconciled bundle (from sync/import) in one transaction.
 * It's re-merged against what's stored *inside* the transaction, so a tap,
 * edit, new intersection or undo made after the bundle was read isn't clobbered.
 */
export function applyMerged(merged) {
  return tx(['intersections', 'observations', 'tombstones', 'tracks', 'dismissals'], 'readwrite', (s) => {
    const ix = s.intersections.getAll(), obsKeys = s.observations.getAllKeys(), tb = s.tombstones.getAll(), trk = s.tracks.getAll(), dis = s.dismissals.getAllKeys();
    let pending = 5;
    const done = () => {
      if (--pending) return;
      const have = new Set(obsKeys.result);
      const current = { intersections: ix.result, observations: [], tombstones: tb.result };
      const { merged: m } = mergeBundles(current, { ...merged, observations: [], tracks: [], dismissals: [] });
      const keep = new Set(m.intersections.map((i) => i.id));
      for (const i of ix.result) if (!keep.has(i.id)) s.intersections.delete(i.id);
      const before = new Map(ix.result.map((i) => [i.id, i]));
      for (const i of m.intersections) {
        const clean = stripLegacy(i);
        if (before.get(i.id) !== clean) s.intersections.put(clean);
      }
      const deadObs = new Set(m.tombstones.filter((t) => t.kind === 'obs').map((t) => t.id));
      for (const o of merged.observations ?? []) if (!have.has(o.id) && !deadObs.has(o.id)) s.observations.put(o);
      for (const id of deadObs) if (have.has(id)) s.observations.delete(id);
      for (const t of m.tombstones) s.tombstones.put(t);
      // tracks + dismissals: add what is new, drop tracks whose taps are all gone
      const gone = (r) => (r.obsIds ?? []).every((id) => deadObs.has(id));
      const haveTrk = new Set(trk.result.map((r) => r.id)), haveDis = new Set(dis.result);
      for (const r of merged.tracks ?? []) if (!haveTrk.has(r.id) && !gone(r)) s.tracks.put(r);
      for (const r of trk.result) if (gone(r)) s.tracks.delete(r.id);
      for (const d of merged.dismissals ?? []) if (!haveDis.has(d.id)) s.dismissals.put(d);
    };
    ix.onsuccess = obsKeys.onsuccess = tb.onsuccess = trk.onsuccess = dis.onsuccess = done;
  });
}
