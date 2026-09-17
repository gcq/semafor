// Infer traffic-light timing from low-resolution GPS traces (TeslaMate).
//
// The car is a moving probe. The one clean signal a GPS track gives us is a
// QUEUE DEPARTURE: when a car that was stopped at a light starts moving, that
// approach's head just turned green. That is a genuine "green onset" — the same
// kind of aspect-change event Onda reconstructs phasing from, only sensed
// instead of tapped. Two weaker signals help too: the car was STOPPED (red was
// present) and the car DROVE THROUGH without stopping (green was present).
//
// From many such events over months we can recover, per head:
//   - cycle length      (fold onset times over candidate periods; pick the
//                         shortest period the onsets concentrate at)
//   - green-onset phase  (circular mean of folded onsets) + its spread
//                         (tight => fixed-time; wide => actuated / no clean cycle)
//   - a green/red split  (bracketed by the latest "drove through" phase and the
//                         earliest "had to stop" phase — a range, not a point)
//
// What GPS CANNOT see: amber. So splits are green-vs-red only, and every number
// is reported with the sample count that backs it. Pure: no fs, no DOM. Times in
// ms, distances in m, speeds in m/s, bearings/phases as noted.

import { distanceM, bearingDeg, angularDiff } from '../../src/nav/proximity.js';

/** @typedef {{ t: number, lat: number, lon: number, speed: number }} Fix  speed m/s */

export const DEFAULTS = {
  assocRadiusM: 70,     // a fix within this of the centre belongs to a "pass"
  innerRadiusM: 35,     // a pass must come at least this close (really traversed)
  passGapMs: 120000,    // >2 min between fixes ends a pass
  stopSpeed: 0.8,       // m/s (~3 km/h) below which we call the car stopped
  goSpeed: 1.7,         // m/s (~6 km/h) above which we call it moving again
  minStopMs: 4000,      // ignore momentary dips shorter than this
  approachMinM: 12,     // bearing window: use fixes this..that far from centre
  approachMaxM: 50,
  armToleranceDeg: 45,  // how close a travel bearing must sit to an arm to match
  cycleMinS: 25,
  cycleMaxS: 200,
  cycleStepS: 0.5,
  minCycleStrength: 0.45, // fold resultant length below this = no clean cycle
  fixedSpreadFrac: 0.06,  // onset spread under this fraction of the cycle = fixed
  // --- windowing & plan segmentation (real controllers retime & run TOD plans) ---
  sinceDays: 150,         // ignore onsets older than this (retiming/DST smear); 0 = all
  tzOffsetH: 2,           // local = UTC + this (for time-of-day bucketing); Spain summer
  minSegmentSamples: 8,   // a head needs at least this many onsets in a segment
  jointMinStrength: 0.35, // pooled periodogram must beat this to claim a cycle
  // --- verdict thresholds (see characterizeHead) ---
  predictableResidualFrac: 0.10, // residual scatter under this·cycle = predictable
  unstableResidualFrac: 0.18,    // residual scatter over this·cycle = unstable/actuated
  driftFlagSecPerDay: 0.25,      // |drift| over this = "drifting, re-anchor"
};

// Weekday daytime plus coarse time-of-day buckets, in LOCAL hours. Each segment
// is tried; per head we keep whichever gives the most confident verdict.
export const SEGMENTS = [
  { name: 'daytime', from: 7, to: 20, weekday: true },
  { name: 'morning', from: 7, to: 10, weekday: true },
  { name: 'midday', from: 10, to: 16, weekday: true },
  { name: 'evening', from: 16, to: 20, weekday: true },
];

// ---------- circular statistics on a ring of `period` seconds ----------
function circStats(valsSec, periodSec) {
  let sx = 0, sy = 0;
  for (const v of valsSec) { const a = (v / periodSec) * 2 * Math.PI; sx += Math.cos(a); sy += Math.sin(a); }
  const n = valsSec.length || 1;
  const mx = sx / n, my = sy / n;
  const ang = Math.atan2(my, mx);
  const meanPos = (((ang / (2 * Math.PI)) * periodSec) % periodSec + periodSec) % periodSec;
  const strength = Math.hypot(mx, my); // 0 (uniform) .. 1 (all identical)
  // circular standard deviation in seconds, from resultant length
  const sd = strength >= 1 ? 0 : Math.sqrt(-2 * Math.log(Math.max(strength, 1e-9))) * (periodSec / (2 * Math.PI));
  return { meanPos, strength, sdSec: sd };
}

/** Linear-interpolated percentile (p in 0..1) of a numeric list. */
function percentile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Population standard deviation. */
function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

const foldPhaseSec = (tMs, cycleSec) => {
  const cyc = cycleSec * 1000;
  return ((((tMs % cyc) + cyc) % cyc)) / 1000;
};

// ---------- 1. carve the position stream into passes near one intersection ----------
/**
 * @param {Fix[]} fixes  chronological (any order accepted; sorted here)
 * @param {{lat:number,lon:number}} centre
 * @param {typeof DEFAULTS} [opt]
 * @returns {Fix[][]} one array of fixes per pass through the intersection
 */
export function findPasses(fixes, centre, opt = DEFAULTS) {
  const sorted = [...fixes].sort((a, b) => a.t - b.t);
  const passes = [];
  let cur = [];
  let lastT = null;
  const close = () => {
    if (cur.length >= 2 && cur.some((f) => distanceM(f, centre) <= opt.innerRadiusM)) passes.push(cur);
    cur = [];
  };
  for (const f of sorted) {
    const near = distanceM(f, centre) <= opt.assocRadiusM;
    const gap = lastT != null && f.t - lastT > opt.passGapMs;
    if (!near || gap) close();
    if (near) { cur.push(f); lastT = f.t; } else { lastT = null; }
  }
  close();
  return passes;
}

// ---------- 2. reduce one pass to a timing event ----------
/**
 * @returns {{
 *   crossingT:number, minDist:number, nFixes:number,
 *   approachBearing:number|null, departureBearing:number|null,
 *   stopped:boolean, arrivalT:number|null, departureT:number|null, greenOnsetT:number|null,
 *   waitMs:number|null,
 * }}
 */
export function analyzePass(pass, centre, opt = DEFAULTS) {
  const dists = pass.map((f) => distanceM(f, centre));
  let nearIdx = 0;
  for (let i = 1; i < dists.length; i++) if (dists[i] < dists[nearIdx]) nearIdx = i;
  const near = pass[nearIdx];

  // approach bearing: from the furthest fix inside the window, up to the nearest.
  const approachRef = (() => {
    for (let i = 0; i < nearIdx; i++) if (dists[i] <= opt.approachMaxM && dists[i] >= opt.approachMinM) return pass[i];
    return nearIdx > 0 ? pass[0] : null;
  })();
  const departureRef = (() => {
    for (let i = pass.length - 1; i > nearIdx; i--) if (dists[i] <= opt.approachMaxM && dists[i] >= opt.approachMinM) return pass[i];
    return nearIdx < pass.length - 1 ? pass[pass.length - 1] : null;
  })();
  const approachBearing = approachRef ? bearingDeg(approachRef, near) : null;
  const departureBearing = departureRef ? bearingDeg(near, departureRef) : null;

  // longest contiguous stopped run
  let bestStart = -1, bestLen = 0, curStart = -1;
  for (let i = 0; i < pass.length; i++) {
    if (pass[i].speed <= opt.stopSpeed) {
      if (curStart < 0) curStart = i;
      const len = pass[i].t - pass[curStart].t;
      if (len > bestLen) { bestLen = len; bestStart = curStart; }
    } else curStart = -1;
  }
  let stopped = false, arrivalT = null, departureT = null, greenOnsetT = null, waitMs = null;
  if (bestStart >= 0 && bestLen >= opt.minStopMs) {
    stopped = true;
    arrivalT = pass[bestStart].t;
    // departure = first fix after the stopped run that is clearly moving again
    let endIdx = bestStart;
    while (endIdx < pass.length && pass[endIdx].speed <= opt.stopSpeed) endIdx++;
    let goIdx = endIdx;
    while (goIdx < pass.length && pass[goIdx].speed < opt.goSpeed) goIdx++;
    departureT = pass[Math.min(goIdx, pass.length - 1)].t;
    greenOnsetT = departureT; // the light let this car go ~ here
    waitMs = departureT - arrivalT;
  }
  return {
    crossingT: near.t, minDist: dists[nearIdx], nFixes: pass.length,
    approachBearing, departureBearing,
    stopped, arrivalT, departureT, greenOnsetT, waitMs,
  };
}

// ---------- 3. map a pass to a head ----------
/**
 * Two strategies, in order of precision:
 *  a) ARM geometry (if arms carry positions): from-arm = the arm the car came
 *     FROM (bearing centre->arm opposite the approach heading), to-arm = where it
 *     left; the movement with that (from,to) names the head.
 *  b) MAST direction (the app places masts, not arms): a mast sits on the near
 *     side of the approach it controls, so its bearing from the centre ≈ the
 *     direction the car came from. Pick the closest mast to (approach+180).
 * @returns {{ headId:string|null, movementId:string|null, fromArm:string|null, toArm:string|null, basis?:string, reason?:string }}
 */
export function assignHead(ev, ix, opt = DEFAULTS) {
  const armsWithPos = (ix.arms || []).filter((a) => a.pos && Number.isFinite(a.pos.lat));
  if (armsWithPos.length) return assignByArms(ev, ix, armsWithPos, opt);
  const masts = (ix.masts || []).filter((m) => m.pos && Number.isFinite(m.pos.lat) && m.headIds?.length);
  if (masts.length) return assignByMasts(ev, ix, masts, opt);
  return { headId: null, movementId: null, fromArm: null, toArm: null, reason: 'no arm or mast positions' };
}

function assignByArms(ev, ix, armsWithPos, opt) {
  const dirTo = (arm) => bearingDeg(ix.location, arm.pos); // centre -> arm
  const bestArm = (targetBearing) => {
    if (targetBearing == null) return null;
    let best = null, bestD = Infinity;
    for (const a of armsWithPos) { const d = angularDiff(dirTo(a), targetBearing); if (d < bestD) { bestD = d; best = a; } }
    return bestD <= opt.armToleranceDeg ? best : null;
  };
  const fromArm = ev.approachBearing == null ? null : bestArm((ev.approachBearing + 180) % 360);
  const toArm = bestArm(ev.departureBearing);
  if (!fromArm) return { headId: null, movementId: null, fromArm: null, toArm: toArm?.id ?? null, reason: 'approach unmatched' };
  const sig = (ix.movements || []).filter((m) => !m.unsignalized && m.from === fromArm.id);
  let mv = null;
  if (toArm) mv = sig.find((m) => m.to === toArm.id) || null;
  if (!mv) { const heads = [...new Set(sig.map((m) => m.headId).filter(Boolean))]; if (heads.length === 1) mv = sig.find((m) => m.headId === heads[0]); }
  if (!mv || !mv.headId) return { headId: null, movementId: null, fromArm: fromArm.id, toArm: toArm?.id ?? null, reason: 'no matching movement' };
  return { headId: mv.headId, movementId: mv.id, fromArm: fromArm.id, toArm: toArm?.id ?? null, basis: 'arm' };
}

function assignByMasts(ev, ix, masts, opt) {
  if (ev.approachBearing == null) return { headId: null, movementId: null, fromArm: null, toArm: null, reason: 'no approach bearing' };
  const want = (ev.approachBearing + 180) % 360; // mast is on the side you came from
  let best = null, bestD = Infinity;
  for (const m of masts) { const d = angularDiff(bearingDeg(ix.location, m.pos), want); if (d < bestD) { bestD = d; best = m; } }
  if (bestD > opt.armToleranceDeg) return { headId: null, movementId: null, fromArm: null, toArm: null, reason: 'approach unmatched (mast)' };
  // A mast usually carries one head; if it carries several (a median), geometry
  // can't split them — take the first and flag it.
  const headId = best.headIds[0];
  return { headId, movementId: null, fromArm: null, toArm: null, basis: best.headIds.length > 1 ? 'mast (ambiguous)' : 'mast' };
}

// ---------- generate the TeslaMate dump query from an export ----------
/** Bounding box (with metre padding) covering all intersection locations. */
export function boundingBox(intersections, padM = 350) {
  const pts = intersections.map((i) => i.location).filter((p) => p && Number.isFinite(p.lat));
  if (!pts.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon); }
  const meanLat = (minLat + maxLat) / 2;
  const dLat = padM / 111000;
  const dLon = padM / (111000 * Math.max(0.1, Math.cos(meanLat * Math.PI / 180)));
  return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
}

/** Render the psql query (NDJSON output) for a bounding box. */
export function buildFetchSql(bbox, intersections = [], padM = 350) {
  const f = (n) => n.toFixed(6);
  const names = intersections.map((i) => i.name).filter(Boolean).join(', ');
  return `-- TeslaMate GPS dump for Onda inference — GENERATED by tools/teslamate/infer.js
-- Covers: ${names || '(intersections)'}  (${padM} m padding)
-- Run (fill in your connection), from ~/personal/onda:
--   docker compose exec -T database \\
--     psql -U teslamate -d teslamate -t -A < THIS_FILE > positions.ndjson
-- or against a reachable host:
--   docker run --rm --network host -e PGPASSWORD='<pw>' postgres:16 \\
--     psql -h <host> -U teslamate -d teslamate -t -A -f - < THIS_FILE > positions.ndjson

SELECT json_build_object(
  'date',  to_char(date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'lat',   latitude,
  'lon',   longitude,
  'speed', speed
)
FROM positions
WHERE speed IS NOT NULL
  AND latitude  BETWEEN ${f(bbox.minLat)} AND ${f(bbox.maxLat)}
  AND longitude BETWEEN ${f(bbox.minLon)} AND ${f(bbox.maxLon)}
ORDER BY date;
`;
}

// ---------- 4. cycle length by folding onset times ----------
/**
 * Scan candidate periods; the true cycle is the SHORTEST period at which the
 * onsets concentrate (integer multiples concentrate equally, halves do not).
 * @param {number[]} onsetMs
 * @returns {{ cycleSec:number|null, strength:number, n:number }}
 */
export function estimateCycle(onsetMs, opt = DEFAULTS) {
  const n = onsetMs.length;
  if (n < 4) return { cycleSec: null, strength: 0, n };
  let maxR = 0;
  const scan = [];
  for (let c = opt.cycleMinS; c <= opt.cycleMaxS + 1e-9; c += opt.cycleStepS) {
    const r = circStats(onsetMs.map((t) => foldPhaseSec(t, c)), c).strength;
    scan.push({ c, r });
    if (r > maxR) maxR = r;
  }
  if (maxR < opt.minCycleStrength) return { cycleSec: null, strength: maxR, n };
  // Onsets are (phase + k·T) for arbitrary integer k, so a candidate period
  // concentrates only when it DIVIDES the true period T (halves/thirds fold
  // cleanly too); non-divisors and multiples of T spread out. The fundamental is
  // therefore the LARGEST period that still concentrates.
  // The true period T and all its DIVISORS fold the same comb of onsets, so they
  // reach essentially the same (maximal) concentration — e.g. 30, 45 and 90 all
  // score ~1.0 — while non-divisors and multiples score strictly lower. The
  // fundamental is thus the LARGEST period sitting within a tight band of the max.
  const thresh = Math.max(opt.minCycleStrength, 0.98 * maxR);
  const pick = scan.filter((s) => s.r >= thresh).reduce((a, b) => (b.c > a.c ? b : a));
  return { cycleSec: Math.round(pick.c * 10) / 10, strength: Math.round(pick.r * 100) / 100, n };
}

// ---------- 5. per-head summary ----------
/**
 * @param {{ greenOnsets:number[], passThroughs:number[], stopArrivals:number[] }} obs
 * @returns {object} inference for one head
 */
export function summarizeHead(obs, opt = DEFAULTS) {
  const { greenOnsets, passThroughs, stopArrivals } = obs;
  const cyc = estimateCycle(greenOnsets.length >= 4 ? greenOnsets : [...greenOnsets, ...passThroughs], opt);
  const base = {
    samples: { greenOnsets: greenOnsets.length, passThroughs: passThroughs.length, stopArrivals: stopArrivals.length },
    cycleSec: cyc.cycleSec, cycleStrength: cyc.strength,
  };
  if (!cyc.cycleSec) return { ...base, verdict: greenOnsets.length + passThroughs.length < 4 ? 'insufficient-data' : 'no-clean-cycle (actuated?)' };

  const C = cyc.cycleSec;
  const onStats = circStats(greenOnsets.map((t) => foldPhaseSec(t, C)), C);
  // QUEUE CORRECTION: a departure lags the real onset by the queue-discharge time
  // (~2s startup + ~2s per car ahead), so the mean departure sits LATE and its
  // spread is inflated by variable queue length. The true onset is the EARLY EDGE
  // of the departures (the trips ego was at/near the front). Take a low percentile
  // of the departures' signed offset around their circular mean.
  const signed = greenOnsets.map((t) => {
    let d = ((foldPhaseSec(t, C) - onStats.meanPos) % C + C) % C;
    return d > C / 2 ? d - C : d; // signed distance from the mean, in [-C/2, C/2]
  });
  const offset = ((onStats.meanPos + (percentile(signed, 0.15) ?? 0)) % C + C) % C;
  // fixed/actuated: judge the spread of the FRONT-OF-QUEUE departures only, so
  // queue-length variance doesn't masquerade as controller (actuated) jitter.
  const sortedSigned = [...signed].sort((a, b) => a - b);
  const front = sortedSigned.slice(0, Math.max(2, Math.ceil(sortedSigned.length * 0.4)));
  const frontSpread = stddev(front);
  const queueLagSec = round1(onStats.meanPos <= offset ? onStats.meanPos - offset + C : onStats.meanPos - offset);
  const rel = (t) => ((foldPhaseSec(t, C) - offset) % C + C) % C; // 0 at green onset

  // Every car that had to STOP was caught in the red band, which runs from the
  // green→red boundary up to the onset (rel ≡ 0 ≡ C). So each stop's arrival phase
  // (rel) is an upper bound on green; the smallest such phase ≈ green duration.
  // A low percentile (not the strict min) shrugs off cars that braked early.
  const arrRel = stopArrivals.map(rel).filter((x) => x > 1 && x < C - 0.5);
  const greenFromStops = arrRel.length ? percentile(arrRel, 0.15) : null;
  // Cars that DROVE THROUGH were on green; the furthest-into-cycle one confirms
  // green lasted at least that long (ignore any that wrapped back near the onset).
  const passRel = passThroughs.map(rel).filter((x) => x > 0.5 && x < C * 0.9);
  const greenFromThrough = passRel.length ? percentile(passRel, 0.9) : null;

  let greenEst = greenFromStops;
  if (greenEst == null) greenEst = greenFromThrough;
  else if (greenFromThrough != null) greenEst = Math.max(greenEst, greenFromThrough); // green is at least what we drove through

  const fixed = frontSpread <= opt.fixedSpreadFrac * C;
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return {
    ...base,
    type: fixed ? 'fixed' : 'actuated',
    onsetPhaseSec: r1(offset),
    onsetSpreadSec: r1(frontSpread),      // front-of-queue jitter (queue-robust)
    queueLagSec,                          // mean departure lag behind the onset
    greenSec: r1(greenEst),
    greenRangeSec: [r1(greenFromThrough), r1(greenFromStops)], // [confirmed ≥, upper bound]
    redSec: greenEst == null ? null : r1(C - greenEst),
    verdict: 'reconstructed',
  };
}

// ---------- build an app-importable plan from head summaries ----------
/**
 * Combine per-head green/red windows into one Onda TimingPlan. Green onset phases
 * are already in the same coordinate the predictor uses when `epoch: 0`
 * (position = now mod cycle), so stage 0 starts at cycle position 0.
 * @param {Record<string, ReturnType<typeof summarizeHead>>} heads
 * @returns {{ plan: import('../../src/domain/model.js').TimingPlan|null, headsUsed: string[] }}
 */
export function buildPlan(heads, opt = DEFAULTS) {
  const usable = Object.entries(heads).filter(([, h]) =>
    h.verdict === 'reconstructed' && h.cycleSec && h.greenSec != null);
  if (!usable.length) return { plan: null, headsUsed: [] };
  // one cycle for the whole intersection = the best-supported head's cycle
  const anchor = usable.reduce((a, b) =>
    (b[1].cycleStrength * b[1].samples.greenOnsets > a[1].cycleStrength * a[1].samples.greenOnsets ? b : a));
  const C = anchor[1].cycleSec;
  const inCycle = usable.filter(([, h]) => Math.abs(h.cycleSec - C) <= Math.max(2, 0.1 * C));

  const bounds = new Set([0]);
  for (const [, h] of inCycle) { bounds.add(round1(h.onsetPhaseSec % C)); bounds.add(round1((h.onsetPhaseSec + h.greenSec) % C)); }
  const b = [...bounds].sort((x, y) => x - y);

  const stages = [];
  for (let i = 0; i < b.length; i++) {
    const start = b[i], end = i + 1 < b.length ? b[i + 1] : C;
    if (end - start < 0.5) continue;
    const mid = (start + end) / 2;
    const states = {};
    let actuated = false;
    for (const [id, h] of inCycle) {
      const rel = ((mid - h.onsetPhaseSec) % C + C) % C;
      states[id] = rel < h.greenSec ? 'green' : 'red';
      if (h.type === 'actuated') actuated = true;
    }
    stages.push({ name: `Phase ${stages.length + 1}`, states, timing: { type: actuated ? 'actuated' : 'fixed', sec: round1(end - start) } });
  }
  const worst = Math.max(...inCycle.map(([, h]) => h.onsetSpreadSec || 0));
  const level = inCycle.every(([, h]) => h.type === 'fixed') && worst <= 2 ? 'high' : 'medium';
  return {
    plan: {
      id: 'plan_teslamate', name: 'From TeslaMate', epoch: 0,
      cycleLengthMs: Math.round(C * 1000),
      confidence: { cycles: Math.max(...inCycle.map(([, h]) => h.samples.greenOnsets)), stdevSec: round1(worst), level },
      stages,
    },
    headsUsed: inCycle.map(([id]) => id),
  };
}
const round1 = (x) => Math.round(x * 10) / 10;

// ---------- windowing, joint cycle, and per-head diagnostics ----------

/** Complex resultant of onset phases at a trial cycle: R (0..1) and mean phase (s). */
export function resultant(onsetMs, cycleSec) {
  let sx = 0, sy = 0;
  for (const t of onsetMs) { const a = (foldPhaseSec(t, cycleSec) / cycleSec) * 2 * Math.PI; sx += Math.cos(a); sy += Math.sin(a); }
  const n = onsetMs.length || 1;
  const R = Math.hypot(sx / n, sy / n);
  const phase = ((Math.atan2(sy / n, sx / n) / (2 * Math.PI)) * cycleSec % cycleSec + cycleSec) % cycleSec;
  return { R, phase };
}

/** Is a timestamp inside a segment's local weekday/hour window (and recent enough)? */
export function inSegment(tMs, seg, nowMs, opt = DEFAULTS) {
  if (opt.sinceDays && tMs < nowMs - opt.sinceDays * 86400000) return false;
  const d = new Date(tMs + opt.tzOffsetH * 3600000);
  const day = d.getUTCDay(), hr = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (seg.weekday && (day === 0 || day === 6)) return false;
  if (seg.from != null && !(hr >= seg.from && hr < seg.to)) return false;
  return true;
}

/**
 * One cycle for a whole intersection: the period maximising the sample-weighted
 * average per-head resultant. Heads share the controller, so pooling them
 * disambiguates the harmonics a single sparse head can't. Fundamental = largest
 * period within a tight band of the max.
 */
export function estimateCycleJoint(onsetsByHead, opt = DEFAULTS) {
  const heads = Object.values(onsetsByHead).filter((v) => v.length >= opt.minSegmentSamples);
  const N = heads.reduce((s, v) => s + v.length, 0);
  if (N < opt.minSegmentSamples) return { cycleSec: null, strength: 0, heads: heads.length, n: N };
  let maxScore = 0; const scan = [];
  for (let c = opt.cycleMinS; c <= opt.cycleMaxS + 1e-9; c += opt.cycleStepS) {
    let acc = 0; for (const v of heads) acc += v.length * resultant(v, c).R;
    const s = acc / N; scan.push({ c, s }); if (s > maxScore) maxScore = s;
  }
  if (maxScore < opt.jointMinStrength) return { cycleSec: null, strength: round1(maxScore), heads: heads.length, n: N };
  const thresh = Math.max(opt.jointMinStrength, 0.98 * maxScore);
  const pick = scan.filter((x) => x.s >= thresh).reduce((a, b) => (b.c > a.c ? b : a));
  return { cycleSec: Math.round(pick.c * 10) / 10, strength: round1(pick.s), heads: heads.length, n: N };
}

/** Ordinary least squares; returns slope and RMS residual of y about the fit. */
function linfit(xs, ys) {
  const n = xs.length; if (n < 2) return { slope: 0, residual: stddev(ys) };
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const slope = sxx ? sxy / sxx : 0; const b = my - slope * mx;
  const residual = Math.sqrt(ys.reduce((a, y, i) => a + (y - (slope * xs[i] + b)) ** 2, 0) / n);
  return { slope, residual };
}

/**
 * Characterise one head at a KNOWN cycle: queue-corrected offset, confidence R,
 * drift rate, residual scatter, green/red split, and a verdict that separates
 * "predictable" (stable, noise-limited) from "drifting" (offset slides — re-anchor)
 * from "unstable" (actuated / no stable offset).
 * @param {{greenOnsets:number[],passThroughs:number[],stopArrivals:number[]}} obs
 */
export function characterizeHead(obs, cycleSec, nowMs, opt = DEFAULTS) {
  const { greenOnsets, passThroughs, stopArrivals } = obs;
  const C = cycleSec;
  const { R, phase: meanPhase } = resultant(greenOnsets, C);
  const signed = greenOnsets.map((t) => { const d = ((foldPhaseSec(t, C) - meanPhase) % C + C) % C; return d > C / 2 ? d - C : d; });
  const { slope, residual } = linfit(greenOnsets.map((t) => (t - nowMs) / 86400000), signed);
  const offset = ((meanPhase + (percentile(signed, 0.15) ?? 0)) % C + C) % C; // early-edge (queue-corrected)
  const frontSpread = stddev([...signed].sort((a, b) => a - b).slice(0, Math.max(2, Math.ceil(signed.length * 0.4))));
  const rel = (t) => ((foldPhaseSec(t, C) - offset) % C + C) % C;
  const arrRel = stopArrivals.map(rel).filter((x) => x > 1 && x < C - 0.5);
  const greenFromStops = arrRel.length ? percentile(arrRel, 0.15) : null;
  const passRel = passThroughs.map(rel).filter((x) => x > 0.5 && x < C * 0.9);
  const greenFromThrough = passRel.length ? percentile(passRel, 0.9) : null;
  let greenEst = greenFromStops ?? greenFromThrough;
  if (greenFromStops != null && greenFromThrough != null) greenEst = Math.max(greenFromStops, greenFromThrough);

  let verdict;
  if (greenOnsets.length < opt.minSegmentSamples) verdict = 'insufficient';
  else if (residual > opt.unstableResidualFrac * C) verdict = 'unstable';
  else if (Math.abs(slope) > opt.driftFlagSecPerDay) verdict = 'drifting';
  else if (residual <= opt.predictableResidualFrac * C) verdict = 'predictable';
  else verdict = 'noisy';
  return {
    cycleSec: C, R: round1(R),
    onsetPhaseSec: round1(offset), onsetSpreadSec: round1(frontSpread),
    driftSecPerDay: round1(slope), residualSec: round1(residual),
    greenSec: greenEst == null ? null : round1(greenEst),
    redSec: greenEst == null ? null : round1(C - greenEst),
    type: frontSpread <= opt.fixedSpreadFrac * C ? 'fixed' : 'actuated',
    samples: { greenOnsets: greenOnsets.length, passThroughs: passThroughs.length, stopArrivals: stopArrivals.length },
    verdict,
  };
}

// Rank verdicts so we can keep the most useful segment per head.
const VERDICT_RANK = { predictable: 4, drifting: 3, noisy: 2, unstable: 1, insufficient: 0 };

/** Build a TimingPlan from characterised heads sharing one cycle, with a schedule. */
function buildSegmentPlan(chars, C, schedule, name) {
  const heads = Object.entries(chars).filter(([, h]) => h.greenSec != null);
  if (!heads.length) return null;
  const bounds = new Set([0]);
  for (const [, h] of heads) { bounds.add(round1(h.onsetPhaseSec % C)); bounds.add(round1((h.onsetPhaseSec + h.greenSec) % C)); }
  const b = [...bounds].sort((x, y) => x - y);
  const stages = [];
  for (let i = 0; i < b.length; i++) {
    const start = b[i], end = i + 1 < b.length ? b[i + 1] : C;
    if (end - start < 0.5) continue;
    const mid = (start + end) / 2; const states = {}; let actuated = false;
    for (const [id, h] of heads) { const r = ((mid - h.onsetPhaseSec) % C + C) % C; states[id] = r < h.greenSec ? 'green' : 'red'; if (h.type === 'actuated' || h.verdict !== 'predictable') actuated = true; }
    stages.push({ name: `Phase ${stages.length + 1}`, states, timing: { type: actuated ? 'actuated' : 'fixed', sec: round1(end - start) } });
  }
  const worst = Math.max(...heads.map(([, h]) => h.residualSec || 0));
  const level = heads.every(([, h]) => h.verdict === 'predictable') ? 'high' : heads.some(([, h]) => h.verdict === 'drifting' || h.verdict === 'predictable') ? 'medium' : 'low';
  return { id: `plan_tm_${name}`, name: `TeslaMate ${name}`, epoch: 0, schedule,
    cycleLengthMs: Math.round(C * 1000), confidence: { cycles: Math.max(...heads.map(([, h]) => h.samples.greenOnsets)), stdevSec: round1(worst), level },
    stages };
}

// ---------- top-level: one intersection ----------
/**
 * Run the whole pipeline for a single intersection: collect passes, window to a
 * recent epoch, and for each time-of-day segment estimate a shared cycle + per-head
 * offset/drift/residual. Each head keeps its most confident segment; each segment
 * with confident heads becomes a scheduled TimingPlan.
 * @param {import('../../src/domain/model.js').Intersection} ix
 * @param {Fix[]} fixes  all GPS fixes (will be filtered to this intersection)
 * @param {typeof DEFAULTS} [opt]
 */
export function inferIntersection(ix, fixes, opt = DEFAULTS) {
  const segments = opt.segments || SEGMENTS;
  const passes = findPasses(fixes, ix.location, opt);
  const nowMs = fixes.length ? fixes[fixes.length - 1].t : Date.now();
  const raw = {};            // headId -> { greenOnsets, passThroughs, stopArrivals } (all time)
  const unassigned = [];
  const obsOut = [];
  const bucket = (h) => (raw[h] ??= { greenOnsets: [], passThroughs: [], stopArrivals: [] });

  for (const pass of passes) {
    const ev = analyzePass(pass, ix.location, opt);
    const a = assignHead(ev, ix, opt);
    if (!a.headId) { unassigned.push({ ...ev, reason: a.reason }); continue; }
    const b = bucket(a.headId);
    if (ev.stopped) {
      b.greenOnsets.push(ev.greenOnsetT); b.stopArrivals.push(ev.arrivalT);
      obsOut.push({ intersectionId: ix.id, headId: a.headId, aspect: 'green', t: ev.greenOnsetT,
        where: { lat: pass[0].lat, lon: pass[0].lon }, source: 'teslamate', movementId: a.movementId });
    } else b.passThroughs.push(ev.crossingT);
  }

  const filt = (arr, seg) => arr.filter((t) => inSegment(t, seg, nowMs, opt));
  const heads = {};          // headId -> best characterisation (+ segment)
  const plans = [];
  for (const seg of segments) {
    const onsetsByHead = {};
    for (const [h, o] of Object.entries(raw)) onsetsByHead[h] = filt(o.greenOnsets, seg);
    const jc = estimateCycleJoint(onsetsByHead, opt);
    if (!jc.cycleSec) continue;
    const segChars = {};
    for (const [h, o] of Object.entries(raw)) {
      const obs = { greenOnsets: onsetsByHead[h], passThroughs: filt(o.passThroughs, seg), stopArrivals: filt(o.stopArrivals, seg) };
      if (obs.greenOnsets.length < opt.minSegmentSamples) continue;
      const ch = characterizeHead(obs, jc.cycleSec, nowMs, opt);
      segChars[h] = ch;
      const prev = heads[h];
      if (!prev || VERDICT_RANK[ch.verdict] > VERDICT_RANK[prev.verdict] || (VERDICT_RANK[ch.verdict] === VERDICT_RANK[prev.verdict] && ch.R > prev.R))
        heads[h] = { ...ch, segment: seg.name };
    }
    // A time-of-day bucket (not the broad 'daytime' window) with confident heads → a scheduled plan.
    if (seg.from != null && seg.to - seg.from < 12) {
      const confident = Object.fromEntries(Object.entries(segChars).filter(([, h]) => h.verdict === 'predictable' || h.verdict === 'drifting'));
      const schedule = { fromMin: seg.from * 60, toMin: seg.to * 60, days: [1, 2, 3, 4, 5] };
      const p = buildSegmentPlan(confident, jc.cycleSec, schedule, seg.name);
      if (p) plans.push(p);
    }
  }
  // Fallback: if no scheduled bucket plan was confident, use the broad daytime window.
  if (!plans.length) {
    const seg = segments.find((s) => s.name === 'daytime') || segments[0];
    const chars = Object.fromEntries(Object.entries(heads).filter(([, h]) => h.segment === seg?.name && h.greenSec != null));
    const C = Object.values(chars)[0]?.cycleSec;
    if (C) { const p = buildSegmentPlan(chars, C, undefined, 'observed'); if (p) plans.push(p); }
  }

  // Heads that had data in-window but never resolved a cycle in any segment:
  // report them as unstable rather than dropping them to "missing".
  const daySeg = segments.find((s) => s.name === 'daytime') || segments[0];
  for (const [h, o] of Object.entries(raw)) {
    if (heads[h]) continue;
    const g = filt(o.greenOnsets, daySeg);
    if (!g.length) continue;
    heads[h] = { cycleSec: null, verdict: 'no-clean-cycle',
      samples: { greenOnsets: g.length, passThroughs: filt(o.passThroughs, daySeg).length, stopArrivals: filt(o.stopArrivals, daySeg).length } };
  }

  const structuralHeads = [...new Set((ix.movements || []).filter((m) => !m.unsignalized && m.headId).map((m) => m.headId))];
  return {
    intersectionId: ix.id, name: ix.name,
    passes: passes.length, nowMs, windowDays: opt.sinceDays,
    armsHavePos: (ix.arms || []).some((a) => a.pos && Number.isFinite(a.pos.lat)),
    mastsHavePos: (ix.masts || []).some((m) => m.pos && Number.isFinite(m.pos.lat) && m.headIds?.length),
    heads,
    missingHeads: structuralHeads.filter((h) => !heads[h]),
    unassigned: unassigned.length,
    plans, plan: plans[0] || null, headsUsed: Object.keys(heads),
    observations: obsOut,
  };
}
