// Reconstruct phasing from observations — the core of "give observations, the
// app builds the phasing (if the controller is time-based)".
//
// Input: per-head aspect-change events {headId, aspect, t} (from tapping colors
// in Capture), gathered across any number of trips. Output: a cycle length, each
// head's cycle-relative aspect windows, a derived phase table, a fixed-vs-
// actuated verdict, and coverage (which heads we actually have data for).
//
// Method:
//   1. Per head, order events; the gap between successive same-aspect onsets is a
//      cycle candidate. Reconcile candidates across heads into one cycle length.
//   2. Fold every event onto [0, cycle) via (t - epoch) mod cycle.
//   3. Cluster each head's folded onsets -> its boundary positions (mean) and
//      spread (=> fixed if tight, actuated if wide).
//   4. Union all heads' boundaries -> phase intervals; each phase reads each
//      head's aspect from its windows. Unobserved heads => 'off' + coverage gap.
//
// Pure. Times in ms in; durations out in seconds.

/** @typedef {import('../domain/model.js').Aspect} Aspect */
/** @typedef {{ headId: string, aspect: Aspect, t: number }} Ev */

const FIXED_CV = 0.15;
const MAX_CYCLE_SEC = 600;

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const round1 = (x) => Math.round(x * 10) / 10;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// Circular statistics on a ring of length `period` (positions wrap at 0≡period).
function circMean(vals, period) {
  let sx = 0, sy = 0;
  for (const v of vals) { const a = (v / period) * 2 * Math.PI; sx += Math.cos(a); sy += Math.sin(a); }
  const ang = Math.atan2(sy / vals.length, sx / vals.length);
  return (((ang / (2 * Math.PI)) * period) % period + period) % period;
}
function circSpread(vals, period) {
  if (vals.length < 2) return 0;
  const m = circMean(vals, period);
  const sq = vals.map((v) => { let d = Math.abs(v - m); d = Math.min(d, period - d); return d * d; });
  return Math.sqrt(mean(sq));
}

/** Group events by head, each list sorted by time. */
function byHead(events) {
  const g = {};
  for (const e of events) (g[e.headId] ??= []).push(e);
  for (const k of Object.keys(g)) g[k].sort((a, b) => a.t - b.t);
  return g;
}

/**
 * Estimate the cycle length (seconds) from per-head event streams. For each head
 * we look at gaps between consecutive onsets of the SAME aspect (one full cycle
 * apart, or a small multiple if taps were missed); the robust common base is the
 * cycle. Returns null if there isn't enough signal.
 * @param {Record<string, Ev[]>} heads
 */
export function estimateCycleSec(heads) {
  const gaps = [];
  for (const evs of Object.values(heads)) {
    const lastOf = {};
    for (const e of evs) {
      if (lastOf[e.aspect] != null) gaps.push((e.t - lastOf[e.aspect]) / 1000);
      lastOf[e.aspect] = e.t;
    }
  }
  const clean = gaps.filter((g) => g > 1 && g < MAX_CYCLE_SEC);
  if (clean.length < 2) return null;
  // Base cycle = the smallest gaps' median; larger gaps are ~integer multiples.
  const base = median(clean.filter((g) => g <= median(clean) * 1.5));
  return base > 0 ? round1(base) : null;
}

/**
 * @typedef {Object} HeadWindows
 * @property {string} headId
 * @property {Array<{ pos: number, aspect: Aspect }>} onsets  sorted boundary onsets
 * @property {number} maxSpread   worst boundary spread (s) -> fixed vs actuated
 * @property {number} samples
 */

/**
 * Fold one head's events onto the cycle and derive its aspect windows.
 * @param {Ev[]} evs
 * @param {number} epoch
 * @param {number} cycleSec
 * @returns {HeadWindows}
 */
function headWindows(evs, epoch, cycleSec) {
  const cyc = cycleSec * 1000;
  // fold; group by aspect. Assume each aspect occurs once per cycle, so its
  // onset = circular mean of all folded positions and jitter = circular spread.
  const byAspect = {};
  for (const e of evs) {
    const pos = ((((e.t - epoch) % cyc) + cyc) % cyc) / 1000;
    (byAspect[e.aspect] ??= []).push(pos);
  }
  const onsets = [];
  let maxSpread = 0;
  for (const [aspect, poss] of Object.entries(byAspect)) {
    onsets.push({ pos: round1(circMean(poss, cycleSec)), aspect });
    maxSpread = Math.max(maxSpread, circSpread(poss, cycleSec));
  }
  onsets.sort((a, b) => a.pos - b.pos);
  return { headId: evs[0].headId, onsets, maxSpread: round1(maxSpread), samples: evs.length };
}

/** The aspect a head shows at cycle position `pos`, from its onset windows. */
function aspectAt(hw, pos, cycleSec) {
  if (!hw.onsets.length) return 'off';
  // last onset at or before pos (wrapping)
  let chosen = hw.onsets[hw.onsets.length - 1]; // wrap default = the last one
  for (const o of hw.onsets) { if (o.pos <= pos) chosen = o; else break; }
  return chosen.aspect;
}

/**
 * Reconstruct one plan from a set of observations (assumed one time-of-day
 * regime). Returns null if no cycle can be found.
 * @param {Ev[]} events
 * @param {string[]} allHeadIds   structural heads (for coverage reporting)
 * @returns {null | {
 *   cycleLengthSec: number, epoch: number, phases: Array<{ startSec: number, durSec: number, states: Record<string,Aspect>, type: 'fixed'|'actuated' }>,
 *   headWindows: HeadWindows[], observedHeads: string[], missingHeads: string[],
 *   modelable: boolean, timeBasedRatio: number, cyclesObserved: number,
 *   confidence: import('../domain/model.js').Confidence,
 * }}
 */
export function reconstructPlan(events, allHeadIds = []) {
  if (!events?.length) return null;
  const heads = byHead(events);
  const cycleLengthSec = estimateCycleSec(heads);
  if (!cycleLengthSec) return null;
  const epoch = Math.min(...events.map((e) => e.t));

  const hws = Object.values(heads).map((evs) => headWindows(evs, epoch, cycleLengthSec));
  const observedHeads = hws.map((h) => h.headId);
  const missingHeads = allHeadIds.filter((id) => !observedHeads.includes(id));

  // union of all boundary positions -> phase partition
  const bounds = [...new Set(hws.flatMap((h) => h.onsets.map((o) => o.pos)).map((p) => round1(p)))].sort((a, b) => a - b);
  if (!bounds.length) return null;
  if (bounds[0] > 0) bounds.unshift(0);

  const phases = [];
  for (let i = 0; i < bounds.length; i++) {
    const startSec = bounds[i];
    const endSec = i + 1 < bounds.length ? bounds[i + 1] : cycleLengthSec;
    const mid = (startSec + endSec) / 2;
    const states = {};
    for (const hw of hws) states[hw.headId] = aspectAt(hw, mid, cycleLengthSec);
    // a phase is "actuated" if any head bounding it has wide spread
    const type = hws.some((hw) => hw.maxSpread > FIXED_CV * cycleLengthSec) ? 'actuated' : 'fixed';
    phases.push({ startSec: round1(startSec), durSec: round1(endSec - startSec), states, type });
  }

  const cyclesObserved = Math.max(1, Math.round(events.length / Math.max(1, hws.reduce((s, h) => s + h.onsets.length, 0))));
  const fixedHeads = hws.filter((h) => h.maxSpread <= FIXED_CV * cycleLengthSec).length;
  const timeBasedRatio = hws.length ? fixedHeads / hws.length : 0;
  const modelable = timeBasedRatio > 0 && cycleLengthSec > 0;
  const worstSpread = Math.max(0, ...hws.map((h) => h.maxSpread));
  const level = timeBasedRatio === 1 && observedHeads.length && cyclesObserved >= 5 && worstSpread <= 2 ? 'high'
    : modelable && cyclesObserved >= 2 ? 'medium' : 'low';

  return {
    cycleLengthSec, epoch, phases, headWindows: hws,
    observedHeads, missingHeads, modelable, timeBasedRatio, cyclesObserved,
    confidence: { cycles: cyclesObserved, stdevSec: round1(worstSpread), level },
  };
}

/**
 * Turn a reconstruction into a TimingPlan the predictor consumes (states keyed
 * by headId).
 * @param {ReturnType<typeof reconstructPlan>} rec
 * @param {Partial<import('../domain/model.js').TimingPlan>} [meta]
 */
export function reconstructionToPlan(rec, meta = {}) {
  if (!rec) return null;
  return {
    id: meta.id ?? 'plan_observed',
    name: meta.name ?? 'Observed',
    schedule: meta.schedule,
    epoch: rec.epoch,
    cycleLengthMs: Math.round(rec.cycleLengthSec * 1000),
    confidence: rec.confidence,
    stages: rec.phases.map((p, i) => ({
      name: `Phase ${i + 1}`,
      states: p.states,
      timing: { type: p.type, sec: p.durSec },
    })),
  };
}
