// Storage: everything lives in the browser. IndexedDB holds intersections and
// the raw observation log (which can grow large); localStorage holds tiny prefs.
// No server, ever. Import/export is plain JSON so a model can be shared as a
// file, a QR, or a URL hash without any backend.

const DB_NAME = 'onda';
const DB_VERSION = 2;

/** @returns {Promise<IDBDatabase>} */
function open() {
  return new Promise((resolve, reject) => {
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
        db.createObjectStore('tombstones', { keyPath: 'id' }); // deleted intersection ids
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    const out = fn(os);
    t.oncomplete = () => resolve(out?._result ?? out);
    t.onerror = () => reject(t.error);
  });
}

const reqValue = (request) => {
  const box = {};
  request.onsuccess = () => { box._result = request.result; };
  return box;
};

export async function allIntersections() {
  const db = await open();
  return tx(db, 'intersections', 'readonly', (os) => reqValue(os.getAll()));
}

export async function putIntersection(ix) {
  const db = await open();
  return tx(db, 'intersections', 'readwrite', (os) => os.put(ix));
}

export async function deleteIntersection(id) {
  const db = await open();
  const existing = await tx(db, 'intersections', 'readonly', (os) => reqValue(os.get(id)));
  await tx(db, 'intersections', 'readwrite', (os) => os.delete(id));
  // leave a tombstone so the delete propagates through sync instead of being
  // undone by an older copy on another device
  const t = { id, rev: (existing?.rev ?? 0) + 1, deletedAt: Date.now() };
  await tx(db, 'tombstones', 'readwrite', (os) => os.put(t));
}

export async function allTombstones() {
  const db = await open();
  return tx(db, 'tombstones', 'readonly', (os) => reqValue(os.getAll()));
}

export async function addObservation(obs) {
  const db = await open();
  return tx(db, 'observations', 'readwrite', (os) => os.add(obs));
}

export async function deleteObservation(id) {
  const db = await open();
  return tx(db, 'observations', 'readwrite', (os) => os.delete(id));
}

export async function observationsFor(intersectionId) {
  const db = await open();
  return tx(db, 'observations', 'readonly', (os) =>
    reqValue(os.index('byIntersection').getAll(intersectionId)),
  );
}

/** All observations grouped by intersection id. */
export async function allObservationsByIntersection() {
  const db = await open();
  const all = await tx(db, 'observations', 'readonly', (os) => reqValue(os.getAll()));
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
  const db = await open();
  const intersections = await allIntersections();
  const observations = await tx(db, 'observations', 'readonly', (os) => reqValue(os.getAll()));
  const tombstones = await allTombstones();
  return { version: 2, exportedAt: Date.now(), intersections, observations, tombstones };
}

export async function importAll(bundle, { merge = true } = {}) {
  const db = await open();
  if (!merge) {
    await tx(db, 'intersections', 'readwrite', (os) => os.clear());
    await tx(db, 'observations', 'readwrite', (os) => os.clear());
    await tx(db, 'tombstones', 'readwrite', (os) => os.clear());
  }
  for (const ix of bundle.intersections ?? []) await putIntersection(ix);
  for (const ob of bundle.observations ?? []) {
    try { await addObservation(ob); } catch { /* dupe id on merge */ }
  }
  for (const t of bundle.tombstones ?? []) await tx(db, 'tombstones', 'readwrite', (os) => os.put(t));
}

/**
 * Overwrite storage with an already-reconciled bundle (from sync). Intersections
 * become exactly `merged.intersections` (others removed), observations and
 * tombstones are unioned in.
 */
export async function applyMerged(merged) {
  const db = await open();
  const keep = new Set((merged.intersections ?? []).map((i) => i.id));
  const localIds = (await allIntersections()).map((i) => i.id);
  for (const id of localIds) if (!keep.has(id)) await tx(db, 'intersections', 'readwrite', (os) => os.delete(id));
  for (const ix of merged.intersections ?? []) await putIntersection(ix);
  for (const ob of merged.observations ?? []) { try { await addObservation(ob); } catch { /* dupe */ } }
  for (const t of merged.tombstones ?? []) await tx(db, 'tombstones', 'readwrite', (os) => os.put(t));
}
