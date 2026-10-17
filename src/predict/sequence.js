// Display guard: a head's shown colour only ever goes green -> amber -> red -> green, however the
// model jumps between ticks. Pure. See docs/clock-model.md ("Prediction").

const CYCLE = ['green', 'amber', 'red'];
export const HOLD_MS = 3000, MIN_SHOW_MS = 1000;

const guarded = (a) => CYCLE.includes(a);
const successor = (a, known) => {
  const c = CYCLE.filter((x) => known.includes(x) || x === a);
  return c[(c.indexOf(a) + 1) % c.length];
};

/**
 * @param {{ aspect: string, sinceMs: number, stepAt?: number }|null} prev  what is shown now
 * @param {string|null} model  the model's colour now
 * @param {number} now
 * @param {string[]} known  the head's tapped aspects
 * @returns {{ aspect: string, sinceMs: number, stepAt?: number }|null}
 */
export function guardAspect(prev, model, now, known = []) {
  if (!model) return null;
  if (!prev || !guarded(prev.aspect) || !guarded(model)) return prev && prev.aspect === model ? prev : { aspect: model, sinceMs: now };
  if (model === prev.aspect) return { aspect: prev.aspect, sinceMs: prev.sinceMs };
  const next = successor(prev.aspect, known);
  if (model === next) return { aspect: next, sinceMs: now };
  // illegal jump: hold; once the mismatch (stepAt = its start) has lasted 3 s and this colour has shown 1 s, step once
  const since = prev.stepAt ?? now;
  if (now - since >= HOLD_MS && now - prev.sinceMs >= MIN_SHOW_MS) return { aspect: next, sinceMs: now, stepAt: since };
  return { aspect: prev.aspect, sinceMs: prev.sinceMs, stepAt: since };
}

/** A user tap is ground truth. */
export const tapped = (aspect, now) => ({ aspect, sinceMs: now });
