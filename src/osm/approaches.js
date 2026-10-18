// Which mapped head controls which street approach? Pure + DOM-free: the Live
// scene tints each controlled approach's last stretch with its head's colour.
//
// Street side: the `appr` records of src/osm/lanes.js (one per incoming road end:
// stop point + travel bearing) and the lanes tagged `a`. Onda side:
// intersections with masts. Masts are user-editable, so this is recomputed whenever
// they change (the scene caches it per entry + intersection signature), never per frame.

import { angularDiff } from '../nav/proximity.js';

const R = 6371000;
const RAD = Math.PI / 180;

// An Onda junction can span several small osm2streets intersections, so approaches are
// found by stop-line distance from the junction centre instead of by polygon.
export const APPROACH_RADIUS_M = 40;
// How far off "straight at the centre" an approach's travel direction may be. Wide
// enough for skewed or curving arms, far below 90° (= tangential / leaving).
export const INBOUND_TOL_DEG = 60;
// Same idea as headForApproach: the mast facing an approach sits on the side it comes
// from. 50° (a bit tighter than headForApproach's 60°) because here several approaches
// compete for the masts and a skewed side street should not borrow the main road's head.
export const MAST_TOL_DEG = 50;
// Near-side masts stand just before the stop line; one this far away is not its head.
export const MAST_MAX_DIST_M = 40;

const bearing = (e, n) => ((Math.atan2(e, n) / RAD) + 360) % 360;

/**
 * Local east/north metres of `pt` from `ref` (same projection as lanes.js compaction).
 * @param {{lat:number,lon:number}} pt @param {{lat:number,lon:number}} ref
 */
const toEN = (pt, ref) => ({ e: (pt.lon - ref.lon) * Math.cos(ref.lat * RAD) * R * RAD, n: (pt.lat - ref.lat) * R * RAD });

/**
 * Assign every approach near a mapped intersection to one of its heads.
 * An approach belongs to the nearest intersection centre within APPROACH_RADIUS_M, and to
 * the mast whose bearing from that centre best matches the approach's (centre -> stop
 * point), within MAST_TOL_DEG. A mast with several heads: the first one stands for the
 * whole approach. Approaches without a mast are reported as unmatched, never guessed.
 * @param {{layers:Array}} data  lanes entry data (src/osm/lanes.js)
 * @param {{lat:number,lon:number}} center  the entry's centre (cm positions are relative to it)
 * @param {Array<{id:string, location:{lat:number,lon:number}, masts?:Array<{id:string,pos?:{lat:number,lon:number},headIds?:string[]}>}>} ixs
 * @returns {{matches:Array<{ixId:string, headId:string, mastId:string, layer:number, appr:number, lanes:number[], x:number, y:number, bearing:number, way:number}>,
 *            unmatched:Array<{ixId:string, layer:number, appr:number, x:number, y:number, way:number}>}}
 *   x/y: stop point, metres east/north of `center`; bearing: travel direction (compass deg); lanes: indices into layers[layer].lanes
 */
export function matchApproaches(data, center, ixs) {
  const matches = [], unmatched = [];
  const cs = (ixs ?? []).filter((ix) => Number.isFinite(ix?.location?.lat) && Number.isFinite(ix.location.lon)).map((ix) => ({
    id: ix.id, ...toEN(ix.location, center),
    masts: (ix.masts ?? []).filter((m) => m.pos && m.headIds?.length).map((m) => ({ id: m.id, head: m.headIds[0], ...toEN(m.pos, center) })),
  }));
  data?.layers?.forEach((l, li) => {
    if (!l.appr?.length) return;
    const lanesOf = new Map();
    l.lanes.forEach((ln, i) => { if (ln.a != null) { if (!lanesOf.has(ln.a)) lanesOf.set(ln.a, []); lanesOf.get(ln.a).push(i); } });
    l.appr.forEach(([cx, cy, b, way], ai) => {
      const x = cx / 100, y = cy / 100;
      let ix = null, ixD = APPROACH_RADIUS_M;
      for (const c of cs) { const d = Math.hypot(x - c.e, y - c.n); if (d <= ixD) { ix = c; ixD = d; } }
      if (!ix) return;
      // Inbound only: a lane that ends INSIDE a junction (the short link between two of its
      // osm2streets polygons, already past the real stop line) heads away from the centre.
      if (angularDiff(b, bearing(ix.e - x, ix.n - y)) > INBOUND_TOL_DEG) return;
      const want = bearing(x - ix.e, y - ix.n);
      let best = null, bestA = Infinity;
      for (const m of ix.masts) {
        if (Math.hypot(x - m.e, y - m.n) > MAST_MAX_DIST_M) continue;
        const a = angularDiff(bearing(m.e - ix.e, m.n - ix.n), want);
        if (a < bestA) { bestA = a; best = m; }
      }
      const rec = { ixId: ix.id, layer: li, appr: ai, x, y, way };
      if (best && bestA <= MAST_TOL_DEG) matches.push({ ...rec, headId: best.head, mastId: best.id, lanes: lanesOf.get(ai) ?? [], bearing: b });
      else unmatched.push(rec);
    });
  });
  return { matches, unmatched };
}
