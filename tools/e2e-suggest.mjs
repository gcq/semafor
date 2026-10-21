// End-to-end check of the suggested re-files: GPS track -> Analyze suggestion + badge -> Accept / Dismiss -> store.
//   node tools/e2e-suggest.mjs [app-url|self] [chromium|webkit] [outDir]
// Runs against the real app in Playwright. The app is served by this script itself when the url is omitted / 'self'.
//
// Scenario (real Molins de Rei geometry, the user's three junctions from test/data/molins-ixs.json, street data computed in
// Node from test/data/pont.osm.xml and seeded into IndexedDB, so no network is needed):
//   1. drive west on Carrer de Verdaguer into Verdaguer - Terraple, stop at the red, tap RED in Capture under
//      "Verdaguer N Straight", then turn off to Terraple N (that movement is the "Verdaguer N Left" head's).
//      Fixes are pushed through a scripted navigator.geolocation with a virtual clock (Date.now follows the fix times),
//      GPS noise 4 m, ~12% dropped fixes, garbage heading at a standstill.
//   2. When the recorder has the track: the Analyze tab shows a badge "1" and a "Suggested re-files" card (time, colour,
//      Straight -> Left, why). Accept: IndexedDB must hold the NEW observation (<id>_rf, head Left) and a tombstone for the
//      old id, and no suggestion/badge may remain.
//   3. Drive it again tapping the WRONG head again, Dismiss: a dismissal record is stored, the tap stays where it is, and after
//      a reload the suggestion does not come back.
//   4. A correct tap (Left, turning to Terraple N) produces no suggestion.
// Exit code 0 = all checks passed. Needs the repo checkout and playwright (1.49):
//   docker run --rm -v "$PWD":/w -v /tmp/e2e-out:/out mcr.microsoft.com/playwright:v1.49.0-noble sh -c \
//     'cd /w && npm i playwright@1.49.0 --prefix /tmp/pw >/dev/null 2>&1; NODE_PATH=/tmp/pw/node_modules node tools/e2e-suggest.mjs self chromium /out'
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [urlArg = 'self', engine = 'chromium', outDir = '/tmp/e2e-suggest'] = process.argv.slice(2);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pw = createRequire(import.meta.url)('playwright');
const device = { chromium: 'Pixel 7', webkit: 'iPhone 14' }[engine];
if (!device) { console.error(`unknown engine ${engine}`); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

// ---- what the app is fed: the real geometry + simulated drives (same fixtures as the unit tests) ----
const fx = await import('../test/trackfix.js');
const { SCENARIOS, run } = await import('../test/trackscen.js');
const { clusterIntersections, STREETS_FORMAT } = await import('../src/osm/lanes-cache.js');
const { areaBbox, bboxCenter, buildLanes } = await import('../src/osm/lanes.js');
const { initSync, JsStreetNetwork } = await import('../vendor/osm2streets/osm2streets_js.js');
void initSync; // already initialised by test/trackfix.js
const ixs = fx.ixs;
const cluster = clusterIntersections(ixs)[0];
const bbox = areaBbox(cluster.members), streetEntry = {
  id: cluster.key, v: STREETS_FORMAT, members: cluster.members, center: bboxCenter(bbox), computedAt: Date.now(), kind: 'lanes',
  data: buildLanes(JsStreetNetwork, new Uint8Array(fs.readFileSync(path.join(root, 'test/data/pont.osm.xml'))), bbox).data,
};
const VT = fx.ixNamed('Verdaguer - Terraple');
const H = { straight: fx.headId('Verdaguer - Terraple', 'Verdaguer N Straight'), left: fx.headId('Verdaguer - Terraple', 'Verdaguer N Left') };
const turn = SCENARIOS.find((s) => s.id === 'vt-turn-tapStraight');   // off to Terraple N after the stop
// each drive on its own hour of the virtual clock (a fix older than the last one is dropped by the recorder)
const drives = (seed, k) => { const r = run(turn, { sigma: 4, seed, dwell: 40 }), dt = k * 3600e3; return { fixes: r.d.fixes.map((f) => ({ ...f, t: f.t + dt })), tapT: r.tapT + dt }; };

// ---- static server for the app ----
let server = null, base = urlArg;
if (urlArg === 'self') {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
  server = http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
}
base = base.endsWith('/') ? base : `${base}/`;

const browser = await pw[engine].launch();
const ctx = await browser.newContext({ ...pw.devices[device], geolocation: { latitude: VT.location.lat, longitude: VT.location.lon }, permissions: ['geolocation'] });
// scripted geolocation + a virtual clock: Date.now() = the time of the last pushed fix, so taps and fixes share one timeline
await ctx.addInitScript(() => {
  const real = Date.now.bind(Date); let off = 0;
  Date.now = () => real() + off;
  window.__setNow = (t) => { off = t - real(); };
  const cbs = []; let last = null;
  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    watchPosition: (ok) => { cbs.push(ok); if (last) ok(last); return cbs.length; },
    getCurrentPosition: (ok) => { if (last) ok(last); }, clearWatch: () => {},
  } });
  window.__pushFix = (f) => {
    last = { coords: { latitude: f.lat, longitude: f.lon, heading: f.heading, speed: f.speed, accuracy: f.acc ?? 5, altitude: null, altitudeAccuracy: null }, timestamp: f.t };
    cbs.forEach((cb) => cb(last));
  };
});
const page = await ctx.newPage();
const problems = [], checks = [];
const WASM_NOISE = /^(Hack!|Road #|Not collapsing|Found \d+ nodes|Ignoring country)/;
page.on('console', (m) => { if (m.type() === 'error' && !WASM_NOISE.test(m.text())) console.log('console.error', m.text().slice(0, 200)); });
page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); problems.push(e.message); });
const check = (name, ok, detail = '') => { checks.push([name, !!ok]); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const db = (fn, arg) => page.evaluate(async ([b, src, a]) => new Function('db', 'a', `return (${src})(db, a)`)(await import(`${b}src/store/db.js`), a), [base, fn.toString(), arg]);
const view = async (name) => { await page.click(`#tab-${name}`); await page.waitForTimeout(150); };

async function boot() {
  await page.goto(base); await page.waitForTimeout(2500);
  await db(async (d, a) => { for (const ix of a.ixs) await d.putIntersection(ix); await d.putStreets(a.street); }, { ixs, street: streetEntry });
  await page.reload(); await page.waitForTimeout(2000);
}
// push the drive's fixes; at the tap time choose the head in Capture and tap RED. Returns once every fix is in.
async function driveAndTap({ fixes, tapT }, headId) {
  let tapped = false;
  for (const f of fixes) {
    if (!tapped && f.t >= tapT) {
      tapped = true;
      await page.evaluate((t) => window.__setNow(t), tapT);
      await view('capture');
      await page.selectOption('#cap-ix', VT.id);
      await page.waitForTimeout(150);
      await page.selectOption('#cap-head', headId);
      await page.click('#cap-buttons .cap.red');
      await page.waitForTimeout(150);
    }
    await page.evaluate((fix) => { window.__setNow(fix.t); window.__pushFix(fix); }, f);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(1200); // debounce of the suggestion pass
}
const tapsInStore = () => db(async (d) => ({ obs: (await d.allObservations()).filter((o) => o.headId), tombs: await d.allTombstones(), tracks: await d.allTracks(), dis: await d.allDismissals(), exp: await d.exportAll() }));
const badge = async () => (await page.$('#analyze-badge')) ? (await page.textContent('#analyze-badge')).trim() : null;

let ok = false;
try {
  await boot();
  const shot = (n) => page.screenshot({ path: `${outDir}/suggest-${engine}-${n}.png` });

  // ---- 1+2: wrong head (Straight) while turning off to Terraple N -> suggestion -> Accept ----
  await driveAndTap(drives(7, 0), H.straight);
  let s = await tapsInStore();
  check('the tap was stored under Straight right away', s.obs.length === 1 && s.obs[0].headId === H.straight && s.obs[0].aspect === 'red', JSON.stringify(s.obs.map((o) => [o.id, o.headId])));
  const oldId = s.obs[0].id;
  check('a track record was saved for it (keyed by the tap)', s.tracks.length === 1 && s.tracks[0].obsIds.includes(oldId) && s.tracks[0].id === `trk_${oldId}`, `${s.tracks.length} track(s), ${JSON.stringify(s.tracks[0] ?? {}).length} bytes`);
  check('the Analyze tab shows a badge with 1', (await badge()) === '1', `badge=${await badge()}`);
  await view('analyze'); await page.waitForSelector('#suggestions', { timeout: 5000 }).catch(() => {});
  const card = (await page.$('#suggestions')) ? await page.innerText('#suggestions') : '';
  await shot('1-suggestion');
  check('the card lists colour, from -> to light and why', /· red/.test(card) && /Verdaguer N Straight/.test(card) && /Verdaguer N Left/.test(card) && /you came from Verdaguer N and turned right/i.test(card), card.replace(/\s+/g, ' ').slice(170, 420));
  check('nothing moved before the user chose', (await tapsInStore()).obs[0].id === oldId);
  await page.click('[data-sug="accept"]'); await page.waitForTimeout(800);
  s = await tapsInStore();
  const nu = s.obs.find((o) => o.id === `${oldId}_rf`);
  check('Accept: the store has the new observation on the Left head', nu && nu.headId === H.left && nu.intersectionId === VT.id && nu.t === s.obs[0].t, JSON.stringify(nu && [nu.id, nu.headId, nu.refiledFrom]));
  check('Accept: the old id is gone and tombstoned (kind obs)', !s.obs.some((o) => o.id === oldId) && s.tombs.some((t) => t.id === oldId && t.kind === 'obs'));
  check('Accept: the exported (synced) bundle carries the tombstone and the new tap, not the dead track', s.exp.tombstones.some((t) => t.id === oldId) && s.exp.observations.some((o) => o.id === `${oldId}_rf`) && s.exp.tracks.length === 0);
  check('Accept: card and badge are gone', (await badge()) === null && !(await page.$('#suggestions')));
  await shot('2-accepted');

  // ---- 3: wrong again, Dismiss ----
  await view('live');
  await driveAndTap(drives(8, 1), H.straight);
  s = await tapsInStore();
  const second = s.obs.find((o) => o.id !== `${oldId}_rf`);
  check('a second wrong tap is suggested too', (await badge()) === '1' && second?.headId === H.straight, `badge=${await badge()}`);
  await view('analyze');
  await page.click('[data-sug="dismiss"]'); await page.waitForTimeout(600);
  s = await tapsInStore();
  check('Dismiss: a dismissal is stored, the tap stays under Straight, nothing tombstoned for it', s.dis.length === 1 && s.dis[0].obsId === second.id && s.obs.some((o) => o.id === second.id && o.headId === H.straight) && !s.tombs.some((t) => t.id === second.id));
  check('Dismiss: the badge is gone', (await badge()) === null);
  await page.reload(); await page.waitForTimeout(3500);
  check('after a reload the dismissed suggestion does not come back', (await badge()) === null);
  check('the dismissal is part of the synced bundle', (await tapsInStore()).exp.dismissals.some((d) => d.obsId === second.id));

  // ---- 4: a correct tap makes no suggestion ----
  await view('live');
  await driveAndTap(drives(9, 2), H.left);
  check('a correct tap (Left, turning to Terraple N) makes no suggestion', (await badge()) === null && (await tapsInStore()).tracks.length === 3);
  check('no page errors', problems.length === 0, problems.join(' | '));
  ok = checks.every(([, v]) => v);
} catch (e) { console.log('E2E ERROR', e.stack ?? e.message); await page.screenshot({ path: `${outDir}/suggest-${engine}-error.png` }).catch(() => {}); }
finally { await browser.close(); server?.close(); }
console.log(ok ? `PASS ${engine} (${checks.length} checks)` : `FAIL ${engine}: ${checks.filter(([, v]) => !v).map(([n]) => n).join('; ') || 'error above'}`);
process.exit(ok ? 0 : 1);
