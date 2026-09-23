// The model of an intersection: its timing plans rebuilt from the whole tap log
// (inference/plans.js). This is the ONE function every view uses (Live, Coming
// up, Analyze, the Edit preview), so they can never disagree and nothing ever
// needs "saving". Pure.

import { buildModel } from './plans.js';
import { usedHeadIds } from '../domain/model.js';

/** @typedef {import('../domain/model.js').Intersection} Intersection */
/** @typedef {import('../domain/model.js').Observation} Observation */

/**
 * @param {Intersection} ix
 * @param {Observation[]} observations
 * @param {number} [now]
 * @returns {ReturnType<typeof buildModel>}  { rec, plan (for `now`, with .reliability), plans, cleaning, lastTap }
 */
export function characterizeIntersection(ix, observations, now = Date.now()) {
  return buildModel(observations ?? [], usedHeadIds(ix), now);
}
