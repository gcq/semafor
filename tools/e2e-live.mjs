// End-to-end check that Live gets its street geometry on a real (emulated) phone.
//   node tools/e2e-live.mjs <app-url> <intersections.json> [chromium|webkit] [outDir]
// Opens the app in a fresh context (Pixel 7 / iPhone 14, so the service worker never
// carries state over), seeds the intersections through the app's own db module,
// reloads, then waits up to 2 min for db.allStreets() to hold a 'lanes' entry.
// Prints console errors, failed requests, OSM fetches with timings; saves
// <outDir>/e2e-<engine>-early.png (status note while loading) and -final.png.
// Exits non-zero on failure. Needs playwright but nothing in the repo:
//   docker run --rm -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.49.0-noble bash -c \
//     "npm i -s --prefix /tmp/pw playwright@1.49.0 && NODE_PATH=/tmp/pw/node_modules node tools/e2e-live.mjs <url> <ix.json> webkit"
// (ESM ignores NODE_PATH, hence the createRequire below.)
import { createRequire } from 'node:module';
import fs from 'node:fs';

const [url, ixFile, engine = 'chromium', outDir = '/tmp'] = process.argv.slice(2);
if (!url || !ixFile) { console.error('usage: e2e-live.mjs <app-url> <intersections.json> [chromium|webkit] [outDir]'); process.exit(2); }
const pw = createRequire(import.meta.url)('playwright');
const device = { chromium: 'Pixel 7', webkit: 'iPhone 14' }[engine];
if (!device) { console.error(`unknown engine ${engine}`); process.exit(2); }

const base = new URL('.', url.endsWith('/') ? url : `${url}/`).href; // app root, trailing slash
const ixs = JSON.parse(fs.readFileSync(ixFile, 'utf8'));
const at = ixs.find((i) => i.location)?.location ?? { lat: 0, lon: 0 };
const WAIT_MS = 120000;

const browser = await pw[engine].launch();
const ctx = await browser.newContext({ ...pw.devices[device], geolocation: { latitude: at.lat, longitude: at.lon }, permissions: ['geolocation'] });
const page = await ctx.newPage();
// E2E_OSM=delay:<ms> holds every OSM API / Overpass request for <ms> (to catch the "Loading streets…" note in the
// early screenshot); E2E_OSM=block fails them all (checks "Streets unavailable — retrying"; no lanes expected, exits 0).
const [osmMode, osmArg] = (process.env.E2E_OSM ?? '').split(':');
if (osmMode) {
  await ctx.route(/openstreetmap\.org\/api|overpass/, async (route) => {
    if (osmMode === 'block') return route.abort('failed');
    await new Promise((r) => setTimeout(r, Number(osmArg) || 5000));
    return route.continue().catch(() => {});
  });
}
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const problems = [];
const started = new Map();
const WASM_NOISE = /^(Hack!|Road #|Not collapsing|Found \d+ nodes|Ignoring country)/; // osm2streets logs via console.error
page.on('console', (m) => {
  if (WASM_NOISE.test(m.text())) return;
  if (m.type() === 'error' || m.type() === 'warning' || /\[streets\]/.test(m.text())) console.log(ts(), `console.${m.type()}`, m.text().slice(0, 300));
  if (m.type() === 'error') problems.push(m.text());
});
page.on('pageerror', (e) => { console.log(ts(), 'PAGEERROR', e.message); problems.push(e.message); });
page.on('request', (r) => { if (/openstreetmap\.org\/api|overpass/.test(r.url())) started.set(r, Date.now()); });
page.on('requestfailed', (r) => console.log(ts(), 'REQFAIL', r.url().slice(0, 120), r.failure()?.errorText));
page.on('response', (r) => {
  const u = r.url();
  if (/openstreetmap\.org\/api|overpass|osm2streets/.test(u)) {
    const took = started.has(r.request()) ? ` (${((Date.now() - started.get(r.request())) / 1000).toFixed(1)}s)` : '';
    console.log(ts(), 'RESP', r.status(), u.slice(0, 110) + took);
  }
});

const streets = () => page.evaluate(async (b) => {
  const db = await import(`${b}src/store/db.js`);
  return (await db.allStreets()).map((e) => ({ id: e.id, kind: e.kind, v: e.v, bytes: JSON.stringify(e).length }));
}, base);

let ok = false, found = [];
try {
  await page.goto(base); await page.waitForTimeout(3000);
  const n = await page.evaluate(async ([b, list]) => {
    const db = await import(`${b}src/store/db.js`);
    for (const ix of list) await db.putIntersection(ix);
    for (const e of await db.allStreets()) await db.deleteStreets(e.id); // start from nothing cached
    return (await db.allIntersections()).length;
  }, [base, ixs]);
  console.log(ts(), 'seeded', n, 'intersections;', engine, device);
  await page.reload();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/e2e-${engine}-early.png` });
  const tStart = Date.now();
  if (osmMode === 'block') { await page.waitForTimeout(12000); await page.screenshot({ path: `${outDir}/e2e-${engine}-blocked.png` }); ok = true; found = await streets(); }
  while (!ok && Date.now() - tStart < WAIT_MS) {
    found = await streets();
    if (found.some((e) => e.kind === 'lanes')) { ok = true; break; }
    await page.waitForTimeout(1000);
  }
  console.log(ts(), ok && osmMode === 'block' ? 'BLOCKED (no lanes expected)' : ok ? 'STREETS' : 'NO LANES ENTRY', JSON.stringify(found));
  await page.waitForTimeout(1500); // let a frame draw
  await page.screenshot({ path: `${outDir}/e2e-${engine}-final.png` });
} catch (e) {
  console.log(ts(), 'E2E ERROR', e.message);
} finally { await browser.close(); }

console.log(ok ? `PASS ${engine}: lanes entry after ${((Date.now() - t0) / 1000).toFixed(1)}s` : `FAIL ${engine}`);
process.exit(ok ? 0 : 1);
