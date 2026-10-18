// End-to-end drive simulation for Live's course-up orientation.
//   node tools/e2e-drive.mjs <app-url> <intersections.json> [chromium|webkit] [outDir]
// Seeds the intersections (like e2e-live.mjs), replaces navigator.geolocation with a scripted feed and
// drives straight through the junction Pont (41.414314, 2.012107) on heading 335° at 10 m/s, from 150 m
// before to 150 m past, one fix every STEP_MS. After each fix it reads the read-only debug hook
// window.__onda.lastScene {ixId, upDeg, scale} (set by renderLive) and FAILS if upDeg moves more than
// 30° between consecutive fixes while the simulated heading is constant, or isn't ~heading once moving.
// Screenshots at ~80 m before, ~5 m before, ~10 m past and ~80 m past -> <outDir>/drive-<engine>-*.png.
// Run like e2e-live.mjs (Playwright container, NODE_PATH for playwright, app served over http).
import { createRequire } from 'node:module';
import fs from 'node:fs';

const [url, ixFile, engine = 'chromium', outDir = '/tmp'] = process.argv.slice(2);
if (!url || !ixFile) { console.error('usage: e2e-drive.mjs <app-url> <intersections.json> [chromium|webkit] [outDir]'); process.exit(2); }
const pw = createRequire(import.meta.url)('playwright');
const device = { chromium: 'Pixel 7', webkit: 'iPhone 14' }[engine];
if (!device) { console.error(`unknown engine ${engine}`); process.exit(2); }

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

const browser = await pw[engine].launch();
const ctx = await browser.newContext({ ...pw.devices[device], geolocation: { latitude: PONT.lat, longitude: PONT.lon }, permissions: ['geolocation'] });
// scripted geolocation: the test pushes fixes through window.__push(d)
await ctx.addInitScript(({ P, HEADING, SPEED }) => {
  const cbs = [];
  const fix = (d) => {
    const r = Math.PI / 180;
    return { coords: { latitude: P.lat + (d * Math.cos(HEADING * r)) / 111320, longitude: P.lon + (d * Math.sin(HEADING * r)) / (111320 * Math.cos(P.lat * r)), heading: HEADING, speed: SPEED, accuracy: 5, altitude: null, altitudeAccuracy: null }, timestamp: Date.now() };
  };
  let last = null;
  const geo = {
    watchPosition: (ok) => { cbs.push(ok); if (last != null) ok(fix(last)); return cbs.length; },
    getCurrentPosition: (ok) => { if (last != null) ok(fix(last)); },
    clearWatch: () => {},
  };
  Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
  window.__push = (d) => { last = d; cbs.forEach((cb) => cb(fix(d))); };
}, { P: PONT, HEADING, SPEED });
const page = await ctx.newPage();
const problems = [];
const WASM_NOISE = /^(Hack!|Road #|Not collapsing|Found \d+ nodes|Ignoring country)/;
page.on('console', (m) => { if (m.type() === 'error' && !WASM_NOISE.test(m.text())) { console.log('console.error', m.text().slice(0, 200)); } });
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); problems.push(e.message); });

let ok = false;
try {
  fs.mkdirSync(outDir, { recursive: true });
  await page.goto(base); await page.waitForTimeout(3000);
  await page.evaluate(async ([b, list]) => {
    const db = await import(`${b}src/store/db.js`);
    for (const ix of list) await db.putIntersection(ix);
  }, [base, ixs]);
  await page.reload(); await page.waitForTimeout(1500);
  // let the street geometry arrive for nicer screenshots (best effort)
  await page.evaluate(() => window.__push(-150));
  for (let i = 0; i < 60; i++) {
    const has = await page.evaluate(async (b) => (await (await import(`${b}src/store/db.js`)).allStreets()).some((e) => e.kind === 'lanes'), base);
    if (has) break;
    await page.waitForTimeout(1000);
  }
  await page.evaluate(() => { window.__onda.frames.length = 0; });
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
  ok = series.length > 20 && !bad.length && !problems.length;
} catch (e) { console.log('E2E ERROR', e.message); }
finally { await browser.close(); }
console.log(ok ? `PASS ${engine}: course-up stable through the junction` : `FAIL ${engine}`);
process.exit(ok ? 0 : 1);
