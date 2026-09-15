// Correlating intersections: are two of them run by the same controller / on a
// coordinated plan, and if so what's the offset (the green-wave shift)?
//
// You define intersections independently. This is the tool's job: decide, from
// the estimated cycles, which ones are linked. The rule mirrors real signal
// coordination:
//   - LINKED if their cycle lengths match (within tolerance) AND the phase
//     offset between their clocks is stable across observation sessions.
//   - INDEPENDENT otherwise (different cycle, or a wandering offset = actuated
//     / free-running).
//
// Pure. Operates on CycleEstimates keyed by intersection id.

/** @typedef {import('./cycle.js').CycleEstimate} CycleEstimate */

const CYCLE_TOL_SEC = 3;     // cycle lengths within this are "the same"
const OFFSET_STABLE_SEC = 4; // offset spread under this is "stable"

/** Signed offset of B relative to A, folded into [0, cycle). */
function relativeOffset(aEpoch, bEpoch, cycleSec) {
  const cyc = cycleSec * 1000;
  return ((((bEpoch - aEpoch) % cyc) + cyc) % cyc) / 1000;
}

/**
 * @typedef {Object} LinkVerdict
 * @property {string} a
 * @property {string} b
 * @property {boolean} linked
 * @property {number} offsetSec       best-estimate B-vs-A offset (if linked)
 * @property {number} cycleLengthSec
 * @property {'low'|'medium'|'high'} confidence
 * @property {string} reason          human explanation for the UI
 */

/**
 * Compare two intersections' cycle estimates. For a stable-offset check you can
 * pass per-session estimates (same intersection, different days); with a single
 * estimate each we fall back to a cycle-match verdict at reduced confidence.
 * @param {string} aId
 * @param {CycleEstimate|CycleEstimate[]} a
 * @param {string} bId
 * @param {CycleEstimate|CycleEstimate[]} b
 * @returns {LinkVerdict}
 */
export function compareIntersections(aId, a, bId, b) {
  const as = Array.isArray(a) ? a : [a];
  const bs = Array.isArray(b) ? b : [b];
  const aCyc = median(as.map((e) => e.cycleLengthSec));
  const bCyc = median(bs.map((e) => e.cycleLengthSec));
  const cycleLengthSec = round1((aCyc + bCyc) / 2);

  if (Math.abs(aCyc - bCyc) > CYCLE_TOL_SEC) {
    return {
      a: aId, b: bId, linked: false, offsetSec: 0, cycleLengthSec,
      confidence: 'high',
      reason: `Different cycle lengths (${aCyc}s vs ${bCyc}s) — independent controllers.`,
    };
  }

  // Pair estimates across sessions to measure offset stability.
  const pairs = Math.min(as.length, bs.length);
  const offsets = [];
  for (let i = 0; i < pairs; i++) offsets.push(relativeOffset(as[i].epoch, bs[i].epoch, cycleLengthSec));
  const offsetSpread = offsets.length > 1 ? spread(offsets, cycleLengthSec) : null;
  const offsetSec = round1(circularMean(offsets, cycleLengthSec));

  if (offsetSpread == null) {
    // One session each: the offset is defined but a single window can't tell a
    // real coordination from two independent controllers that happen to share a
    // cycle. Trust it a bit more (medium) when both inputs are authoritative.
    const bothConfident = worstLevel(as) === 'high' && worstLevel(bs) === 'high';
    return {
      a: aId, b: bId, linked: true, offsetSec, cycleLengthSec,
      confidence: bothConfident ? 'medium' : 'low',
      reason: bothConfident
        ? `Same cycle (~${cycleLengthSec}s) and a defined ~${offsetSec}s offset — looks coordinated. Based on a single window; a second pass rules out coincidence.`
        : `Cycle lengths match (~${cycleLengthSec}s); only one session each, so offset (~${offsetSec}s) is unconfirmed. Capture another pass to confirm.`,
    };
  }

  if (offsetSpread <= OFFSET_STABLE_SEC) {
    return {
      a: aId, b: bId, linked: true, offsetSec, cycleLengthSec,
      confidence: offsets.length >= 3 ? 'high' : 'medium',
      reason: `Same cycle (~${cycleLengthSec}s) and a stable ~${offsetSec}s offset across ${offsets.length} sessions — coordinated (green wave).`,
    };
  }

  return {
    a: aId, b: bId, linked: false, offsetSec, cycleLengthSec,
    confidence: 'medium',
    reason: `Cycle lengths match but the offset drifts (±${round1(offsetSpread)}s) — likely actuated / free-running, not coordinated.`,
  };
}

/**
 * Cluster a set of intersections into corridors of linked ones (transitive).
 * @param {Record<string, CycleEstimate|CycleEstimate[]>} estimates
 * @returns {{ corridors: string[][], verdicts: LinkVerdict[] }}
 */
export function findCorridors(estimates) {
  const ids = Object.keys(estimates);
  const verdicts = [];
  const parent = Object.fromEntries(ids.map((id) => [id, id]));
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (x, y) => { parent[find(x)] = find(y); };

  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const v = compareIntersections(ids[i], estimates[ids[i]], ids[j], estimates[ids[j]]);
      verdicts.push(v);
      if (v.linked && v.confidence !== 'low') union(ids[i], ids[j]);
    }

  const groups = {};
  for (const id of ids) (groups[find(id)] ??= []).push(id);
  return { corridors: Object.values(groups).filter((g) => g.length > 1), verdicts };
}

// --- small circular-stats helpers (offsets live on a ring of length cycle) ---
const round1 = (x) => Math.round(x * 10) / 10;
const LEVEL_RANK = { low: 0, medium: 1, high: 2 };
/** Worst (lowest) confidence level across a set of estimates. */
function worstLevel(estimates) {
  let worst = 'high';
  for (const e of estimates) {
    const l = e.confidence?.level ?? 'low';
    if (LEVEL_RANK[l] < LEVEL_RANK[worst]) worst = l;
  }
  return worst;
}
function median(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function circularMean(vals, period) {
  if (!vals.length) return 0;
  let sx = 0, sy = 0;
  for (const v of vals) { const a = (v / period) * 2 * Math.PI; sx += Math.cos(a); sy += Math.sin(a); }
  const ang = Math.atan2(sy / vals.length, sx / vals.length);
  return ((ang / (2 * Math.PI)) * period + period) % period;
}
function spread(vals, period) {
  const m = circularMean(vals, period);
  const devs = vals.map((v) => {
    const d = Math.abs(v - m);
    return Math.min(d, period - d);
  });
  return Math.max(...devs);
}
