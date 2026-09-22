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
 * @property {import('../domain/model.js').Aspect|null} aspect  null = not predicted (actuated)
 * @property {string} color
 * @property {boolean} go
 * @property {number|null} secToChange   null when unpredictable
 * @property {boolean} uncertain          an unobserved aspect makes this arc a guess
 * @property {boolean} unpredictable      actuated head: no prediction offered
 * @property {import('../domain/model.js').Aspect|null} next
 * @property {number} phaseIndex
 */

// Actuated lights are not predicted: their timing depends on live detector
// demand, so the error compounds cycle after cycle and within a few cycles any
// "green in T" is noise. Reconstructed plans name those heads explicitly;
// older/imported plans (e.g. from the TeslaMate tool) mark phases instead, so
// for them the boundary you're waiting for being actuated means "don't predict".
const unpredictable = (plan, headId, endPhase) =>
  plan.unpredictableHeads ? plan.unpredictableHeads.includes(headId) : endPhase?.timing?.type === 'actuated';
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

// Seconds from now to the END of the phase `steps` phases ahead. Positions are
// cycle-relative, so other heads' boundaries in between don't move it.
function secondsUntilEnd(phases, idx, elapsed, steps) {
  let total = phases[idx].timing.sec - elapsed;
  for (let s = 1; s <= steps; s++) total += phases[(idx + s) % phases.length].timing.sec;
  return Math.max(0, total);
}

const NOT_PREDICTED = { aspect: null, color: 'dark', go: false, secToChange: null, uncertain: true, unpredictable: true, next: null };

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
  if (unpredictable(plan, headId, phases[(idx + steps) % phases.length])) return { ...NOT_PREDICTED, phaseIndex: idx };

  const info = ASPECT_INFO[aspect] ?? ASPECT_INFO.off;
  return {
    aspect, color: info.color, go: info.go,
    secToChange: Math.round(secondsUntilEnd(phases, idx, elapsed, steps)),
    uncertain: partialFor(phases[idx], headId), unpredictable: false,
    next: aspectAt((idx + steps + 1) % phases.length), phaseIndex: idx,
  };
}

/**
 * Seconds until a head NEXT turns `targetAspect` (its onset), scanning forward
 * from `now`. This is the "green in T seconds" horizon the Live view needs. If
 * the head is already showing the target, secToAspect is 0 (see predictHead for
 * how long it lasts). Returns null if the plan never shows that aspect for it.
 * @param {TimingPlan} plan
 * @param {string} headId
 * @param {number} now
 * @param {import('../domain/model.js').Aspect} targetAspect
 * @returns {{ secToAspect: number|null, current: boolean, unpredictable: boolean }|null}
 */
export function timeToAspect(plan, headId, now, targetAspect = 'green') {
  if (!plan?.stages?.length) return null;
  const phases = plan.stages;
  const aspectAt = (i) => phases[i].states[headId] ?? 'off';
  if (!phases.some((_, i) => aspectAt(i) === targetAspect)) return null;
  const { idx, elapsed } = locate(phases, cycleTimeMs(plan, now) / 1000);
  if (plan.unpredictableHeads?.includes(headId)) return { secToAspect: null, current: false, unpredictable: true };
  if (aspectAt(idx) === targetAspect) return { secToAspect: 0, current: true, unpredictable: false };

  // the target begins at the start of phase j = the end of phase j-1
  for (let steps = 0; steps < phases.length; steps++) {
    const j = (idx + steps + 1) % phases.length;
    if (aspectAt(j) === targetAspect) {
      if (unpredictable(plan, headId, phases[(idx + steps) % phases.length])) return { secToAspect: null, current: false, unpredictable: true };
      return { secToAspect: Math.round(secondsUntilEnd(phases, idx, elapsed, steps)), current: false, unpredictable: false };
    }
  }
  return null;
}
