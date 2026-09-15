// High-level characterization for the observation-first model: reconstruct one
// intersection's plan(s) from its aspect observations, and find coordinated
// corridors across the network. Pure.

import { reconstructPlan, reconstructionToPlan } from './reconstruct.js';
import { findCorridors, compareIntersections } from './linkage.js';
import { usedHeadIds } from '../domain/model.js';

/** @typedef {import('../domain/model.js').Intersection} Intersection */
/** @typedef {import('../domain/model.js').Observation} Observation */

/**
 * Reconstruct an intersection from its observations.
 * @param {Intersection} ix
 * @param {Observation[]} observations
 * @returns {{ rec: ReturnType<typeof reconstructPlan>, plan: import('../domain/model.js').TimingPlan|null }}
 */
export function characterizeIntersection(ix, observations) {
  const heads = usedHeadIds(ix);
  const rec = reconstructPlan(observations ?? [], heads);
  return { rec, plan: rec ? reconstructionToPlan(rec) : null };
}

/** Turn a saved plan into the linkage-facing cycle estimate. */
export function planToEstimate(plan) {
  if (!plan?.stages?.length) return null;
  const cycleLengthSec = plan.stages.reduce((s, st) => s + st.timing.sec, 0);
  return {
    cycleLengthSec,
    cycleStdevSec: plan.confidence?.stdevSec ?? 0,
    cyclesObserved: plan.confidence?.cycles ?? 1,
    epoch: plan.epoch,
    confidence: plan.confidence ?? { cycles: 1, stdevSec: 0, level: 'low' },
  };
}

/**
 * Build one cycle estimate per intersection (prefer fresh reconstruction, fall
 * back to a saved plan) and find coordinated corridors.
 * @param {Intersection[]} intersections
 * @param {Record<string, Observation[]>} observationsByIx
 * @param {(ix: Intersection) => import('../domain/model.js').TimingPlan|null} pickPlan
 */
export function characterizeNetwork(intersections, observationsByIx, pickPlan) {
  const estimates = {};
  for (const ix of intersections) {
    const { rec } = characterizeIntersection(ix, observationsByIx[ix.id] ?? []);
    const est = (rec && rec.modelable)
      ? { cycleLengthSec: rec.cycleLengthSec, cycleStdevSec: rec.confidence.stdevSec, cyclesObserved: rec.cyclesObserved, epoch: rec.epoch, confidence: rec.confidence }
      : planToEstimate(pickPlan ? pickPlan(ix) : ix.plans[0]);
    if (est) estimates[ix.id] = est;
  }
  const { corridors, verdicts } = findCorridors(estimates);
  return { corridors, verdicts, estimates };
}

export { compareIntersections };
