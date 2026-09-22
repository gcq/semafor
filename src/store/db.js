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
const DB_VERSION = 2;

let _db = null;
/** @returns {Promise<IDBDatabase>} */
function open() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('intersections'))
        db.createObjectStore('intersections', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('observations')) {
        const os = db.createObjectStore('observations', { keyPath: 'id' });
        os.createIndex('byIntersection', 'intersectionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('tombstones'))
        db.createObjectStore('tombstones', { keyPath: 'id' }); // deleted intersection + observation ids
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
export const putIntersection = (ix) => tx('intersections', 'readwrite', (s) => { s.intersections.put(ix); });
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

export const observationsFor = (intersectionId) =>
  tx('observations', 'readonly', (s) => reqValue(s.observations.index('byIntersection').getAll(intersectionId)));

/** All observations grouped by intersection id. */
export async function allObservationsByIntersection() {
  const all = await tx('observations', 'readonly', (s) => reqValue(s.observations.getAll()));
  const by = {};
  for (const o of all) (by[o.intersectionId] ??= []).push(o);
  return by;
}

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
  const [intersections, observations, tombstones] = await tx(['intersections', 'observations', 'tombstones'], 'readonly', (s) => {
    const a = reqValue(s.intersections.getAll()), b = reqValue(s.observations.getAll()), c = reqValue(s.tombstones.getAll());
    const box = {};
    Object.defineProperty(box, '_result', { get: () => [a._result, b._result, c._result] });
    return box;
  });
  return { version: 2, exportedAt: Date.now(), intersections, observations, tombstones };
}

/**
 * Import a bundle. Default merges exactly like sync (newest edit wins,
 * tombstones honored); `merge:false` replaces everything with the bundle.
 */
export async function importAll(bundle, { merge = true } = {}) {
  if (merge) return applyMerged(mergeBundles(await exportAll(), bundle).merged);
  await tx(['intersections', 'observations', 'tombstones'], 'readwrite', (s) => {
    s.intersections.clear(); s.observations.clear(); s.tombstones.clear();
  });
  return applyMerged({ intersections: bundle.intersections ?? [], observations: bundle.observations ?? [], tombstones: bundle.tombstones ?? [] });
}

/**
 * Overwrite storage with an already-reconciled bundle (from sync/import), in one
 * transaction: intersections become exactly `merged.intersections`, new
 * observations are added, tombstoned observations removed, tombstones unioned.
 */
export function applyMerged(merged) {
  const keep = new Set((merged.intersections ?? []).map((i) => i.id));
  const deadObs = new Set((merged.tombstones ?? []).filter((t) => t.kind === 'obs').map((t) => t.id));
  return tx(['intersections', 'observations', 'tombstones'], 'readwrite', (s) => {
    const ixKeys = s.intersections.getAllKeys();
    ixKeys.onsuccess = () => {
      for (const id of ixKeys.result) if (!keep.has(id)) s.intersections.delete(id);
      for (const ix of merged.intersections ?? []) s.intersections.put(ix);
    };
    const obsKeys = s.observations.getAllKeys();
    obsKeys.onsuccess = () => {
      const have = new Set(obsKeys.result);
      for (const o of merged.observations ?? []) if (!have.has(o.id) && !deadObs.has(o.id)) s.observations.put(o);
      for (const id of deadObs) if (have.has(id)) s.observations.delete(id);
    };
    for (const t of merged.tombstones ?? []) s.tombstones.put(t);
  });
}
