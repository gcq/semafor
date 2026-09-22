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
const MIN_ONSETS_TO_JUDGE = 3; // below this a head is 'insufficient', not fixed/actuated

// Spanish signal grammar: green → amber → red → green. There is NO red+amber
// step (that's UK/DE). flash-amber and off are permissive/degraded states that
// can precede or follow anything. LEGAL_NEXT[a] = aspects that may directly
// follow `a`; anything else means an aspect went unobserved between two taps.
const LEGAL_NEXT = {
  green: ['amber', 'flash-amber', 'off'],
  amber: ['red', 'flash-amber', 'off'],
  red: ['green', 'flash-amber', 'off'],
  'flash-amber': ['green', 'amber', 'red', 'off'],
  off: ['green', 'amber', 'red', 'flash-amber'],
};
const isLegalNext = (a, b) => a === b || (LEGAL_NEXT[a] ?? []).includes(b);

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const round1 = (x) => Math.round(x * 10) / 10;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// Circular distance between two ring positions (0..period), 0..period/2.
const circDist = (a, b, period) => { const d = Math.abs(a - b) % period; return Math.min(d, period - d); };

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
      if (e.kind === 'presence') continue; // presence never marks a cycle boundary
      if (lastOf[e.aspect] != null) gaps.push((e.t - lastOf[e.aspect]) / 1000);
      lastOf[e.aspect] = e.t;
    }
  }
  const clean = gaps.filter((g) => g > 1 && g < MAX_CYCLE_SEC);
  if (clean.length < 2) return null;
  // Base cycle = the smallest gaps' median; larger gaps are ~integer multiples
  // (a tap was missed for a cycle or two). Taking the median of the sub-median
  // gaps is robust both to those multiples and to onset jitter, as long as the
  // true cycle is the most common gap — which a consecutive-tap burst guarantees.
  const base = median(clean.filter((g) => g <= median(clean) * 1.5));
  return base > 0 ? round1(base) : null;
}

/**
 * @typedef {Object} HeadWindows
 * @property {string} headId
 * @property {Array<{ pos: number, aspect: Aspect, nextPartial: boolean }>} onsets  sorted boundary onsets
 * @property {number} maxSpread   worst boundary spread (s) -> fixed vs actuated
 * @property {number} samples     onset events folded (excludes presence)
 * @property {'fixed'|'actuated'|'insufficient'} verdict
 */

// Drop one-off outlier positions (fat-finger taps) before averaging a boundary,
// while leaving a systematically-wandering (actuated) cluster intact. Circular
// MAD with a seconds floor so a tight, clean cluster rejects nothing.
function rejectOutliers(poss, period) {
  if (poss.length < 4) return poss;
  const m = circMean(poss, period);
  const dists = poss.map((p) => circDist(p, m, period));
  const md = median(dists);
  const mad = median(dists.map((d) => Math.abs(d - md)));
  const thresh = md + Math.max(3.5 * mad, 2);
  const kept = poss.filter((_, i) => dists[i] <= thresh);
  return kept.length ? kept : poss;
}

/**
 * Fold one head's ONSET events onto the cycle and derive its aspect windows.
 * Presence events are ignored here (they never define a boundary). Each aspect's
 * onset is the circular mean of its folded positions after outlier rejection;
 * an arc to the next onset that breaks the Spanish grammar (e.g. red→amber, with
 * green unseen) is flagged `nextPartial` so that interval is treated as uncertain
 * rather than a confidently-held phase.
 * @param {Ev[]} evs
 * @param {number} epoch
 * @param {number} cycleSec
 * @returns {HeadWindows}
 */
function headWindows(evs, epoch, cycleSec) {
  const cyc = cycleSec * 1000;
  const onsetEvs = evs.filter((e) => e.kind !== 'presence');
  const byAspect = {};
  for (const e of onsetEvs) {
    const pos = ((((e.t - epoch) % cyc) + cyc) % cyc) / 1000;
    (byAspect[e.aspect] ??= []).push(pos);
  }
  const onsets = [];
  let maxSpread = 0;
  for (const [aspect, raw] of Object.entries(byAspect)) {
    const poss = rejectOutliers(raw, cycleSec);
    const pos = circMean(poss, cycleSec);
    // signed scatter of this boundary around its mean -> the actuated range
    const devs = poss.map((p) => ((p - pos + cycleSec * 1.5) % cycleSec) - cycleSec / 2);
    onsets.push({ pos: round1(pos), aspect, nextPartial: false, devMin: round1(Math.min(...devs)), devMax: round1(Math.max(...devs)) });
    maxSpread = Math.max(maxSpread, circSpread(poss, cycleSec));
  }
  onsets.sort((a, b) => a.pos - b.pos);
  // Grammar check across adjacent (wrapping) onsets: an illegal step means an
  // aspect changed unobserved inside that arc.
  for (let i = 0; i < onsets.length; i++) {
    const next = onsets[(i + 1) % onsets.length];
    if (onsets.length > 1 && !isLegalNext(onsets[i].aspect, next.aspect)) onsets[i].nextPartial = true;
  }
  const samples = onsetEvs.length;
  const verdict = samples < MIN_ONSETS_TO_JUDGE ? 'insufficient'
    : maxSpread > FIXED_CV * cycleSec ? 'actuated' : 'fixed';
  return { headId: evs[0].headId, onsets, maxSpread: round1(maxSpread), samples, verdict };
}

/** The aspect a head shows at cycle position `pos` (+ whether that arc is partial). */
function aspectAt(hw, pos) {
  if (!hw.onsets.length) return { aspect: 'off', partial: false };
  let chosen = hw.onsets[hw.onsets.length - 1]; // wrap default = the last one
  for (const o of hw.onsets) { if (o.pos <= pos) chosen = o; else break; }
  return { aspect: chosen.aspect, partial: !!chosen.nextPartial };
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
export function reconstructPlan(events, allHeadIds = [], opts = {}) {
  if (!events?.length) return null;

  // Recent-window re-anchor: fold only recent events so a stale epoch or slow
  // drift can't smear the fold (see the TeslaMate long-span analysis). Falls
  // back to the full log if the window is too sparse to reconstruct from.
  let used = events;
  if (opts.recentWindowMs) {
    const now = opts.now ?? Math.max(...events.map((e) => e.t));
    const recent = events.filter((e) => e.t >= now - opts.recentWindowMs);
    if (recent.length >= 2) used = recent;
  }

  const heads = byHead(used);
  const cycleLengthSec = estimateCycleSec(heads);
  if (!cycleLengthSec) return null;
  const epoch = Math.min(...used.filter((e) => e.kind !== 'presence').map((e) => e.t));
  if (!Number.isFinite(epoch)) return null;

  const hws = Object.values(heads).map((evs) => headWindows(evs, epoch, cycleLengthSec));
  const observedHeads = hws.map((h) => h.headId);
  const missingHeads = allHeadIds.filter((id) => !observedHeads.includes(id));
  const headVerdicts = Object.fromEntries(hws.map((h) => [h.headId, h.verdict]));

  // union of all boundary positions -> phase partition
  const bounds = [...new Set(hws.flatMap((h) => h.onsets.map((o) => o.pos)).map((p) => round1(p)))].sort((a, b) => a - b);
  if (!bounds.length) return null;
  if (bounds[0] > 0) bounds.unshift(0);

  // What each boundary position is: owned by which heads' onsets, is any owner
  // actuated, and how far it scatters. A phase's type/range come from the
  // boundary that ENDS it — so one actuated head no longer taints the countdown
  // of a fixed head at the same junction.
  const boundaryAt = new Map();
  for (const hw of hws) for (const o of hw.onsets) {
    const b = boundaryAt.get(o.pos) ?? { actuated: false, devMin: 0, devMax: 0 };
    if (hw.verdict === 'actuated') {
      b.actuated = true;
      b.devMin = Math.min(b.devMin, o.devMin); b.devMax = Math.max(b.devMax, o.devMax);
    }
    boundaryAt.set(o.pos, b);
  }

  const phases = [];
  let impliedGaps = 0;
  for (let i = 0; i < bounds.length; i++) {
    const startSec = bounds[i];
    const endSec = i + 1 < bounds.length ? bounds[i + 1] : cycleLengthSec;
    const mid = (startSec + endSec) / 2;
    const states = {};
    const partialHeads = [];
    for (const hw of hws) {
      const at = aspectAt(hw, mid);
      states[hw.headId] = at.aspect;
      if (at.partial) partialHeads.push(hw.headId); // an unobserved change falls in this arc
    }
    if (partialHeads.length) impliedGaps++;
    const durSec = round1(endSec - startSec);
    const end = boundaryAt.get(i + 1 < bounds.length ? bounds[i + 1] : bounds[0]);
    const phase = { startSec: round1(startSec), durSec, states, type: end?.actuated ? 'actuated' : 'fixed',
      partial: partialHeads.length > 0, partialHeads };
    if (end?.actuated) { phase.minSec = round1(Math.max(0, durSec + end.devMin)); phase.maxSec = round1(durSec + end.devMax); }
    phases.push(phase);
  }

  const cyclesObserved = Math.max(1, Math.round(used.length / Math.max(1, hws.reduce((s, h) => s + h.onsets.length, 0))));
  const judgeable = hws.filter((h) => h.verdict !== 'insufficient');
  const fixedHeads = hws.filter((h) => h.verdict === 'fixed').length;
  const timeBasedRatio = judgeable.length ? fixedHeads / judgeable.length : 0;
  const modelable = fixedHeads > 0 && cycleLengthSec > 0;
  const worstSpread = Math.max(0, ...hws.map((h) => h.maxSpread));
  // `impliedGaps` (an unobserved aspect, e.g. amber never captured) is surfaced
  // separately and makes those phases uncertain in the predictor; it does not
  // demote the cycle/offset confidence that linkage keys on.
  const level = timeBasedRatio === 1 && observedHeads.length && cyclesObserved >= 5 && worstSpread <= 2 ? 'high'
    : modelable && cyclesObserved >= 2 ? 'medium' : 'low';

  return {
    cycleLengthSec, epoch, phases, headWindows: hws,
    observedHeads, missingHeads, headVerdicts, impliedGaps,
    modelable, timeBasedRatio, cyclesObserved,
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
      partial: !!p.partial,
      partialHeads: p.partialHeads ?? [],
      timing: p.type === 'actuated' && p.minSec != null
        ? { type: p.type, sec: p.durSec, min: p.minSec, max: p.maxSec }
        : { type: p.type, sec: p.durSec },
    })),
  };
}
