// Clock model (v2): stateless timing from taps. See docs/clock-model.md.
//
// computeModel({ observations, intersections }) is pure and deterministic: the
// same taps and map always give the same Model. No DOM, no storage, no
// randomness; runs in Node and in a Web Worker.
//
// Pipeline: clean -> sittings -> per-(sitting, intersection) cycle -> plans
// (cycle clusters + time of day) -> per plan: marks, actuated, slips, clock
// hypotheses (steady / nudged / independent by leave-one-day-out error) ->
// corridors (plans of different intersections that share a clock) -> lights,
// useful taps.

export const ALGO_VERSION = 'clock-2';

export const MIN_LAG = 0.2;            // a tap is never before the change, s
const REPEAT_MS = 20000;               // same mark again this soon = double tap
export const SITTING_GAP_MS = 3 * 60 * 1000;
const MIN_C = 20, MAX_C = 300;         // plausible cycle lengths, s
const PLAN_C_TOL = 2;                  // cycle estimates agree within this, s
const CORRIDOR_C_TOL = 1.5;
const CORRIDOR_PHASE_TOL = 1.5;        // same-day phase difference repeats within this, s
const CORRIDOR_PAIR_SEC = 240;         // taps this close in time are "together"
const ACTUATED_SPREAD = 3;             // a mark's wander inside a sitting beyond this, s
const MIN_DAYS = 3;                    // distinct days needed to claim steady / nudged
const MAX_FOLDS = 8;                   // cross-validation folds (= leave-one-day-out up to this many days)
const CAP = 4;                         // robust cap on a phase residual, s
const DAY_SHIFT_MS = 4 * 3600e3;       // the "day" starts at 04:00 local
const FAR_MIN = 120;                   // a cycle-less tap this far (minutes of day) from any timed sitting may be another plan
const MARGIN_MIN = 150;                // a plan's window extends this far past its own sittings
const FILL_MIN = 600;                  // ...and fills the stretch between two of its sittings up to this long
const GRID_MIN = 5;                    // window grid, minutes
const ASPECT_ORDER = ['green', 'amber', 'flash-amber', 'red', 'off'];

const mod = (x, m) => ((x % m) + m) % m;
const sdiff = (a, b, C) => { let d = (a - b) % C; if (d > C / 2) d -= C; else if (d < -C / 2) d += C; return d; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = (x, k = 3) => { const f = 10 ** k; return Math.round(x * f) / f; };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]; };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const dayKeyOf = (t) => {
  const d = new Date(t - DAY_SHIFT_MS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const localMinute = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };
const minuteDist = (a, b) => { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d); };

function circMean(vals, C) {
  let sx = 0, sy = 0;
  for (const v of vals) { const a = (v / C) * 2 * Math.PI; sx += Math.cos(a); sy += Math.sin(a); }
  return mod((Math.atan2(sy, sx) / (2 * Math.PI)) * C, C);
}
// Robust circular location: circular mean, then clipped-mean refinement.
function robustLoc(vals, C, cap = CAP) {
  if (!vals.length) return 0;
  let r = vals.length === 1 ? vals[0] : circMean(vals, C);
  for (let it = 0; it < 2; it++) {
    let s = 0;
    for (const v of vals) s += clamp(sdiff(v, r, C), -cap, cap);
    r += s / vals.length;
  }
  return mod(r, C);
}
// Circular median-ish (for edges): median of signed diffs around the circular mean.
function circMedian(vals, C) {
  if (vals.length === 1) return vals[0];
  const m = circMean(vals, C);
  return mod(m + median(vals.map((v) => sdiff(v, m, C))), C);
}

// ---------- 1. clean ----------

/**
 * Keep only taps that can be real onsets of a known light.
 * @returns {{ taps: object[], dropped: {tapId:string, reason:string}[] }}
 */
export function cleanTaps(observations, headToIx) {
  const dropped = [];
  const ok = [];
  for (const o of observations ?? []) {
    if (!o || !o.headId || !o.aspect || !Number.isFinite(o.t)) dropped.push({ tapId: o?.id ?? null, reason: 'old format' });
    else if (o.kind && o.kind !== 'onset') dropped.push({ tapId: o.id, reason: 'not an onset' });
    else if (!headToIx.has(o.headId)) dropped.push({ tapId: o.id, reason: 'unknown light' });
    else ok.push({ id: o.id, t: o.t, headId: o.headId, aspect: o.aspect, mark: `${o.headId}|${o.aspect}`, ixId: headToIx.get(o.headId) });
  }
  ok.sort((a, b) => a.t - b.t || cmp(a.id, b.id));
  const last = new Map();
  const taps = [];
  for (const tp of ok) {
    const prev = last.get(tp.mark);
    if (prev != null && tp.t - prev < REPEAT_MS) { dropped.push({ tapId: tp.id, reason: 'repeat' }); continue; }
    last.set(tp.mark, tp.t);
    taps.push(tp);
  }
  return { taps, dropped };
}

// ---------- 2. sittings, parts ----------

export function sittingsOf(taps) {
  const out = [];
  let cur = null;
  for (const tp of taps) {
    if (!cur || tp.t - cur.t1 > SITTING_GAP_MS) out.push(cur = { id: `s${out.length + 1}`, index: out.length, t0: tp.t, t1: tp.t, taps: [] });
    cur.taps.push(tp); cur.t1 = tp.t;
  }
  return out;
}

const groupBy = (xs, f) => { const m = new Map(); for (const x of xs) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };

/**
 * Cycle of one set of taps (one sitting at one intersection): same-mark gaps
 * divided by the whole cycles they span. Fractional cycles; chains of
 * consistent gaps are regressed so a long chain pins C tightly.
 * @returns {{ C:number, sigma:number, nGaps:number, strong:boolean, g0?:number }|null}
 */
export function partCycle(taps) {
  const chains = [];
  const gaps = [];
  for (const list of groupBy(taps, (x) => x.mark).values()) {
    for (let i = 1; i < list.length; i++) {
      const g = (list[i].t - list[i - 1].t) / 1000;
      if (g >= MIN_C * 0.9 && g <= MAX_C * 8) gaps.push({ g, mark: list[0].mark, i });
    }
  }
  if (!gaps.length) return null;
  const explained = (c, g) => { const k = Math.max(1, Math.round(g / c)); return k <= 8 && Math.abs(g - k * c) <= 2 + 0.15 * k ? k : 0; };
  const cands = [];
  for (const { g } of gaps) for (let k = 1; k <= 8; k++) { const c = g / k; if (c >= MIN_C && c <= MAX_C) cands.push(c); }
  cands.sort((a, b) => a - b);
  const scored = [];
  for (let ci = 0; ci < cands.length; ci++) {
    if (ci && cands[ci] - cands[ci - 1] < 0.05) continue;
    let c = cands[ci];
    for (let pass = 0; pass < 2; pass++) { // refine on the gaps it explains
      let sk = 0, skg = 0;
      for (const { g } of gaps) { const k = explained(c, g); if (k) { sk += k * k; skg += k * g; } }
      if (sk) c = skg / sk;
    }
    const n = gaps.filter(({ g }) => explained(c, g)).length;
    if (n) scored.push({ c, n });
  }
  if (!scored.length) return null;
  // the largest cycle that explains nearly as many gaps as the best (a smaller
  // divisor of the true cycle always explains at least as many)
  const nmax = Math.max(...scored.map((x) => x.n));
  const best = scored.filter((x) => x.n >= Math.ceil(0.7 * nmax)).sort((a, b) => b.c - a.c)[0];
  // chain regression
  let sxx = 0, sxy = 0, rss = 0, dof = 0;
  for (const list of groupBy(taps, (x) => x.mark).values()) {
    let chain = [list[0]], ns = [0];
    const flush = () => {
      if (chain.length >= 2) {
        const tm = mean(chain.map((x) => x.t / 1000)), nm = mean(ns);
        let a = 0, b = 0;
        chain.forEach((x, i) => { a += (ns[i] - nm) * (ns[i] - nm); b += (ns[i] - nm) * (x.t / 1000 - tm); });
        chains.push({ chain, ns, a, b, tm, nm });
        sxx += a; sxy += b;
      }
    };
    for (let i = 1; i < list.length; i++) {
      const g = (list[i].t - list[i - 1].t) / 1000, k = explained(best.c, g);
      if (k) { chain.push(list[i]); ns.push(ns[ns.length - 1] + k); }
      else { flush(); chain = [list[i]]; ns = [0]; }
    }
    flush();
  }
  if (!sxx) return null;
  const C = sxy / sxx;
  for (const { chain, ns, tm, nm } of chains) chain.forEach((x, i) => { const r = x.t / 1000 - tm - (ns[i] - nm) * C; rss += r * r; });
  dof = chains.reduce((a, c) => a + c.chain.length - 1, 0) - chains.length;
  const sRes = dof > 0 ? Math.max(0.3, Math.sqrt(rss / dof)) : 0.4;
  const nGaps = best.n;
  const out = { C, sigma: sRes / Math.sqrt(sxx), nGaps, strong: nGaps >= 2 };
  if (!out.strong) out.g0 = gaps.find(({ g }) => explained(best.c, g)).g;
  return out;
}

// ---------- lag model ----------

// Shifted exponential: tap = change + MIN_LAG + Exp(mean mu). Within a cell of k
// same-mark taps the k-1 spacings above the earliest tap are an unbiased sample
// of the exponential, so mu = sum(x - min) / sum(k - 1).
function learnLag(parts) {
  let num = 0, den = 0;
  for (const part of parts) {
    if (!part.strong) continue;
    for (const list of groupBy(part.taps, (x) => x.mark).values()) {
      if (list.length < 2) continue;
      const t0 = list[0].t;
      const rs = list.map((x) => { const dt = (x.t - t0) / 1000; return dt - Math.round(dt / part.C) * part.C; });
      const med = median(rs);
      if (rs.some((r) => Math.abs(r - med) > 2.5)) continue;
      const mn = Math.min(...rs);
      num += sum(rs.map((r) => r - mn)); den += list.length - 1;
    }
  }
  const mu = den >= 4 ? clamp(num / den, 0.1, 1.0) : 0.35;
  return { muSec: mu, minSec: MIN_LAG, medianSec: round(MIN_LAG + mu * Math.LN2, 2), p90Sec: round(MIN_LAG + mu * Math.LN10, 2) };
}

// ---------- 3. plans ----------

function clusterByC(items, tol = PLAN_C_TOL) {
  const sorted = [...items].sort((a, b) => a.C - b.C || a.t0 - b.t0);
  const out = [];
  for (const it of sorted) {
    const cl = out[out.length - 1];
    if (cl && it.C - cl.items[cl.items.length - 1].C <= tol) cl.items.push(it);
    else out.push({ items: [it] });
  }
  return out;
}
const weightedC = (items) => {
  const w = items.map((p) => 1 / (p.sigma ** 2 + 0.0004));
  const C = sum(items.map((p, i) => p.C * w[i])) / sum(w);
  return { C, sigma: Math.max(0.005, Math.sqrt(1 / sum(w))) };
};

function buildPlansFor(ixId, parts) {
  const mine = parts.filter((p) => p.ixId === ixId);
  const withC = mine.filter((p) => p.cyc && p.cyc.strong).map((p) => ({ part: p, C: p.cyc.C, sigma: p.cyc.sigma, t0: p.t0 }));
  let clusters = clusterByC(withC).map((c) => ({ items: c.items }));
  const weak = mine.filter((p) => p.cyc && !p.cyc.strong);
  const unresolved = [];
  for (const p of weak) {
    let pick = null;
    for (let k = 1; k <= 8; k++) {
      const c = p.cyc.g0 / k;
      if (c < MIN_C || c > MAX_C) continue;
      for (const cl of clusters) {
        const d = Math.abs(c - weightedC(cl.items).C);
        if (d <= PLAN_C_TOL && (!pick || d < pick.d - 1e-9)) pick = { cl, d, c };
      }
      if (pick) break; // smallest k that matches a known cycle
    }
    if (pick) pick.cl.items.push({ part: p, C: pick.c, sigma: 0.5, t0: p.t0 });
    else unresolved.push({ part: p, C: p.cyc.g0, sigma: 0.5, t0: p.t0 });
  }
  for (const c of clusterByC(unresolved)) {
    const near = clusters.find((cl) => Math.abs(weightedC(cl.items).C - c.items[0].C) <= PLAN_C_TOL);
    if (near) near.items.push(...c.items); else clusters.push({ items: c.items });
  }
  clusters = clusters.map((cl) => ({ parts: cl.items.map((i) => i.part), items: cl.items }));
  // lone taps (no cycle estimate): the plan nearest in time of day
  for (const p of mine.filter((q) => !q.cyc)) {
    if (!clusters.length) break;
    let best = null;
    for (const cl of clusters) {
      const d = Math.min(...cl.items.map((q) => minuteDist(q.part.minute, p.minute)));
      if (!best || d < best.d) best = { cl, d };
    }
    p.far = best.d > FAR_MIN;
    best.cl.parts.push(p);
  }
  return clusters.map((cl) => {
    const wc = weightedC(cl.items);
    return { ixIds: [ixId], parts: cl.parts, C0: wc.C, sigC0: wc.sigma };
  });
}

// ---------- 4. clock fit ----------

function makeFit(cells) {
  const marks = [...new Set(cells.map((c) => c.mark))].sort();
  const days = [...new Set(cells.map((c) => c.day))].sort();
  const mi = new Map(marks.map((m, i) => [m, i])), di = new Map(days.map((d, i) => [d, i]));
  const n = cells.length;
  const F = { n, marks, days, tau: new Float64Array(n), mk: new Int32Array(n), dy: new Int32Array(n), byMark: marks.map(() => []), byDay: days.map(() => []) };
  cells.forEach((c, i) => { F.tau[i] = c.u; F.mk[i] = mi.get(c.mark); F.dy[i] = di.get(c.day); F.byMark[F.mk[i]].push(i); F.byDay[F.dy[i]].push(i); });
  return F;
}

// Fit positions (and, if nudged, day offsets) at a fixed cycle C.
function solveAt(F, C, mode, sigma) {
  const p = new Float64Array(F.n);
  for (let i = 0; i < F.n; i++) { const t = F.tau[i]; p[i] = t - Math.floor(t / C) * C; }
  const pos = new Float64Array(F.marks.length), off = new Float64Array(F.days.length);
  const nudged = mode === 'nudged';
  const K = nudged ? 1 / (sigma * sigma) : 0; // cell noise ~1 s
  const adj = [];
  for (let it = 0; it < (nudged ? 3 : 1); it++) {
    for (let m = 0; m < F.marks.length; m++) {
      adj.length = 0;
      for (const i of F.byMark[m]) adj.push(p[i] - off[F.dy[i]]);
      pos[m] = robustLoc(adj, C);
    }
    if (nudged) {
      for (let d = 0; d < F.days.length; d++) {
        let s = 0;
        for (const i of F.byDay[d]) s += clamp(sdiff(p[i], pos[F.mk[i]], C), -CAP, CAP);
        off[d] = s / (F.byDay[d].length + K);
      }
    }
  }
  let cost = 0;
  for (let i = 0; i < F.n; i++) { const r = sdiff(p[i] - off[F.dy[i]], pos[F.mk[i]], C); cost += Math.min(r * r, CAP * CAP); }
  if (nudged) for (let d = 0; d < F.days.length; d++) cost += (off[d] / sigma) ** 2;
  return { cost, pos, off, p };
}

// Allocation-free cost of cycle C (the hot loop of the C search): the same
// objective as solveAt, with a cheap location estimate per mark.
function costAt(F, C, nudged, sigma) {
  const n = F.n, tau = F.tau, mk = F.mk, dy = F.dy;
  const p = F._p ?? (F._p = new Float64Array(n)), off = F._off ?? (F._off = new Float64Array(F.days.length)), pos = F._pos ?? (F._pos = new Float64Array(F.marks.length));
  for (let i = 0; i < n; i++) { const t = tau[i]; p[i] = t - Math.floor(t / C) * C; }
  off.fill(0);
  const K = nudged ? 1 / (sigma * sigma) : 0, iters = nudged ? 3 : 1, CAP2 = CAP * CAP;
  for (let it = 0; it < iters; it++) {
    for (let m = 0; m < pos.length; m++) {
      const ids = F.byMark[m], L = ids.length;
      let r = p[ids[0]] - off[dy[ids[0]]];
      for (let k = 0; k < 3; k++) {
        let s = 0;
        for (let j = 0; j < L; j++) { const i = ids[j]; let d = p[i] - off[dy[i]] - r; d -= C * Math.round(d / C); s += d > CAP ? CAP : d < -CAP ? -CAP : d; }
        r += s / L;
      }
      pos[m] = r;
    }
    if (nudged) {
      for (let d = 0; d < off.length; d++) {
        const ids = F.byDay[d];
        let s = 0;
        for (let j = 0; j < ids.length; j++) { const i = ids[j]; let x = p[i] - pos[mk[i]]; x -= C * Math.round(x / C); s += x > CAP ? CAP : x < -CAP ? -CAP : x; }
        off[d] = s / (ids.length + K);
      }
    }
  }
  let cost = 0;
  for (let i = 0; i < n; i++) { let d = p[i] - off[dy[i]] - pos[mk[i]]; d -= C * Math.round(d / C); cost += d * d < CAP2 ? d * d : CAP2; }
  if (nudged) for (let d = 0; d < off.length; d++) cost += (off[d] / sigma) ** 2;
  return cost;
}

// Search C around C0 (coarse, then fine), pulled toward C0 by the within-sitting estimate.
function searchC(F, C0, w, mode, sigma, refine = true, prior = 0.05) {
  let tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < F.n; i++) { tmin = Math.min(tmin, F.tau[i]); tmax = Math.max(tmax, F.tau[i]); }
  const N = Math.max(1, (tmax - tmin) / C0);
  const s1 = Math.min(0.02, Math.max(1e-5, (refine ? 2.5 : 3.5) / N));
  let best = null;
  const nudged = mode === 'nudged';
  const tryC = (C) => { const cost = costAt(F, C, nudged, sigma) + ((C - C0) / prior) ** 2; if (!best || cost < best.cost - 1e-9) best = { C, cost }; };
  const n1 = Math.ceil(w / s1);
  for (let i = -n1; i <= n1; i++) tryC(C0 + i * s1);
  if (refine) { const c0 = best.C; for (let i = -15; i <= 15; i++) tryC(c0 + (i * s1) / 10); }
  best.N = N;
  return best;
}

// Search C, then solve everything at the winner. For `steady`, marks seen in
// one cell cannot constrain C, so the search ignores them (positions don't).
function fitSearch(cells, C0, w, mode, sigma, refine = true, prior = 0.05) {
  const Ff = makeFit(cells);
  let C = C0, N = 1;
  const sub = mode === 'steady' ? cells.filter((c) => Ff.byMark[Ff.marks.indexOf(c.mark)].length >= 2) : cells;
  if (sub.length) { const s = searchC(sub === cells ? Ff : makeFit(sub), C0, w, mode, sigma, refine, prior); C = s.C; N = s.N; }
  return { C, N, F: Ff, ...solveAt(Ff, C, mode, sigma) };
}

// Cost of cycle C when only same-day links count (days are unrelated): positions
// from within-sitting phase differences, one free offset per (day, component).
function independentDayCost(cells, C) {
  const sol = independentSolve(cells, C);
  let cost = 0;
  for (const list of groupBy(cells, (c) => `${c.day}#${sol.comp[c.mark]}`).values()) {
    const vals = list.map((c) => mod(mod(c.u, C) - sol.pos[c.mark], C));
    const o = robustLoc(vals, C);
    for (const v of vals) { const r = sdiff(v, o, C); cost += Math.min(r * r, CAP * CAP); }
  }
  return cost;
}

function independentSolve(cells, C) {
  const marks = [...new Set(cells.map((c) => c.mark))].sort();
  const bySit = groupBy(cells, (c) => c.sit);
  const edges = new Map();
  const cnt = new Map();
  const phase = (c) => mod(c.u, C);
  for (const c of cells) cnt.set(c.mark, (cnt.get(c.mark) ?? 0) + 1);
  for (const list of bySit.values()) {
    const pm = new Map();
    for (const c of list) { if (!pm.has(c.mark)) pm.set(c.mark, []); pm.get(c.mark).push(phase(c)); }
    const ms = [...pm.keys()].sort();
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
      const key = `${ms[i]}\u0000${ms[j]}`;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push(sdiff(circMean(pm.get(ms[i]), C), circMean(pm.get(ms[j]), C), C)); // pos_i - pos_j
    }
  }
  const adj = new Map(marks.map((m) => [m, []]));
  for (const [key, diffs] of edges) {
    const [a, b] = key.split('\u0000');
    const d = sdiff(circMedian(diffs.map((x) => mod(x, C)), C), 0, C);
    adj.get(a).push([b, -d]); // pos_b = pos_a - d
    adj.get(b).push([a, d]);  // pos_a = pos_b + d
  }
  const pos = {}, comp = {};
  let k = 0;
  const order = [...marks].sort((a, b) => cnt.get(b) - cnt.get(a) || cmp(a, b));
  for (const seed of order) {
    if (comp[seed] !== undefined) continue;
    comp[seed] = k; pos[seed] = 0;
    const q = [seed];
    while (q.length) {
      const a = q.shift();
      for (const [b, d] of adj.get(a).sort((x, y) => cmp(x[0], y[0]))) if (comp[b] === undefined) { comp[b] = k; pos[b] = pos[a] + d; q.push(b); }
    }
    k++;
  }
  // per sitting-component offsets, gauge so the offsets average 0
  const offSit = new Map();
  const perComp = new Map();
  for (const [sit, list] of bySit) {
    for (const [kk, cl] of groupBy(list, (c) => comp[c.mark])) {
      const o = circMean(cl.map((c) => phase(c) - pos[c.mark]), C);
      offSit.set(`${sit}#${kk}`, o);
      if (!perComp.has(kk)) perComp.set(kk, []);
      perComp.get(kk).push(o);
    }
  }
  const A = new Map([...perComp].map(([kk, os]) => [kk, circMean(os, C)]));
  const posRaw = {};
  for (const m of marks) { posRaw[m] = pos[m] + A.get(comp[m]); pos[m] = mod(posRaw[m], C); }
  for (const [key, o] of offSit) offSit.set(key, sdiff(o, A.get(Number(key.split('#')[1])), C));
  return { pos, posRaw, comp, offSit, ncomp: k };
}

// Hold each day out: refit on the others, predict that day's cells from the
// training positions (offset 0). Score a day by its median |error|.
function heldOut(cells, C0, w, mode, sigma, prior) {
  const days = [...new Set(cells.map((c) => c.day))].sort();
  const folds = Math.min(days.length, MAX_FOLDS); // leave-one-day-out; many days -> round-robin folds
  const errs = [];
  for (let f = 0; f < folds; f++) {
    const out = new Set(days.filter((_, i) => i % folds === f));
    const train = cells.filter((c) => !out.has(c.day)), test = cells.filter((c) => out.has(c.day));
    if (new Set(train.map((c) => c.day)).size < 2) continue;
    const fit = fitSearch(train, C0, w, mode, sigma, false, prior);
    const pm = new Map(fit.F.marks.map((m, i) => [m, fit.pos[i]]));
    for (const d of out) {
      const e = [];
      for (const c of test) if (c.day === d && pm.has(c.mark)) e.push(Math.abs(sdiff(mod(c.u, fit.C), pm.get(c.mark), fit.C)));
      if (e.length) errs.push(median(e));
    }
  }
  return errs;
}

function scoreDays(errs) { return errs.length >= 2 ? pct(errs, 0.75) : null; }

// ---------- 5. plan analysis ----------

const DEFAULT_SIGMA_N = 4;

function analyzePlan(plan, lag) {
  const { muSec: mu } = lag;
  const C0 = plan.C0;
  const outliers = [];
  const cells = [];
  const tapsOf = new Map(); // mark -> n taps kept
  const markStat = new Map(); // mark -> { wander, ambiguous }
  const stat = (m) => { if (!markStat.has(m)) markStat.set(m, { wander: 0, ambiguous: 0 }); return markStat.get(m); };
  for (const part of plan.parts) {
    const Cp = part.cyc?.strong ? part.cyc.C : C0;
    for (const [mark, list] of groupBy(part.taps, (x) => x.mark)) {
      let taps = list;
      const redus = (ts) => { const t0 = ts[0].t; return ts.map((x) => { const dt = (x.t - t0) / 1000, n = Math.round(dt / Cp); return { x, r: dt - n * Cp, tr: x.t - n * Cp * 1000 }; }); };
      let rs = redus(taps);
      let spread = Math.max(...rs.map((o) => o.r)) - Math.min(...rs.map((o) => o.r));
      let kind = 'ok';
      if (spread > ACTUATED_SPREAD) {
        if (taps.length >= 3) {
          const med = median(rs.map((o) => o.r));
          const worst = rs.reduce((a, b) => (Math.abs(b.r - med) > Math.abs(a.r - med) ? b : a));
          const rest = rs.filter((o) => o !== worst);
          if (rest.length >= 2 && Math.max(...rest.map((o) => o.r)) - Math.min(...rest.map((o) => o.r)) <= 2) {
            outliers.push({ tapId: worst.x.id, sittingId: part.sitting.id, kind: 'slip', gainSec: round(Math.abs(worst.r - median(rest.map((o) => o.r))), 1) });
            taps = rest.map((o) => o.x); rs = redus(taps);
          } else { kind = 'wander'; stat(mark).wander++; }
        } else { kind = 'ambiguous'; stat(mark).ambiguous++; }
      }
      tapsOf.set(mark, (tapsOf.get(mark) ?? 0) + taps.length);
      const k = taps.length;
      const tau = (Math.min(...rs.map((o) => o.tr)) - 1000 * (MIN_LAG + mu / k)) / 1000;
      cells.push({ mark, part, sit: part.sitting.index, day: dayKeyOf(tau * 1000), tau, k, kind, taps, ids: taps.map((x) => x.id), spreadIn: spread });
    }
  }
  // Phases are measured from T0 (near the data), not from the 1970 epoch: a tiny
  // change of C then moves positions by well under a second instead of minutes.
  const T0 = Math.round(median(cells.map((c) => c.tau)) || 0);
  for (const c of cells) c.u = c.tau - T0;
  const actuated = new Set();
  for (const [m, s] of markStat) if (s.wander >= 1 || s.ambiguous >= 2) actuated.add(m);
  const fitCells = (extraOut = new Set()) => cells.filter((c) => c.kind === 'ok' && !actuated.has(c.mark) && !extraOut.has(c) && !farIn.has(c));
  const farIn = new Set();
  let used = fitCells();
  let clock = fitClock(used, C0, plan.sigC0, lag);
  // Cycle-less taps far (in time of day) from every timed sitting only inform
  // this plan if they agree with it; if the plan only holds a clock without them,
  // they belong to some other plan we know nothing about.
  if (clock && clock.hypothesis === 'independent' && clock.days >= MIN_DAYS && used.some((c) => c.part.far)) {
    const core = used.filter((c) => !c.part.far);
    const c2 = core.length ? fitClock(core, C0, plan.sigC0, lag) : null;
    if (c2 && c2.hypothesis !== 'independent') { clock = c2; used = core; for (const c of cells) if (c.part.far) farIn.add(c); }
  }
  if (clock && clock.hypothesis !== 'independent') {
    const off = clock.resid.filter((r) => r.cell.part.far && Math.abs(r.v) > 3).map((r) => r.cell);
    if (off.length) { for (const c of off) farIn.add(c); used = fitCells(); clock = fitClock(used, C0, plan.sigC0, lag); }
  }
  // cross-mark slips: a single tap that disagrees with its own sitting
  const slipCells = new Set();
  if (clock && used.length >= 4) {
    const byPart = groupBy(used, (c) => c.part.id);
    for (const list of byPart.values()) {
      if (list.length < 4) continue;
      const rho0 = list.map((c) => sdiff(mod(c.u, clock.C), clock.pos[c.mark] ?? 0, clock.C));
      const m0 = circMean(rho0.map((x) => mod(x, clock.C)), clock.C);
      const rho = rho0.map((x) => sdiff(x, m0, clock.C));
      let worst = null;
      for (let i = 0; i < list.length; i++) {
        if (list[i].k !== 1) continue;
        const others = rho.filter((_, j) => j !== i), mo = median(others);
        const dev = Math.abs(rho[i] - mo), osp = Math.max(...others.map((x) => Math.abs(x - mo)));
        if (dev > 3.5 && osp <= 1.5 && (!worst || dev > worst.dev)) worst = { c: list[i], dev };
      }
      if (worst) {
        slipCells.add(worst.c);
        outliers.push({ tapId: worst.c.ids[0], sittingId: worst.c.part.sitting.id, kind: 'slip', gainSec: round(worst.dev, 1) });
      }
    }
    if (slipCells.size) { used = fitCells(slipCells); clock = fitClock(used, C0, plan.sigC0, lag); }
  }
  // marks
  const C = clock ? clock.C : C0;
  const marks = {};
  const allMarks = [...tapsOf.keys()].sort();
  for (const m of allMarks) {
    const mc = cells.filter((c) => c.mark === m && !slipCells.has(c) && !farIn.has(c));
    if (!mc.length) continue; // only seen at a time of day that is some other plan
    const fitted = clock && clock.pos[m] !== undefined && !actuated.has(m);
    let posSec, spreadSec, comp = 0;
    if (fitted) {
      posSec = clock.pos[m]; comp = clock.comp[m] ?? 0;
      const res = clock.resid.filter((r) => r.mark === m).map((r) => r.v);
      spreadSec = res.length >= 2 ? Math.sqrt(mean(res.map((v) => v * v))) : mu;
    } else {
      // actuated (or unfittable): informative position only
      const ph = mc.map((c) => mod(c.u, C));
      posSec = ph.length ? circMean(ph, C) : 0;
      const dev = ph.map((x) => Math.abs(sdiff(x, posSec, C)));
      spreadSec = Math.max(ACTUATED_SPREAD, dev.length ? Math.sqrt(mean(dev.map((v) => v * v))) : 0);
      if (clock && clock.comp[m] === undefined) comp = 0;
    }
    marks[m] = { posSec: round(mod(posSec, C), 3), spreadSec: round(Math.max(spreadSec, 0.05), 2), n: mc.reduce((a, c) => a + c.k, 0), actuated: actuated.has(m), comp };
  }
  const rcells = used;
  const rel = rcells.length ? independentSolve(rcells, C) : null;
  const usedParts = new Set(used.map((c) => c.part));
  const keptParts = plan.parts.filter((p) => !p.far || usedParts.has(p));
  return { cells, used, rcells, outliers, marks, actuated, clock, rel, C, T0, keptParts };
}

function fitClock(cells, C0, sigC0, lag) {
  if (!cells.length) return null;
  const days = [...new Set(cells.map((c) => c.day))].sort();
  const w = clamp(4 * sigC0, 0.05, 0.4);
  // Same-hour taps on several days leave aliases of C spaced C^2/day apart; the
  // within-sitting estimate (good to ~sigC0) arbitrates.
  const prior = Math.max(0.02, 1.5 * sigC0);
  const base = { days: days.length };
  let scores = null;
  const indep = () => {
    // Several sittings on one day (hours apart) pin C far better than one sitting can.
    let C = C0, sigC = sigC0;
    let spanDay = 0;
    for (const list of groupBy(cells, (c) => c.day).values()) { const us = list.map((c) => c.u); spanDay = Math.max(spanDay, (Math.max(...us) - Math.min(...us)) / C0); }
    if (spanDay > 20) {
      const step = Math.min(0.02, 1.5 / spanDay), n1 = Math.ceil(w / step);
      let best = null;
      const tryC = (c) => { const k = independentDayCost(cells, c) + ((c - C0) / prior) ** 2; if (!best || k < best.k - 1e-9) best = { c, k }; };
      for (let i = -n1; i <= n1; i++) tryC(C0 + i * step);
      const c0 = best.c;
      for (let i = -8; i <= 8; i++) tryC(c0 + (i * step) / 8);
      C = best.c;
    }
    const sol = independentSolve(cells, C);
    const resid = cells.map((c) => ({ mark: c.mark, v: sdiff(sdiff(mod(c.u, C), sol.pos[c.mark], C), sol.offSit.get(`${c.sit}#${sol.comp[c.mark]}`) ?? 0, C), cell: c }));
    if (C !== C0) sigC = Math.max(1e-3, (Math.max(0.3, Math.sqrt(mean(resid.map((r) => r.v * r.v)))) * Math.sqrt(12)) / (spanDay * Math.sqrt(Math.max(1, cells.length))));
    // day offsets: from that day's latest sitting, per component
    const dayOff = {};
    const lastSit = new Map();
    for (const c of cells) { const key = `${c.day}#${sol.comp[c.mark]}`; if (!lastSit.has(key) || c.sit > lastSit.get(key)) lastSit.set(key, c.sit); }
    for (const [key, sit] of lastSit) {
      const [d, k] = key.split('#');
      dayOff[Number(k) === 0 ? d : key] = sol.offSit.get(`${sit}#${k}`) ?? 0;
    }
    return { hypothesis: 'independent', C, sigC, pos: sol.pos, comp: sol.comp, dayOff, nudgeSigma: null, heldOutErr: null, scores, resid, ...base };
  };
  if (days.length < MIN_DAYS) return indep();

  const out = {};
  for (const [mode, sg] of [['steady', 0], ['nudged', DEFAULT_SIGMA_N]]) out[mode] = scoreDays(heldOut(cells, C0, w, mode, sg, prior));
  scores = { steady: out.steady, nudged: out.nudged };
  const thr = C0 / 12;
  let pick = null;
  const sc = out.steady, nu = out.nudged;
  if (sc != null || nu != null) {
    const bestMode = nu != null && (sc == null || nu + 0.5 < sc) ? 'nudged' : 'steady';
    if (out[bestMode] <= thr) pick = bestMode;
  }
  if (!pick) return indep();
  let sigma = DEFAULT_SIGMA_N;
  let fit = fitSearch(cells, C0, w, pick, sigma, true, prior);
  const F = fit.F;
  if (pick === 'nudged') {
    // learn sigma from the unshrunk offsets, then refit once
    const raw = F.days.map((_, d) => mean(F.byDay[d].map((i) => sdiff(fit.p[i], fit.pos[F.mk[i]], fit.C))));
    sigma = Math.max(1, Math.sqrt(mean(raw.map((x) => x * x))));
    fit = fitSearch(cells, fit.C, Math.max(0.02, w / 4), 'nudged', sigma, true, prior);
  }
  const resid = cells.map((c, i) => ({ mark: c.mark, v: sdiff(fit.p[i] - fit.off[F.dy[i]], fit.pos[F.mk[i]], fit.C), cell: c }));
  const pos = {}, comp = {};
  F.marks.forEach((m, i) => { pos[m] = fit.pos[i]; comp[m] = 0; });
  const dayOff = {};
  F.days.forEach((d, i) => { dayOff[d] = pick === 'steady' ? 0 : fit.off[i]; });
  const rms = Math.sqrt(mean(resid.map((r) => r.v * r.v)));
  let rawOff = null;
  if (pick === 'nudged') {
    const raws = F.days.map((_, d) => mean(F.byDay[d].map((i) => sdiff(fit.p[i], fit.pos[F.mk[i]], fit.C))));
    rawOff = Math.sqrt(mean(raws.map((x) => x * x)));
  }
  const errs = heldOut(cells, C0, w, pick, pick === 'nudged' ? DEFAULT_SIGMA_N : 0, prior);
  const sigC = Math.max(1e-4, (Math.max(0.3, rms) * Math.sqrt(12)) / (fit.N * Math.sqrt(Math.max(1, cells.length))));
  return { hypothesis: pick, C: fit.C, sigC, pos, comp, dayOff, nudgeSigma: pick === 'nudged' ? round(Math.max(0.5, rawOff), 2) : null, heldOutErr: median(errs), scores, resid, rms, ...base };
}

// drift within a day: only if some day has cells >= 2 h apart
function fitDrift(cells, clock) {
  if (!clock) return null;
  const C = clock.C;
  let num = 0, den = 0, any = false;
  for (const list of groupBy(cells, (c) => c.day).values()) {
    const ts = list.map((c) => c.tau);
    if (Math.max(...ts) - Math.min(...ts) < 2 * 3600) continue;
    const rho0 = list.map((c) => sdiff(mod(c.u, C), clock.pos[c.mark] ?? 0, C));
    const m = circMean(rho0.map((x) => mod(x, C)), C);
    const r = rho0.map((x) => sdiff(x, m, C));
    const hrs = list.map((c) => c.tau / 3600), hm = mean(hrs), rm = mean(r);
    hrs.forEach((h, i) => { num += (h - hm) * (r[i] - rm); den += (h - hm) ** 2; });
    any = true;
  }
  return any && den > 0 ? round(num / den, 3) : null;
}

// ---------- 6. windows ----------

function windowsFor(planOwners) {
  // planOwners: [{ plan, minutes, ixId }] where ixId is the GROUP key. One plan owns each
  // time of day: the span of a plan's own sittings, a margin either side (or up to
  // the midpoint with a neighbouring plan), and the stretch between two consecutive
  // sittings of the same plan. Hours nobody tapped at belong to no plan.
  const masks = new Map();
  const byGroup = groupBy(planOwners, (o) => o.ixId);
  const slots = 1440 / GRID_MIN;
  for (const owners of byGroup.values()) {
    const pts = owners.flatMap((o) => o.minutes.map((m) => ({ o, m }))).sort((a, b) => a.m - b.m);
    if (!pts.length) continue;
    for (let s = 0; s < slots; s++) {
      const m = s * GRID_MIN + GRID_MIN / 2;
      let prev = null, next = null;
      for (const q of pts) if (q.m <= m) prev = q;
      for (const q of pts) if (q.m > m) { next = q; break; }
      prev ??= pts[pts.length - 1]; next ??= pts[0];
      const dp = mod(m - prev.m, 1440), dn = mod(next.m - m, 1440);
      let owner = null;
      if (prev.o === next.o && dp + dn <= FILL_MIN) owner = prev.o;
      else if (Math.min(dp, dn) <= MARGIN_MIN) owner = dp <= dn ? prev.o : next.o;
      if (!owner) continue;
      if (!masks.has(owner.plan)) masks.set(owner.plan, new Array(slots).fill(false));
      masks.get(owner.plan)[s] = true;
    }
  }
  const out = new Map();
  for (const [plan, mask] of masks) {
    const slots2 = mask.length;
    if (mask.every(Boolean)) { out.set(plan, [{ fromMin: 0, toMin: 1440 }]); continue; }
    const start = mask.findIndex((v, i) => v && !mask[(i - 1 + slots2) % slots2]);
    const spans = [];
    for (let n = 0, i = start; start >= 0 && n < slots2; n++, i = (i + 1) % slots2) {
      if (mask[i]) {
        if (n && mask[(i - 1 + slots2) % slots2] && spans.length) spans[spans.length - 1].toMin = ((i + 1) % slots2) * GRID_MIN || 1440;
        else spans.push({ fromMin: i * GRID_MIN, toMin: ((i + 1) % slots2) * GRID_MIN || 1440 });
      }
    }
    out.set(plan, spans);
  }
  return out;
}

// ---------- 7. corridors ----------

function corridorMatch(A, B) {
  if (!A.rel || !B.rel || Math.abs(A.C - B.C) > CORRIDOR_C_TOL) return false;
  const Cs = (A.C + B.C) / 2;
  const byKey = new Map();
  for (const a of A.rcells) for (const b of B.rcells) {
    if (a.day !== b.day || Math.abs(a.tau - b.tau) > CORRIDOR_PAIR_SEC) continue;
    const d = mod((a.tau - A.rel.posRaw[a.mark]) - (b.tau - B.rel.posRaw[b.mark]), Cs);
    const key = `${A.rel.comp[a.mark]}|${B.rel.comp[b.mark]}`;
    if (!byKey.has(key)) byKey.set(key, new Map());
    const dm = byKey.get(key);
    if (!dm.has(a.day)) dm.set(a.day, []);
    dm.get(a.day).push(d);
  }
  for (const dm of byKey.values()) {
    const vals = [...dm.values()].map((ds) => circMedian(ds, Cs));
    if (vals.length < 2) continue;
    let ok = true;
    for (let i = 0; i < vals.length && ok; i++) for (let j = i + 1; j < vals.length; j++) if (Math.abs(sdiff(vals[i], vals[j], Cs)) > CORRIDOR_PHASE_TOL) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

// ---------- computeModel ----------

/**
 * @param {{ observations: object[], intersections: object[] }} input
 * @param {{ now?: number }} [opts]
 */
export function computeModel({ observations, intersections }, opts = {}) {
  const ixs = [...(intersections ?? [])];
  const headToIx = new Map();
  const names = {};
  for (const ix of ixs) { names[ix.id] = ix.name; for (const h of ix.heads ?? []) headToIx.set(h.id, ix.id); }
  const { taps, dropped } = cleanTaps(observations, headToIx);
  const sittings = sittingsOf(taps);

  // parts: one sitting at one intersection
  const parts = [];
  for (const s of sittings) {
    for (const [ixId, list] of groupBy(s.taps, (x) => x.ixId)) {
      const mid = (list[0].t + list[list.length - 1].t) / 2;
      parts.push({ id: `${s.id}:${ixId}`, sitting: s, ixId, taps: list, t0: list[0].t, t1: list[list.length - 1].t, minute: localMinute(mid), cyc: partCycle(list) });
      const p = parts[parts.length - 1];
      p.strong = !!p.cyc?.strong; p.C = p.cyc?.C;
    }
  }
  const lag = learnLag(parts);

  // plans per intersection (only intersections with taps)
  const ixOrder = ixs.map((i) => i.id).filter((id) => parts.some((p) => p.ixId === id));
  let plans = [];
  for (const id of ixOrder) plans.push(...buildPlansFor(id, parts).map((p) => ({ ...p, ixId: id })));
  for (const p of plans) p.an = analyzePlan(p, lag);

  // corridors: merge plans of different intersections that share a clock
  const uf = plans.map((_, i) => i);
  const find = (i) => (uf[i] === i ? i : (uf[i] = find(uf[i])));
  for (let i = 0; i < plans.length; i++) for (let j = i + 1; j < plans.length; j++) {
    if (plans[i].ixId !== plans[j].ixId && find(i) !== find(j) && corridorMatch(plans[i].an, plans[j].an)) uf[find(j)] = find(i);
  }
  const merged = [];
  for (const [, idxs] of groupBy(plans.map((p, i) => i), (i) => find(i))) {
    if (idxs.length === 1) { merged.push({ ...plans[idxs[0]], members: [plans[idxs[0]]], corridor: false }); continue; }
    const members = idxs.map((i) => plans[i]);
    const ps = members.flatMap((m) => m.parts);
    const wc = weightedC(members.map((m) => ({ C: m.C0, sigma: m.sigC0 })));
    const mp = { ixIds: [...new Set(members.map((m) => m.ixId))], ixId: members[0].ixId, parts: ps, C0: wc.C, sigC0: wc.sigma };
    mp.an = analyzePlan(mp, lag);
    merged.push({ ...mp, members, corridor: true });
  }

  // groups: intersections connected by merged plans
  const gu = new Map(ixOrder.map((id) => [id, id]));
  const gfind = (id) => (gu.get(id) === id ? id : (gu.set(id, gfind(gu.get(id))), gu.get(id)));
  for (const mp of merged) if (mp.corridor) for (const id of mp.ixIds.slice(1)) gu.set(gfind(id), gfind(mp.ixIds[0]));
  const groupIxs = [];
  for (const id of ixOrder) { const g = gfind(id); let e = groupIxs.find((x) => x.root === g); if (!e) groupIxs.push(e = { root: g, ids: [] }); e.ids.push(id); }

  // windows
  const owners = [];
  for (const mp of merged) {
    const minutes = [...new Set(mp.an.keptParts.map((p) => p.minute))];
    if (minutes.length) owners.push({ plan: mp, ixId: gfind(mp.ixIds?.[0] ?? mp.ixId), minutes });
  }
  const windows = windowsFor(owners);

  const groups = [];
  const lights = {};
  const outliers = [];
  groupIxs.forEach((gx, gi) => {
    const gid = `g${gi + 1}`;
    const mps = merged.filter((mp) => (mp.ixIds ?? [mp.ixId]).every((i) => gx.ids.includes(i))).filter((mp) => gx.ids.includes(mp.ixIds?.[0] ?? mp.ixId));
    mps.sort((a, b) => Math.min(...a.parts.map((p) => p.minute)) - Math.min(...b.parts.map((p) => p.minute)) || a.C0 - b.C0);
    const gPlans = mps.map((mp, pi) => {
      const an = mp.an, ck = an.clock;
      const C = ck ? ck.C : mp.C0;
      const cells = an.used;
      const epochMs = an.T0 * 1000;
      const dayOffsets = {};
      if (ck) for (const [d, v] of Object.entries(ck.dayOff)) dayOffsets[d] = round(v, 3);
      const lastTaps = {};
      for (const p of mp.parts) for (const tp of p.taps) {
        const m = an.marks[tp.mark];
        if (!m || m.actuated) continue;
        const key = ck && ck.hypothesis === 'independent' && (m.comp ?? 0) !== 0 ? `${dayKeyOf(tp.t)}#${m.comp}` : dayKeyOf(tp.t);
        if (!lastTaps[key] || tp.t > lastTaps[key].t) lastTaps[key] = { t: tp.t, ixId: tp.ixId, headId: tp.headId, aspect: tp.aspect };
      }
      for (const o of an.outliers) outliers.push(o);
      const sigmaC = ck ? ck.sigC : mp.sigC0;
      return {
        id: `${gid}-p${pi + 1}`,
        windows: windows.get(mp) ?? [],
        dayClass: 'all',
        cycleSec: C, cycleSigmaSec: Number(sigmaC.toPrecision(2)),
        marks: an.marks,
        clock: {
          hypothesis: ck ? ck.hypothesis : 'independent',
          epochMs,
          nudgeSigmaSec: ck ? ck.nudgeSigma : null,
          driftSecPerHour: fitDrift(cells, ck),
          dayOffsets,
          heldOutErrSec: ck && ck.heldOutErr != null ? round(ck.heldOutErr, 2) : null,
          days: ck ? ck.days : 0,
          residRmsSec: ck && ck.resid.length ? round(Math.sqrt(mean(ck.resid.map((r) => r.v * r.v))), 2) : null,
          lastTaps,
          candidates: ck?.scores ? { steady: ck.scores.steady != null ? round(ck.scores.steady, 2) : null, nudged: ck.scores.nudged != null ? round(ck.scores.nudged, 2) : null } : null,
        },
        sittingIds: [...new Set(mp.parts.map((p) => p.sitting.id))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
        _headIds: [...new Set(Object.keys(an.marks).map((m) => m.split('|')[0]))],
      };
    });
    const headIds = [...new Set(taps.filter((t) => gx.ids.includes(t.ixId)).map((t) => t.headId))].sort();
    for (const h of headIds) {
      const aspects = [...new Set(taps.filter((t) => t.headId === h).map((t) => t.aspect))].sort((a, b) => ASPECT_ORDER.indexOf(a) - ASPECT_ORDER.indexOf(b));
      const act = new Set();
      for (const p of gPlans) for (const [m, v] of Object.entries(p.marks)) if (v.actuated && m.startsWith(`${h}|`)) act.add(m.split('|')[1]);
      lights[h] = { intersectionId: headToIx.get(h), groupId: gid, aspects, actuated: aspects.filter((a) => act.has(a)) };
    }
    for (const p of gPlans) delete p._headIds;
    groups.push({
      id: gid, intersectionIds: gx.ids, headIds,
      corridor: mps.some((mp) => mp.corridor),
      plans: gPlans,
    });
  });

  const model = {
    algoVersion: ALGO_VERSION,
    computedAt: opts.now ?? Date.now(),
    lag: { minSec: lag.minSec, medianSec: lag.medianSec, p90Sec: lag.p90Sec, meanSec: round(lag.muSec + MIN_LAG, 2) },
    sittings: sittings.map((s) => ({ id: s.id, t0: s.t0, t1: s.t1, intersectionIds: [...new Set(s.taps.map((x) => x.ixId))], tapIds: s.taps.map((x) => x.id) })),
    dropped,
    outliers: outliers.sort((a, b) => cmp(a.tapId, b.tapId)),
    groups,
    lights,
    names,
    usefulTaps: [],
  };
  model.usefulTaps = usefulTaps(model);
  // hours the driver passes but no plan covers (taps there could not be placed in a plan)
  const inWin = (plan, min) => plan.windows.some((w) => (w.fromMin <= w.toMin ? min >= w.fromMin && min < w.toMin : min >= w.fromMin || min < w.toMin));
  for (const g of groups) {
    const seen = new Set();
    for (const pt of parts.filter((q) => g.intersectionIds.includes(q.ixId)).sort((a, b) => a.t0 - b.t0)) {
      if (g.plans.some((pl) => inWin(pl, pt.minute))) continue;
      const hour = Math.floor(pt.minute / 60);
      if (seen.has(hour)) continue;
      seen.add(hour);
      const heads = groupBy(pt.taps, (x) => x.headId);
      const [headId] = [...heads].sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0]))[0];
      const near = g.plans.length ? g.plans.reduce((a, b) => (a.cycleSec > b.cycleSec ? a : b)).cycleSec : 60;
      model.usefulTaps.push({ headId, aspect: 'green', why: `tap any light here around ${String(hour).padStart(2, '0')}:00; nothing known about that time of day yet`, gainSec: round(near / 4, 1) });
    }
  }
  if (opts.debug) model.debug = { merged, parts };
  return model;
}

// ---------- 8. useful taps ----------

function usefulTaps(model) {
  const out = [];
  for (const g of model.groups) {
    const cand = [];
    for (const p of g.plans) {
      const ck = p.clock, C = p.cycleSec;
      const marks = Object.entries(p.marks).filter(([, m]) => !m.actuated);
      if (ck.hypothesis === 'independent' && ck.days < MIN_DAYS && marks.length) {
        const [mk] = [...marks].sort((a, b) => b[1].n - a[1].n || cmp(a[0], b[0]))[0];
        const [headId, aspect] = mk.split('|');
        cand.push({ headId, aspect, why: `a tap on another day shows whether this plan keeps one clock (${ck.days} of ${MIN_DAYS} days so far)`, gainSec: round(C / 4, 1) });
      }
      for (const [mk, m] of marks) {
        const [headId, aspect] = mk.split('|');
        if (m.n === 1) cand.push({ headId, aspect, why: `only one ${aspect} tap here; a second confirms it`, gainSec: round(Math.max(m.spreadSec, 1), 1) });
      }
    }
    for (const h of g.headIds) {
      const l = model.lights[h];
      if (l && l.aspects.length === 1) cand.push({ headId: h, aspect: l.aspects[0] === 'green' ? 'red' : 'green', why: `only ${l.aspects[0]} tapped; the other colour tells what it shows right now`, gainSec: 0.5 });
    }
    cand.sort((a, b) => b.gainSec - a.gainSec || cmp(a.headId, b.headId) || cmp(a.aspect, b.aspect));
    out.push(...cand.slice(0, 3));
  }
  return out;
}

// exported for tests / debugging
export const _internal = { heldOut, searchC, makeFit, solveAt, independentSolve, analyzePlan, fitClock, corridorMatch };
