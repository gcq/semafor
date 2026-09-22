// What does a tap mean? Pure.
//
// 'onset'    = you watched this light change to that color just now (a boundary).
// 'presence' = it's showing that color; you didn't see it change (no boundary).
//
// A tap is an onset ONLY if your immediately previous tap was on the same light,
// in a different color, recently enough that you were still watching it. Every
// other tap just records what the light shows — the first tap on a light, the
// first tap after switching lights (or switching back), a repeat of the same
// color, or a tap after a long gap. The model is never consulted: when it had
// drifted it turned "this is what it shows now" into a false boundary.

export const TAP_MEMORY_MS = 200000; // longer than any single phase

/**
 * @param {{ headId: string, aspect: string, t: number }|null|undefined} prev  your previous tap (any light)
 * @param {string} headId
 * @param {string} aspect
 * @param {number} now
 * @returns {'onset'|'presence'}
 */
export function tapKind(prev, headId, aspect, now) {
  return prev && prev.headId === headId && prev.aspect !== aspect && now - prev.t <= TAP_MEMORY_MS
    ? 'onset' : 'presence';
}
