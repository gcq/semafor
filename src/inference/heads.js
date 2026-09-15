// Head helpers for the observation-first model. Heads are AUTHORED (each
// movement carries a headId; grouping = merge, its own head = split). Nothing is
// derived from phase columns any more. Pure.

/** @typedef {import('../domain/model.js').Intersection} Intersection */

/** Movements controlled by a head. */
export const movementsOfHead = (ix, headId) =>
  ix.movements.filter((m) => !m.unsignalized && m.headId === headId);

/** A short label for a head, from its name or the movements it serves. */
export function headLabel(ix, headId) {
  const head = ix.heads.find((h) => h.id === headId);
  if (head?.name) return head.name;
  const armName = (id) => ix.arms.find((a) => a.id === id)?.name || id;
  const movs = movementsOfHead(ix, headId);
  if (!movs.length) return headId;
  return movs.map((m) => m.label || `${armName(m.from)}→${armName(m.to)}`).join(', ');
}

/**
 * Give every signalized movement its own head if it has none yet (safe default:
 * never silently merges). Mutates + returns the intersection. `mkId`/`mkName`
 * mint new heads.
 * @param {Intersection} ix
 */
export function ensureHeadsForMovements(ix, mkId, mkName) {
  ix.heads ??= [];
  const ids = new Set(ix.heads.map((h) => h.id));
  for (const m of ix.movements) {
    if (m.unsignalized) continue;
    if (!m.headId || !ids.has(m.headId)) {
      const id = mkId();
      ix.heads.push({ id, name: mkName ? mkName(ix.heads.length) : '' });
      ids.add(id);
      m.headId = id;
    }
  }
  // prune heads no movement references
  const used = new Set(ix.movements.filter((m) => !m.unsignalized).map((m) => m.headId));
  ix.heads = ix.heads.filter((h) => used.has(h.id));
  return ix;
}

/**
 * Keep masts consistent with the head set: drop dead head ids (and empty masts),
 * and give every head at least one mast (auto-seed one per orphan). Pure.
 * @param {Array<{id:string,pos:any,headIds:string[]}>} masts
 * @param {string[]} headIds
 * @param {(i:number,total:number)=>any} seedPos
 * @param {()=>string} mkId
 */
export function reconcileMasts(masts, headIds, seedPos, mkId) {
  const valid = new Set(headIds);
  // Mutate in place so surviving masts keep their identity AND their dragged
  // position across re-renders (cloning here was dropping saved positions).
  const kept = (masts ?? []).filter((m) => {
    m.headIds = m.headIds.filter((k) => valid.has(k));
    return m.headIds.length > 0;
  });
  const shown = new Set(kept.flatMap((m) => m.headIds));
  const orphans = headIds.filter((id) => !shown.has(id));
  orphans.forEach((id) => kept.push({ id: mkId(), pos: seedPos(kept.length, kept.length + orphans.length), headIds: [id] }));
  return kept;
}
