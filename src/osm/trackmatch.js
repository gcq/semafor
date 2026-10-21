// Which light was a tap for, judging by the GPS track around it? Pure + DOM-free.
//
// One fix + heading cannot tell neighbouring junctions or parallel roads apart, but the whole
// track can: the approach whose lanes the track follows over the last ~150 m before its stop line
// is the one you came in on, and the direction you left in (20-80 m past the junction centre)
// says which movement, hence which head, you made. Everything is metres east/north of the street
// entry's centre (src/osm/approaches.js), the same frame as the lane polygons.
//
// Deliberately conservative: anything not clearly decided comes back 'low' / 'none', and the
// suggestion rule (src/osm/suggest.js) only ever acts on 'high'.

import { angularDiff } from '../nav/proximity.js';
import { toLocal } from './approaches.js';

const RAD = Math.PI / 180;
export const MATCH = {
  tapWinMs: 4000,    // the position "at the tap" = mean of fixes this close in time (stillWinMs when standing: speed < stillSpeed m/s)
  stillWinMs: 10000, stillSpeed: 1.5,
  histM: 150,        // inbound history: this far before the stop line
  binM: 10,          // ... resampled to one sample per bin of this length (a long red is ONE sample, not 60)
  minBins: 5, minSpanM: 60, // evidence needed: bins, and the metres of road they cover
  lateralM: 30,      // an approach whose corridor is further than this from the tap position is not a candidate
  aheadM: 130,       // ... nor one whose stop line is further ahead than this,
  behindM: 40,       // or that you are further past than this
  crossM: 12,        // past the stop line by this much (3-fix mean) = crossed, the history ends
  aheadBuf: 6,       // a stop line you are at most this far past still counts as "ahead" (ambers tapped while passing)
  ambigNear: 25,     // a line you passed by less than this, or are at (within 1 m before it) with another light just ahead = can't tell which
  tierM: 25,         // approaches whose stop lines are this close together compete (parallel roads); further apart = successive lights
  capM: 25, sigmaM: 10, sigmaMin: 6, sigmaInflate: 1.3, // per-bin misfit cap; GPS noise assumed when the track has no standstill to show it (and its ceiling); floor and inflation of the estimate
  rhoDefault: 0.5,   // fix-to-fix error correlation assumed when the track has no standstill to show it
  minLogOdds: 6,     // best approach must beat the runner-up by this (nats, with correlated fixes counted as fewer samples)
  progressM: 30, dirTol: 45, // the run-in must advance this far along the approach, within this of its bearing (kills the opposite carriageway and crossing roads)
  hdgMinSpeed: 3, hdgVeto: 75, // heading counts only while moving; a median this far off vetoes an approach
  depM: 25,          // "still at the stop point" radius: the exit is read from fixes after the last one
  exitMin: 28, exitMax: 85, exitMinPts: 3, exitR: 0.85, // exit ring around the centre, fixes needed, direction concentration
  exitTol: 35, exitMargin: 25, // exit arm must be within this of the exit bearing and this much better than the next arm
  turnStraight: 30, turnU: 150,
};

const bearing = (e, n) => ((Math.atan2(e, n) / RAD) + 360) % 360;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ---------- arms: no positions in the data, so derive them from the heads ----------

/**
 * Per approach (cand): the arm it starts at, from the movements of the heads on its mast (the arm
 * most of them start at; a tie = unknown). Per arm: its bearing from the junction centre = where its
 * approaches come FROM (their travel bearing reversed; a stop point inside the junction box is too close
 * to the centre to give a direction).
 * @returns {{fromArm:Map<string,string|null>, bearing:Map<string,Map<string,number>>}}
 */
export function armBearings(set, ixs) {
  const byId = new Map(ixs.map((i) => [i.id, i]));
  const fromArm = new Map(), acc = new Map();
  for (const c of set.cands) {
    const ix = byId.get(c.ixId), centre = set.centres.get(c.ixId);
    if (!ix || !centre) continue;
    const heads = new Set(ix.masts?.find((m) => m.id === c.mastId)?.headIds ?? [c.headId]);
    const n = new Map();
    for (const mv of ix.movements ?? []) if (!mv.unsignalized && mv.from !== mv.to && heads.has(mv.headId)) n.set(mv.from, (n.get(mv.from) ?? 0) + 1);
    const top = [...n].sort((a, b) => b[1] - a[1]);
    const arm = top.length && (top.length === 1 || top[0][1] > top[1][1]) ? top[0][0] : null;
    fromArm.set(c.key, arm);
    if (!arm) continue;
    const b = ((c.bearing + 180) % 360) * RAD, per = acc.get(c.ixId) ?? new Map(), v = per.get(arm) ?? [0, 0];
    per.set(arm, [v[0] + Math.sin(b), v[1] + Math.cos(b)]); acc.set(c.ixId, per);
  }
  const brg = new Map();
  for (const [id, per] of acc) brg.set(id, new Map([...per].map(([arm, v]) => [arm, bearing(v[0], v[1])])));
  return { fromArm, bearing: brg };
}

/** The head of the movement from -> to (null if none, or if several heads claim it). */
export function headOfMovement(ix, from, to) {
  const hs = new Set((ix.movements ?? []).filter((m) => !m.unsignalized && m.from === from && m.to === to).map((m) => m.headId));
  return hs.size === 1 ? [...hs][0] : null;
}
/** The one head every movement from `from` shares (null if several, or none). U-turn movements are left out: they are often hung on a neighbouring head. */
export function soleHeadFrom(ix, from) {
  const hs = new Set((ix.movements ?? []).filter((m) => !m.unsignalized && m.from === from && m.to !== from).map((m) => m.headId));
  return hs.size === 1 ? [...hs][0] : null;
}

// ---------- corridor geometry ----------

// An approach's lane polygons cover only the last ~40-55 m of its road, and GPS noise says nothing
// about where inside a lane you are, so the road is modelled by its AXIS: stop point -> the middle
// of the polygon ends furthest back, then carried on as a ray in that direction.
function axisOf(c) {
  if (c.axis) return c.axis;
  let fd = 0;
  for (const r of c.rings) for (let i = 0; i < r.length; i += 2) fd = Math.max(fd, Math.hypot(r[i] - c.x, r[i + 1] - c.y));
  let fx = 0, fy = 0, k = 0;
  for (const r of c.rings) for (let i = 0; i < r.length; i += 2) if (Math.hypot(r[i] - c.x, r[i + 1] - c.y) >= fd - 3) { fx += r[i]; fy += r[i + 1]; k++; }
  if (!k || fd < 5) return (c.axis = { sx: c.x, sy: c.y, fx: c.x - c.dx * 5, fy: c.y - c.dy * 5, ux: -c.dx, uy: -c.dy });
  fx /= k; fy /= k;
  const l = Math.hypot(fx - c.x, fy - c.y);
  return (c.axis = { sx: c.x, sy: c.y, fx, fy, ux: (fx - c.x) / l, uy: (fy - c.y) / l });
}
const segD = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2)) : 0;
  return Math.hypot(px - ax - t * vx, py - ay - t * vy);
};
/** Distance from a point to the road an approach group (all stop points of one mast) runs on. */
function corridor(group, p) {
  let d = Infinity;
  for (const c of group) {
    const x = axisOf(c), t = Math.max(0, (p.e - x.fx) * x.ux + (p.n - x.fy) * x.uy);
    d = Math.min(d, segD(p.e, p.n, x.sx, x.sy, x.fx, x.fy), Math.hypot(p.e - x.fx - t * x.ux, p.n - x.fy - t * x.uy));
  }
  return d;
}
const along = (c, p) => (p.e - c.x) * c.dx + (p.n - c.y) * c.dy;

// ---------- entry: how well does the track follow an approach? ----------

/**
 * Fit of the inbound history to one approach (its stop point c, road = `group`). Binned by metres of
 * approach, one sample per bin, so parallel roads are told apart by the whole run-in rather than
 * by the (many, correlated) fixes of a wait at the line.
 * @returns {{ok:boolean, why?:string, ll:number, rms:number, bins:number}}
 */
function fit(c, group, P, sigma, neff) {
  const a = P.map((p) => along(c, p));
  let end = P.length;
  for (let i = 0; i + 2 < P.length; i++) if (mean(a.slice(i, i + 3)) >= MATCH.crossM) { end = i; break; }
  const bins = new Map();
  for (let i = 0; i < end; i++) {
    if (a[i] < -MATCH.histM || a[i] > MATCH.aheadBuf) continue;
    const k = Math.floor((a[i] + MATCH.histM) / MATCH.binM), b = bins.get(k) ?? { e: 0, n: 0, a: 0, k: 0, t0: P[i].t };
    b.e += P[i].e; b.n += P[i].n; b.a += a[i]; b.k++; bins.set(k, b);
  }
  const bs = [...bins.values()].map((b) => ({ e: b.e / b.k, n: b.n / b.k, a: b.a / b.k, t0: b.t0 })).sort((x, y) => x.t0 - y.t0); // in the order you drove through them
  const fail = (why) => ({ ok: false, why, ll: -Infinity, rms: Infinity, bins: bs.length });
  if (bs.length < MATCH.minBins) return fail('too little track before the stop line');
  if (Math.max(...bs.map((b) => b.a)) - Math.min(...bs.map((b) => b.a)) < MATCH.minSpanM) return fail('track covers too little of the approach');
  // direction of travel from the run-in itself (first third -> last third of the bins, so a long red is one sample), never from heading
  const third = Math.max(1, Math.floor(bs.length / 3));
  const g = (xs) => ({ e: mean(xs.map((b) => b.e)), n: mean(xs.map((b) => b.n)) });
  const g0 = g(bs.slice(0, third)), g1 = g(bs.slice(-third));
  const dx = g1.e - g0.e, dy = g1.n - g0.n;
  if (dx * c.dx + dy * c.dy < MATCH.progressM || angularDiff(bearing(dx, dy), c.bearing) > MATCH.dirTol) return fail('not travelling towards this stop line');
  const hist = []; for (let i = 0; i < end; i++) if (a[i] >= -MATCH.histM && a[i] <= MATCH.aheadBuf) hist.push(i);
  const hd = hist.map((i) => P[i]).filter((p) => p.heading != null && p.speed != null && p.speed >= MATCH.hdgMinSpeed).map((p) => angularDiff(p.heading, c.bearing));
  if (hd.length >= 3 && median(hd) > MATCH.hdgVeto) return fail('heading against this approach');
  let cost = 0;
  for (const b of bs) cost += Math.min(corridor(group, b), MATCH.capM) ** 2;
  return { ok: true, ll: -neff * cost / (2 * sigma ** 2), rms: Math.sqrt(cost / bs.length), bins: bs.length };
}

// GPS noise from the standstills of the track itself: std per axis of the fixes at rest, and how correlated
// consecutive ones are (real GPS error drifts: fixes 1 s apart are NOT independent samples). No standstill =
// the worst we plan for.
function noiseOf(P) {
  const worst = { sigma: MATCH.sigmaM, rho: MATCH.rhoDefault };
  const rest = P.filter((p) => p.speed != null && p.speed < 1);
  if (rest.length < 8) return worst;
  const me = median(rest.map((p) => p.e)), mn = median(rest.map((p) => p.n));
  const cl = rest.filter((p) => Math.hypot(p.e - me, p.n - mn) < 40);
  if (cl.length < 8) return worst;
  const ce = mean(cl.map((p) => p.e)), cn = mean(cl.map((p) => p.n));
  let num = 0, den = 0;
  cl.forEach((p, i) => {
    den += (p.e - ce) ** 2 + (p.n - cn) ** 2;
    const q = cl[i + 1];
    if (q && q.t - p.t <= 2500) num += (p.e - ce) * (q.e - ce) + (p.n - cn) * (q.n - cn);
  });
  return { sigma: Math.min(MATCH.sigmaM, Math.max(3, Math.sqrt(den / cl.length / 2))), rho: Math.max(0, Math.min(0.95, num / den)) };
}

// ---------- the matcher ----------

/**
 * @param {Object} o
 * @param {Array<{t:number,lat:number,lon:number,heading?:number|null,speed?:number|null}>} o.track  decoded fixes (src/nav/trackrec.js)
 * @param {number} o.t  when the tap was made (ms): which stop line you were at is judged there
 * @param {ReturnType<import('./approaches.js').approachCandidates>} o.set
 * @param {{lat:number,lon:number}} o.center  the street entry's centre (cm/m positions are relative to it)
 * @param {Array<Object>} o.intersections  Onda junctions of the cluster (arms, movements, masts, heads)
 * @param {string} [o.only]  consider this junction's approaches only
 * @returns {{ixId:string|null, approachKey:string|null, fromArmId:string|null, toArmId:string|null, headId:string|null,
 *   confidence:'high'|'low'|'none', reason:string, margin?:number, turn?:string|null, entryBearing?:number, exitBearing?:number|null}}
 */
export function matchTrack({ track, t, set, center, intersections, only = null }) {
  const out = (confidence, reason, extra = {}) => ({ ixId: null, approachKey: null, fromArmId: null, toArmId: null, headId: null, confidence, reason, ...extra });
  const cands = (set?.cands ?? []).filter((c) => !only || c.ixId === only);
  if (!cands.length) return out('none', 'no mapped approaches here');
  const P = [];
  for (const f of track ?? []) {
    if (!Number.isFinite(f?.lat) || !Number.isFinite(f.lon) || !Number.isFinite(f.t)) continue;
    P.push({ t: f.t, ...toLocal(f, center), speed: Number.isFinite(f.speed) ? f.speed : null, heading: Number.isFinite(f.heading) ? f.heading : null });
  }
  P.sort((x, y) => x.t - y.t);
  let near = P.filter((p) => Math.abs(p.t - t) <= MATCH.tapWinMs);
  if (near.length < 2) return out('none', 'no GPS fixes around the tap');
  // standing still: average a longer stretch (the position is the same, the noise averages out)
  const sp = near.map((p) => p.speed).filter((v) => v != null);
  if (sp.length >= 2 && median(sp) < MATCH.stillSpeed) near = P.filter((p) => Math.abs(p.t - t) <= MATCH.stillWinMs);
  const p0 = { e: mean(near.map((p) => p.e)), n: mean(near.map((p) => p.n)) };

  const noise = noiseOf(P), sigmaHat = noise.sigma;
  // the likelihood's noise: what the track shows at rest, plus an allowance for drift while moving; correlated fixes count as fewer samples
  const sigmaEff = Math.min(MATCH.sigmaM, Math.max(MATCH.sigmaMin, MATCH.sigmaInflate * sigmaHat)), neff = (1 - noise.rho) / (1 + noise.rho);
  // candidates: stop line ahead (or just behind) the tap position, corridor close to it, history that fits
  const groups = new Map();
  for (const c of cands) { const k = `${c.ixId}|${c.mastId ?? c.headId}`; groups.set(k, [...(groups.get(k) ?? []), c]); }
  const ok = [];
  for (const [gk, gcs] of groups) for (const c of gcs) {
    const a0 = along(c, p0);
    if (a0 < -MATCH.aheadM || a0 > MATCH.behindM || corridor(gcs, p0) > MATCH.lateralM) continue;
    const f = fit(c, gcs, P, sigmaEff, neff);
    if (f.ok) ok.push({ c, gk, a0, f });
  }
  if (!ok.length) return out('none', 'the track does not follow any mapped approach');

  // per approach group: the stop line you are about to cross (nearest ahead); lines you are past are kept apart
  const ahead = new Map(), behind = [];
  for (const o of ok) {
    if (o.a0 <= MATCH.aheadBuf) { const cur = ahead.get(o.gk); if (!cur || o.a0 > cur.a0) ahead.set(o.gk, o); }
    else behind.push(o);
  }
  for (let i = behind.length; i--;) if (ahead.has(behind[i].gk)) behind.splice(i, 1); // the earlier stop line of a light you are still approaching
  if (!ahead.size) return out('none', 'the tap was made past every stop line it could belong to');
  const a1 = Math.max(...[...ahead.values()].map((o) => o.a0));
  const comp = [...ahead.values()].filter((o) => o.a0 >= a1 - MATCH.tierM).sort((x, y) => y.f.ll - x.f.ll);
  const best = comp[0], margin = comp.length > 1 ? best.f.ll - comp[1].f.ll : Infinity;
  // right at a stop line with another light just ahead of it, or one you have only just passed: which was meant?
  const atLine = (a1 > -1 && ahead.size > comp.length) || behind.some((o) => o.a0 <= MATCH.ambigNear);

  const { fromArm, bearing: armBrg } = armBearings(set, intersections);
  const c = best.c, ixId = c.ixId, ix = intersections.find((i) => i.id === ixId), centre = set.centres.get(ixId);
  const fromArmId = fromArm.get(c.key) ?? null;
  const base = { ixId, approachKey: c.key, fromArmId, toArmId: null, headId: null, margin, entryBearing: c.bearing, fit: { rms: best.f.rms, bins: best.f.bins, sigma: sigmaHat, rho: noise.rho }, stopAhead: a1, others: { ahead: [...ahead.values()].map((o) => `${o.c.key}@${o.a0.toFixed(0)}`), behind: behind.map((o) => `${o.c.key}@${o.a0.toFixed(0)}`) } };
  const weak = (reason) => out('low', reason, base);
  if (!ix || !centre) return weak('junction not mapped');
  if (best.f.rms > 1.5 * sigmaHat + 2) return weak('the track fits the approach loosely');
  if (margin < MATCH.minLogOdds) return weak('another approach fits almost as well');
  if (atLine) return weak('too close to a stop line to tell which light the tap was for');
  if (!fromArmId) return weak('approach has no clear arm in the map');

  // exit: fixes 30-85 m from the centre after the last one at the stop point (a dwell at the line ends there)
  const dep = (p) => Math.hypot(p.e - c.x, p.n - c.y);
  let last = -1; P.forEach((p, i) => { if (dep(p) <= MATCH.depM) last = i; });
  const ring = P.slice(last + 1).map((p) => ({ x: p.e - centre.e, y: p.n - centre.n })).filter((v) => Math.hypot(v.x, v.y) >= MATCH.exitMin && Math.hypot(v.x, v.y) <= MATCH.exitMax);
  if (last < 0 || ring.length < MATCH.exitMinPts) return out('none', 'the track ends before the junction is cleared', base);
  const sx = ring.reduce((s, v) => s + v.x, 0), sy = ring.reduce((s, v) => s + v.y, 0), sl = ring.reduce((s, v) => s + Math.hypot(v.x, v.y), 0);
  const exitBearing = Math.hypot(sx, sy) / sl >= MATCH.exitR ? bearing(sx, sy) : null;
  const arms = [...(armBrg.get(ixId) ?? [])].map(([id, b]) => ({ id, d: exitBearing == null ? Infinity : angularDiff(b, exitBearing) })).sort((x, y) => x.d - y.d);
  const exitArm = arms[0] && arms[0].d <= MATCH.exitTol && (arms.length < 2 || arms[1].d - arms[0].d >= MATCH.exitMargin) ? arms[0].id : null;
  const dTurn = exitBearing == null ? null : ((exitBearing - c.bearing + 540) % 360) - 180;
  const turn = exitArm == null || dTurn == null ? null : exitArm === fromArmId ? 'u-turn' : Math.abs(dTurn) <= MATCH.turnStraight ? 'straight' : dTurn > 0 ? 'right' : 'left';
  const res = { ...base, toArmId: exitArm, exitBearing, turn };

  // head: the movement's, or the only head the arm has (then the exit does not matter)
  const sole = soleHeadFrom(ix, fromArmId);
  if (sole) return { ...res, headId: sole, confidence: 'high', reason: 'one head serves this approach' };
  if (!exitArm) return { ...res, confidence: 'low', reason: exitBearing == null ? 'the way out is not clear' : 'the way out matches no arm clearly' };
  const headId = headOfMovement(ix, fromArmId, exitArm);
  if (!headId) return { ...res, confidence: 'low', reason: 'no single head for that movement' };
  return { ...res, headId, confidence: 'high', reason: 'entry and exit are unambiguous' };
}
