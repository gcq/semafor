// Which intersection am I about to hit?
//
// No routes. Given live GPS (position, heading, speed) we keep only the
// intersections that lie ahead in a forward cone and rank them by ETA. When
// stationary (heading is null/speed ~0) we fall back to nearest-by-distance.
//
// Pure geometry. Angles in degrees, distances in metres, speed in m/s.

/** @typedef {import('../domain/model.js').Intersection} Intersection */
/** @typedef {import('../domain/model.js').GeoPoint} GeoPoint */

const R = 6371000; // earth radius, m
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in metres. @param {GeoPoint} a @param {GeoPoint} b */
export function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing from a to b, degrees 0..360. */
export function bearingDeg(a, b) {
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0..180. */
export function angularDiff(a, b) {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
}

/**
 * Rank intersections by how likely you are to reach them next.
 * @param {GeoPoint} pos
 * @param {number|null} heading  travel heading in deg, or null if unknown
 * @param {number} speed         m/s (0 if stationary)
 * @param {Intersection[]} intersections
 * @param {Object} [opts]
 * @param {number} [opts.coneHalfAngle=60]  forward cone half-width, deg
 * @param {number} [opts.maxDistanceM=3000] ignore anything further than this
 * @param {number} [opts.minSpeed=1.5]      below this we treat as stationary
 * @returns {Array<{ intersection: Intersection, distanceM: number, bearing: number, offAxis: number, etaSec: number|null }>}
 */
export function rankNext(pos, heading, speed, intersections, opts = {}) {
  const coneHalfAngle = opts.coneHalfAngle ?? 60;
  const maxDistanceM = opts.maxDistanceM ?? 3000;
  const minSpeed = opts.minSpeed ?? 1.5;
  const moving = heading != null && speed >= minSpeed;

  const rows = intersections
    .map((ix) => {
      const d = distanceM(pos, ix.location);
      const brg = bearingDeg(pos, ix.location);
      const offAxis = moving ? angularDiff(heading, brg) : 0;
      return {
        intersection: ix,
        distanceM: d,
        bearing: brg,
        offAxis,
        etaSec: moving ? d / speed : null,
      };
    })
    .filter((r) => r.distanceM <= maxDistanceM)
    .filter((r) => (moving ? r.offAxis <= coneHalfAngle : true));

  // Moving: soonest ETA first (offAxis breaks ties). Stationary: nearest first.
  rows.sort((a, b) =>
    moving ? a.etaSec - b.etaSec || a.offAxis - b.offAxis : a.distanceM - b.distanceM,
  );
  return rows;
}

/**
 * Pick the approach whose travel bearing best matches the current heading, so
 * we show the right signal group without the driver choosing.
 * @param {Intersection} ix
 * @param {number|null} heading
 * @returns {import('../domain/model.js').Approach | null}
 */
export function pickApproach(ix, heading) {
  if (!ix.approaches?.length) return null;
  if (heading == null) return ix.approaches[0];
  return ix.approaches.reduce((best, a) =>
    angularDiff(a.bearing, heading) < angularDiff(best.bearing, heading) ? a : best,
  );
}

/**
 * The head facing you as you approach `ix` travelling on `approachBearing`.
 * Spanish lights are near-side (before the stop line), so the mast that faces
 * you sits on the side of the junction you are coming FROM: its bearing from the
 * centre is ≈ approachBearing + 180. Returns that mast's first head, or null if
 * no mast is within `tolDeg` (or masts lack positions).
 * @param {Intersection} ix
 * @param {number|null} approachBearing  deg, direction of travel toward the junction
 * @param {number} [tolDeg=60]
 * @returns {string|null} headId
 */
export function headForApproach(ix, approachBearing, tolDeg = 60) {
  if (approachBearing == null || !ix?.location) return null;
  const want = (approachBearing + 180) % 360;
  let best = null, bestD = Infinity;
  for (const m of ix.masts ?? []) {
    if (!m.pos || !m.headIds?.length) continue;
    const d = angularDiff(bearingDeg(ix.location, m.pos), want);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best && bestD <= tolDeg ? best.headIds[0] : null;
}
