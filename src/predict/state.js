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

/**
 * Predict a head's aspect at `now`.
 * @param {TimingPlan} plan
 * @param {string} headId
 * @param {number} now
 * @returns {Prediction|null}
 */
export function predictHead(plan, headId, now) {
  if (!plan?.stages?.length) return null;
  const phases = plan.stages;
  const t = cycleTimeMs(plan, now) / 1000;

  let acc = 0, idx = 0, uncertainBefore = false;
  for (let i = 0; i < phases.length; i++) {
    const len = phases[i].timing.sec;
    if (t < acc + len || i === phases.length - 1) { idx = i; break; }
    if (phases[i].timing.type === 'actuated' || phases[i].partial) uncertainBefore = true;
    acc += len;
  }
  const phase = phases[idx];
  const elapsed = t - acc;
  const remaining = Math.max(0, phase.timing.sec - elapsed);
  const aspect = phase.states[headId] ?? 'off';
  const nextPhase = phases[(idx + 1) % phases.length];

  const uncertain = uncertainBefore || phase.timing.type === 'actuated' || !!phase.partial;
  let range = null;
  if (phase.timing.type === 'actuated') {
    const min = Math.max(0, (phase.timing.min ?? phase.timing.sec) - elapsed);
    const max = Math.max(0, (phase.timing.max ?? phase.timing.sec) - elapsed);
    range = [Math.round(min), Math.round(max)];
  }
  const info = ASPECT_INFO[aspect] ?? ASPECT_INFO.off;
  return {
    aspect, color: info.color, go: info.go,
    secToChange: Math.round(remaining), range, uncertain,
    next: nextPhase.states[headId] ?? 'off', phaseIndex: idx,
  };
}

/**
 * Seconds until a head NEXT turns `targetAspect` (its onset), scanning forward
 * from `now`. This is the "green in T seconds" horizon the Live view needs: it
 * answers "when will it change TO green", not "how long until the current phase
 * ends". If the head is already showing the target, secToAspect is 0. Returns
 * null if the plan never shows that aspect for the head.
 *
 * `uncertain` is set when any phase between now and that onset is actuated or
 * partial (an unobserved transition), so the horizon is an estimate, not a clock.
 * @param {TimingPlan} plan
 * @param {string} headId
 * @param {number} now
 * @param {import('../domain/model.js').Aspect} targetAspect
 * @returns {{ secToAspect: number, current: boolean, uncertain: boolean }|null}
 */
export function timeToAspect(plan, headId, now, targetAspect = 'green') {
  if (!plan?.stages?.length) return null;
  const phases = plan.stages;
  if (!phases.some((p) => (p.states[headId] ?? 'off') === targetAspect)) return null;

  const len = phases.reduce((s, p) => s + p.timing.sec, 0);
  if (!len) return null;
  const t = cycleTimeMs(plan, now) / 1000;

  // locate current phase + offset
  let acc = 0, idx = 0;
  for (let i = 0; i < phases.length; i++) {
    if (t < acc + phases[i].timing.sec || i === phases.length - 1) { idx = i; break; }
    acc += phases[i].timing.sec;
  }
  const aspectOf = (i) => phases[i].states[headId] ?? 'off';
  if (aspectOf(idx) === targetAspect) return { secToAspect: 0, current: true, uncertain: phases[idx].timing.type === 'actuated' || !!phases[idx].partial };

  // walk forward to the next phase whose aspect is the target (an onset)
  let remaining = phases[idx].timing.sec - (t - acc);
  let uncertain = phases[idx].timing.type === 'actuated' || !!phases[idx].partial;
  for (let step = 1; step <= phases.length; step++) {
    const j = (idx + step) % phases.length;
    if (aspectOf(j) === targetAspect) return { secToAspect: Math.round(remaining), current: false, uncertain };
    if (phases[j].timing.type === 'actuated' || phases[j].partial) uncertain = true;
    remaining += phases[j].timing.sec;
  }
  return null;
}

/**
 * Predict for a movement (resolves its head) or the intersection's first
 * signalized movement.
 * @param {Intersection} ix
 * @param {{ movementId?: string, headId?: string, now?: number }} [opts]
 * @returns {Prediction|null}
 */
export function predictIntersection(ix, opts = {}) {
  const now = opts.now ?? Date.now();
  const plan = activePlan(ix.plans, now);
  if (!plan) return null;
  let headId = opts.headId;
  if (!headId && opts.movementId) headId = ix.movements.find((m) => m.id === opts.movementId)?.headId;
  if (!headId) headId = ix.movements?.find((m) => !m.unsignalized && m.headId)?.headId;
  if (!headId) return null;
  return predictHead(plan, headId, now);
}
