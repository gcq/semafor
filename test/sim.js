// Deterministic traffic-controller + driver simulator for the clock-model tests.
// Pure ES module, no dependencies. All randomness comes from seeded PRNGs, so a
// scenario is reproducible from its seed alone.
//
//   const sim = createSim({ seed: 1, controllers: [ctrl({...})] });
//   sim.sit({ t: at(0, '09:00'), watch: ['hG'], aspects: ['green'], cycles: 5 });
//   const { intersections, observations } = sim.world();
//   sim.nextChange('ixA', 'hG', 'green', t)   // ground truth, ms
//
// Controller description (plain object):
//   { id, cycleSec?,                       // single all-day plan if `plans` absent
//     plans?: [{ fromMin, toMin, cycleSec, epochSec?, lights?: {headId: {green, greenSec, amberSec}} }],
//     clock?: { mode: 'steady'|'nudged'|'independent', sigmaSec?, driftSecPerHour? },
//     intersections: [{ id, name?, offsetSec?,        // offsetSec = corridor offset
//        lights: [{ id, name?, green, greenSec, amberSec = 3, actuatedSec = 0 }] }] }
// `green` = position of the green onset within the cycle (s); amber follows
// after greenSec, red after amberSec more. `actuatedSec` = +-amplitude by which
// the green length varies per cycle (the cycle itself stays fixed).
//
// A day is a "controller day": local date of (t - 4 h), matching the spec.

const H = 3600e3, DAY = 24 * H;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts) {
  let h = 2166136261;
  for (const c of parts.join('|')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const gauss = (rng) => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());

// Day 0 = Monday 7 Sep 2026 (local time of the test process).
const BASE = { y: 2026, m: 8, d: 7 };
/** Local ms for `day` (0 = Mon 7 Sep 2026) at 'HH:MM' or 'HH:MM:SS'. */
export function at(day, hms = '00:00') {
  const [h = 0, m = 0, s = 0] = hms.split(':').map(Number);
  return new Date(BASE.y, BASE.m, BASE.d + day, h, m, s).getTime();
}
const pad = (n) => String(n).padStart(2, '0');
/** The day key of the spec: local date of t - 4 h. */
export function dayKey(t) {
  const d = new Date(t - 4 * H);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayStart(t) { // local 04:00 boundary at/before t
  const d = new Date(t - 4 * H);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4).getTime();
}
function nextDayStart(s) {
  const d = new Date(s + 12 * H);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 4).getTime();
}
const minOfDay = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };
const inWindow = (p, m) => (p.fromMin <= p.toMin ? m >= p.fromMin && m < p.toMin : m >= p.fromMin || m < p.toMin);

/** Shorthand light: green onset at `green`, `greenSec` of green, `amberSec` amber. */
export const light = (id, green, greenSec, extra = {}) => ({ id, name: id, green, greenSec, amberSec: 3, actuatedSec: 0, ...extra });
export const ctrl = (c) => c;

function normalize(c, seed) {
  const plans = (c.plans ?? [{ fromMin: 0, toMin: 1440, cycleSec: c.cycleSec }])
    .map((p, i) => ({ epochSec: 0, lights: {}, ...p, idx: i }));
  const clock = { mode: 'steady', sigmaSec: 0, driftSecPerHour: 0, ...(c.clock ?? {}) };
  return { ...c, plans, clock, seed };
}

function dayOffsetSec(c, s) {
  const { mode, sigmaSec } = c.clock;
  if (mode === 'steady') return 0;
  const rng = mulberry32(hashSeed(c.seed, c.id, dayKey(s)));
  return mode === 'nudged' ? gauss(rng) * sigmaSec : rng() * 1000;
}

function markPos(c, plan, lt, aspect, n) {
  const o = { green: lt.green, greenSec: lt.greenSec, amberSec: lt.amberSec ?? 3, ...(plan.lights[lt.id] ?? {}) };
  const v = lt.actuatedSec ? (mulberry32(hashSeed(c.seed, lt.id, plan.idx, n))() - 0.5) * 2 * lt.actuatedSec : 0;
  if (aspect === 'green') return o.green;
  if (aspect === 'amber') return o.green + o.greenSec + v;
  if (aspect === 'red') return o.green + o.greenSec + o.amberSec + v;
  throw new Error('sim supports green/amber/red, got ' + aspect);
}

export function createSim({ seed = 1, controllers }) {
  const rng = mulberry32(seed);
  const ctrls = controllers.map((c) => normalize(c, seed));
  const lights = new Map(); // headId -> { c, ix, lt }
  const intersections = [];
  for (const c of ctrls) for (const ix of c.intersections) {
    intersections.push({ id: ix.id, name: ix.name ?? ix.id, heads: ix.lights.map((l) => ({ id: l.id, name: l.name ?? l.id })) });
    for (const lt of ix.lights) {
      if (lights.has(lt.id)) throw new Error('duplicate headId ' + lt.id);
      lights.set(lt.id, { c, ix, lt });
    }
  }
  const observations = [];
  let seq = 0;

  /** True change times (ms) of a light's aspect in [t0, t1). */
  function changes(headId, aspect, t0, t1) {
    const { c, ix, lt } = lights.get(headId);
    const out = [];
    for (let s = dayStart(t0); s < t1; s = nextDayStart(s)) {
      const e = nextDayStart(s), lo = Math.max(t0, s), hi = Math.min(t1, e);
      const o = dayOffsetSec(c, s);
      for (const p of c.plans) {
        const C = p.cycleSec, pos0 = (ix.offsetSec ?? 0) + markPos(c, p, lt, aspect, 0);
        const n0 = Math.floor((lo / 1000 - o - p.epochSec - pos0) / C) - 2;
        const n1 = Math.ceil((hi / 1000 - o - p.epochSec - pos0) / C) + 2;
        for (let n = n0; n <= n1; n++) {
          const base = p.epochSec + (ix.offsetSec ?? 0) + markPos(c, p, lt, aspect, n) + n * C;
          let t = (base + o) * 1000;
          t += c.clock.driftSecPerHour * ((t - s) / H) * 1000;
          if (t >= lo && t < hi && inWindow(p, minOfDay(t))) out.push(t);
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** First true change of the aspect strictly after t (ms). */
  function nextChange(headId, aspect, t) {
    for (let span = H; span <= 4 * DAY; span *= 2) {
      const r = changes(headId, aspect, t + 1e-6, t + span);
      if (r.length) return r[0];
    }
    return null;
  }

  const planAt = (headId, t) => {
    const { c } = lights.get(headId);
    return c.plans.find((p) => inWindow(p, minOfDay(t))) ?? c.plans[0];
  };

  /**
   * One sitting: watch lights from t for `cycles` cycles and tap the chosen
   * aspects. Options: watch (headIds), aspects, cycles, maxTaps, lag
   * ({minSec=0.2, extraMeanSec=0.15}), missProb, missAt (indices into the
   * time-ordered candidate taps), slipProb, slipAt ({index: {kind:'late', delaySec}
   * | {kind:'wrong'}}). Returns the new observations (also kept in the sim).
   */
  function sit({ t, watch, aspects = ['green'], cycles = 3, maxTaps = Infinity,
                 lag = {}, missProb = 0, missAt = [], slipProb = 0, slipAt = {} }) {
    const { minSec = 0.2, extraMeanSec = 0.15 } = lag;
    const heads = watch.map((w) => (typeof w === 'string' ? w : w.headId));
    const dur = cycles * planAt(heads[0], t).cycleSec * 1000;
    const cand = [];
    for (const h of heads) for (const a of aspects) for (const ev of changes(h, a, t, t + dur)) cand.push({ h, a, ev });
    cand.sort((x, y) => x.ev - y.ev || (x.h < y.h ? -1 : 1));
    const made = [];
    cand.forEach((k, i) => {
      // Always draw the same numbers per candidate so options don't shift the stream.
      const lagS = minSec - Math.log(1 - rng()) * extraMeanSec;
      const pMiss = rng(), pSlip = rng(), slipDelay = 3 + 7 * rng();
      if (made.length >= maxTaps) return;
      if (missAt.includes(i) || pMiss < missProb) return;
      let aspect = k.a, tt = k.ev + lagS * 1000;
      const slip = slipAt[i] ?? (pSlip < slipProb ? { kind: 'late', delaySec: slipDelay } : null);
      if (slip?.kind === 'late') tt = k.ev + (slip.delaySec ?? slipDelay) * 1000 + lagS * 1000;
      if (slip?.kind === 'wrong') aspect = aspects.find((a) => a !== k.a) ?? (k.a === 'green' ? 'red' : 'green');
      const obs = { id: `o${seq++}`, intersectionId: lights.get(k.h).ix.id, headId: k.h, aspect, kind: 'onset', t: Math.round(tt) };
      made.push(obs);
    });
    observations.push(...made);
    return made;
  }

  return {
    seed, intersections, observations, changes, nextChange, sit,
    /** `{ intersections, observations }` as computeModel wants it (copies). */
    world: () => ({ intersections: structuredClone(intersections), observations: observations.map((o) => ({ ...o })) }),
    intersectionOf: (headId) => lights.get(headId).ix.id,
    cycleAt: (headId, t) => planAt(headId, t).cycleSec,
  };
}
