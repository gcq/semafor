// Shared fixture for the track tests: the real Molins de Rei street geometry (osm2streets over
// test/data/pont.osm.xml), the user's three junctions (test/data/molins-ixs.json: arms, movements,
// masts, heads) and a drive simulator that walks real OSM ways with GPS noise, dropped fixes and
// a garbage heading at a standstill, then runs the fixes through the real recorder.
import { readFileSync } from 'node:fs';
import { initSync, JsStreetNetwork } from '../vendor/osm2streets/osm2streets_js.js';
import { areaBbox, bboxCenter, buildLanes } from '../src/osm/lanes.js';
import { approachCandidates, toLocal } from '../src/osm/approaches.js';
import { createRecorder, decodeTrack } from '../src/nav/trackrec.js';

initSync({ module: readFileSync(new URL('../vendor/osm2streets/osm2streets_js_bg.wasm', import.meta.url)) });
export const ixs = JSON.parse(readFileSync(new URL('./data/molins-ixs.json', import.meta.url), 'utf8'));
const xml = readFileSync(new URL('./data/pont.osm.xml', import.meta.url));
const bbox = areaBbox(ixs.map((i) => i.location));
export const center = bboxCenter(bbox);
export const streets = { kind: 'lanes', center, data: buildLanes(JsStreetNetwork, new Uint8Array(xml), bbox).data };
export const set = approachCandidates(streets, ixs);

const R = 6371000, RAD = Math.PI / 180;
export const toLL = ({ e, n }) => ({ lat: center.lat + n / (R * RAD), lon: center.lon + e / (R * RAD * Math.cos(center.lat * RAD)) });

// ---- names -> ids ----
export const ixNamed = (name) => ixs.find((i) => i.name.startsWith(name));
export const headId = (ixName, headName) => ixNamed(ixName).heads.find((h) => h.name === headName).id;
/** Head of the mast whose id ends with `suffix` (the first one). */
export const mastHead = (suffix) => { for (const ix of ixs) for (const m of ix.masts) if (m.id.endsWith(suffix)) return m.headIds[0]; throw new Error(suffix); };
export const armId = (ixName, armName) => ixNamed(ixName).arms.find((a) => a.name === armName).id;

// ---- routes along real OSM ways ----
const nodes = new Map([...xml.toString().matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)"[^>]*?lon="([-\d.]+)"/g)].map((m) => [m[1], toLocal({ lat: +m[2], lon: +m[3] }, center)]));
export const wayPts = (id) => [...new RegExp(`<way id="${id}"[^>]*>([\\s\\S]*?)</way>`).exec(xml.toString())[1].matchAll(/<nd ref="(\d+)"/g)].map((m) => nodes.get(m[1])).filter(Boolean);
const d2 = (a, b) => Math.hypot(a.e - b.e, a.n - b.n);

/**
 * Polyline from parts, in driving order. A part is a way id (oriented to continue from the end so far;
 * the first one as stored unless [id,'rev']) or {pts:[{e,n}…]} raw points, or {cut:[e,n]} = drop the
 * points after the one nearest (e,n) from what was built so far.
 */
export function route(...parts) {
  let pts = [];
  for (const part of parts) {
    if (part.cut) { const i = pts.reduce((bi, p, k) => (d2(p, { e: part.cut[0], n: part.cut[1] }) < d2(pts[bi], { e: part.cut[0], n: part.cut[1] }) ? k : bi), 0); pts = pts.slice(0, i + 1); continue; }
    let w = part.pts ?? wayPts(Array.isArray(part) ? part[0] : part);
    if (Array.isArray(part) && part[1] === 'rev') w = [...w].reverse();
    else if (pts.length && !part.pts && d2(pts.at(-1), w[0]) > d2(pts.at(-1), w.at(-1))) w = [...w].reverse();
    pts = pts.concat(w);
  }
  // the OSM clip ends the first way ~100 m out: carry it on straight (the run-in the matcher judges is up to 150 m)
  { const a = pts[0], b = pts[1], l = d2(a, b); pts.unshift({ e: a.e + (a.e - b.e) / l * 150, n: a.n + (a.n - b.n) / l * 150 }); }
  { const a = pts.at(-1), b = pts.at(-2), l = d2(a, b); pts.push({ e: a.e + (a.e - b.e) / l * 150, n: a.n + (a.n - b.n) / l * 150 }); } // ... and on past the other end
  pts = pts.filter((p, i) => !i || d2(p, pts[i - 1]) > 0.01);
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + d2(pts[i], pts[i - 1]));
  const at = (s) => {
    s = Math.max(0, Math.min(cum.at(-1) - 1e-6, s));
    let i = 1; while (cum[i] < s) i++;
    const f = (s - cum[i - 1]) / (cum[i] - cum[i - 1]), a = pts[i - 1], b = pts[i];
    return { e: a.e + (b.e - a.e) * f, n: a.n + (b.n - a.n) * f, brg: ((Math.atan2(b.e - a.e, b.n - a.n) / RAD) + 360) % 360 };
  };
  return { pts, length: cum.at(-1), at };
}
/** Arc length of the route point nearest to a stop point. */
export const sOf = (r, x, y) => { let best = 0, bd = Infinity; for (let s = 0; s < r.length; s += 0.25) { const p = r.at(s), d = Math.hypot(p.e - x, p.n - y); if (d < bd) { bd = d; best = s; } } return best; };
/** Arc length of the route's stop line at approach `key` (its stop point). */
export const stopS = (r, key) => { const c = set.cands.find((k) => k.key === key); return sOf(r, c.x, c.y); };

// ---- noise ----
export const rng = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = (rand) => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());

export const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);

/**
 * Drive `r` and return GPS fixes (1 Hz by default). Cruise `speed`, brake to a stop `stopBefore` m
 * before arc length `stopAt`, wait `dwell` s, accelerate on. Noise: white Gaussian `sigma` m per axis
 * (or AR(1) with `corr`), ~`drop` of fixes lost (+ one 4 s gap), heading +-4° while moving and
 * garbage (random, or `frozenHeading`) at a standstill.
 * @returns {{fixes:Array, tAt:(s:number)=>number, dwellStart:number, dwellEnd:number}}
 */
export function drive(r, { speed = 10, stopAt = null, stopBefore = 5, dwell = 40, from = 0, to = r.length, sigma = 6, corr = 0, drop = 0.12, seed = 1, frozenHeading = null, hz = 1, leadS = 20 } = {}) {
  const rand = rng(seed * 7919 + 17), dt = 0.1, acc = 2, stopS0 = stopAt == null ? null : stopAt - stopBefore;
  let s = from, v = speed, t = -leadS, state = 'cruise', wait = 0, dwellStart = null, dwellEnd = null;
  const trace = [];
  while (s < to && t < 900) {
    if (stopS0 != null && state === 'cruise' && s >= stopS0 - (v * v) / (2 * acc)) state = 'brake';
    if (state === 'brake') { v = Math.max(0, v - acc * dt); if (v === 0 || s >= stopS0) { v = 0; state = 'dwell'; dwellStart = t; } }
    else if (state === 'dwell') { wait += dt; if (wait >= dwell) { state = 'go'; dwellEnd = t; } }
    else if (state === 'go') { v = Math.min(speed, v + acc * dt); if (v >= speed) state = 'cruise2'; }
    s += v * dt; t += dt;
    trace.push({ t, s, v });
  }
  let nx = 0, ny = 0; // AR(1) noise state
  const fixes = [], gapAt = 8 + rand() * 20;
  for (const q of trace) {
    if (Math.abs(q.t * hz - Math.round(q.t * hz)) > dt * hz / 2) continue;
    if (rand() < drop || (q.t >= gapAt && q.t < gapAt + 4)) continue;
    const p = r.at(q.s);
    let ex, ey;
    if (corr) { nx = corr * nx + Math.sqrt(1 - corr * corr) * gauss(rand) * sigma; ny = corr * ny + Math.sqrt(1 - corr * corr) * gauss(rand) * sigma; ex = nx; ey = ny; }
    else { ex = gauss(rand) * sigma; ey = gauss(rand) * sigma; }
    const moving = q.v > 2;
    fixes.push({
      t: T0 + Math.round(q.t * 1000), ...toLL({ e: p.e + ex, n: p.n + ey }),
      heading: moving ? (p.brg + gauss(rand) * 4 + 360) % 360 : frozenHeading ?? rand() * 360,
      speed: Math.max(0, q.v + gauss(rand) * 0.3), acc: Math.max(3, sigma * 1.5),
    });
  }
  return { fixes, tAt: (sArc) => T0 + Math.round((trace.find((q) => q.s >= sArc)?.t ?? trace.at(-1).t) * 1000), dwellStart: dwellStart == null ? null : T0 + Math.round(dwellStart * 1000), dwellEnd: dwellEnd == null ? null : T0 + Math.round(dwellEnd * 1000) };
}

/**
 * Feed fixes through the real recorder with a tap at `tapT` under `tapIx`; returns the decoded track
 * of the finished record (or what is pending at the end of the fixes, like an app that was closed).
 */
export function record(fixes, { tapT, tapIx, obsId = 'obs_x' }) {
  let rec = null;
  const rr = createRecorder({ junctions: () => ixs.map((i) => ({ id: i.id, ...i.location })), onDone: (r) => { rec = r; } });
  let tapped = false;
  for (const f of fixes) {
    if (!tapped && f.t >= tapT) { rr.tap({ id: obsId, t: tapT, intersectionId: tapIx }); tapped = true; }
    rr.fix(f);
    if (rec) break;
  }
  if (!rec) rr.flush();
  return rec ? { rec, track: decodeTrack(rec) } : { rec: null, track: [] };
}
