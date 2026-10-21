// Prediction from the clock model (src/inference/clock.js). Pure: the Model and
// `now` in, a countdown out. See docs/clock-model.md ("Prediction").

import { successor } from './sequence.js';
import { dayKeyOf } from '../inference/clock.js';

const mod = (x, m) => ((x % m) + m) % m;
const round1 = (x) => Math.round(x * 10) / 10;
const minuteOf = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };

const inWindow = (min, w) => (w.fromMin <= w.toMin ? min >= w.fromMin && min < w.toMin : min >= w.fromMin || min < w.toMin);
const windowDist = (plan, min) => {
  let best = Infinity;
  for (const w of plan.windows ?? []) {
    if (inWindow(min, w)) return 0;
    for (const e of [w.fromMin, w.toMin]) { const d = Math.abs(min - e) % 1440; best = Math.min(best, d, 1440 - d); }
  }
  return best;
};
const pickPlan = (plans, t) => {
  const min = minuteOf(t);
  return plans.map((p) => ({ p, d: windowDist(p, min) })).sort((a, b) => a.d - b.d)[0]?.p ?? null;
};

// The one plan of a group in force at t (by window), or null.
const planInForce = (group, t) => {
  const min = minuteOf(t);
  return group.plans.find((p) => windowDist(p, min) === 0) ?? null;
};

const lagMean = (model) => Math.max(0.2, model.lag?.meanSec ?? (model.lag?.medianSec ?? 0.35)) ;
const lagSd = (model) => Math.max(0.1, lagMean(model) - (model.lag?.minSec ?? 0.2));

function findLight(model, headId) {
  const light = model.lights?.[headId];
  if (!light) return null;
  const group = model.groups.find((g) => g.id === light.groupId);
  return group ? { light, group } : null;
}

const offKey = (plan, mark, day) => (plan.clock.hypothesis === 'independent' && (plan.marks[mark]?.comp ?? 0) !== 0 ? `${day}#${plan.marks[mark].comp}` : day);

// Today's offset for an independent plan with no tap yet: circular mean (on the cycle) of the
// past days' offsets for the same component. n = 0 -> offset 0, sd = C/2 (no idea).
function estOffset(ck, key, C) {
  const suffix = key.split('#')[1] ?? '';
  let s = 0, c = 0, n = 0;
  for (const [k, v] of Object.entries(ck.dayOffsets ?? {})) {
    if (k === key || (k.split('#')[1] ?? '') !== suffix) continue;
    s += Math.sin((2 * Math.PI * v) / C); c += Math.cos((2 * Math.PI * v) / C); n++;
  }
  if (!n) return { off: 0, sd: C / 2, n };
  const R = Math.min(1, Math.hypot(s, c) / n);
  const sd = R < 1e-9 ? C / 2 : Math.min(C / 2, Math.sqrt(-2 * Math.log(R)) * C / (2 * Math.PI));
  return { off: (Math.atan2(s, c) * C) / (2 * Math.PI), sd, n };
}

const agoText = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : m < 36 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/**
 * Where one mark stands at `now`: its next and previous change, and how sure.
 * `guess: true` marks a best estimate with no tap today (or from another time of day's plan).
 * @returns {{ unpredictable: true, reason: string } | { nextMs, lastMs, plusMinus, basis, planId, plan, mark, guess? }}
 */
export function predictMark(model, headId, aspect, now) {
  const f = findLight(model, headId);
  if (!f) return { unpredictable: true, reason: 'no taps for this light' };
  const mark = `${headId}|${aspect}`;
  if (!f.group.plans.some((p) => p.marks[mark])) return { unpredictable: true, reason: `no ${aspect} tap in a known plan yet` };
  let plan = planInForce(f.group, now), guess = false;
  if (!plan?.marks[mark]) { plan = pickPlan(f.group.plans.filter((p) => p.marks[mark]), now); guess = true; }
  const m = plan.marks[mark], ck = plan.clock, C = plan.cycleSec;
  if (m.actuated) return { unpredictable: true, reason: 'actuated' };
  const day = dayKeyOf(now), key = offKey(plan, mark, day);
  const anchored = ck.dayOffsets[key] !== undefined;
  let off = 0, basis, pm;
  const cyclesSigma = plan.cycleSigmaSec ?? 0;
  if (anchored) {
    off = ck.dayOffsets[key];
    const tap = ck.lastTaps?.[key];
    const agoMs = tap ? Math.max(0, now - tap.t) : 0;
    const aSpread = tap ? plan.marks[`${tap.headId}|${tap.aspect}`]?.spreadSec ?? 0 : 0;
    const cycles = agoMs / 1000 / C, hours = agoMs / 3.6e6;
    pm = Math.sqrt(lagSd(model) ** 2 + m.spreadSec ** 2 + aSpread ** 2 + (cycles * cyclesSigma) ** 2 + (hours * Math.abs(ck.driftSecPerHour ?? 0)) ** 2);
    const ixName = tap ? model.names?.[tap.ixId] ?? tap.ixId : null;
    basis = tap ? `tap ${agoText(agoMs)}${ixName ? ` at ${ixName}` : ''}` : 'tap today';
  } else if (ck.hypothesis === 'independent') {
    const e = estOffset(ck, key, C);
    off = e.off; guess = true;
    pm = e.n ? Math.min(C / 2, Math.sqrt(e.sd ** 2 + m.spreadSec ** 2 + lagSd(model) ** 2)) : C / 2;
    basis = 'guess · no tap today';
  } else {
    const sigma = ck.hypothesis === 'nudged' ? ck.nudgeSigmaSec ?? 3 : ck.residRmsSec ?? 1;
    const cycles = Math.abs(now - ck.epochMs) / 1000 / C;
    pm = Math.sqrt(sigma ** 2 + m.spreadSec ** 2 + (cycles * cyclesSigma) ** 2 + lagSd(model) ** 2);
    pm = Math.max(pm, ck.heldOutErrSec ?? 0);
    basis = `clock from ${ck.days} days`;
  }
  if (guess && basis !== 'guess · no tap today') basis = 'guess · other time of day';
  const Cms = C * 1000, base = ck.epochMs + 1000 * (off + m.posSec);
  const nextMs = base + Math.ceil((now - base) / Cms) * Cms;
  return { nextMs, lastMs: nextMs - Cms, plusMinus: Math.max(0.5, round1(pm)), basis, planId: plan.id, plan, mark, ...(guess && { guess }) };
}

/**
 * When does this light next change to `aspect`?
 * @returns {{ inSec:number, plusMinus:number, basis:string, planId:string, guess?:true } | { unpredictable:true, reason:string }}
 */
export function nextOnset(model, headId, aspect = 'green', now = Date.now()) {
  const p = predictMark(model, headId, aspect, now);
  if (p.unpredictable) return p;
  return { inSec: round1((p.nextMs - now) / 1000), plusMinus: p.plusMinus, basis: p.basis, planId: p.planId, ...(p.guess && { guess: true }) };
}

const SIGNAL = ['green', 'amber', 'red'];

/**
 * The next phase change of a light: the soonest onset among its tapped colours other than the
 * one shown (`shown`, default `currentAspect`). If `shown` is a colour the model has already left
 * (the display guard is holding it), it is overdue: its successor in the guard's order, in 0 s,
 * with the ± and basis of the model's current mark. Only for a light whose whole cycle is known (>= 2
 * tapped colours, all predictable, all green/amber/red) — with just green and red the change
 * after green is red, nothing is invented in between. null otherwise: the caller falls back to
 * `nextOnset(..., 'green')`.
 * @returns {{ aspect:string, inSec:number, plusMinus:number, basis:string, guess?:true } | null}
 */
export function nextChange(model, headId, now = Date.now(), shown = undefined) {
  const light = model.lights?.[headId];
  if (!light || light.aspects.length < 2 || light.aspects.some((a) => !SIGNAL.includes(a))) return null;
  const cur = shown ?? currentAspect(model, headId, now);
  if (!cur) return null;
  const modelNow = currentAspect(model, headId, now);
  // (a shown colour whose own onset is < 1 s away is the display a hair ahead of the model, not behind it)
  if (shown && modelNow && shown !== modelNow && predictMark(model, headId, shown, now).nextMs - now > 1000) {
    const p = predictMark(model, headId, modelNow, now);
    return { aspect: successor(shown, light.aspects), inSec: 0, plusMinus: p.plusMinus, basis: p.basis, ...(p.guess && { guess: true }) };
  }
  let best = null;
  for (const a of SIGNAL.filter((x) => light.aspects.includes(x))) {
    const p = predictMark(model, headId, a, now);
    if (p.unpredictable) return null;
    if (a !== cur && (!best || p.nextMs < best.p.nextMs)) best = { a, p };
  }
  if (!best) return null;
  const { p } = best;
  return { aspect: best.a, inSec: Math.max(0, round1((p.nextMs - now) / 1000)), plusMinus: p.plusMinus, basis: p.basis, ...(p.guess && { guess: true }) };
}

/**
 * The colour showing now, or null when it can't honestly be said (fewer than two
 * colours tapped for this light, or one of them is unpredictable).
 */
export function currentAspect(model, headId, now = Date.now()) {
  const light = model.lights?.[headId];
  if (!light || light.aspects.length < 2) return null;
  let best = null;
  for (const a of light.aspects) {
    const p = predictMark(model, headId, a, now);
    if (p.unpredictable) return null;
    if (!best || p.lastMs > best.lastMs) best = { a, lastMs: p.lastMs };
  }
  return best?.a ?? null;
}

/**
 * @typedef {Object} PhaseTable  one intersection's cycle as stages, for the scene and editor preview
 * @property {string} id
 * @property {string} name
 * @property {number} epoch                ms; start of the stage cycle containing `now`
 * @property {number} cycleLengthMs
 * @property {{ name: string, states: Record<string, string>, timing: { type: 'fixed'|'actuated', sec: number } }[]} stages
 *           states: headId -> aspect, held for timing.sec
 * @property {string[]} unpredictableHeads  heads with an actuated mark
 * @property {boolean} uncertain           today's offset is unknown (independent days, no tap yet)
 * @property {{ cycles: number, level: 'low'|'medium'|'high' }} confidence
 */

/**
 * The cycle of one intersection from mark positions, for the scene and editor
 * preview. null if nothing is known.
 * @returns {PhaseTable|null}
 */
export function phaseTable(model, intersectionId, now = Date.now()) {
  const heads = Object.entries(model.lights ?? {}).filter(([, l]) => l.intersectionId === intersectionId).map(([h]) => h);
  if (!heads.length) return null;
  const group = model.groups.find((g) => g.id === model.lights[heads[0]].groupId);
  if (!group) return null;
  const mine = (plan) => Object.keys(plan.marks).filter((k) => heads.includes(k.split('|')[0]));
  const plan = planInForce(group, now);
  if (!plan || !mine(plan).length) return null;
  const C = plan.cycleSec, ck = plan.clock;
  // marks of this intersection, in the component with the most of them
  const all = mine(plan).map((k) => ({ k, head: k.split('|')[0], aspect: k.split('|')[1], ...plan.marks[k] }));
  const comps = new Map();
  for (const m of all) comps.set(m.comp ?? 0, (comps.get(m.comp ?? 0) ?? 0) + 1);
  const comp = [...comps].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const ms = all.filter((m) => (m.comp ?? 0) === comp);
  const perHead = new Map();
  for (const m of ms) { if (!perHead.has(m.head)) perHead.set(m.head, []); perHead.get(m.head).push(m); }
  const full = [...perHead].filter(([, l]) => l.length >= 2);
  if (!full.length) return null;
  const marks = full.flatMap(([, l]) => l).sort((a, b) => a.posSec - b.posSec || (a.k < b.k ? -1 : 1));
  // boundaries: positions closer than 0.75 s are one boundary
  const bounds = [];
  for (const m of marks) {
    const b = bounds[bounds.length - 1];
    if (b && m.posSec - b.pos < 0.75) { b.marks.push(m); m.bi = bounds.length - 1; } else { bounds.push({ pos: m.posSec, marks: [m] }); m.bi = bounds.length - 1; }
  }
  const stages = bounds.map((b, i) => {
    const end = i + 1 < bounds.length ? bounds[i + 1].pos : bounds[0].pos + C;
    const states = {};
    for (const [head, l] of full) {
      const sorted = [...l].sort((a, c) => a.bi - c.bi);
      const cur = [...sorted].reverse().find((m) => m.bi <= i) ?? sorted[sorted.length - 1];
      states[head] = cur.aspect;
    }
    const ending = bounds[(i + 1) % bounds.length];
    return { name: `phase ${i + 1}`, states, timing: { type: ending.marks.some((m) => m.actuated) ? 'actuated' : 'fixed', sec: round1(end - b.pos) } };
  });
  // the stages' seconds are rounded; make them add up to the cycle
  const drift = C - stages.reduce((a, s) => a + s.timing.sec, 0);
  stages[stages.length - 1].timing.sec = round1(stages[stages.length - 1].timing.sec + drift);
  const key = comp !== 0 && ck.hypothesis === 'independent' ? `${dayKeyOf(now)}#${comp}` : dayKeyOf(now);
  const off = ck.dayOffsets[key] ?? (ck.hypothesis === 'independent' ? estOffset(ck, key, C).off : 0), Cms = C * 1000;
  const base = ck.epochMs + 1000 * (off + bounds[0].pos);
  const epoch = Math.round(base + Math.floor((now - base) / Cms) * Cms);
  const unpredictableHeads = full.filter(([, l]) => l.some((m) => m.actuated)).map(([h]) => h);
  return {
    id: plan.id, name: plan.id, epoch, cycleLengthMs: Math.round(Cms), stages, unpredictableHeads,
    uncertain: ck.dayOffsets[key] === undefined && ck.hypothesis === 'independent',
    confidence: { cycles: ck.days, level: ck.hypothesis === 'steady' ? 'high' : ck.hypothesis === 'nudged' ? 'medium' : 'low' },
  };
}

/**
 * A cheap copy of the model with today's offset re-anchored on `tap`
 * ({ headId, aspect, t }): the instant response before the full recompute lands.
 * Returns the model unchanged if the tap can't anchor anything.
 */
export function withTap(model, tap) {
  const f = findLight(model, tap.headId);
  if (!f) return model;
  const mark = `${tap.headId}|${tap.aspect}`;
  const plan = planInForce(f.group, tap.t);
  if (!plan || !plan.marks[mark] || plan.marks[mark].actuated) return model;
  const C = plan.cycleSec, m = plan.marks[mark], ck = plan.clock;
  const tau = tap.t / 1000 - lagMean(model);
  const off = mod(tau - ck.epochMs / 1000 - m.posSec + C / 2, C) - C / 2;
  const key = offKey(plan, mark, dayKeyOf(tap.t));
  const clock = {
    ...ck,
    dayOffsets: { ...ck.dayOffsets, [key]: Math.round(off * 1000) / 1000 },
    lastTaps: { ...ck.lastTaps, [key]: { t: tap.t, ixId: f.light.intersectionId, headId: tap.headId, aspect: tap.aspect } },
  };
  return {
    ...model,
    groups: model.groups.map((g) => (g.id !== f.group.id ? g : { ...g, plans: g.plans.map((p) => (p.id !== plan.id ? p : { ...p, clock })) })),
  };
}
