// Timing plans from a sparse, many-day tap log. Pure.
//
// Taps come mostly one or two at a time while driving; Capture adds the odd
// dense session. A cycle length measured in one sitting is good to ~0.1 s, which
// smears to more than a whole cycle after a day (~1000 cycles), so the log is
// never folded onto one clock. Instead:
//
//   1. clean     drop taps that can't be real (repeats, slips, old formats).
//   2. sessions  taps within a few minutes of each other. A session measures
//                durations (red→green = red length) and, if it saw a color
//                twice, the cycle. A lone tap only says "the cycle is HERE now".
//   3. plans     sessions grouped by time of day while their cycle/durations
//                agree; a disagreement is a plan change. Weekday vs weekend is
//                split only when the same hour disagrees across day types, and
//                a duration that disagrees with itself at the same hour (or
//                within one session) is a sensor, not a plan.
//   4. shape     each plan's phase table: its dense sessions aligned onto the
//                richest one, then reconstructed on the plan's cycle.
//   5. phase     where the cycle is now. If the plan's taps from different days
//                line up on one cycle (clock-coordinated controller) it is
//                locked and needs no fresh taps; otherwise it's anchored on your
//                latest tap and its ± grows with every cycle since.

import { reconstructPlan, reconstructionToPlan, estimateCycleSec, circMean, isLegalNext, byHead, median } from './reconstruct.js';

export const SESSION_GAP_MS = 3 * 60 * 1000;
const REPEAT_MS = 20000;                          // same color again this soon = a double tap
const MIN_HOLD_SEC = { green: 4, red: 4, amber: 2 }; // a color can't really last less
const MAX_PAIR_SEC = 180;                         // longer than any single color
const DUR_TOL = 3.5;       // two measurements of one duration agree within this (tap jitter)
const CYCLE_TOL = 2;
const VARIABLE_SEC = 7;    // a duration swinging more than this in one sitting = sensor
const SAME_HOUR_MIN = 30;  // "the same time of day"
const TAP_SIGMA = 0.8;     // your tap vs the real change, s
const LOCK_TOL = 2;        // a session is on the locked clock if within this, s
const LOCK_FALSE_ALARM = 0.01;
const SIGMA_C_DEFAULT = 0.3;
const MAX_GRID = 20000;

const mod = (x, m) => ((x % m) + m) % m;
const round1 = (x) => Math.round(x * 10) / 10;
const std = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
const localMinute = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };
const localMidnight = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayClassOf = (t) => { const w = new Date(t).getDay(); return w === 0 || w === 6 ? 'weekend' : 'weekday'; };
const minuteDist = (a, b) => { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d); };
const circDist = (a, b, p) => { const d = mod(a - b, p); return Math.min(d, p - d); };
const clock = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// ---------- 1. clean ----------

/**
 * Keep only taps that can be real color changes. Nothing is deleted from the
 * log; the dropped ones are reported with a reason.
 * @param {object[]} observations
 * @param {string[]} [headIds]  lights that exist (others are dropped)
 */
export function cleanTaps(observations, headIds = []) {
  const known = new Set(headIds);
  const dropped = [];
  const drop = (ev, reason) => dropped.push({ ev, reason });
  const ok = [];
  for (const o of observations ?? []) {
    if (!o?.headId || !o.aspect || !Number.isFinite(o.t)) drop(o, 'old format');
    else if (known.size && !known.has(o.headId)) drop(o, 'light no longer exists');
    else if (o.kind === 'presence') drop(o, 'old "what it shows" tap');
    else ok.push(o);
  }
  const kept = [];
  for (const evs of Object.values(byHead(ok))) {
    const out = [];
    for (const e of evs) {
      const prev = out[out.length - 1];
      if (prev && prev.aspect === e.aspect && e.t - prev.t < REPEAT_MS) { drop(e, 'repeat'); continue; }
      // the previous color "lasted" impossibly briefly: that tap was a slip
      if (prev && prev.aspect !== e.aspect && (e.t - prev.t) / 1000 < (MIN_HOLD_SEC[prev.aspect] ?? 0)) { out.pop(); drop(prev, 'too short to be real'); }
      out.push(e);
    }
    kept.push(...out);
  }
  return { kept: kept.sort((a, b) => a.t - b.t), dropped };
}

// ---------- 2. sessions ----------

// Cycle measurements in a session: same-color gaps, divided by the cycles they span.
function cycleSamples(evs, C) {
  const out = [];
  for (const hev of Object.values(byHead(evs))) {
    const last = {};
    for (const e of hev) {
      if (last[e.aspect] != null) {
        const g = (e.t - last[e.aspect]) / 1000, k = Math.round(g / C);
        if (k >= 1 && Math.abs(g / k - C) < CYCLE_TOL) out.push(g / k);
      }
      last[e.aspect] = e.t;
    }
  }
  return out;
}

export function sessionsOf(events) {
  const raw = [];
  let cur = null;
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (!cur || e.t - cur.t1 > SESSION_GAP_MS) raw.push(cur = { evs: [], t0: e.t, t1: e.t });
    cur.evs.push(e); cur.t1 = e.t;
  }
  return raw.map((s) => {
    const durs = {};
    for (const hev of Object.values(byHead(s.evs))) {
      for (let i = 1; i < hev.length; i++) {
        const a = hev[i - 1], b = hev[i], sec = (b.t - a.t) / 1000;
        if (sec <= MAX_PAIR_SEC && a.aspect !== b.aspect && isLegalNext(a.aspect, b.aspect)) (durs[`${a.headId}|${a.aspect}`] ??= []).push(sec);
      }
    }
    const C = estimateCycleSec(byHead(s.evs));
    const mid = (s.t0 + s.t1) / 2;
    return { ...s, minute: localMinute(mid), dayClass: dayClassOf(mid), durs, C, samples: C ? cycleSamples(s.evs, C) : [] };
  });
}

// ---------- 3. plans ----------

const hasSignature = (s) => s.C || Object.keys(s.durs).length;

function signature(sessions) {
  const all = {};
  for (const s of sessions) for (const [k, v] of Object.entries(s.durs)) (all[k] ??= []).push(...v);
  const samples = sessions.flatMap((s) => s.samples);
  return { durs: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, median(v)])), C: samples.length ? median(samples) : null };
}

function conflicts(a, b, variable) {
  const keys = [];
  for (const [k, v] of Object.entries(a.durs)) if (!variable.has(k) && k in b.durs && Math.abs(v - b.durs[k]) > DUR_TOL) keys.push(k);
  if (a.C && b.C && Math.abs(a.C - b.C) > CYCLE_TOL) keys.push('cycle');
  return keys;
}

// Which disagreements are sensors (same hour, same day type, or inside one
// sitting) and whether weekday/weekend need separate plans (same hour, the two
// day types disagree, and nothing else explains it).
function classify(sessions) {
  const variable = new Set();
  for (const s of sessions) for (const [k, v] of Object.entries(s.durs)) if (Math.max(...v) - Math.min(...v) > VARIABLE_SEC) variable.add(k);
  let splitDays = false;
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i], b = sessions[j];
      if (minuteDist(a.minute, b.minute) > SAME_HOUR_MIN) continue;
      for (const k of conflicts(signature([a]), signature([b]), variable)) {
        if (a.dayClass === b.dayClass) { if (k !== 'cycle') variable.add(k); } else splitDays = true;
      }
    }
  }
  return { variable, splitDays };
}

// Sessions of one day type, in time-of-day order, grouped while they agree.
function groupByTime(sessions, variable) {
  const groups = [];
  for (const s of [...sessions].sort((a, b) => a.minute - b.minute)) {
    const g = groups[groups.length - 1];
    if (g && !conflicts(signature(g), signature([s]), variable).length) g.push(s);
    else groups.push([s]);
  }
  // the day wraps: the last group may simply continue into the first
  if (groups.length > 1 && !conflicts(signature(groups[0]), signature(groups[groups.length - 1]), variable).length) groups[0].unshift(...groups.pop());
  return groups;
}

// The plan in force at `t`: same day type, nearest observed time of day.
function planAt(plans, t) {
  const dc = dayClassOf(t), m = localMinute(t);
  const pool = plans.filter((p) => p.dayClass === 'all' || p.dayClass === dc);
  const pick = (ps) => ps.reduce((best, p) => {
    const d = Math.min(...p.sessions.map((s) => minuteDist(s.minute, m)));
    return !best || d < best.d ? { p, d } : best;
  }, null)?.p ?? null;
  return { plan: pick(pool.length ? pool : plans), otherDays: !pool.length };
}

// When each plan runs: the minutes of the day nearest to its sessions.
function windowsOf(plans, dayClass) {
  const probe = (m) => { const d = new Date(2026, 0, dayClass === 'weekend' ? 3 : 5); d.setHours(0, m, 0, 0); return planAt(plans, d.getTime()).plan; };
  const spans = [];
  for (let m = 0; m < 1440; m += 5) {
    const p = probe(m), last = spans[spans.length - 1];
    if (last && last.plan === p) last.to = m + 5; else spans.push({ plan: p, from: m, to: m + 5 });
  }
  if (spans.length > 1 && spans[0].plan === spans[spans.length - 1].plan) spans[0].from = spans.pop().from - 1440;
  return spans;
}

// ---------- 4. shape ----------

const onsetPos = (rec, headId, aspect) => rec.headWindows.find((h) => h.headId === headId)?.onsets.find((o) => o.aspect === aspect)?.pos;

// Consensus implied cycle-start (ms) of a session under a shape: each tap says
// "the cycle started pos seconds before me"; pull them together on one cycle.
function sessionStart(s, rec, Cms, skipHeads, lastOnly = false) {
  const starts = [];
  for (const e of lastOnly ? [...s.evs].reverse() : s.evs) {
    if (lastOnly && starts.length) break;
    if (skipHeads.has(e.headId)) continue;
    const pos = onsetPos(rec, e.headId, e.aspect);
    if (pos != null) starts.push(e.t - pos * 1000);
  }
  if (!starts.length) return null;
  const base = starts[starts.length - 1];
  const folded = starts.map((c) => c + Math.round((base - c) / Cms) * Cms);
  return { t: s.t1, start: folded.reduce((a, b) => a + b, 0) / folded.length, s };
}

function planShape(plan, headIds) {
  const dense = plan.sessions.filter((s) => s.C);
  if (!dense.length) return null;
  const samples = dense.flatMap((s) => s.samples);
  const C = Math.round(median(samples) * 100) / 100;
  const sigmaC = Math.max(0.03, samples.length > 1 ? std(samples) / Math.sqrt(samples.length) : SIGMA_C_DEFAULT);
  const Cms = C * 1000;
  const ref = dense.reduce((a, b) => (b.evs.length > a.evs.length ? b : a));
  const refRec = reconstructPlan(ref.evs, headIds, { cycleSec: C });
  if (!refRec) return null;
  // Lay every other dense session onto the reference cycle, then rebuild.
  const virtual = [...ref.evs];
  dense.forEach((s, i) => {
    if (s === ref) return;
    const a = sessionStart(s, refRec, Cms, new Set());
    if (!a) return;
    for (const e of s.evs) virtual.push({ ...e, t: refRec.epoch + mod(e.t - a.start, Cms) + (i + 1) * 1000 * Cms });
  });
  const rec = reconstructPlan(virtual, headIds, { cycleSec: C });
  return rec ? { rec, C, sigmaC } : null;
}

// ---------- 5. phase ----------

/**
 * Do this plan's sessions from different days sit on one cycle? Tried on raw
 * clock time and on time since local midnight (controllers that restart their
 * plan daily), for whole-second cycles near C and a fine grid around it. A lock
 * is accepted only when chance alignment is unlikely (few sessions can line up
 * on SOME cycle by accident, so more are needed without the whole-second prior).
 * @returns {null | { hyp: 'clock'|'daily', C: number, phase: number, rms: number, n: number }}
 */
export function lockTest(anchors, C, sigmaC) {
  if (anchors.length < 3) return null;
  const spanSec = (Math.max(...anchors.map((a) => a.start)) - Math.min(...anchors.map((a) => a.start))) / 1000;
  if (spanSec < 2 * 3600) return null;
  const p = (2 * LOCK_TOL) / C;
  const w = Math.max(0.3, 4 * sigmaC);
  const step = Math.max((LOCK_TOL / (spanSec / C)) / 2, (2 * w) / MAX_GRID);
  const ints = [];
  for (let c = Math.ceil(C - w); c <= Math.floor(C + w); c++) ints.push(c);
  const trials = Math.max(1, (2 * w * spanSec) / (C * C));
  const tol = (n) => Math.floor(n / 5); // allow one stray session per five
  let best = null;
  for (const hyp of ['clock', 'daily']) {
    const secs = anchors.map((a) => (hyp === 'clock' ? a.start : a.start - localMidnight(a.start)) / 1000);
    const score = (c, fine) => {
      const ph = secs.map((s) => mod(s, c));
      const m = circMean(ph, c);
      const r = ph.map((x) => circDist(x, m, c));
      const inl = r.filter((x) => x <= LOCK_TOL);
      if (anchors.length - inl.length > tol(anchors.length)) return;
      const k = inl.length;
      const fa = 2 * (fine ? trials * p ** (k - 2) : ints.length * p ** (k - 1));
      if (fa > LOCK_FALSE_ALARM) return;
      const rms = Math.sqrt(inl.reduce((a, x) => a + x * x, 0) / k);
      if (!best || rms < best.rms - 0.05) best = { hyp, C: c, phase: m, rms, n: k }; // ties keep 'clock' (same thing when C divides a day)
    };
    for (const c of ints) score(c, false);
    for (let c = C - w; c <= C + w; c += step) score(c, true);
  }
  return best;
}

/**
 * The whole model of one intersection at `now`.
 * @param {object[]} observations
 * @param {string[]} headIds
 * @param {number} now
 */
export function buildModel(observations, headIds, now) {
  const cleaning = cleanTaps(observations, headIds);
  const events = cleaning.kept;
  const lastTap = events[events.length - 1] ?? null;
  const lastTaps = Object.fromEntries(Object.entries(byHead(events)).map(([h, evs]) => [h, evs[evs.length - 1]]));
  const empty = { rec: null, plan: null, plans: [], cleaning, lastTap, lastTaps };
  if (!events.length) return empty;

  // plans
  const sessions = sessionsOf(events);
  const sig = sessions.filter(hasSignature);
  const { variable, splitDays } = classify(sig);
  const classes = splitDays ? ['weekday', 'weekend'] : ['all'];
  const plans = classes.flatMap((dc) => groupByTime(sig.filter((s) => dc === 'all' || s.dayClass === dc), variable)
    .map((g) => ({ dayClass: dc, sessions: g })));
  if (!plans.length) plans.push({ dayClass: 'all', sessions: [] });
  plans.forEach((p, i) => { p.id = `plan${i + 1}`; });
  for (const s of sessions) if (!hasSignature(s)) {
    const target = plans.every((p) => !p.sessions.length) ? plans[0] : planAt(plans, s.t1).plan;
    target.sessions.push(s);
  }
  for (const p of plans) {
    p.sessions.sort((a, b) => a.t0 - b.t0);
    p.shape = planShape(p, headIds);
    p.signature = signature(p.sessions.filter(hasSignature));
  }
  for (const dc of classes) for (const w of windowsOf(plans.filter((p) => p.dayClass === dc), dc)) (w.plan.windows ??= []).push(w);

  // the plan for now, and a shape for it (borrowed from the nearest plan that has one)
  const { plan: cur, otherDays } = planAt(plans, now);
  let shape = cur.shape, donor = null;
  if (!shape) {
    const m = localMinute(now);
    donor = plans.filter((p) => p.shape).sort((a, b) =>
      Math.min(...a.sessions.map((s) => minuteDist(s.minute, m))) - Math.min(...b.sessions.map((s) => minuteDist(s.minute, m))))[0];
    shape = donor?.shape ?? null;
  }
  const summary = plans.map((p) => summarize(p, variable));
  if (!shape) return { ...empty, plans: summary, variable: [...variable] };

  const { rec, C, sigmaC } = shape;
  const Cms = C * 1000;
  // a duration that swings at the same hour marks its light a sensor, like a wide fold spread
  for (const k of variable) { const h = k.split('|')[0]; if (h in rec.headVerdicts) rec.headVerdicts[h] = 'actuated'; }
  const sensorHeads = new Set(Object.entries(rec.headVerdicts).filter(([, v]) => v === 'actuated').map(([h]) => h));
  // sensor lights' taps don't anchor the cycle — unless nothing else was tapped
  const anchorsIn = (p) => {
    const a = p.sessions.map((s) => sessionStart(s, rec, Cms, sensorHeads)).filter(Boolean);
    return a.length ? a : p.sessions.map((s) => sessionStart(s, rec, Cms, new Set())).filter(Boolean);
  };
  const anchors = anchorsIn(cur);
  const lock = donor ? null : lockTest(anchors, C, sigmaC);

  // phase: locked clock; else your latest tap in this plan; else any latest tap
  const reasons = [];
  let epoch, cycleSec = C, sigma, locked = false, anchorAt = null;
  const latest = anchors[anchors.length - 1] ?? anchorsIn({ sessions: sessions }).pop();
  const fresh = latest && now - latest.t < 30 * 60 * 1000;
  const lockEpoch = lock && (lock.hyp === 'clock' ? lock.phase * 1000 : localMidnight(now) + lock.phase * 1000);
  const onLock = (start) => circDist((lock.hyp === 'clock' ? start : start - localMidnight(start)) / 1000, lock.phase, lock.C);
  const lockAgrees = lock && (!fresh || onLock(latest.start) <= 2 * LOCK_TOL);
  if (lock && lockAgrees) {
    epoch = lockEpoch; cycleSec = lock.C; sigma = round1(Math.max(TAP_SIGMA, lock.rms)); locked = true;
    reasons.push(`clock-locked over ${lock.n} sittings${lock.hyp === 'daily' ? ' (restarts at midnight)' : ''}`);
  } else if (latest) {
    // re-anchor on the last change you saw (earlier taps in that sitting can
    // disagree with a borrowed or stale shape; this one is what's on the road)
    epoch = sessionStart(latest.s, rec, Cms, sensorHeads, true)?.start ?? latest.start; anchorAt = latest.t;
    const cycles = Math.max(0, (now - latest.start) / Cms);
    sigma = Math.sqrt(TAP_SIGMA ** 2 + (cycles * sigmaC) ** 2);
    if (lock) reasons.push('your latest taps disagree with the learned clock');
    reasons.push(`anchored on your tap ${ago(now - latest.t)}`);
    if (!anchors.length) reasons.push('no taps at this time of day yet');
  } else return { ...empty, plans: summary, variable: [...variable] };

  if (donor) {
    const diff = Object.entries(cur.signature.durs).find(([k, v]) => k in donor.signature.durs && Math.abs(v - donor.signature.durs[k]) > DUR_TOL);
    reasons.push(diff ? `timing differs at this hour (${diff[0].split('|')[1]} ${Math.round(diff[1])}s vs ${Math.round(donor.signature.durs[diff[0]])}s learned)` : 'timing learned at another time of day');
  }
  if (otherDays) reasons.push(`no ${dayClassOf(now)} taps yet`);
  const level = donor && reasons.some((r) => r.startsWith('timing differs')) ? 'low'
    : sigma <= 3 && !donor && !otherDays ? 'high'
    : sigma <= cycleSec / 6 ? 'medium' : 'low';

  const plan = reconstructionToPlan(rec, { id: cur.id, name: cur.id });
  plan.epoch = epoch;
  plan.cycleLengthMs = Math.round(cycleSec * 1000);
  plan.reliability = { level, sigmaSec: round1(sigma), reasons, locked, anchorAt, borrowed: !!donor };
  return { rec, plan, plans: summary, cleaning, lastTap, lastTaps, variable: [...variable] };
}

function ago(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : m < 36 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

function summarize(p, variable) {
  return {
    id: p.id, dayClass: p.dayClass,
    windows: (p.windows ?? []).map((w) => `${clock(mod(w.from, 1440))}–${clock(mod(w.to, 1440))}`),
    cycleSec: p.shape?.C ?? (p.signature?.C ? round1(p.signature.C) : null),
    durations: Object.fromEntries(Object.entries(p.signature?.durs ?? {}).filter(([k]) => !variable.has(k)).map(([k, v]) => [k, round1(v)])),
    sittings: p.sessions.length, taps: p.sessions.reduce((a, s) => a + s.evs.length, 0), hasShape: !!p.shape,
  };
}
