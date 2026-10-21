// End-to-end layout check for Live's car layout (borderless map + rail) and that the phone layout / other tabs are untouched.
//   node tools/e2e-layout.mjs <app-url> <intersections.json> [outDir] [prefix] [chromium|webkit]
// Seeds the intersections plus a fake tap history (so there is a countdown), replaces navigator.geolocation with a scripted
// fix 40 m before the junction Pont (41.414314, 2.012107), then
//   - car viewports, all with the Tesla browser's measured devicePixelRatio where known:
//       773x601 @1.53   collapsed window, the only size usable while driving (primary target)
//       1256x706 @1.53  expanded window, parked only
//       1280x800, 1920x1200 @1   big screens
//     Live -> <outDir>/<prefix>layout-car-<w>.png, and checks the rail: no scrolling, everything on screen, all tabs fully
//     visible, at least one Coming-up row visible, tap buttons >= 44 px tall, text >= 18 px (tab labels >= 16 px), map flush
//     and sharp (canvas backing store = css size x DPR). The same checks repeat with the "GPS blocked" note showing
//     (-> <prefix>layout-car-<w>-gps.png) and with the update banner (-> <prefix>layout-car-<w>-banner.png);
//   - Live -> Capture -> Live: tabs / GPS note / countdown go back to the topbar and the map and return; Capture at 1920 ->
//     <prefix>layout-capture-1920.png;
//   - 773x601: every tab (Live, Capture, Edit, Analyze, Sync) -> <prefix>layout-tab-773-<tab>.png; each must have all tabs on
//     screen, no horizontal overflow and nothing hanging off the right edge (vertical scrolling is fine off Live);
//   - a 390x844 phone: Live -> <prefix>layout-phone.png.
// Prints BAD lines and exits non-zero on a problem or a console error. Run like e2e-drive.mjs (Playwright container, NODE_PATH
// for playwright, app served over http); /ix.json is private data and never committed.
import { createRequire } from 'node:module';
import fs from 'node:fs';

const [url, ixFile, outDir = '/tmp', prefix = '', engine = 'chromium'] = process.argv.slice(2);
if (!url || !ixFile) { console.error('usage: e2e-layout.mjs <app-url> <intersections.json> [outDir] [prefix] [chromium|webkit]'); process.exit(2); }
const pw = createRequire(import.meta.url)('playwright');
const base = new URL('.', url.endsWith('/') ? url : `${url}/`).href;
const ixs = JSON.parse(fs.readFileSync(ixFile, 'utf8'));
const PONT = { lat: 41.414314, lon: 2.012107 }, HEADING = 335, SPEED = 10;
// osm2streets logs via console.error; the OSM/Overpass fetches fail in the sandbox (CORS / no network) and the extra fake junctions can break the wasm
const WASM_NOISE = /^(Hack!|Road #|Not collapsing|Found \d+ nodes|Ignoring country|panicked|capacity overflow|Failed to load resource|Access to fetch)/;
const bad = [];
const check = (ok, msg) => { if (!ok) { bad.push(msg); console.log('BAD', msg); } };

const browser = await pw[engine].launch();
fs.mkdirSync(outDir, { recursive: true });

// tap history per light: [seconds into the 90 s cycle, colour]. FULL = every phase known; the others know less.
const FULL = [[0, 'green'], [35, 'amber'], [38, 'red']], PHASED = [[0, 'green'], [20, 'amber'], [60, 'red']], GREEN_RED = [[0, 'green'], [38, 'red']], GREEN_ONLY = [[0, 'green']];

async function open(viewport, extra = {}, history = FULL) {
  let seedNow;
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
  page.on('pageerror', (e) => { if (!/due to access control checks/.test(e.message)) check(false, `${label}: pageerror ${e.message}`); }); // WebKit's wording of the blocked Overpass fetch
  await page.goto(base); await page.waitForTimeout(2500);
  // intersections + a 90 s cycle (green, amber at +35, red at +38) over the last 30 min for every light, so the model has a countdown
  await page.evaluate(async ([b, ixList, hist]) => {
    let list = ixList, seedNow;
    const db = await import(`${b}src/store/db.js`);
    const extra = [1, 2, 3, 4].map((k) => ({ ...list[0], id: `${list[0].id}_x${k}`, name: `${list[0].name} + ${k * 150} m ahead`, location: { lat: list[0].location.lat + k * 0.0012, lon: list[0].location.lon - k * 0.0006 } }));
    list = [...list, ...extra];
    for (const ix of list) await db.putIntersection(ix);
    const now = Date.now(); let n = 0; seedNow = now;
    for (const ix of list) for (const h of new Set((ix.movements ?? []).map((m) => m.headId).filter(Boolean))) {
      for (let k = 20; k >= 1; k--) for (const [dt, aspect] of hist)
        await db.addObservation({ id: `seed_${n++}`, intersectionId: ix.id, headId: h, aspect, kind: 'onset', t: now - k * 90000 + dt * 1000 });
    }
    return seedNow;
  }, [base, ixs, history]).then((t) => { seedNow = t; });
  await page.reload(); await page.waitForTimeout(1500);
  await page.evaluate(() => window.__push(-40));
  for (let i = 0; i < 25; i++) { // best effort: wait for the street geometry
    if (await page.evaluate(async (b) => (await (await import(`${b}src/store/db.js`)).allStreets()).some((e) => e.kind === 'lanes'), base)) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(3000); // model recompute + a few frames
  return { ctx, page, label, seedNow };
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
  // Coming up rows that are entirely inside both their list and the screen
  const ur = up.getBoundingClientRect();
  out.rowsShown = [...document.querySelectorAll('#upcoming-list .row')].filter((el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= ur.top - 1 && r.bottom <= ur.bottom + 1 && r.bottom <= innerHeight + 1; }).length;
  out.rail = { sh: side.scrollHeight, ch: side.clientHeight, rect: rect(side), ovf: getComputedStyle(side).overflowY };
  const caps = [...document.querySelectorAll('#active-head .cap')].map(rect);
  out.capsBottom = caps.length ? Math.max(...caps.map((c) => c.b)) : null;
  out.capHeights = [...caps.map((c) => c.h), ...(document.querySelector('[data-act="undo"]') ? [rect(document.querySelector('[data-act="undo"]')).h] : [])];
  out.undoRect = document.querySelector('[data-act="undo"]') ? rect(document.querySelector('[data-act="undo"]')) : null;
  out.tabs = [...document.querySelectorAll('.tabs button')].map((b) => ({ id: b.id, vis: vis(b), ...rect(b), clipped: b.scrollWidth > b.clientWidth + 1, font: parseFloat(getComputedStyle(b).fontSize) }));
  out.gpsText = $('gps-sub').textContent;
  out.countText = $('count').textContent; out.countFont = getComputedStyle($('count')).fontSize; out.countAspect = $('count').dataset.aspect ?? '';
  const ind = $('ind-label'), il = parseFloat(getComputedStyle(ind).lineHeight) || parseFloat(getComputedStyle(ind).fontSize) * 1.2;
  out.ind = { text: ind.textContent, num: $('count-num').textContent, lines: Math.round(ind.getBoundingClientRect().height / il), clipped: ind.scrollWidth > ind.clientWidth + 1 };
  out.cardBorder =getComputedStyle(document.querySelector('.scene-hud')).borderLeftColor;
  // text smaller than 18 px inside the rail (what is read while driving); the tab labels (navigation, a deliberate tap) are checked on their own
  out.small = [...side.querySelectorAll('*')].filter((el) => !el.closest('.tabs') && vis(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 18)
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${el.className}=${getComputedStyle(el).fontSize}`);
  // anything poking out past the right edge, and horizontal scroll of the page (outside the Leaflet map, which clips itself)
  out.hscroll = document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1 || $('view-live').closest('main').scrollWidth > $('view-live').closest('main').clientWidth + 1;
  out.offRight = [...document.querySelectorAll('body *')].filter((el) => vis(el) && !el.closest('.leaflet-container, [hidden], .update-banner, details:not([open])') && el.getBoundingClientRect().right > innerWidth + 1)
    .slice(0, 5).map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className).slice(0, 30)} r=${Math.round(el.getBoundingClientRect().right)}`);
  return out;
});

// The countdown label: with every phase tapped it counts to the next phase change (<Cur> now · <next> in, the number no
// bigger than that phase's distance in the seeded 0/35/38 s cycle), with green + red only to the other colour, with green
// only to the next green. On one line, not clipped.
const NEXT_MAX = { Green: ['amber', 35], Amber: ['red', 3], Red: ['green', 52] }; // + a little slack for the tick
function labelChecks(label, p, kind) {
  const { text, num, lines, clipped } = p.ind, m = /^(Green|Amber|Red) now · (green|amber|red) in$/.exec(text), n = Number(num);
  check(lines <= 1 && !clipped, `${label}: countdown label "${text}" wraps/clipped (${lines} lines)`);
  check(Number.isFinite(n) && n >= 0 && n <= 90, `${label}: countdown number "${num}"`);
  if (kind === 'phased') { /* checked by the caller against the exact colour */ } else if (kind === 'full') {
    check(m && NEXT_MAX[m[1]][0] === m[2] && n <= NEXT_MAX[m[1]][1] + 2, `${label}: full-cycle label "${text} ${num}" is not <Cur> now · <successor> in <= ${m ? NEXT_MAX[m[1]][1] : '?'}`);
  } else if (kind === 'green-red') {
    check(m && ((m[1] === 'Green' && m[2] === 'red') || (m[1] === 'Red' && m[2] === 'green')), `${label}: green+red label "${text}" should name the other colour (no amber)`);
  } else check(text === 'Green in', `${label}: green-only label "${text}" should stay "green in"`);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// the rail checks shared by the plain and the "GPS note" states of a car viewport
function railChecks(label, p, h, tag) {
  check(p.rail.sh <= p.rail.ch + 1, `${label}${tag}: rail scrolls (${p.rail.sh} > ${p.rail.ch})`);
  check(p.rowsShown >= 1, `${label}${tag}: no Coming up row fully visible (${p.rowsShown} of ${p.counts.rows})`);
  check(p.capsBottom != null && p.undoRect && p.undoRect.b <= h + 1 && p.capsBottom <= h + 1, `${label}${tag}: tap buttons off screen`);
  check(p.capHeights.length === 6 && p.capHeights.every((x) => x >= 44), `${label}${tag}: tap buttons / undo under 44 px: ${p.capHeights.map(Math.round)}`);
  check(p.tabs.filter((t) => t.vis).length === 4 && p.tabs.filter((t) => t.vis).every((t) => t.x >= 0 && t.r <= p.vw + 0.5 && t.y >= 0 && t.b <= h && !t.clipped), `${label}${tag}: a tab is cut off ${JSON.stringify(p.tabs.map((t) => [t.id, Math.round(t.x), Math.round(t.r), t.clipped]))}`);
  check(p.tabs.every((t) => !t.vis || t.font >= 16), `${label}${tag}: tab text under 16 px`);
  check(!p.hscroll && !p.offRight.length, `${label}${tag}: horizontal overflow ${p.offRight.join(' ')}`);
}

// ---------- car ----------
for (const [w, h, dsf] of [[773, 601, 1.53], [1256, 706, 1.53], [1280, 800, 1], [1920, 1200, 1]]) {
  const { ctx, page, label } = await open({ width: w, height: h }, { deviceScaleFactor: dsf });
  let p = await probe(page);
  console.log(label, 'live', JSON.stringify({ car: p.carClass, canvas: p.canvas, rail: p.rail, count: p.countText, font: p.countFont, aspect: p.countAspect, card: p.cardBorder, capsBottom: p.capsBottom, rows: p.counts.rows, rowsShown: p.rowsShown }));
  const mapShare = h <= 650 ? 0.6 : 2 / 3; // compact car screens give the rail 40%
  check(p.carClass, `${label}: body.live-car not set`);
  check(!p.tabLiveVisible, `${label}: Live tab visible while Live is selected`);
  check(p.tabsParent === 'live-side' && p.hudParent === 'live-side', `${label}: tabs/countdown not in the rail (${p.tabsParent}, ${p.hudParent})`);
  check(p.canvas.x === 0 && p.canvas.y === 0 && Math.abs(p.canvas.h - h) < 1 && Math.abs(p.canvas.w - w * mapShare) < 1.5, `${label}: map not flush / ${mapShare.toFixed(2)}: ${JSON.stringify(p.canvas)}`);
  check(p.canvas.radius === '0px' && p.canvas.border === '0px', `${label}: map has radius/border`);
  check(Math.abs(p.canvas.dpr - dsf) < 0.01, `${label}: devicePixelRatio ${p.canvas.dpr} != ${dsf}`);
  check(p.canvas.bw === Math.round(p.canvas.w * p.canvas.dpr) && p.canvas.bh === Math.round(p.canvas.h * p.canvas.dpr), `${label}: canvas backing store ${p.canvas.bw}x${p.canvas.bh} != css x dpr`);
  railChecks(label, p, h, '');
  labelChecks(label, p, 'full');
  for (const id of ['ix-name', 'ind-label', 'count', 'count-cap', 'upcoming-list']) check(p.ids[id].n === 1 && p.ids[id].vis, `${label}: #${id} missing/hidden (${JSON.stringify(p.ids[id])})`);
  check(p.ids.meta.n === 1, `${label}: #meta missing`);
  check(p.counts.cap === 5 && p.counts.undo === 1 && p.counts.ah === 1 && p.counts.hint === 1 && p.counts.rows > 0, `${label}: tap panel/upcoming incomplete ${JSON.stringify(p.counts)}`);
  check(!p.small.length, `${label}: text under 18 px: ${p.small.join(' ')}`);
  check(parseFloat(p.countFont) >= (h <= 650 ? 72 : 88), `${label}: countdown only ${p.countFont}`);
  await page.screenshot({ path: `${outDir}/${prefix}layout-car-${w}.png` });

  // GPS note: shown in the rail when there is one, and everything above still fits
  await page.evaluate(() => { document.getElementById('gps-sub').textContent = 'GPS blocked — pick manually'; });
  await page.waitForTimeout(300);
  const g = await probe(page);
  const gr = await page.evaluate(() => { const r = document.getElementById('gps-sub').getBoundingClientRect(); const rl = document.querySelector('.live-side'); return { vis: r.height > 0, inside: r.right <= innerWidth && r.left >= rl.getBoundingClientRect().left, wraps: r.height > parseFloat(getComputedStyle(document.getElementById('gps-sub')).fontSize) * 1.6 }; });
  check(gr.vis && gr.inside, `${label}: GPS note not visible in the rail`);
  console.log(label, 'with GPS note: rail', g.rail.sh, '/', g.rail.ch, 'rows shown', g.rowsShown, 'wraps', gr.wraps);
  railChecks(label, g, h, ' (GPS note)');
  check(!g.small.length, `${label} (GPS note): text under 18 px: ${g.small.join(' ')}`);
  await page.screenshot({ path: `${outDir}/${prefix}layout-car-${w}-gps.png` });
  await page.evaluate(() => { document.getElementById('gps-sub').textContent = ''; });

  // update banner overlays the top of the rail
  await page.evaluate(() => { document.getElementById('update-banner').hidden = false; });
  const ub = await page.evaluate(() => { const r = document.getElementById('update-banner').getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom }; });
  check(ub.x >= w * mapShare - 1 && ub.y < 40 && ub.r <= w + 0.5, `${label}: update banner not over the rail top ${JSON.stringify(ub)}`);
  await page.screenshot({ path: `${outDir}/${prefix}layout-car-${w}-banner.png` });
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

  // every tab at the driving size: all five tabs reachable, nothing hanging off the right edge, no sideways scrolling
  if (w === 773) {
    for (const t of ['live', 'capture', 'edit', 'analyze', 'sync']) {
      if (t !== 'live') { await page.click(`#tab-${t}`); await page.waitForTimeout(t === 'edit' ? 1500 : 700); } // Live is showing, its tab is hidden in the car layout
      const r = await probe(page);
      const tg = `${label} tab ${t}`;
      if (t === 'live') { check(r.carClass, `${tg}: not the car layout`); railChecks(label, r, h, ` (tab ${t})`); }
      else {
        const vt = r.tabs.filter((x) => x.vis);
        check(!r.carClass && vt.length === 5 && vt.every((x) => x.x >= 0 && x.r <= r.vw + 0.5 && x.b <= h && !x.clipped), `${tg}: tabs cut off ${JSON.stringify(r.tabs.map((x) => [x.id, x.vis, Math.round(x.x), Math.round(x.r), x.clipped]))}`);
        check(!r.hscroll && !r.offRight.length, `${tg}: horizontal overflow ${r.offRight.join(' ')}`);
      }
      await page.screenshot({ path: `${outDir}/${prefix}layout-tab-773-${t}.png` });
    }
  }
  await ctx.close();
}

// ---------- countdown target by what is known (773x601: the longest label must still fit one line) ----------
for (const [kind, history] of [['full', FULL], ['green-red', GREEN_RED], ['green-only', GREEN_ONLY]]) {
  const { ctx, page, label } = await open({ width: 773, height: 601 }, { deviceScaleFactor: 1.53 }, history);
  const p = await probe(page);
  console.log(label, 'countdown', kind, JSON.stringify(p.ind), 'aspect', p.countAspect);
  labelChecks(`${label} ${kind}`, p, kind);
  railChecks(`${label} ${kind}`, p, 601, '');
  await page.screenshot({ path: `${outDir}/${prefix}nextchange-773-${kind}.png` });
  await ctx.close();
}
// every colour of the cycle on screen, with a 20 s green, 40 s amber, 30 s red cycle (a number below the green-in one):
// the page clock is skewed (kept across a reload so the amber/red guard starts fresh) to land mid-phase at probe time
for (const [phase, cur, next, max] of [[8, 'Green', 'amber', 20], [40, 'Amber', 'red', 40], [75, 'Red', 'green', 30]]) {
  const { ctx, page, label, seedNow } = await open({ width: 773, height: 601 }, { deviceScaleFactor: 1.53 }, PHASED);
  await ctx.addInitScript(() => { const s = Number(localStorage.getItem('__skew') || 0); if (s) { const R = Date.now.bind(Date); Date.now = () => R() + s * 1000; } });
  await page.evaluate(([sn, ph]) => localStorage.setItem('__skew', String((((ph - 4.5 - (Date.now() - sn) / 1000) % 90) + 90) % 90)), [seedNow, phase]);
  await page.reload(); await page.waitForTimeout(1500);
  await page.evaluate(() => window.__push(-40)); await page.waitForTimeout(1500);
  const p = await probe(page);
  console.log(label, 'countdown phase', cur, JSON.stringify(p.ind), 'aspect', p.countAspect);
  check(p.ind.text === `${cur} now · ${next} in` && Number(p.ind.num) <= max + 2 && p.countAspect === cur.toLowerCase(), `${label}: at ${cur} expected "${cur} now · ${next} in" <= ${max}, got "${p.ind.text}" ${p.ind.num} (${p.countAspect})`);
  labelChecks(`${label} ${cur}`, p, 'phased');
  if (cur === 'Amber') await page.screenshot({ path: `${outDir}/${prefix}nextchange-773.png` });
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
console.log(bad.length ? `FAIL (${bad.length})` : `PASS layout (${engine})`);
process.exit(bad.length ? 1 : 0);
