// End-to-end drive simulation for Live's course-up orientation and active-head pick.
//   node tools/e2e-drive.mjs <app-url> <intersections.json> [chromium|webkit] [outDir] [route]
//   route: straight (default) | avinguda | carretera (the last two follow the real OSM roads, see below)
// Seeds the intersections (like e2e-live.mjs), replaces navigator.geolocation with a scripted feed.
//
// straight: drives straight through the junction Pont (41.414314, 2.012107) on heading 335° at 10 m/s, from 150 m
// before to 150 m past, one fix every STEP_MS. After each fix it reads the read-only debug hook
// window.__onda.lastScene {ixId, upDeg, scale} (set by renderLive) and FAILS if upDeg moves more than
// 30° between consecutive fixes while the simulated heading is constant, or isn't ~heading once moving.
// Screenshots at ~80 m before, ~5 m before, ~10 m past and ~80 m past -> <outDir>/drive-<engine>-*.png.
//
// avinguda / carretera: 1 Hz fixes at 10 m/s along the real OSM way geometry (test/data/pont.osm.xml: Avinguda de
// Caldes, resp. Carretera de Molins de Rei a Caldes) from 150 m before Pont's first stop line on that road to 100 m
// past, with seeded noise (±2 m position per axis, ±3° course). After each fix it reads window.__onda.head
// {ixId, headId, reason} and the shown junction, prints (metres to that stop line, junction, head, reason) and FAILS if
//   - from 60 m before the line to the line the head isn't this road's own: Pont's jw8ph head on Avinguda / h9sy6 head
//     on Carretera (from 30 m before; further back Live may still be on Pere Calders, whose own stop line comes first:
//     its rhyy7 / 660rt head),
//   - the (junction, head) pair flips back to one it already left, from 60 m before to 50 m past, changes more than
//     once in the 50 m after the line, or falls back to bearings between -60 and +50 m.
//   It also prints where Live moved on after the line (the "first change" line: next light ahead, or none mapped).
// Screenshots at -60, -20, +10, +40 m -> <outDir>/head-<route>-<engine>-*.png.
// Needs the repo checkout (it computes the stop lines with src/osm/* in Node), the private intersections file (not in
// the repo) and playwright. Run like e2e-live.mjs (Playwright container, NODE_PATH for playwright, app served over http):
//   docker run --rm -v "$PWD":/w -v ix.json:/ix.json:ro -v outdir:/out -v run.sh:/run.sh mcr.microsoft.com/playwright:v1.49.0-noble sh /run.sh chromium avinguda
// with run.sh = cd /w; serve it on :8123; npm i playwright@1.49.0 --prefix /tmp/pw;
//   NODE_PATH=/tmp/pw/node_modules node tools/e2e-drive.mjs http://127.0.0.1:8123/ /ix.json "$1" /out "$2"
import { createRequire } from 'node:module';
import fs from 'node:fs';

const [url, ixFile, engine = 'chromium', outDir = '/tmp', route = 'straight'] = process.argv.slice(2);
if (!url || !ixFile) { console.error('usage: e2e-drive.mjs <app-url> <intersections.json> [chromium|webkit] [outDir] [straight|avinguda|carretera]'); process.exit(2); }
const pw = createRequire(import.meta.url)('playwright');
const device = { chromium: 'Pixel 7', webkit: 'iPhone 14' }[engine];
if (!device) { console.error(`unknown engine ${engine}`); process.exit(2); }
if (!['straight', 'avinguda', 'carretera'].includes(route)) { console.error(`unknown route ${route}`); process.exit(2); }

const base = new URL('.', url.endsWith('/') ? url : `${url}/`).href;
const ixs = JSON.parse(fs.readFileSync(ixFile, 'utf8'));
const PONT = { lat: 41.414314, lon: 2.012107 };
const HEADING = 335, SPEED = 10, STEP_MS = 300, FROM = -150, TO = 150;
const SHOTS = new Map([[-80, 'before80'], [-5, 'before5'], [10, 'past10'], [80, 'past80']]);
const posAt = (d) => ({
  lat: PONT.lat + (d * Math.cos(HEADING * Math.PI / 180)) / 111320,
  lon: PONT.lon + (d * Math.sin(HEADING * Math.PI / 180)) / (111320 * Math.cos(PONT.lat * Math.PI / 180)),
});
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const nameOf = (id) => ixs.find((i) => i.id === id)?.name ?? id;

// ---------- polyline routes ----------
const RAD = Math.PI / 180, MLAT = 111320, MLON = MLAT * Math.cos(PONT.lat * RAD);
const toLL = ({ e, n }) => ({ lat: PONT.lat + n / MLAT, lon: PONT.lon + e / MLON });
// mast id suffix -> { head id, junction id }; heads/ixs are the user's private data
const mastInfo = (suffix) => {
  for (const ix of ixs) for (const m of ix.masts ?? []) if (m.id.endsWith(suffix)) return { headId: m.headIds[0], ixId: ix.id, ix: ix.name };
  throw new Error(`no mast ...${suffix} in ${ixFile}`);
};
const ROUTES = {
  // OSM way ids (test/data/pont.osm.xml), in driving order.
  // Avinguda de Caldes enters Pont and leaves it only through the junction box, which OSM models as a link: the
  // polyline follows the way up to its node 16 m east / 16 m south of Pont, then goes straight to node 13 m east /
  // 34 m north of Pont of the way that continues it (the only non-OSM stretch, ~50 m inside the junction; the way's
  // first nodes loop round an island, which nobody drives).
  avinguda: { ways: [296913512, 'to:16,-16', 414832354, 'from:13,34'], road: 'Avinguda de Caldes', pontMast: 'jw8ph', calders: 'rhyy7' },
  carretera: { ways: [230443675, 1410456370, 547228455, 1410456371, 547228456], road: 'Carretera de Molins de Rei a Caldes', pontMast: 'h9sy6', calders: '660rt' },
};

function buildRoute(spec) {
  const xml = fs.readFileSync(new URL('../test/data/pont.osm.xml', import.meta.url), 'utf8');
  const nodes = new Map([...xml.matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)"[^>]*?lon="([-\d.]+)"/g)].map((m) => [m[1], { e: (+m[3] - PONT.lon) * MLON, n: (+m[2] - PONT.lat) * MLAT }]));
  const wayPts = (id) => [...new RegExp(`<way id="${id}"[^>]*>([\\s\\S]*?)</way>`).exec(xml)[1].matchAll(/<nd ref="(\d+)"/g)].map((x) => nodes.get(x[1])).filter(Boolean);
  let pts = [], lastStart = 0;
  for (const w of spec.ways) {
    if (typeof w === 'number') { lastStart = pts.length; pts = pts.concat(wayPts(w)); continue; }
    const [kind, xy] = w.split(':'), [x, y] = xy.split(',').map(Number);
    let bi = 0, bd = Infinity; pts.forEach((p, i) => { const d = Math.hypot(p.e - x, p.n - y); if (d < bd) { bd = d; bi = i; } });
    // 'to:x,y' cuts the polyline after the node nearest (x, y); 'from:x,y' drops the start of the polyline up to it (just the last way's, in practice)
    pts = kind === 'to' ? pts.slice(0, bi + 1) : pts.slice(0, lastStart).concat(pts.slice(bi));
  }
  pts = pts.filter((p, i) => !i || Math.hypot(p.e - pts[i - 1].e, p.n - pts[i - 1].n) > 0.01);
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].e - pts[i - 1].e, pts[i].n - pts[i - 1].n));
  const at = (s) => { // position + travel bearing at arc length s
    s = Math.max(0, Math.min(cum.at(-1) - 1e-6, s));
    let i = 1; while (cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1]), a = pts[i - 1], b = pts[i];
    return { e: a.e + (b.e - a.e) * t, n: a.n + (b.n - a.n) * t, brg: ((Math.atan2(b.e - a.e, b.n - a.n) / RAD) + 360) % 360 };
  };
  return { at, length: cum.at(-1) };
}

// Pont's first stop line on this road (the same approach data the app matches), as an arc length along the route
async function stopLineS(spec) {
  const { initSync, JsStreetNetwork } = await import('../vendor/osm2streets/osm2streets_js.js');
  const { areaBbox, bboxCenter, buildLanes } = await import('../src/osm/lanes.js');
  const { matchApproaches } = await import('../src/osm/approaches.js');
  initSync({ module: fs.readFileSync(new URL('../vendor/osm2streets/osm2streets_js_bg.wasm', import.meta.url)) });
  const bbox = areaBbox([{ lat: 41.4143, lon: 2.0121 }]);
  const xml = fs.readFileSync(new URL('../test/data/pont.osm.xml', import.meta.url));
  const { data } = buildLanes(JsStreetNetwork, new Uint8Array(xml), bbox);
  const pont = ixs.find((i) => i.id === mastInfo(spec.pontMast).ixId);
  const c = bboxCenter(bbox), off = { e: (c.lon - PONT.lon) * MLON, n: (c.lat - PONT.lat) * MLAT }; // entry frame -> Pont frame
  const wayName = (id) => new RegExp(`<way id="${id}"[^>]*>[\\s\\S]*?</way>`).exec(xml.toString())?.[0].match(/k="name" v="([^"]*)"/)?.[1];
  const m = matchApproaches(data, c, [pont]).matches.filter((a) => wayName(a.way) === spec.road && Math.abs(a.bearing - HEADING) <= 10 && a.headId === mastInfo(spec.pontMast).headId);
  if (!m.length) throw new Error(`no Pont approach on ${spec.road}`);
  const a = m.reduce((p, q) => (q.y < p.y ? q : p)); // the one furthest back
  const stop = { e: a.x + off.e, n: a.y + off.n }, d = { e: Math.sin(a.bearing * RAD), n: Math.cos(a.bearing * RAD) };
  const r = buildRoute(spec);
  for (let s = 0; s < r.length; s += 0.25) { // first sample past the stop line, near the stop point
    const p = r.at(s);
    if ((p.e - stop.e) * d.e + (p.n - stop.n) * d.n >= 0 && Math.hypot(p.e - stop.e, p.n - stop.n) < 25) return { route: r, s0: s, stop };
  }
  throw new Error('route never crosses the stop line');
}

// seeded noise: mulberry32
const rng = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const browser = await pw[engine].launch();
const ctx = await browser.newContext({ ...pw.devices[device], geolocation: { latitude: PONT.lat, longitude: PONT.lon }, permissions: ['geolocation'] });
// scripted geolocation: the test pushes fixes through window.__push(d) (straight line) or window.__pushFix(lat, lon, heading)
await ctx.addInitScript(({ P, HEADING, SPEED }) => {
  const cbs = [];
  const mk = (lat, lon, heading) => ({ coords: { latitude: lat, longitude: lon, heading, speed: SPEED, accuracy: 5, altitude: null, altitudeAccuracy: null }, timestamp: Date.now() });
  const fix = (d) => {
    const r = Math.PI / 180;
    return mk(P.lat + (d * Math.cos(HEADING * r)) / 111320, P.lon + (d * Math.sin(HEADING * r)) / (111320 * Math.cos(P.lat * r)), HEADING);
  };
  let last = null;
  const geo = {
    watchPosition: (ok) => { cbs.push(ok); if (last) ok(last); return cbs.length; },
    getCurrentPosition: (ok) => { if (last) ok(last); },
    clearWatch: () => {},
  };
  Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
  window.__push = (d) => { last = fix(d); cbs.forEach((cb) => cb(last)); };
  window.__pushFix = (lat, lon, heading) => { last = mk(lat, lon, heading); cbs.forEach((cb) => cb(last)); };
}, { P: PONT, HEADING, SPEED });
const page = await ctx.newPage();
const problems = [];
const WASM_NOISE = /^(Hack!|Road #|Not collapsing|Found \d+ nodes|Ignoring country)/;
page.on('console', (m) => { if (m.type() === 'error' && !WASM_NOISE.test(m.text())) { console.log('console.error', m.text().slice(0, 200)); } });
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); problems.push(e.message); });

// boot the app with the user's junctions and wait (best effort) for the street geometry
async function boot(firstPush, arg) {
  fs.mkdirSync(outDir, { recursive: true });
  await page.goto(base); await page.waitForTimeout(3000);
  await page.evaluate(async ([b, list]) => {
    const db = await import(`${b}src/store/db.js`);
    for (const ix of list) await db.putIntersection(ix);
  }, [base, ixs]);
  await page.reload(); await page.waitForTimeout(1500);
  await page.evaluate(firstPush, arg);
  for (let i = 0; i < 60; i++) {
    const has = await page.evaluate(async (b) => (await (await import(`${b}src/store/db.js`)).allStreets()).some((e) => e.kind === 'lanes'), base);
    if (has) break;
    await page.waitForTimeout(1000);
  }
  await page.evaluate(() => { window.__onda.frames.length = 0; });
}

async function driveStraight() {
  await boot(() => window.__push(-150));
  const series = [];
  let prev = null, bad = [];
  for (let d = FROM; d <= TO; d += SPEED * STEP_MS / 1000) {
    await page.evaluate((x) => window.__push(x), d);
    await page.waitForTimeout(STEP_MS);
    const s = await page.evaluate(() => window.__onda?.lastScene ?? null);
    if (!s) { bad.push(`d=${d}: no __onda.lastScene`); continue; }
    series.push({ d, ...s });
    if (prev && angDiff(s.upDeg, prev.upDeg) > 30) bad.push(`d=${d}: upDeg jumped ${prev.upDeg.toFixed(0)} -> ${s.upDeg.toFixed(0)}`);
    if (series.length > 3 && angDiff(s.upDeg, HEADING) > 5) bad.push(`d=${d}: upDeg ${s.upDeg.toFixed(0)} != heading ${HEADING}`);
    prev = s;
    for (const [at, name] of SHOTS) {
      if (Math.abs(d - at) < SPEED * STEP_MS / 2000 + 1e-9) {
        await page.screenshot({ path: `${outDir}/drive-${engine}-${name}.png` });
        console.log(`shot ${name} at d=${d.toFixed(1)}m: shown=${nameOf(s.ixId)} upDeg=${s.upDeg.toFixed(0)} scale=${s.scale?.toFixed(2)}`);
      }
    }
  }
  console.log('upDeg series (every 5th):', series.filter((_, i) => i % 5 === 0).map((s) => `${s.d.toFixed(0)}:${s.upDeg.toFixed(0)}`).join(' '));
  console.log('shown junctions:', [...new Set(series.map((s) => nameOf(s.ixId)))].join(' | '));
  // per-frame smoothness: consecutive rendered frames of the same junction must not jump
  const frames = await page.evaluate(() => window.__onda.frames);
  let maxEgo = 0, maxUp = 0, nPairs = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    if (a.ixId !== b.ixId || !a.ego || !b.ego) continue;
    nPairs++;
    const de = Math.hypot(b.ego.x - a.ego.x, b.ego.y - a.ego.y), du = angDiff(b.up, a.up);
    maxEgo = Math.max(maxEgo, de); maxUp = Math.max(maxUp, du);
    if (de > 15) bad.push(`frame ${i}: ego jumped ${de.toFixed(1)} px`);
    if (du > 5) bad.push(`frame ${i}: upDeg stepped ${du.toFixed(1)}°`);
  }
  const ms = frames.map((f) => f.ms).sort((x, y) => x - y), q = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
  const span = frames.length > 1 ? (frames.at(-1).t - frames[0].t) / 1000 : 0;
  console.log(`frames: n=${frames.length} (${(frames.length / span).toFixed(1)} fps) pairs=${nPairs} maxEgoStep=${maxEgo.toFixed(1)}px maxUpStep=${maxUp.toFixed(2)}° draw median=${q(0.5)?.toFixed(2)}ms p95=${q(0.95)?.toFixed(2)}ms max=${ms.at(-1)?.toFixed(2)}ms`);
  if (frames.length < 100) bad.push(`only ${frames.length} frames drawn`);
  for (const b of bad) console.log('BAD', b);
  return series.length > 20 && !bad.length && !problems.length;
}

async function drivePolyline() {
  const spec = ROUTES[route];
  const { route: r, s0, stop } = await stopLineS(spec);
  const own = mastInfo(spec.pontMast), calders = mastInfo(spec.calders);
  const label = new Map();
  for (const ix of ixs) for (const m of ix.masts ?? []) for (const h of m.headIds ?? []) label.set(h, `${ix.name}/${m.id.slice(-5)}`);
  console.log(`route ${route}: stop line at s=${s0.toFixed(1)} m of ${r.length.toFixed(0)} (stop point ${stop.e.toFixed(1)},${stop.n.toFixed(1)} m from Pont); expected heads: Pont ${label.get(own.headId)}, Pere Calders ${label.get(calders.headId)}`);
  const rand = rng(20260519);
  const noise = (k) => (rand() * 2 - 1) * k;
  const start = s0 - 150, end = Math.min(r.length - 1, s0 + 100);
  const f0 = r.at(start);
  await boot(([lat, lon, h]) => window.__pushFix(lat, lon, h), [toLL(f0).lat, toLL(f0).lon, f0.brg]);
  const rows = [], bad = [];
  const shots = new Map([[-60, 'before60'], [-20, 'before20'], [10, 'past10'], [40, 'past40']]), shot = new Set();
  for (let s = start; s <= end; s += SPEED) { // 1 Hz at 10 m/s
    const p = r.at(s), ll = toLL({ e: p.e + noise(2), n: p.n + noise(2) });
    await page.evaluate(([lat, lon, h]) => window.__pushFix(lat, lon, h), [ll.lat, ll.lon, (p.brg + noise(3) + 360) % 360]);
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => ({ head: window.__onda?.head ?? null, ixId: window.__onda?.lastScene?.ixId ?? null }));
    const row = { rel: s - s0, ixId: st.head?.ixId ?? st.ixId, headId: st.head?.headId ?? null, reason: st.head?.reason ?? null, key: st.head?.key ?? null, next: st.head?.nextIxId ?? null, passed: st.head?.passedIxId ?? null };
    rows.push(row);
    for (const [at, name] of shots) {
      if (!shot.has(at) && Math.abs(row.rel - at) <= SPEED / 2) {
        shot.add(at);
        await page.screenshot({ path: `${outDir}/head-${route}-${engine}-${name}.png` });
      }
    }
  }
  const show = (x) => `${nameOf(x.ixId)} / ${label.get(x.headId) ?? x.headId}`;
  console.log('rel[m]  shown junction / active head  (reason)');
  for (const x of rows) console.log(`${x.rel.toFixed(0).padStart(5)}  ${show(x)}  (${x.reason}) appr ${x.key?.split(':').slice(1).join(':') ?? '-'}${x.next ? ` next=${nameOf(x.next)}` : ''}${x.passed ? ` passed=${nameOf(x.passed)}` : ''}`);

  const keyOf = (x) => `${x.ixId}|${x.headId}`;
  const win = rows.filter((x) => x.rel >= -60 && x.rel <= 50), left = new Set();
  win.forEach((x, i) => { if (i && keyOf(x) !== keyOf(win[i - 1])) { left.add(keyOf(win[i - 1])); if (left.has(keyOf(x))) bad.push(`rel ${x.rel.toFixed(0)}: ${show(x)} again after leaving it`); } });
  for (const x of rows.filter((y) => y.rel >= -60 && y.rel < -4)) {
    // Pere Calders (its own stop line is ~40-55 m before Pont's on both roads) until Live moves on, then Pont's head
    const pereOk = x.rel < -30 && x.ixId === calders.ixId && x.headId === calders.headId;
    if (!(pereOk || (x.ixId === own.ixId && x.headId === own.headId))) bad.push(`rel ${x.rel.toFixed(0)}: ${show(x)} is not this road's head (Pont ${label.get(own.headId)}; Pere Calders ${label.get(calders.headId)} only before -30)`);
  }
  for (const x of win) if (x.reason === 'bearing') bad.push(`rel ${x.rel.toFixed(0)}: fell back to bearings`);
  const changes = rows.filter((y, i) => i && y.rel >= 0 && y.rel <= 50 && keyOf(y) !== keyOf(rows[i - 1])).length;
  if (changes > 1) bad.push(`${changes} (junction, head) changes in the 50 m after the line`);
  const crossed = rows.findIndex((y) => y.rel >= 0), beforeLine = rows[crossed - 1];
  const afterRows = rows.slice(crossed, crossed + 4), moved = afterRows.findIndex((y) => keyOf(y) !== keyOf(beforeLine));
  console.log(`before the line: ${show(beforeLine)}; first change ${moved < 0 ? 'none within 4 fixes' : `${afterRows[moved].rel.toFixed(0)} m past the line (fix ${moved + 1} after crossing): ${show(afterRows[moved])} (${afterRows[moved].reason})`}`);
  if (rows.length < 20) bad.push(`only ${rows.length} fixes`);
  for (const b of bad) console.log('BAD', b);
  return !bad.length && !problems.length;
}

let ok = false;
try {
  ok = route === 'straight' ? await driveStraight() : await drivePolyline();
} catch (e) { console.log('E2E ERROR', e.stack ?? e.message); }
finally { await browser.close(); }
console.log(ok ? `PASS ${engine} ${route}` : `FAIL ${engine} ${route}`);
process.exit(ok ? 0 : 1);
