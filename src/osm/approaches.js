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
 * An approach belongs to the nearest intersection centre within APPROACH_RADIUS_M that it heads at, and to
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
      // Inbound only: a lane that ends INSIDE a junction (the short link between two of its
      // osm2streets polygons, already past the real stop line) heads away from the centre.
      // Among the centres it heads at, the nearest: a stop line between two junctions belongs
      // to the one ahead of it, not to the (slightly) nearer one it has just left behind.
      let ix = null, ixD = APPROACH_RADIUS_M;
      for (const c of cs) {
        const d = Math.hypot(x - c.e, y - c.n);
        if (d <= ixD && angularDiff(b, bearing(c.e - x, c.n - y)) <= INBOUND_TOL_DEG) { ix = c; ixD = d; }
      }
      if (!ix) return;
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

// ---------- which head am I on? (Live's active head) ----------
// Bearing from the junction centre can't tell two PARALLEL one-way roads apart, so the active head
// comes from the approach you are actually driving on: the matched approaches (above) whose lane
// polygons you are in / closest to. Pure; the app feeds it one smoothed-or-raw fix at a time.
export const PICK = {
  courseTol: 45,   // an approach counts only if its travel bearing is this close to your course
  maxDist: 20,     // ... and its lanes are within this many m of you, else the caller falls back to bearings
  switchMargin: 2, // a rival must be this much closer (m) ...
  switchFixes: 2,  // ... for this many consecutive fixes to take over (GPS noise between parallel roads)
  latchM: 12,      // this close to (before) your approach's stop point the pick is frozen
  crossM: 2,       // past the stop line by this much = crossed (a noisy fix right on the line isn't)
  crossFixes: 2,   // ... on this many consecutive fixes: 5-10 m of GPS noise throws one fix across the line while you still queue before it,
  crossClearM: 10, // ... unless a single fix is this far past it (beyond any noise: fast traffic must not wait a whole extra fix)
  nextMax: 80,     // the next approach ahead: stop point 3..80 m ahead along your course,
  nextMin: 3,
  nextLat: 20,     // ... at most this far to the side; nearest by along + nextSide * side, so a parallel road's line loses
  nextSide: 3,
  reachM: 25,     // lane polygons are only the last ~40-55 m of a road: the approach's axis is extended this far back
  releaseM: 60,    // this far past the junction centre a passed approach gives way to any lane you are on
};

const sig = (ixs) => ixs.map((i) => `${i.id}@${i.location?.lat},${i.location?.lon}:${(i.masts ?? []).map((m) => `${m.id}/${m.pos?.lat},${m.pos?.lon}/${(m.headIds ?? []).join()}`).join(';')}`).sort().join('|');
const setCache = new WeakMap();

/** Metres east/north of `ref`. Same projection as the lanes. */
export const toLocal = toEN;

/**
 * Ground-level approaches of the given intersections with their lane polygons, in metres
 * east/north of the entry centre. Cached per streets entry + masts.
 * @param {{kind?:string, center:{lat:number,lon:number}, data:{layers:Array}}|null} streets  cache entry (src/osm/lanes-cache.js)
 * @returns {{cands:Array<{key:string, ixId:string, headId:string, mastId:string, way:number, x:number, y:number, bearing:number, dx:number, dy:number, rings:number[][], ext:number[]|null}>, centres:Map<string,{e:number,n:number}>}|null}
 */
export function approachCandidates(streets, ixs) {
  if (streets?.kind !== 'lanes' || !streets.data?.layers?.length) return null;
  const s = sig(ixs), hit = setCache.get(streets);
  if (hit?.sig === s) return hit.set;
  const layers = streets.data.layers;
  const cands = matchApproaches(streets.data, streets.center, ixs).matches
    .filter((m) => layers[m.layer].z === 0 && m.lanes.length)
    .map((m) => {
      const rings = m.lanes.map((i) => layers[m.layer].lanes[i].r.map((v) => v / 100));
      // the polygon vertex furthest back from the stop point, and the same axis carried on
      let fx = m.x, fy = m.y, fd = 0;
      for (const r of rings) for (let i = 0; i < r.length; i += 2) { const d = Math.hypot(r[i] - m.x, r[i + 1] - m.y); if (d > fd) { fd = d; fx = r[i]; fy = r[i + 1]; } }
      const ext = fd > 1 ? [fx, fy, fx + ((fx - m.x) / fd) * PICK.reachM, fy + ((fy - m.y) / fd) * PICK.reachM] : null;
      return {
        key: `${m.ixId}:${m.layer}:${m.appr}`, ixId: m.ixId, headId: m.headId, mastId: m.mastId, way: m.way, x: m.x, y: m.y, bearing: m.bearing,
        dx: Math.sin(m.bearing * RAD), dy: Math.cos(m.bearing * RAD), rings, ext,
      };
    });
  const centres = new Map(ixs.filter((i) => Number.isFinite(i?.location?.lat)).map((i) => [i.id, toEN(i.location, streets.center)]));
  const set = { cands, centres };
  setCache.set(streets, { sig: s, set });
  return set;
}

const segDist = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2)) : 0;
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
};
/** Distance from a point to a flat [x0,y0,x1,y1,…] polygon (closed implicitly); 0 inside. */
export function ringDist(r, px, py) {
  let inside = false, best = Infinity;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const ax = r[j], ay = r[j + 1], bx = r[i], by = r[i + 1];
    if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
    best = Math.min(best, segDist(px, py, ax, ay, bx, by));
  }
  return inside ? 0 : best;
}

const laneDist = (c, p) => c.rings.reduce((d, r) => Math.min(d, ringDist(r, p.e, p.n)), c.ext ? segDist(p.e, p.n, ...c.ext) : Infinity);
// metres past the approach's stop point along its own travel direction (> 0 = crossed the stop line)
const along = (c, p) => (p.e - c.x) * c.dx + (p.n - c.y) * c.dy;

/**
 * The next approach ahead of you: stop point 3..80 m ahead along `course`, within 45° of it
 * and at most 20 m to the side; lowest along + 3 * side wins (a parallel road's stop line a few
 * metres to the side doesn't beat the next one on your own road). `skip`: the approach you just crossed.
 */
export function nextApproachAhead(set, ego, course, skipKey) {
  if (!set || course == null) return null;
  const ux = Math.sin(course * RAD), uy = Math.cos(course * RAD);
  let best = null, bestA = Infinity;
  for (const c of set.cands) {
    if (c.key === skipKey || angularDiff(c.bearing, course) > PICK.courseTol) continue;
    const dx = c.x - ego.e, dy = c.y - ego.n, a = dx * ux + dy * uy, side = Math.abs(dx * uy - dy * ux);
    const score = a + PICK.nextSide * side;
    if (a < PICK.nextMin || a > PICK.nextMax || side > PICK.nextLat || score >= bestA) continue;
    best = c; bestA = score;
  }
  return best;
}

/**
 * One fix of the head picker for junction `ixId`. Idempotent per `fixId` (call it as often as
 * you like; hysteresis counts distinct fixes). Returns the new state (pass it back as `prev`):
 *  reason 'lane'    the approach you're on (nearest lanes, hysteresis),
 *         'latched' within latchM of its stop point (or past it for fewer than crossFixes fixes): frozen, no re-pick,
 *         'passed'  you crossed its stop line: head kept only until something ahead takes over;
 *                   `nextIxId` = the junction of the next approach ahead (null = nothing ahead),
 *         'bearing' no usable approach: the caller falls back to bearings (headId null).
 * @param {{set:ReturnType<typeof approachCandidates>, ixId:string, ego:{e:number,n:number}|null, course:number|null, prev:Object|null, fixId:any}} o
 */
export function pickHead({ set, ixId, ego, course, prev, fixId }) {
  if (prev && prev.fixId === fixId && prev.ixId === ixId) return prev;
  const done = (o) => ({ key: null, headId: null, strike: null, nextIxId: null, ...o, fixId, ixId });
  if (!set || !ego || course == null) return done({ reason: 'bearing' });

  // the approach you're on: nearest lanes of this junction's approaches within 45° of your course, with hysteresis
  const lanes = (cur) => {
    const list = [];
    for (const c of set.cands) {
      if (c.ixId !== ixId || angularDiff(c.bearing, course) > PICK.courseTol || along(c, ego) > PICK.crossM) continue;
      const d = laneDist(c, ego);
      if (d <= PICK.maxDist) list.push({ c, d });
    }
    if (!list.length) return done({ reason: 'bearing' });
    const best = list.reduce((a, b) => (b.d < a.d ? b : a));
    const was = cur && list.find((o) => o.c.key === cur.key);
    let pick = best, strike = null;
    if (was && best.c.key !== was.c.key) {
      if (was.d - best.d > PICK.switchMargin) {
        const n = (cur.strike?.key === best.c.key ? cur.strike.n : 0) + 1;
        if (n >= PICK.switchFixes) pick = best; else { pick = was; strike = { key: best.c.key, n }; }
      } else pick = was;
    }
    return done({ key: pick.c.key, headId: pick.c.headId, reason: 'lane', strike });
  };

  let cur = prev?.ixId === ixId ? prev : null;
  const P = cur?.key ? set.cands.find((c) => c.key === cur.key) : null;
  if (cur && !P) cur = null;
  if (!cur) return lanes(null);

  if (cur.reason === 'passed') {
    // far past the junction a real approach (coming back, another road) takes over; else the passed head stays (no flicker)
    const centre = set.centres.get(ixId);
    if (centre && Math.hypot(ego.e - centre.e, ego.n - centre.n) > PICK.releaseM) { const r = lanes(null); if (r.headId) return r; }
  }
  if (cur.reason !== 'passed' && along(P, ego) > PICK.crossM && along(P, ego) < PICK.crossClearM) { // just past the line: only a run of such fixes counts as crossed
    const n = (cur.cross ?? 0) + 1;
    if (n < PICK.crossFixes) return done({ key: P.key, headId: P.headId, reason: 'latched', cross: n });
  }
  if (cur.reason === 'passed' || along(P, ego) > PICK.crossM) { // crossed its stop line: move on to the next approach ahead
    const next = nextApproachAhead(set, ego, course, P.key);
    if (next?.ixId === ixId) return done({ key: next.key, headId: next.headId, reason: 'lane' });
    return done({ key: P.key, headId: P.headId, reason: 'passed', nextIxId: next?.ixId ?? null });
  }
  if (along(P, ego) > -PICK.latchM) return done({ key: P.key, headId: P.headId, reason: 'latched' });
  return lanes(cur);
}
