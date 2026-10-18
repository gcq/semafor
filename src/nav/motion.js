// Smooth Live motion between ~1 Hz GPS fixes. Pure helpers; the render loop owns the state.
// Positions are {lat, lon}; time in ms (fix.t, nowMs share a clock), angles in degrees.

const M_PER_DEG = 111320;
const RAD = Math.PI / 180;

/**
 * Where we are `nowMs` given the last fix: extrapolate along its course at its speed,
 * at most `maxS` seconds; with no course or (almost) no speed, hold the fix.
 * @param {{lat:number, lon:number, speed:number, course:number|null, t:number}|null} fix
 */
export function deadReckon(fix, nowMs, maxS = 1.5) {
  if (!fix) return null;
  if (fix.course == null || !(fix.speed >= 0.5)) return { lat: fix.lat, lon: fix.lon };
  const d = fix.speed * Math.min(maxS, Math.max(0, (nowMs - fix.t) / 1000));
  const lat = fix.lat + (d * Math.cos(fix.course * RAD)) / M_PER_DEG;
  return { lat, lon: fix.lon + (d * Math.sin(fix.course * RAD)) / (M_PER_DEG * Math.cos(fix.lat * RAD)) };
}

/** Offset (displayed − target) between two positions, as degree deltas. */
export const offsetBetween = (shown, target) => ({ dlat: shown.lat - target.lat, dlon: shown.lon - target.lon });

/** Let a blend offset die out exponentially (≈ 95 % gone after 3·tau). */
export function decayOffset(off, dtS, tau = 0.15) {
  const k = Math.exp(-Math.max(0, dtS) / tau);
  return { dlat: off.dlat * k, dlon: off.dlon * k };
}

export const applyOffset = (target, off) => ({ lat: target.lat + off.dlat, lon: target.lon + off.dlon });

/** Ease a bearing toward `target` along the shortest arc (first-order, time constant tau). */
export function easeAngle(cur, target, dtS, tau = 0.5) {
  const diff = ((target - cur + 540) % 360) - 180;
  return (cur + diff * (1 - Math.exp(-Math.max(0, dtS) / tau)) + 360) % 360;
}
