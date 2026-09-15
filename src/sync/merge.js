// Reconciliation — decide what's kept when two instances meet. Serverless and
// symmetric: both sides run this on {local, remote} and converge to the same
// result, so "one takes from the other" happens in both directions at once.
//
// Rules:
//  - Observations are append-only historical facts with unique ids: KEEP ALL
//    (union by id). Nothing is ever lost, so the oldest data always survives.
//  - Intersections are mutable definitions: last edit wins, compared by `rev`
//    (a monotonic counter bumped on every save) with `updatedAt` as tiebreaker.
//  - Deletions propagate via tombstones (an id + when it was deleted), so a
//    delete on one device isn't undone by an older copy on the other.
//
// Pure. No transport here.

/** @typedef {import('../domain/model.js').Intersection} Intersection */
/** @typedef {import('../domain/model.js').Observation} Observation */
/** @typedef {{ id: string, deletedAt: number, rev: number }} Tombstone */
/** @typedef {{ intersections: Intersection[], observations: Observation[], tombstones?: Tombstone[] }} Bundle */

/** Which of two revisions is newer: higher rev wins, else newer updatedAt. */
export function newer(a, b) {
  const ra = a.rev ?? 0, rb = b.rev ?? 0;
  if (ra !== rb) return ra > rb ? a : b;
  return (a.updatedAt ?? 0) >= (b.updatedAt ?? 0) ? a : b;
}

/**
 * Merge two bundles into one convergent result.
 * @param {Bundle} local
 * @param {Bundle} remote
 * @returns {{ merged: Bundle, stats: { ixAdded: number, ixUpdated: number, ixDeleted: number, obsAdded: number } }}
 */
export function mergeBundles(local, remote) {
  const stats = { ixAdded: 0, ixUpdated: 0, ixDeleted: 0, obsAdded: 0 };

  // --- tombstones: newest delete per id wins ---
  const tombs = new Map();
  for (const t of [...(local.tombstones ?? []), ...(remote.tombstones ?? [])]) {
    const prev = tombs.get(t.id);
    if (!prev || t.deletedAt > prev.deletedAt) tombs.set(t.id, t);
  }

  // --- intersections: last edit wins, unless a newer tombstone deletes it ---
  const ix = new Map();
  for (const i of local.intersections ?? []) ix.set(i.id, i);
  for (const r of remote.intersections ?? []) {
    const cur = ix.get(r.id);
    if (!cur) { ix.set(r.id, r); stats.ixAdded++; }
    else { const win = newer(cur, r); if (win !== cur) { ix.set(r.id, win); stats.ixUpdated++; } }
  }
  for (const [id, t] of tombs) {
    const cur = ix.get(id);
    // a delete wins only if it's newer than the surviving edit
    if (cur && (t.rev ?? 0) >= (cur.rev ?? 0) && t.deletedAt >= (cur.updatedAt ?? 0)) {
      ix.delete(id); stats.ixDeleted++;
    }
  }

  // --- observations: union by id ---
  const obs = new Map();
  for (const o of local.observations ?? []) obs.set(o.id, o);
  for (const o of remote.observations ?? []) if (!obs.has(o.id)) { obs.set(o.id, o); stats.obsAdded++; }

  return {
    merged: { intersections: [...ix.values()], observations: [...obs.values()], tombstones: [...tombs.values()] },
    stats,
  };
}

/** A compact manifest for the wire: ids + versions, no payloads. */
export function manifest(bundle) {
  return {
    intersections: (bundle.intersections ?? []).map((i) => ({ id: i.id, rev: i.rev ?? 0, updatedAt: i.updatedAt ?? 0 })),
    observationIds: (bundle.observations ?? []).map((o) => o.id),
    tombstones: (bundle.tombstones ?? []).map((t) => ({ id: t.id, deletedAt: t.deletedAt, rev: t.rev ?? 0 })),
  };
}

/**
 * Given the peer's manifest, what does THIS bundle need to send so the peer can
 * merge? (The peer runs the same against ours — symmetric.)
 * @param {Bundle} local
 * @param {ReturnType<typeof manifest>} peer
 */
export function diffForPeer(local, peer) {
  const peerIx = new Map(peer.intersections.map((m) => [m.id, m]));
  const peerObs = new Set(peer.observationIds);
  const peerTomb = new Map(peer.tombstones.map((t) => [t.id, t]));
  return {
    intersections: (local.intersections ?? []).filter((i) => {
      const m = peerIx.get(i.id);
      if (!m) return true; // peer lacks it
      return newer(i, m) === i && ((i.rev ?? 0) !== m.rev || (i.updatedAt ?? 0) !== m.updatedAt); // ours is newer
    }),
    observations: (local.observations ?? []).filter((o) => !peerObs.has(o.id)),
    tombstones: (local.tombstones ?? []).filter((t) => {
      const m = peerTomb.get(t.id);
      return !m || t.deletedAt > m.deletedAt;
    }),
  };
}
