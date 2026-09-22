// Predictor. A reconstructed plan is a phase sequence whose states are keyed by
// headId and whose values are observed ASPECTS (green/amber/flash-amber/red/off).
// Given the wall clock, report a head's (or movement's) aspect and countdown.
// Amber is a real observed phase now, so there's no clearance math here.
//
// Pure.

import { ASPECT_INFO } from '../domain/model.js';

/** @typedef {import('../domain/model.js').Intersection} Intersection */
/** @typedef {import('../domain/model.js').TimingPlan} TimingPlan */

export function activePlan(plans, now, clock = () => new Date(now)) {
  if (!plans?.length) return null;
  const d = clock();
  const min = d.getHours() * 60 + d.getMinutes();
  const day = d.getDay();
  let fallback = null;
  for (const p of plans) {
    const s = p.schedule;
    if (!s) { fallback = fallback ?? p; continue; }
    if (s.days && !s.days.includes(day)) continue;
    const from = s.fromMin ?? 0, to = s.toMin ?? 24 * 60;
    const inWindow = from <= to ? min >= from && min < to : min >= from || min < to;
    if (inWindow) return p;
  }
  return fallback;
}

export function cycleTimeMs(plan, now) {
  const len = plan.cycleLengthMs || plan.stages.reduce((s, p) => s + p.timing.sec * 1000, 0);
  if (!len) return 0;
  return ((now - plan.epoch) % len + len) % len;
}

/**
 * @typedef {Object} Prediction
 * @property {import('../domain/model.js').Aspect} aspect
 * @property {string} color
 * @property {boolean} go
 * @property {number} secToChange
 * @property {[number,number]|null} range
 * @property {boolean} uncertain
 * @property {import('../domain/model.js').Aspect} next
 * @property {number} phaseIndex
 */

// A phase's timing describes its END boundary: `type` says whether that
// boundary is fixed or actuated, and for actuated ones `min`/`max` bound the
// phase's duration (i.e. when the boundary can fall).
const endsActuated = (ph) => ph.timing?.type === 'actuated';
// Is this head's aspect in this phase a guess spanning an unobserved change?
const partialFor = (ph, headId) => (ph.partialHeads ? ph.partialHeads.includes(headId) : !!ph.partial);

function locate(phases, t) {
  let acc = 0;
  for (let i = 0; i < phases.length; i++) {
    if (t < acc + phases[i].timing.sec || i === phases.length - 1) return { idx: i, elapsed: t - acc };
    acc += phases[i].timing.sec;
  }
  return { idx: 0, elapsed: 0 };
}

// Seconds from now until the boundary at the END of phase `endIdx` (walking
// forward from the current phase), plus its range if that boundary is actuated.
// Only the boundary you're waiting for matters: jitter of other heads'
// boundaries in between doesn't move it (positions are cycle-relative), so a
// fixed head at a junction with an actuated one still gets an exact countdown.
function arrival(phases, idx, elapsed, steps) {
  let total = phases[idx].timing.sec - elapsed;
  let end = idx;
  for (let s = 1; s <= steps; s++) { end = (idx + s) % phases.length; total += phases[end].timing.sec; }
  const ph = phases[end];
  let range = null;
  if (endsActuated(ph)) {
    const lo = total + ((ph.timing.min ?? ph.timing.sec) - ph.timing.sec);
    const hi = total + ((ph.timing.max ?? ph.timing.sec) - ph.timing.sec);
    range = [Math.max(0, Math.round(lo)), Math.max(0, Math.round(hi))];
  }
  return { sec: Math.max(0, total), range, actuated: endsActuated(ph) };
}

/**
 * Predict a head's aspect at `now`, and how long until IT changes color (not
 * merely until the next phase boundary — at a multi-head junction the head can
 * keep its color across several phases).
 * @param {TimingPlan} plan
 * @param {string} headId
 * @param {number} now
 * @returns {Prediction|null}
 */
export function predictHead(plan, headId, now) {
  if (!plan?.stages?.length) return null;
  const phases = plan.stages;
  const { idx, elapsed } = locate(phases, cycleTimeMs(plan, now) / 1000);
  const aspectAt = (i) => phases[i].states[headId] ?? 'off';
  const aspect = aspectAt(idx);

  // walk until the head's aspect differs (at most one full cycle)
  let steps = 0;
  while (steps < phases.length - 1 && aspectAt((idx + steps + 1) % phases.length) === aspect) steps++;
  const next = aspectAt((idx + steps + 1) % phases.length);
  const a = arrival(phases, idx, elapsed, steps);

  const info = ASPECT_INFO[aspect] ?? ASPECT_INFO.off;
  return {
    aspect, color: info.color, go: info.go,
    secToChange: Math.round(a.sec), range: a.range,
    uncertain: a.actuated || partialFor(phases[idx], headId),
    next, phaseIndex: idx,
  };
}

/**
 * Seconds until a head NEXT turns `targetAspect` (its onset), scanning forward
 * from `now`. This is the "green in T seconds" horizon the Live view needs. If
 * the head is already showing the target, secToAspect is 0 (see predictHead for
 * how long it lasts). Returns null if the plan never shows that aspect for it.
 * `range` is set when that onset is an actuated boundary.
 * @param {TimingPlan} plan
 * @param {string} headId
 * @param {number} now
 * @param {import('../domain/model.js').Aspect} targetAspect
 * @returns {{ secToAspect: number, current: boolean, uncertain: boolean, range: [number,number]|null }|null}
 */
export function timeToAspect(plan, headId, now, targetAspect = 'green') {
  if (!plan?.stages?.length) return null;
  const phases = plan.stages;
  const aspectAt = (i) => phases[i].states[headId] ?? 'off';
  if (!phases.some((_, i) => aspectAt(i) === targetAspect)) return null;
  const { idx, elapsed } = locate(phases, cycleTimeMs(plan, now) / 1000);
  if (aspectAt(idx) === targetAspect) return { secToAspect: 0, current: true, uncertain: false, range: null };

  // the target begins at the start of phase j = the end of phase j-1
  for (let steps = 0; steps < phases.length; steps++) {
    const j = (idx + steps + 1) % phases.length;
    if (aspectAt(j) === targetAspect) {
      const a = arrival(phases, idx, elapsed, steps);
      return { secToAspect: Math.round(a.sec), current: false, uncertain: a.actuated, range: a.range };
    }
  }
  return null;
}
