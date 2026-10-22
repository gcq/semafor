// Where the Live arrow is drawn: GPS is good to 5-10 m, a road is 3-4 m a lane, so the raw
// fix often lands on a sidewalk or parking strip beside the road you are on. Pure + DOM-free.
// The drawn position moves onto the nearest driving lane that runs your way; with none close
// enough (or no course, or you are inside a junction) it stays the raw fix.

import { angularDiff } from '../nav/proximity.js';
import { ringDist, toLocal } from './approaches.js';

const R = 6371000;
const RAD = Math.PI / 180;

export const SNAP = {
  maxM: 5,      // a lane further than this from the fix is not "the road you are on"
  courseTol: 45,  // ... and it must run within this many degrees of your course (not the oncoming lane)
  insetM: 0.4,    // the snapped point sits this far inside the lane, not on its edge
};

const geoCache = new WeakMap();
// Ground-level driving lanes that know their direction, and the junction polygons: rings in metres east/north of the entry centre.
const geo = (streets) => {
  let g = geoCache.get(streets);
  if (!g) {
    const l0 = streets.data?.layers?.find((l) => l.z === 0), m = (r) => r.map((v) => v / 100);
    g = { lanes: (l0?.lanes ?? []).filter((ln) => ln.k === 'drive' && ln.b != null).map((ln) => ({ b: ln.b, r: m(ln.r) })), ints: (l0?.ints ?? []).map(m) };
    geoCache.set(streets, g);
  }
  return g;
};

/** Closest point of a flat polygon's outline to (px, py). */
function nearestOnRing(r, px, py) {
  let best = { d: Infinity, x: px, y: py, nx: 0, ny: 0 };
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const ax = r[j], ay = r[j + 1], vx = r[i] - ax, vy = r[i + 1] - ay, l2 = vx * vx + vy * vy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2)) : 0;
    const x = ax + t * vx, y = ay + t * vy, d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { d, x, y, nx: -vy / (Math.sqrt(l2) || 1), ny: vx / (Math.sqrt(l2) || 1) };
  }
  return best;
}

/**
 * `pos` moved onto the nearest driving lane of `streets` heading your way (within SNAP.maxM,
 * SNAP.courseTol of `course`); `pos` itself when already on such a lane, or when nothing fits.
 * @param {{kind?:string, center:{lat:number,lon:number}, data:{layers:Array}}|null} streets  cache entry (src/osm/lanes-cache.js)
 * @param {{lat:number,lon:number}|null} pos @param {number|null} course  deg
 */
export function snapToLane(streets, pos, course) {
  if (!pos || course == null || streets?.kind !== 'lanes') return pos;
  const p = toLocal(pos, streets.center);
  const { lanes, ints } = geo(streets);
  if (ints.some((r) => ringDist(r, p.e, p.n) === 0)) return pos; // inside a junction there is no lane to be on (and no snapping across it)
  let best = null, bestD = SNAP.maxM;
  for (const ln of lanes) {
    if (angularDiff(ln.b, course) > SNAP.courseTol) continue;
    const d = ringDist(ln.r, p.e, p.n);
    if (d === 0) return pos;
    if (d < bestD) { bestD = d; best = ln; }
  }
  if (!best) return pos;
  const q = nearestOnRing(best.r, p.e, p.n);
  // step inwards: the outline normal points one way or the other (or, at a corner, towards the middle)
  const mid = best.r.reduce((m, v, i) => (i % 2 ? { ...m, n: m.n + v / (best.r.length / 2) } : { ...m, e: m.e + v / (best.r.length / 2) }), { e: 0, n: 0 });
  const toMid = Math.hypot(mid.e - q.x, mid.n - q.y) || 1;
  const inside = [[q.nx, q.ny], [-q.nx, -q.ny], [(mid.e - q.x) / toMid, (mid.n - q.y) / toMid]]
    .map(([ux, uy]) => ({ e: q.x + ux * SNAP.insetM, n: q.y + uy * SNAP.insetM })).find((c) => ringDist(best.r, c.e, c.n) === 0);
  if (!inside) return pos;
  const c = streets.center;
  return { lat: c.lat + inside.n / (R * RAD), lon: c.lon + inside.e / (R * RAD * Math.cos(c.lat * RAD)) };
}
