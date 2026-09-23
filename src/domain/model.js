// Onda domain model — observation-first.
//
// You author only STRUCTURE: arms, movements (from-arm →(via)→ to-arm), the
// mapping of each movement to a HEAD (a logical light, grouped by hand with
// split/merge), and where masts sit on the map. You DO NOT author phasing.
//
// PHASING is reconstructed from OBSERVATIONS: you watch a head and tap its color
// on each change (green / amber / flashing-amber / red / off). inference/
// reconstruct.js folds those onto a cycle, derives the phases, and decides if
// the controller is time-based at all. Plans (time-of-day) are inferred too.
//
// Pure data + constructors + guards. No DOM, no storage.

/** @typedef {{ lat: number, lon: number }} GeoPoint */

/** What a head actually shows — the observed vocabulary. */
/** @typedef {'green'|'amber'|'flash-amber'|'red'|'off'} Aspect */
export const ASPECTS = ['green', 'amber', 'flash-amber', 'red', 'off'];
export const MOVE_KINDS = ['vehicle', 'bike'];

/** UI color token + whether a driver may proceed, per aspect. */
export const ASPECT_INFO = {
  green:         { color: 'green',    go: true,  label: 'Green' },
  amber:         { color: 'yellow',   go: false, label: 'Amber' },
  'flash-amber': { color: 'flashYel', go: true,  label: 'Flashing amber' },
  red:           { color: 'red',      go: false, label: 'Red' },
  off:           { color: 'dark',     go: false, label: 'Off / dark' },
};

/**
 * A road segment (arm) meeting the junction.
 * @typedef {Object} Arm
 * @property {string} id
 * @property {string} [name]
 * @property {GeoPoint} [pos]
 */

/**
 * A logical light. Movements are assigned to heads by hand (merge = same head,
 * split = its own head). Heads are placed physically via masts.
 * @typedef {Object} Head
 * @property {string} id
 * @property {string} [name]
 * @property {boolean} [flashing]  a permanent flashing-amber/red head (Spanish yield)
 */

/**
 * A maneuver: from one arm to another, optionally via intermediates. Controlled
 * by exactly one head (unless unsignalized).
 * @typedef {Object} Movement
 * @property {string} id
 * @property {string} from
 * @property {string} to
 * @property {string[]} [via]
 * @property {'vehicle'|'bike'} [kind]
 * @property {boolean} [unsignalized]
 * @property {string} [label]
 * @property {string} [headId]     which head controls it
 */

/** @typedef {{ type: 'fixed'|'actuated', sec: number }} PhaseTiming  type describes the boundary that ENDS the phase */

/**
 * A reconstructed phase: each head's aspect, held for a duration. Derived from
 * observation, never authored. (Kept as `stages` so shared timing code works.)
 * @typedef {Object} Phase
 * @property {string} [name]
 * @property {Record<string, Aspect>} states   headId -> aspect
 * @property {PhaseTiming} timing
 */

/** @typedef {{ fromMin?: number, toMin?: number, days?: number[] }} Schedule */
/** @typedef {{ cycles: number, stdevSec?: number, level: 'low'|'medium'|'high' }} Confidence */

/**
 * A reconstructed controller behaviour for a time window.
 * @typedef {Object} TimingPlan
 * @property {string} id
 * @property {string} [name]
 * @property {Schedule} [schedule]
 * @property {number} epoch
 * @property {Phase[]} stages
 * @property {number} [cycleLengthMs]
 * @property {Confidence} [confidence]
 * @property {string[]} [unpredictableHeads]  actuated heads: never predicted
 */

/**
 * A physical pole on the map, showing one or more heads. The same head can ride
 * on several masts (median dual carriageway = one head, two masts).
 * @typedef {Object} Mast
 * @property {string} id
 * @property {GeoPoint} pos
 * @property {string[]} headIds
 */

/**
 * An observation: a head changed to `aspect` at time `t`. This is the ground
 * truth phasing is reconstructed from — one tap per real-world color change.
 *
 * `kind` is always 'onset' for new taps (the head JUST changed to `aspect`).
 * 'presence' (showing `aspect`, change unseen) is legacy: the app no longer
 * records it, and reconstruction ignores any old ones still in the log.
 * @typedef {Object} Observation
 * @property {string} id            unique (sync merges by union of ids)
 * @property {string} intersectionId
 * @property {string} headId
 * @property {Aspect} aspect
 * @property {number} t
 * @property {'onset'|'presence'} [kind]
 * @property {GeoPoint} [where]
 * @property {number} [heading]
 */

/**
 * @typedef {Object} Intersection
 * @property {string} id
 * @property {string} name
 * @property {GeoPoint} location
 * @property {Arm[]} arms
 * @property {Head[]} heads
 * @property {Movement[]} movements
 * @property {Mast[]} masts
 * @property {TimingPlan[]} plans      imported fallback only (e.g. TeslaMate); the live model is
 *                                     always reconstructed from observations, never saved
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} rev              monotonic edit counter (sync compares this)
 */

let _seq = 0;
export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${(_seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** @param {Partial<Intersection>} [init] @returns {Intersection} */
export function makeIntersection(init = {}) {
  const now = Date.now();
  return {
    id: init.id ?? uid('ix'),
    name: init.name ?? 'Untitled intersection',
    location: init.location ?? { lat: 0, lon: 0 },
    arms: init.arms ?? [],
    heads: init.heads ?? [],
    movements: init.movements ?? [],
    masts: init.masts ?? [],
    plans: init.plans ?? [],
    createdAt: init.createdAt ?? now,
    updatedAt: now,
    rev: init.rev ?? 0,
  };
}

/** Head ids actually used by signalized movements. */
export const usedHeadIds = (ix) =>
  [...new Set(ix.movements.filter((m) => !m.unsignalized && m.headId).map((m) => m.headId))];

export const cycleLengthMs = (phases) =>
  phases.reduce((s, p) => s + Math.max(0, p.timing?.sec ?? 0) * 1000, 0);

export function withCycleLength(plan) {
  return { ...plan, cycleLengthMs: cycleLengthMs(plan.stages) };
}

/** @param {Intersection} ix @returns {string[]} problems; empty = OK */
export function validateIntersection(ix) {
  const errs = [];
  if (!ix.id) errs.push('missing id');
  if (!ix.location || typeof ix.location.lat !== 'number') errs.push('missing/invalid location');
  const armIds = new Set((ix.arms ?? []).map((a) => a.id));
  const headIds = new Set((ix.heads ?? []).map((h) => h.id));
  for (const m of ix.movements ?? []) {
    if (!armIds.has(m.from)) errs.push(`movement ${m.id}: unknown from-arm ${m.from}`);
    if (!armIds.has(m.to)) errs.push(`movement ${m.id}: unknown to-arm ${m.to}`);
    if (!m.unsignalized && m.headId && !headIds.has(m.headId)) errs.push(`movement ${m.id}: unknown head ${m.headId}`);
  }
  return errs;
}
