// End-to-end layout check for Live's car layout (borderless map + rail) and that the phone layout / other tabs are untouched.
//   node tools/e2e-layout.mjs <app-url> <intersections.json> [outDir] [prefix]
// Seeds the intersections plus a fake tap history (so there is a countdown), replaces navigator.geolocation with a scripted
// fix 40 m before the junction Pont (41.414314, 2.012107), then
//   - car viewports 1920x1200 and 1280x800: Live -> <outDir>/<prefix>layout-car-<w>.png, and checks the rail (no scrolling,
//     everything on screen, text >= 18 px, map flush and sharp);
//   - Live -> Capture -> Live: tabs / GPS note / countdown go back to the topbar and the map and return; Capture at 1920 ->
//     <prefix>layout-capture-1920.png;
//   - a 390x844 phone: Live -> <prefix>layout-phone.png.
// Prints BAD lines and exits non-zero on a problem or a console error. Run like e2e-drive.mjs (Playwright container, NODE_PATH
// for playwright, app served over http); /ix.json is private data and never committed.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const [url, ixFile, outDir = '/tmp', prefix = ''] = process.argv.slice(2);
if (!url || !ixFile) { console.error('usage: e2e-layout.mjs <app-url> <intersections.json> [outDir] [prefix]'); process.exit(2); }
const pw = createRequire(import.meta.url)('playwright');
const base = new URL('.', url.endsWith('/') ? url : `${url}/`).href;
const ixs = JSON.parse(fs.readFileSync(ixFile, 'utf8'));
const PONT = { lat: 41.414314, lon: 2.012107 }, HEADING = 335, SPEED = 10;
// osm2streets logs via console.error; the OSM/Overpass fetches fail in the sandbox (CORS / no network) and the extra fake junctions can break the wasm
const WASM_NOISE = /^(Hack!|Road #|Not collapsing|Found \d+ nodes|Ignoring country|panicked|capacity overflow|Failed to load resource|Access to fetch)/;
const bad = [];
const check = (ok, msg) => { if (!ok) { bad.push(msg); console.log('BAD', msg); } };

const browser = await pw.chromium.launch();
fs.mkdirSync(outDir, { recursive: true });

async function open(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, geolocation: { latitude: PONT.lat, longitude: PONT.lon }, permissions: ['geolocation'], ...extra });
  await ctx.addInitScript(({ P, HEADING, SPEED }) => {
    const cbs = []; let last = null;
    const r = Math.PI / 180;
    const fix = (d) => ({ coords: { latitude: P.lat + (d * Math.cos(HEADING * r)) / 111320, longitude: P.lon + (d * Math.sin(HEADING * r)) / (111320 * Math.cos(P.lat * r)), heading: HEADING, speed: SPEED, accuracy: 5, altitude: null, altitudeAccuracy: null }, timestamp: Date.now() });
    Object.defineProperty(navigator, 'geolocation', { value: { watchPosition: (ok) => { cbs.push(ok); if (last) ok(last); return cbs.length; }, getCurrentPosition: (ok) => { if (last) ok(last); }, clearWatch: () => {} }, configurable: true });
    window.__push = (d) => { last = fix(d); cbs.forEach((cb) => cb(last)); };
  }, { P: PONT, HEADING, SPEED });
  const page = await ctx.newPage();
  const label = `${viewport.width}x${viewport.height}`;
  page.on('console', (m) => { if (m.type() === 'error' && !WASM_NOISE.test(m.text())) check(false, `${label}: console.error ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => check(false, `${label}: pageerror ${e.message}`));
  await page.goto(base); await page.waitForTimeout(2500);
  // intersections + a 90 s cycle (green, amber at +35, red at +38) over the last 30 min for every light, so the model has a countdown
  await page.evaluate(async ([b, ixList]) => {
    let list = ixList;
    const db = await import(`${b}src/store/db.js`);
    const extra = [1, 2, 3, 4].map((k) => ({ ...list[0], id: `${list[0].id}_x${k}`, name: `${list[0].name} + ${k * 150} m ahead`, location: { lat: list[0].location.lat + k * 0.0012, lon: list[0].location.lon - k * 0.0006 } }));
    list = [...list, ...extra];
    for (const ix of list) await db.putIntersection(ix);
    const now = Date.now(); let n = 0;
    for (const ix of list) for (const h of new Set((ix.movements ?? []).map((m) => m.headId).filter(Boolean))) {
      for (let k = 20; k >= 1; k--) for (const [dt, aspect] of [[0, 'green'], [35, 'amber'], [38, 'red']])
        await db.addObservation({ id: `seed_${n++}`, intersectionId: ix.id, headId: h, aspect, kind: 'onset', t: now - k * 90000 + dt * 1000 });
    }
  }, [base, ixs]);
  await page.reload(); await page.waitForTimeout(1500);
  await page.evaluate(() => window.__push(-40));
  for (let i = 0; i < 25; i++) { // best effort: wait for the street geometry
    if (await page.evaluate(async (b) => (await (await import(`${b}src/store/db.js`)).allStreets()).some((e) => e.kind === 'lanes'), base)) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(3000); // model recompute + a few frames
  return { ctx, page, label };
}

// where the topbar-only things live, whether every Live element is on screen, text sizes, canvas sharpness
const probe = (page) => page.evaluate(() => {
  const $ = (id) => document.getElementById(id);
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right }; };
  const live = $('view-live').classList.contains('active');
  const out = { live, carClass: document.body.classList.contains('live-car'), vw: innerWidth, vh: innerHeight };
  out.tabsParent = document.querySelector('.tabs').parentElement.className;
  out.gpsParent = $('gps-sub').parentElement.className;
  out.hudParent = document.querySelector('.scene-hud').parentElement.className;
  out.tabLiveVisible = vis($('tab-live'));
  out.ids = {};
  for (const id of ['ix-name', 'meta', 'ind-label', 'count', 'count-cap', 'upcoming-list', 'live-hint', 'live-scene', 'active-head']) out.ids[id] = { n: document.querySelectorAll(`#${id}`).length, vis: vis($(id)), rect: rect($(id)) };
  out.counts = { tabs: document.querySelectorAll('.tabs').length, gps: document.querySelectorAll('#gps-sub').length, hud: document.querySelectorAll('.scene-hud').length, cap: document.querySelectorAll('#active-head .cap').length, undo: document.querySelectorAll('[data-act="undo"]').length, rows: document.querySelectorAll('#upcoming-list .row').length, ah: document.querySelectorAll('.ah-name').length, hint: document.querySelectorAll('#active-head .tap-hint').length };
  const canvas = $('live-scene'), cr = canvas.getBoundingClientRect();
  out.canvas = { x: cr.left, y: cr.top, w: cr.width, h: cr.height, bw: canvas.width, bh: canvas.height, dpr: devicePixelRatio, radius: getComputedStyle(canvas).borderRadius, border: getComputedStyle(canvas).borderTopWidth };
  const side = document.querySelector('.live-side');
  const up = document.querySelector('.upcoming');
  out.upcoming = { sh: up.scrollHeight, ch: up.clientHeight };
  out.rail = { sh: side.scrollHeight, ch: side.clientHeight, rect: rect(side), ovf: getComputedStyle(side).overflowY };
  const caps = [...document.querySelectorAll('#active-head .cap')].map(rect);
  out.capsBottom = caps.length ? Math.max(...caps.map((c) => c.b)) : null;
  out.undoRect = document.querySelector('[data-act="undo"]') ? rect(document.querySelector('[data-act="undo"]')) : null;
  out.tabs = [...document.querySelectorAll('.tabs button')].map((b) => ({ id: b.id, vis: vis(b) }));
  out.gpsText = $('gps-sub').textContent;
  out.countText = $('count').textContent; out.countFont = getComputedStyle($('count')).fontSize; out.countAspect = $('count').dataset.aspect ?? '';
  out.cardBorder = getComputedStyle(document.querySelector('.scene-hud')).borderLeftColor;
  // text smaller than 18 px inside the rail (what is read while driving)
  out.small = [...side.querySelectorAll('*')].filter((el) => vis(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 18)
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${el.className}=${getComputedStyle(el).fontSize}`);
  return out;
});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- car ----------
for (const [w, h] of [[1920, 1200], [1280, 800]]) {
  const { ctx, page, label } = await open({ width: w, height: h });
  let p = await probe(page);
  console.log(label, 'live', JSON.stringify({ car: p.carClass, canvas: p.canvas, rail: p.rail, count: p.countText, font: p.countFont, aspect: p.countAspect, card: p.cardBorder, capsBottom: p.capsBottom, rows: p.counts.rows }));
  check(p.carClass, `${label}: body.live-car not set`);
  check(!p.tabLiveVisible, `${label}: Live tab visible while Live is selected`);
  check(p.tabsParent === 'live-side' && p.hudParent === 'live-side', `${label}: tabs/countdown not in the rail (${p.tabsParent}, ${p.hudParent})`);
  check(p.canvas.x === 0 && p.canvas.y === 0 && Math.abs(p.canvas.h - h) < 1 && Math.abs(p.canvas.w - w * 2 / 3) < 1.5, `${label}: map not flush / 2/3: ${JSON.stringify(p.canvas)}`);
  check(p.canvas.radius === '0px' && p.canvas.border === '0px', `${label}: map has radius/border`);
  check(p.canvas.bw === Math.round(p.canvas.w * p.canvas.dpr) && p.canvas.bh === Math.round(p.canvas.h * p.canvas.dpr), `${label}: canvas backing store ${p.canvas.bw}x${p.canvas.bh} != css x dpr`);
  check(p.rail.sh <= p.rail.ch + 1, `${label}: rail scrolls (${p.rail.sh} > ${p.rail.ch})`);
  check(p.upcoming.sh <= p.upcoming.ch + 1, `${label}: Coming up is clipped (${p.upcoming.sh} > ${p.upcoming.ch})`);
  check(p.capsBottom != null && p.undoRect && p.undoRect.b <= h && p.capsBottom <= h, `${label}: tap buttons off screen`);
  for (const id of ['ix-name', 'meta', 'ind-label', 'count', 'count-cap', 'upcoming-list']) check(p.ids[id].n === 1 && p.ids[id].vis, `${label}: #${id} missing/hidden (${JSON.stringify(p.ids[id])})`);
  check(p.counts.cap === 5 && p.counts.undo === 1 && p.counts.ah === 1 && p.counts.hint === 1 && p.counts.rows > 0, `${label}: tap panel/upcoming incomplete ${JSON.stringify(p.counts)}`);
  check(!p.small.length, `${label}: text under 18 px: ${p.small.join(' ')}`);
  check(parseFloat(p.countFont) >= 88, `${label}: countdown only ${p.countFont}`);
  check(p.tabs.filter((t) => t.vis).length === 4, `${label}: expected 4 visible tabs`);
  await page.screenshot({ path: `${outDir}/${prefix}layout-car-${w}.png` });

  // GPS note: shown in the rail when there is one
  await page.evaluate(() => { document.getElementById('gps-sub').textContent = 'GPS blocked — pick manually'; });
  const g = await page.evaluate(() => { const r = document.getElementById('gps-sub').getBoundingClientRect(); const rl = document.querySelector('.live-side'); return { vis: r.height > 0, inside: r.right <= innerWidth && r.left >= rl.getBoundingClientRect().left, sh: rl.scrollHeight, ch: rl.clientHeight }; });
  check(g.vis && g.inside, `${label}: GPS note not visible in the rail`);
  console.log(label, 'with GPS note: rail', g.sh, '/', g.ch);
  if (w === 1280) await page.screenshot({ path: `${outDir}/${prefix}layout-car-${w}-gps.png` });
  await page.evaluate(() => { document.getElementById('gps-sub').textContent = ''; });

  // update banner overlays the top of the rail
  await page.evaluate(() => { document.getElementById('update-banner').hidden = false; });
  const ub = await page.evaluate(() => { const r = document.getElementById('update-banner').getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom }; });
  check(ub.x >= w * 2 / 3 && ub.y < 40 && ub.r <= w, `${label}: update banner not over the rail top ${JSON.stringify(ub)}`);
  if (w === 1280) await page.screenshot({ path: `${outDir}/${prefix}layout-car-${w}-banner.png` });
  await page.evaluate(() => { document.getElementById('update-banner').hidden = true; });

  // Live -> Capture -> Live restores everything
  if (w === 1920) {
    await page.click('#tab-capture'); await page.waitForTimeout(800);
    p = await probe(page);
    check(!p.carClass && p.tabsParent === 'topbar' && p.gpsParent === 'topbar' && p.hudParent === 'scene-wrap', `${label}: capture did not restore (${p.carClass} ${p.tabsParent} ${p.gpsParent} ${p.hudParent})`);
    check(p.tabLiveVisible && p.tabs.filter((t) => t.vis).length === 5, `${label}: Live tab not back on Capture`);
    await page.screenshot({ path: `${outDir}/${prefix}layout-capture-1920.png` });
    await page.click('#tab-live'); await page.waitForTimeout(1500);
    const q = await probe(page);
    check(q.carClass && q.tabsParent === 'live-side' && q.hudParent === 'live-side' && !q.tabLiveVisible, `${label}: Live did not come back`);
    check(same(q.canvas, p.canvas) === false && q.canvas.w > 1000 && q.canvas.bw === Math.round(q.canvas.w * q.canvas.dpr), `${label}: canvas after round trip ${JSON.stringify(q.canvas)}`);
    check(q.counts.cap === 5 && q.counts.tabs === 1 && q.counts.hud === 1 && q.counts.gps === 1, `${label}: duplicates after round trip ${JSON.stringify(q.counts)}`);
    // every other tab keeps the topbar
    for (const t of ['edit', 'analyze', 'sync']) { await page.click(`#tab-${t}`); await page.waitForTimeout(300); const r = await probe(page); check(!r.carClass && r.tabLiveVisible, `${label}: ${t} tab in live-car mode`); }
    await page.click('#tab-live'); await page.waitForTimeout(500);
    // rotation / resize: portrait -> phone layout, back -> car
    await page.setViewportSize({ width: 800, height: 1200 }); await page.waitForTimeout(800);
    r2: { const r = await probe(page); check(!r.carClass && r.tabsParent === 'topbar' && r.hudParent === 'scene-wrap', `${label}: portrait did not restore the phone layout`); }
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(1200);
    const r3 = await probe(page);
    check(r3.carClass && r3.canvas.w > 1000 && r3.canvas.bw === Math.round(r3.canvas.w * r3.canvas.dpr), `${label}: landscape again did not restore car layout`);
  }
  await ctx.close();
}

// ---------- phone ----------
{
  const { ctx, page, label } = await open({ width: 390, height: 844 }, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await probe(page);
  check(!p.carClass && p.tabsParent === 'topbar' && p.hudParent === 'scene-wrap' && p.tabLiveVisible, `${label}: phone layout changed`);
  await page.screenshot({ path: `${outDir}/${prefix}layout-phone.png` });
  await ctx.close();
}

await browser.close();
console.log(bad.length ? `FAIL (${bad.length})` : 'PASS layout');
process.exit(bad.length ? 1 : 0);
