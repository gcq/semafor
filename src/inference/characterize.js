// The model of an intersection: reconstruct its plan from its observations.
// This is the ONE function every view uses (Live, Coming up, Analyze, the Edit
// preview), so they can never disagree and nothing ever needs "saving". Pure.

import { reconstructPlan, reconstructionToPlan } from './reconstruct.js';
import { usedHeadIds } from '../domain/model.js';

/** @typedef {import('../domain/model.js').Intersection} Intersection */
/** @typedef {import('../domain/model.js').Observation} Observation */

// Fold only the recent taps (a session) so the current cycle/phase dominate any
// older, drifted ones; with nothing recent, the full log is used.
export const RECENT_WINDOW_MS = 6 * 3600 * 1000;

/**
 * @param {Intersection} ix
 * @param {Observation[]} observations
 * @param {number} [now]
 * @returns {{ rec: ReturnType<typeof reconstructPlan>, plan: import('../domain/model.js').TimingPlan|null }}
 */
export function characterizeIntersection(ix, observations, now = Date.now()) {
  const rec = reconstructPlan(observations ?? [], usedHeadIds(ix), { recentWindowMs: RECENT_WINDOW_MS, now });
  return { rec, plan: rec ? reconstructionToPlan(rec) : null };
}
