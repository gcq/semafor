// Onda UI controller. Thin glue: it reads the pure core (predict, nav) and the
// store, and paints the DOM on a timer. No framework.

import * as store from '../store/db.js';
import { nextOnset, nextChange, currentAspect, phaseTable, withTap, predictMark } from '../predict/next.js';
import { guardAspect, tapped } from '../predict/sequence.js';
import { deadReckon, turnRate, offsetBetween, decayOffset, easeOffset, applyOffset, easeAngle } from '../nav/motion.js';
import { rankNext, headForApproach, viewBearing, pickIntersection, distanceM } from '../nav/proximity.js';
import { approachCandidates, pickHead, toLocal } from '../osm/approaches.js';
import { snapToLane } from '../osm/lanesnap.js';
import { ALGO_VERSION, computeModel } from '../inference/clock.js';
import { createRecorder } from '../nav/trackrec.js';
import { pendingSuggestions, refileOf } from '../osm/suggest.js';
import { uid, ASPECT_INFO } from '../domain/model.js';
import { headLabel } from '../inference/heads.js';
import { mergeBundles } from '../sync/merge.js';
import { createStreetFeed } from '../osm/lanes-cache.js';
import { fetchOsmXml } from '../osm/lanes.js';
import { computeLanes } from '../osm/lanes-client.js';
import { fetchStreets } from '../osm/streets.js';
import { drawScene } from './live-scene.js';
import { esc, icon, intersectionOptions } from './dom.js';
import { mountEditor, refreshEditor } from './editor.js';
import { mountAnalyze, refreshAnalyze } from './analyze.js';
import { mountSync, autoJoinFromUrl } from './sync.js';


const $ = (id) => document.getElementById(id);
const state = {
  intersections: [],
  ranked: [],
  selectedId: null,        // manual override of "next"
  pos: null,               // {lat, lon}
  heading: null,
  headingFrozen: null,     // last non-null heading (orientation freeze when stopped)
  speed: 0,
  captureHead: null,       // { ixId, id } head being watched in Capture
  captureLog: [],
  sceneHead: null,         // { ixId, id } head made active by tapping its pole
  obs: [],                 // every tap (the clock model is global: corridors span intersections)
  model: null,             // THE model every view uses (a pure function of taps + map; cached, never authoritative)
  modelKey: null,          // cache key of the inputs `model` was computed from (null = withTap'd / stale)
  modelStatus: 'none',     // 'none' | 'uptodate' | 'recomputing'
  lastTaps: {},            // headId -> { t, aspect }: echo of your last tap on a light
  shown: new Map(),        // headId -> { aspect, sinceMs, stepAt? }: the colour the sequence guard shows
  tables: new Map(),       // phaseTable memo: `${ixId}` -> { model, minute, table }
  lastIxId: null,          // to reset the manual head pick when the intersection changes
  headPicks: new Map(),    // ixId -> pickHead state (approach you're on, see src/osm/approaches.js); per junction so Live flipping between two close ones loses nothing
  passedIxId: null,        // the junction whose stop line you crossed last: Live moves on to another one ahead, else keeps showing this
  lastObs: null,           // { id, ixId } for undo
  sceneBoxes: [],          // canvas hit boxes from the last draw
  tracks: [],              // GPS tracks around taps (synced records, src/nav/trackrec.js)
  dismissals: [],          // suggested re-files the user declined (synced)
  suggestions: [],         // pending re-file suggestions, recomputed from taps + tracks + map + streets (never stored)
  suggestCache: new Map(), // tap id -> suggestion|null; cleared when the map or the streets change
};

// Every tap opens (or joins) a pending GPS track so Analyze can check afterwards, from the road you came in on and the
// one you left on, that the tap went to the right light. The tap itself is stored first and never waits for any of this.
const trackRec = createRecorder({
  junctions: () => state.intersections.filter((ix) => Number.isFinite(ix.location?.lat)).map((ix) => ({ id: ix.id, ...ix.location })),
  onDone: (rec) => {
    store.putTrack(rec).catch((e) => console.error('track save failed', e));
    state.tracks = [...state.tracks.filter((r) => r.id !== rec.id), rec];
    scheduleSuggest();
  },
});

// Street geometry for the Live scene: derived, cached on-device, built in the
// background (OSM API -> osm2streets lanes, plain lines as fallback; retried while
// the app is open). Never blocks boot or render; with nothing cached yet Live
// draws without streets and shows a small status note.
const streetFeed = createStreetFeed({
  loadAll: store.allStreets, save: store.putStreets, remove: store.deleteStreets,
  fetchXml: fetchOsmXml, computeLanes, fetchPlain: fetchStreets,
});
const streetStatusOf = (ixId) => {
  const st = streetFeed.status(ixId);
  return st === 'ready' || st === null ? null : navigator.onLine === false ? 'offline' : st;
};
const refreshStreets = () => streetFeed.check(state.intersections).catch((e) => console.log('[streets]', e?.message ?? e));

// ---------- boot ----------
(async function boot() {
  // Ask the browser not to evict our IndexedDB under storage pressure (Safari
  // otherwise may wipe a site's data) — the real way taps get lost, not sync.
  navigator.storage?.persist?.().catch(() => {});
  state.intersections = await store.allIntersections();
  state.obs = await store.allObservations();
  state.tracks = await store.allTracks().catch(() => []);
  state.dismissals = await store.allDismissals().catch(() => []);
  noteLastTaps();
  // A manual pick lives only for this session: a remembered pick silently filed
  // later taps under the wrong intersection. Clear what older builds saved.
  try { localStorage.removeItem('onda.selectedId'); } catch { /* private mode */ }
  startGps();
  wireUi();
  // A bug in one tab must never stop boot: a throw here used to skip the render
  // loop entirely (blank Live view) and the SW registration (no self-update).
  const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`${name} failed to mount`, e); } };
  safe('editor', () => mountEditor(document.getElementById('editor-root'), editorApi()));
  safe('analyze', () => mountAnalyze(document.getElementById('analyze-root'), analyzeApi()));
  safe('sync', () => mountSync(document.getElementById('sync-root'), syncApi()));
  registerSW();
  await bootModel(); // predictions take `now` as an input, so no periodic rebuild is needed
  safe('sync-url', () => { if (autoJoinFromUrl()) showView('sync'); });
  setInterval(() => safe('render', tick), 250);
  safe('render', tick);
  scheduleSuggest(2000);
  setInterval(() => scheduleSuggest(0), 30000); // the street geometry arrives in the background
  syncLoop();
  safe('streets', () => {
    refreshStreets(); // after the first render; loads the cache, then queues what's stale
    window.addEventListener('online', () => streetFeed.online().catch(() => {}));
  });
})();

// Service worker: offline cache + update checks. No automatic reloads (they
// could hit mid-drive and drop an open sync room or capture): when the server
// has a newer version than the one running, show a "Reload" bar instead.
//  - updateViaCache:'none' → the browser never HTTP-caches sw.js (GitHub Pages
//    sets max-age=600 on everything);
//  - the version lives in src/version.js; comparing the server's copy with the
//    one this page loaded means we never prompt for a version you already run.
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  let reg = null;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((r) => { reg = r; }).catch(() => {});
  const check = () => { reg?.update().catch(() => {}); checkForUpdate(); };
  setTimeout(check, 3000);
  setInterval(check, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

async function checkForUpdate() {
  try {
    const text = await (await fetch('src/version.js', { cache: 'no-cache' })).text();
    const latest = /ONDA_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1];
    if (latest && latest !== self.ONDA_VERSION) $('update-banner').hidden = false;
  } catch { /* offline: nothing to offer */ }
}

// ---------- gps ----------
function startGps() {
  if (!('geolocation' in navigator)) { $('gps-sub').textContent = 'no GPS — pick manually'; return; }
  navigator.geolocation.watchPosition(
    (p) => {
      state.pos = { lat: p.coords.latitude, lon: p.coords.longitude };
      trackRec.fix({ t: Number.isFinite(p.timestamp) ? p.timestamp : Date.now(), lat: p.coords.latitude, lon: p.coords.longitude, heading: p.coords.heading, speed: p.coords.speed, acc: p.coords.accuracy });
      const fix = { ...state.pos, speed: Number.isFinite(p.coords.speed) ? p.coords.speed : 0, course: Number.isFinite(p.coords.heading) ? p.coords.heading : null, t: performance.now() };
      state.fix = { ...fix, turn: turnRate(state.fix, fix) };
      state.fixNew = true;
      state.heading = Number.isFinite(p.coords.heading) ? p.coords.heading : null;
      state.speed = Number.isFinite(p.coords.speed) ? p.coords.speed : 0;
      // Keep the last real heading: GPS course goes null at a standstill — exactly
      // when you tap — so the scene freezes to it instead of spinning.
      if (state.heading != null && state.speed >= 1.5) state.headingFrozen = state.heading;
      $('gps-sub').textContent = ''; // only speak up when something's wrong
    },
    () => { $('gps-sub').textContent = 'GPS blocked — pick manually'; },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
  );
}

// ---------- selection ----------
function currentIntersection() {
  if (state.selectedId) {
    const found = state.intersections.find((i) => i.id === state.selectedId);
    if (found) return found;
  }
  return pickIntersection({ ranked: state.ranked, intersections: state.intersections, pos: state.pos, lastId: state.lastRankedId, moving: state.heading != null && state.speed >= 1.5, passedId: state.passedIxId });
}

function recomputeRanking() {
  if (state.pos) state.ranked = rankNext(state.pos, state.heading, state.speed, state.intersections);
  else state.ranked = state.intersections.map((ix) => ({ intersection: ix, distanceM: null, etaSec: null, offAxis: 0 }));
  if (state.ranked[0]) state.lastRankedId = state.ranked[0].intersection.id; // what to keep showing once you've passed it
}

// ---------- render loop ----------
const PASSED_FORGET_M = 120; // a passed junction counts as passed until you are this far from it
function tick() {
  trackRec.poll(Date.now());
  const shown = !state.selectedId && state.intersections.find((i) => i.id === state.lastIxId);
  if (shown) stepHeadPick(shown); // may mark `shown` passed, before the ranking picks what's next
  const passed = state.passedIxId && state.intersections.find((i) => i.id === state.passedIxId);
  if (!passed || !state.pos || distanceM(state.pos, passed.location) > PASSED_FORGET_M) state.passedIxId = null;
  recomputeRanking();
  const ix = currentIntersection();
  if (ix && ix.id !== state.lastIxId) { state.sceneHead = null; state.lastIxId = ix.id; }
  renderLive(ix);
  renderCapture();
}

// ---------- the model ----------
// ONE global model, a pure function of (taps, map). Boot shows the cached one
// right away; every change applies `withTap` instantly (a new tap) and then a
// debounced full recompute in a Web Worker swaps in the exact result. Nothing
// here is authoritative: dropping the cache just costs one recompute.
let worker = null, workerBroken = false, jobId = 0, recomputeTimer = null, running = false, again = false, gen = 0;
const pending = new Map(); // job id -> { observations, intersections, res, rej }

const mainThread = ({ observations, intersections }) => new Promise((res, rej) => setTimeout(() => {
  try { res(computeModel({ observations, intersections })); } catch (e) { rej(e); }
}, 0));

function getWorker() {
  if (worker || workerBroken || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('../inference/worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, model, error } = e.data ?? {};
      const job = pending.get(id); if (!job) return;
      pending.delete(id);
      if (error) job.rej(new Error(error)); else job.res(model);
    };
    // No module-worker support (older browsers), or it failed to load: from now
    // on compute on the main thread, and rerun whatever was in flight there.
    worker.onerror = (e) => {
      e?.preventDefault?.();
      workerBroken = true; worker?.terminate(); worker = null;
      for (const job of pending.values()) mainThread(job).then(job.res, job.rej);
      pending.clear();
    };
  } catch { workerBroken = true; worker = null; }
  return worker;
}

function compute(observations, intersections) {
  const w = getWorker();
  if (!w) return mainThread({ observations, intersections });
  return new Promise((res, rej) => {
    const id = ++jobId;
    pending.set(id, { observations, intersections, res, rej });
    w.postMessage({ id, observations, intersections });
  });
}

async function bootModel() {
  try {
    const key = await store.modelKey(state.obs, state.intersections, ALGO_VERSION);
    const cached = await store.loadModelCache().catch(() => null);
    if (cached?.model?.algoVersion === ALGO_VERSION) {
      state.model = cached.model;
      if (cached.key === key) { state.modelKey = key; state.modelStatus = 'uptodate'; refreshAnalyze(); return; }
      state.modelStatus = 'recomputing';
    } else state.modelStatus = state.obs.length ? 'recomputing' : 'uptodate';
  } catch (e) { console.error('model cache failed', e); }
  scheduleRecompute(0);
}

/** Taps/map changed: mark the model stale and recompute soon (debounced). */
function scheduleRecompute(delay = 200) {
  gen++;
  if (state.model || state.obs.length) state.modelStatus = 'recomputing';
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(recompute, delay);
}

async function recompute() {
  if (running) { again = true; return; }
  running = true;
  try {
    do {
      again = false;
      const myGen = gen, observations = state.obs, intersections = state.intersections;
      const key = await store.modelKey(observations, intersections, ALGO_VERSION);
      if (key === state.modelKey && state.model) { if (myGen === gen) state.modelStatus = 'uptodate'; continue; }
      let model;
      try { model = await compute(observations, intersections); }
      catch (e) { console.error('model failed', e); state.modelStatus = state.model ? 'recomputing' : 'none'; break; }
      store.saveModelCache(key, model).catch(() => {}); // valid for ITS inputs whatever happened since
      if (myGen === gen) { state.model = model; state.modelKey = key; state.modelStatus = 'uptodate'; refreshAnalyze(); }
      else again = true; // taps arrived meanwhile: this result lacks them, go again
    } while (again);
  } finally { running = false; }
}

function noteLastTaps() {
  const last = {};
  for (const o of state.obs) if (o.headId && (!last[o.headId] || o.t > last[o.headId].t)) last[o.headId] = { t: o.t, aspect: o.aspect };
  state.lastTaps = last;
}

// phaseTable is memoised per model, intersection and minute (the render loop runs 4x/s).
function tableFor(ixId, now) {
  if (!state.model) return null;
  const minute = Math.floor(now / 60000), hit = state.tables.get(ixId);
  if (hit && hit.model === state.model && hit.minute === minute) return hit.table;
  let table = null;
  try { table = phaseTable(state.model, ixId, now); } catch (e) { console.error('phaseTable failed', e); }
  state.tables.set(ixId, { model: state.model, minute, table });
  return table;
}

// The colour shown for a head: the model's, filtered so it only goes green -> amber -> red -> green.
const aspectNow = (hid, now) => {
  if (!state.model) return null;
  let model = null;
  try { model = currentAspect(state.model, hid, now) ?? null; } catch { return null; }
  const prev = state.shown.get(hid) ?? null;
  const next = guardAspect(prev, model, now, state.model.lights?.[hid]?.aspects ?? []);
  if (next) state.shown.set(hid, next); else state.shown.delete(hid);
  return next?.aspect ?? null;
};

// Approach tint (Live scene): the colour of a head washed over its approach lanes, weaker
// the less the prediction can be trusted so a guess never looks like fact. Strength is the
// alpha at the stop line. A head is 'reliable' when every colour is anchored (no guess) and
// its worst ± is within RELIABLE_PM_SEC (about as precise as tap-timed lights get), 'rough'
// up to ROUGH_PM_SEC (right phase, change time a few seconds off), else 'unreliable'; any
// best-estimate "guess" is unreliable regardless of its ±.
const TINT_STRENGTH = { reliable: 0.45, rough: 0.3, unreliable: 0.18 };
const RELIABLE_PM_SEC = 3;
const ROUGH_PM_SEC = 8;

// {aspect, strength} to tint a head's approach with, or null: no model, colour not known,
// or the light is sensor-controlled / unpredictable (then the colour shown is not a claim we can make).
function tintFor(hid, now) {
  const light = state.model?.lights?.[hid];
  if (!light || light.actuated?.length) return null;
  const aspect = aspectNow(hid, now);
  if (!aspect || aspect === 'off') return null;
  let guess = false, pm = 0;
  for (const a of light.aspects) {
    let p = null;
    try { p = predictMark(state.model, hid, a, now); } catch { return null; }
    if (p.unpredictable) return null;
    guess ||= !!p.guess; pm = Math.max(pm, p.plusMinus);
  }
  const rel = guess || pm > ROUGH_PM_SEC ? 'unreliable' : pm > RELIABLE_PM_SEC ? 'rough' : 'reliable';
  return { aspect, strength: TINT_STRENGTH[rel] };
}

// Live's "up" and the approach direction: your travel course (see viewBearing).
function approachBearing(ix) {
  return viewBearing({ heading: state.heading, headingFrozen: state.headingFrozen, speed: state.speed, pos: state.pos, target: ix.location });
}

// The car's own course for the lane snap: live GPS course while moving, else the last one held. Not
// approachBearing: that can still be the previous street's direction just after a turn. No course = no snap.
function carCourse() {
  const f = state.fix;
  return f?.course != null && f.speed >= 1.5 ? f.course : state.headingFrozen;
}

// One head-picker step per GPS fix (idempotent within a fix) from the raw fix position: the
// approach you are on, see pickHead. Nothing without lane geometry, a fix or a course.
let lastPick = null; // { ixId, headId, reason } for the debug hook
function stepHeadPick(ix) {
  const streets = streetFeed.get(ix.id);
  const ixs = [ix, ...streetFeed.neighborIds(ix.id).map((id) => state.intersections.find((o) => o.id === id)).filter(Boolean)];
  const set = state.fix && state.pos && approachCandidates(streets, ixs);
  const hp = pickHead({ set, ixId: ix.id, ego: set && toLocal(state.pos, streets.center), course: approachBearing(ix), prev: state.headPicks.get(ix.id) ?? null, fixId: state.fix?.t });
  state.headPicks.set(ix.id, hp);
  if (hp.reason === 'passed') state.passedIxId = ix.id; // Live moves on from it if another junction is ahead, else keeps it
  return hp;
}

// Head to predict + capture: a pole you tapped, else the head of the approach you are on (lanes),
// else the head facing your approach by bearing (near-side mast), else the first head.
function resolveActiveHead(ix, heads) {
  if (!heads.length) return null;
  const hp = stepHeadPick(ix);
  const pick = (h, reason) => { lastPick = { ixId: ix.id, headId: h.id, reason, key: hp.key, nextIxId: hp.nextIxId, passedIxId: state.passedIxId }; return h; };
  if (state.sceneHead?.ixId === ix.id) { const h = heads.find((x) => x.id === state.sceneHead.id); if (h) return pick(h, 'manual'); }
  if (hp.headId) { const h = heads.find((x) => x.id === hp.headId); if (h) return pick(h, hp.reason); }
  const facing = headForApproach(ix, approachBearing(ix));
  if (facing) { const h = heads.find((x) => x.id === facing); if (h) return pick(h, 'bearing'); }
  const mv = ix.movements?.find((m) => !m.unsignalized && m.headId);
  if (mv?.headId) { const h = heads.find((x) => x.id === mv.headId); if (h) return pick(h, 'bearing'); }
  return pick(heads[0], 'bearing');
}

// ---------- live canvas: rAF loop, dead reckoning, eased orientation ----------
const FRAME_MS = 28; // ~30 fps cap (every 2nd frame at 60 Hz)
let rafId = 0, lastDraw = 0, lastFrameT = 0, shown = null; // shown: { ixId, pos, off, up }
window.__onda = { lastScene: { ixId: null, upDeg: null, scale: null, ego: null }, frames: [], head: null }; // read-only debug hook (tools/e2e-drive.mjs); head: { ixId, headId, reason: lane|latched|passed|bearing|manual, key (approach), nextIxId, passedIxId }

function drawFrame(ts, force) {
  const sc = state.liveScene, canvas = $('live-scene');
  if (!sc || !canvas || !canvas.clientWidth) return;
  if (!force && ts - lastDraw < FRAME_MS) return;
  const t0 = performance.now();
  const dt = lastFrameT ? Math.min(0.5, (ts - lastFrameT) / 1000) : 0;
  lastFrameT = ts; lastDraw = ts;
  const upTarget = approachBearing(sc.ix) ?? 0;
  // the arrow sits on a driving lane of your direction when one is near (raw GPS often lands on the sidewalk);
  // the lane snap is an offset from the raw position, eased so it glides when the lane in reach changes
  const raw = deadReckon(state.fix, ts) ?? state.pos;
  const want = raw ? offsetBetween(snapToLane(streetFeed.get(sc.ix.id), raw, carCourse()), raw) : { dlat: 0, dlon: 0 };
  const fresh = !shown || shown.ixId !== sc.ix.id;
  const lane = fresh ? want : easeOffset(shown.lane, want, dt);
  const target = raw && applyOffset(raw, lane);
  if (fresh) shown = { ixId: sc.ix.id, pos: target, off: { dlat: 0, dlon: 0 }, lane, up: upTarget }; // snap
  else {
    shown.lane = lane;
    shown.up = easeAngle(shown.up, upTarget, dt);
    if (target && state.fixNew && shown.pos) shown.off = offsetBetween(shown.pos, target); // new fix: blend from where we were drawn
    state.fixNew = false;
    shown.off = decayOffset(shown.off, dt);
    shown.pos = target && applyOffset(target, shown.off);
  }
  window.__onda.lastScene.ixId = sc.ix.id; window.__onda.lastScene.upDeg = shown.up;
  state.sceneBoxes = drawScene(canvas, { intersection: sc.ix, ego: shown.pos, upDeg: shown.up, aspectOf: sc.aspectOf, activeHeadId: sc.activeHeadId, streets: streetFeed.get(sc.ix.id), streetStatus: streetStatusOf(sc.ix.id), neighbors: sc.neighbors, tintOf: sc.tintOf });
  const fr = window.__onda.frames;
  fr.push({ ms: performance.now() - t0, t: ts, ixId: sc.ix.id, up: shown.up, ego: window.__onda.lastScene.ego });
  if (fr.length > 1200) fr.shift();
}

function frameLoop(ts) { rafId = requestAnimationFrame(frameLoop); drawFrame(ts); }
// Run only while Live is showing and the page is visible.
function syncLoop() {
  const want = $('view-live')?.classList.contains('active') && !document.hidden;
  if (want && !rafId) { lastFrameT = 0; rafId = requestAnimationFrame(frameLoop); }
  else if (!want && rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}
document.addEventListener('visibilitychange', () => { syncLoop(); if (document.hidden) trackRec.flush(); });
addEventListener('pagehide', () => trackRec.flush()); // closing: save the track as far as it got

function renderLive(ix) {
  ix = ix ?? currentIntersection();
  if (!ix) { $('ix-name').textContent = 'No intersections'; $('active-head').hidden = true; return; }
  $('ix-name').textContent = ix.name;

  const now = Date.now();
  const heads = headsOf(ix);
  const active = resolveActiveHead(ix, heads);
  window.__onda.head = lastPick;

  // scene: a light is coloured only when the model knows enough to say (>= 2 colours tapped)
  // The canvas itself is drawn by the rAF loop (drawFrame); this hands it what to draw, refreshed on the tick.
  // aspects/tints are memoised per tick so a frame costs no predictions.
  const aspects = new Map(), tints = new Map(); // several approaches can share a head
  const aspectOfC = (hid) => { if (!aspects.has(hid)) aspects.set(hid, aspectNow(hid, now) ?? 'off'); return aspects.get(hid); };
  const tintOf = (_ixId, hid) => { if (!tints.has(hid)) tints.set(hid, tintFor(hid, now)); return tints.get(hid); };
  // other junctions of this cluster: lights only (their streets are in the shared entry)
  const neighbors = streetFeed.neighborIds(ix.id)
    .map((id) => state.intersections.find((o) => o.id === id)).filter(Boolean)
    .map((n) => ({ ix: n, aspectOf: aspectOfC }));
  state.liveScene = { ix, aspectOf: aspectOfC, activeHeadId: active?.id ?? null, neighbors, tintOf };
  if (!rafId) drawFrame(performance.now(), true); // no loop running (e.g. rAF throttled): still draw on the tick

  renderCountdown(active, now);
  renderLiveMeta(active, now);
  renderActiveHead(ix, active);
  renderUpcoming(ix);
  $('live-hint').textContent = state.selectedId ? 'Manually selected — tap it again to auto-follow GPS.' : '';
}

const REASONS = {
  actuated: 'sensor-controlled light · not predicted',
};

// Headline: "Amber in 23 s ±2" (next phase change) when every phase of the light is known, else
// "Green in 23 s ±2" (next green), for the active light, with how we know. When the
// model can't say, show why instead of a number. The number takes the current
// colour only when the model knows it (>= 2 colours tapped); else it stays neutral.
function renderCountdown(active, now) {
  const num = $('count-num'), cap = $('count-cap'), ind = $('ind-label'), box = $('count');
  const unit = box.querySelector('.unit');
  const show = (label, n, caption, aspect, guess) => {
    ind.textContent = label; num.textContent = n; cap.textContent = caption;
    box.dataset.aspect = aspect ?? ''; unit.hidden = n === '--';
    if (guess) box.dataset.guess = '1'; else delete box.dataset.guess;
  };
  if (!active) return show('—', '--', '', null);
  if (!state.model) return show('Learning', '--', state.obs.length ? 'working it out…' : 'tap colors to learn', null);

  const cur = aspectNow(active.id, now);
  const curLabel = cur ? ASPECT_INFO[cur]?.label : null;
  // whole cycle known -> count down to the next phase change; else (cycle length only) to the next green
  let pred = null, nextLabel = 'green';
  try {
    const ch = cur ? nextChange(state.model, active.id, now, cur) : null;
    if (ch) { pred = ch; nextLabel = ch.aspect; } else pred = nextOnset(state.model, active.id, 'green', now);
  } catch (e) { console.error('nextOnset failed', e); }
  if (!pred || pred.unpredictable) {
    const last = state.lastTaps[active.id];
    const echo = last && now - last.t < LAST_TAP_ECHO_MS ? ` · your last tap: ${ASPECT_INFO[last.aspect]?.label ?? last.aspect} ${Math.round((now - last.t) / 1000)} s ago` : '';
    const why = pred ? (REASONS[pred.reason] ?? pred.reason ?? 'not predicted') : 'not predicted';
    return show(curLabel ? `${curLabel} now` : 'Green in', '--', why + echo, cur);
  }
  const pm = pred.plusMinus >= 0.5 ? `±${Math.round(pred.plusMinus)} s` : '';
  show(curLabel ? `${curLabel} now · ${nextLabel} in` : 'Green in', String(Math.max(0, Math.round(pred.inSec))),
    [pm, pred.basis].filter(Boolean).join(' · '), cur, pred.guess);
}

const LAST_TAP_ECHO_MS = 10 * 60 * 1000;

function ago(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

// Small, unobtrusive model indicator (+ corridor / sensor flags for the active light).
function renderLiveMeta(active, now) {
  const parts = [];
  const m = state.model;
  if (state.modelStatus === 'uptodate') parts.push('<span class="badge" title="The timing model matches every tap and the map">up to date</span>');
  else if (state.modelStatus === 'recomputing')
    parts.push(`<span class="badge uncertain" title="Showing the last result while the new one is computed">recomputing…${m?.computedAt ? ` (from ${ago(now - m.computedAt)})` : ''}</span>`);
  const light = active && m?.lights?.[active.id];
  const group = light && m.groups?.find((g) => g.id === light.groupId);
  if (group?.corridor) parts.push('<span class="badge" title="Lights at several junctions share one clock">corridor</span>');
  if (light?.actuated?.length) parts.push('<span class="badge uncertain">sensor · not predicted</span>');
  const html = parts.join('');
  if (state._metaHtml !== html) { state._metaHtml = html; $('meta').innerHTML = html; }
}

// The big upright tap panel for the active head (rebuilt only when it changes, so
// taps stay responsive under the 250ms render loop).
function renderActiveHead(ix, active) {
  const box = $('active-head');
  if (!active) { box.hidden = true; box.innerHTML = ''; state._ahKey = null; return; }
  box.hidden = false;
  const canUndo = state.lastObs?.ixId === ix.id;
  const key = `${ix.id}|${active.id}|${canUndo}`;
  if (state._ahKey === key) return;
  state._ahKey = key;
  box.innerHTML = `
    <div class="ah-name">${esc(active.label)}</div>
    ${tapPanelHtml({ undo: true, canUndo, poles: true })}`;
  box.querySelectorAll('.cap').forEach((b) => (b.onclick = () => logAspect(ix.id, active.id, b.dataset.asp)));
  const u = box.querySelector('[data-act="undo"]');
  if (u) u.onclick = undoLast;
}

// Turn a tap on a pole in the scene into "make this head active".
function onSceneClick(e) {
  const ix = currentIntersection(); if (!ix) return;
  const r = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  const hit = state.sceneBoxes.find((b) => b.headId && x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
  if (hit) { state.sceneHead = { ixId: ix.id, id: hit.headId }; tick(); }
}

async function undoLast() {
  if (!state.lastObs) return;
  const { id, ixId } = state.lastObs; void ixId;
  await store.deleteObservation(id);
  state.lastObs = null;
  state.captureLog = state.captureLog.filter((l) => l.id !== id);
  state.obs = state.obs.filter((o) => o.id !== id);
  noteLastTaps();
  scheduleRecompute();
  tick();
}

// The one tapping instruction (Live and Capture used to word it differently).
// Every tap means one thing: the light just changed to this color.
const TAP_HINT = 'Tap a color only at the instant the light changes to it — never to say what it shows now.';

// The signal tap panel, shared by Live and Capture so both look and read the same.
function tapPanelHtml({ undo = false, canUndo = false, poles = false } = {}) {
  return `
    <div class="tap-lamps">
      <button class="cap green" data-asp="green">Green</button>
      <button class="cap yellow" data-asp="amber">Amber</button>
      <button class="cap red" data-asp="red">Red</button>
    </div>
    <div class="tap-more">
      <button class="cap flashYel small" data-asp="flash-amber">Flashing amber</button>
      <button class="cap dark small" data-asp="off">Off / dark</button>
    </div>
    ${undo ? `<div class="tap-undo"><button class="btn quiet" data-act="undo" ${canUndo ? '' : 'disabled'}>${icon('undo')} Undo last tap</button></div>` : ''}
    <p class="tap-hint">${TAP_HINT}${poles ? ' Tap a pole in the view to switch lights.' : ''}</p>`;
}

// Rows are rebuilt only when the set/selection changes; dots and ETAs are then
// updated in place — rebuilding every 250ms tick swallowed taps on the rows.
function renderUpcoming(currentIx) {
  const list = $('upcoming-list');
  const rows = state.ranked.slice(0, 5);
  const key = rows.map((r) => r.intersection.id + ':' + r.intersection.name).join('|') + '#' + currentIx.id;
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.innerHTML = rows.map(({ intersection: ix }) => `<div class="row${ix.id === currentIx.id ? ' sel' : ''}" data-id="${ix.id}">
      <span class="dot"></span><span class="name">${esc(ix.name)}</span><span class="eta"></span></div>`).join('');
    list.querySelectorAll('.row').forEach((r) => (r.onclick = () => {
      const id = r.dataset.id;
      state.selectedId = state.selectedId === id ? null : id; // toggle manual/auto
      tick();
    }));
  }
  const now = Date.now();
  rows.forEach(({ intersection: ix, etaSec }, i) => {
    const row = list.children[i]; if (!row) return;
    const head = resolveActiveHead(ix, headsOf(ix));
    const asp = head ? aspectNow(head.id, now) : null;
    row.querySelector('.dot').className = `dot ${ASPECT_INFO[asp]?.color ?? 'dark'}`;
    row.querySelector('.eta').textContent = etaSec == null ? '' : etaSec > 90 ? `${Math.round(etaSec / 60)} min` : `${Math.round(etaSec)}s`;
  });
}

// ---------- capture: watch one head, tap its color on each change ----------
function headsOf(ix) {
  const seen = new Set(), out = [];
  for (const m of ix.movements || []) {
    if (m.unsignalized || !m.headId || seen.has(m.headId)) continue;
    seen.add(m.headId);
    out.push({ id: m.headId, label: headLabel(ix, m.headId) });
  }
  return out;
}

function renderCapture() {
  const ix = currentIntersection();

  // Selects/buttons are rebuilt only when their content changes, and never while
  // focused: rebuilding every 250ms tick closed the native picker as you opened it.
  const ixSel = $('cap-ix');
  const ixKey = `${state.intersections.map((i) => i.id + ':' + i.name).join('|')}#${state.selectedId ?? ''}#${ix?.id ?? ''}`;
  if (ixSel.dataset.key !== ixKey && document.activeElement !== ixSel) {
    ixSel.dataset.key = ixKey;
    const auto = `Auto — nearest by GPS${!state.selectedId && ix ? ` (${ix.name})` : ''}`;
    ixSel.innerHTML = `<option value="">${esc(auto)}</option>`
      + intersectionOptions(state.intersections, state.selectedId);
    ixSel.onchange = () => { state.selectedId = ixSel.value || null; tick(); };
  }

  const heads = ix ? headsOf(ix) : [];
  const sel = $('cap-head');
  const box = $('cap-buttons');
  if (!heads.length) {
    if (sel.dataset.key !== 'none') {
      sel.dataset.key = 'none'; box.dataset.key = 'none';
      sel.innerHTML = '<option>—</option>';
      box.innerHTML = '<p class="hint">Add signalized movements/heads in the Edit tab first.</p>';
    }
  } else {
    if (state.captureHead?.ixId !== ix.id || !heads.find((h) => h.id === state.captureHead?.id))
      state.captureHead = { ixId: ix.id, id: resolveActiveHead(ix, heads).id }; // the light facing you, not the first one
    const headKey = `${ix.id}#${heads.map((h) => h.id + ':' + h.label).join('|')}#${state.captureHead.id}`;
    if (sel.dataset.key !== headKey && document.activeElement !== sel) {
      sel.dataset.key = headKey;
      sel.innerHTML = heads.map((h) => `<option value="${h.id}" ${h.id === state.captureHead.id ? 'selected' : ''}>${esc(h.label)}</option>`).join('');
      sel.onchange = () => { state.captureHead = { ixId: ix.id, id: sel.value }; };
    }
    if (box.dataset.key !== ix.id) {
      box.dataset.key = ix.id;
      box.innerHTML = tapPanelHtml();
      box.querySelectorAll('.cap').forEach((b) => (b.onclick = () => logAspect(ix.id, state.captureHead.id, b.dataset.asp)));
    }
  }

  const log = $('cap-log');
  const logKey = `${state.captureLog.length}:${state.captureLog.at(-1)?.id ?? ""}`;
  if (log.dataset.key !== logKey) {
    log.dataset.key = logKey;
    log.innerHTML = state.captureLog.slice(-12).reverse()
      .map((l) => `<div>${new Date(l.t).toLocaleTimeString()} · <b>${esc(l.aspect)}</b> · ${esc(l.head)} @ ${esc(l.ix)}</div>`).join('');
  }
}

// Append one aspect observation for a head: it just changed to `aspect`.
async function logAspect(intersectionId, headId, aspect) {
  const ix = state.intersections.find((i) => i.id === intersectionId); if (!ix || !headId) return;
  const ev = {
    id: uid('obs'), intersectionId, headId, aspect, kind: 'onset', t: Date.now(),
    where: state.pos ?? undefined, heading: state.heading ?? undefined,
  };
  await store.addObservation(ev);
  try { trackRec.tap(ev); } catch (e) { console.error('track start failed', e); } // after the tap is safe; a failure here costs a suggestion, not a tap
  state.obs = [...state.obs, ev];
  state.lastTaps[headId] = { t: ev.t, aspect };
  state.shown.set(headId, tapped(aspect, ev.t));
  state.lastObs = { id: ev.id, ixId: intersectionId };
  const head = headsOf(ix).find((h) => h.id === headId);
  state.captureLog.push({ id: ev.id, t: ev.t, aspect, head: head?.label ?? headId, ix: ix.name });
  if (navigator.vibrate) navigator.vibrate(30);
  // instant: re-anchor today's clock on this tap; the exact recompute follows
  if (state.model) { try { state.model = withTap(state.model, ev); } catch (e) { console.error('withTap failed', e); } }
  scheduleRecompute(1000);
  renderCapture();
  tick();
}

// ---------- wiring ----------
function wireUi() {
  $('tab-live').onclick = () => showView('live');
  $('tab-capture').onclick = () => showView('capture');
  $('tab-edit').onclick = () => showView('edit');
  $('tab-analyze').onclick = () => showView('analyze');
  $('tab-sync').onclick = () => showView('sync');
  $('live-scene').addEventListener('click', onSceneClick);
  $('update-reload').onclick = () => location.reload();
  $('update-dismiss').onclick = () => { $('update-banner').hidden = true; };
}

// Reload the intersection set from the store and refresh every view.
async function reloadData() {
  state.intersections = await store.allIntersections();
  state.obs = await store.allObservations();
  state.tracks = await store.allTracks().catch(() => state.tracks);
  state.dismissals = await store.allDismissals().catch(() => state.dismissals);
  state.suggestCache.clear(); // the map may have changed
  scheduleSuggest(0);
  noteLastTaps();
  scheduleRecompute(); // new data (sync/import/map edit): same key -> instant no-op
  refreshStreets(); // new or moved junction -> streets queued in the background
  refreshEditor();
  refreshAnalyze();
  tick();
}

// --- APIs handed to the sub-views (thin adapters over the store + state) ---
function editorApi() {
  return {
    list: () => state.intersections,
    get: (id) => state.intersections.find((i) => i.id === id),
    save: async (ix) => { await store.putIntersection(ix); },
    remove: async (id) => { await store.deleteIntersection(id); },
    gpsNow: () => state.pos,
    nowMs: () => Date.now(),
    model: (id) => tableFor(id, Date.now()),
    onChange: reloadData,
  };
}

function analyzeApi() {
  return {
    list: () => state.intersections,
    get: (id) => state.intersections.find((i) => i.id === id),
    model: () => state.model,
    status: () => state.modelStatus,
    taps: () => state.obs,
    nowMs: () => Date.now(),
    onChange: reloadData,
    suggestions: () => state.suggestions,
    acceptSuggestion,
    dismissSuggestion,
  };
}

// ---------- suggested re-files (Analyze) ----------
// Streets + junctions of the cluster a tap's junction belongs to (the same ones Live uses to pick the head).
function suggestContext(ixId) {
  const ix = state.intersections.find((i) => i.id === ixId), streets = ix && streetFeed.get(ixId);
  if (!streets) return null;
  const ixs = [ix, ...streetFeed.neighborIds(ixId).map((id) => state.intersections.find((o) => o.id === id)).filter(Boolean)];
  const set = approachCandidates(streets, ixs);
  return set && { set, center: streets.center, intersections: ixs };
}

let suggestTimer = null, streetsStamp = '';
function scheduleSuggest(delay = 300) {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => {
    try {
      const stamp = state.intersections.map((i) => streetFeed.get(i.id)?.computedAt ?? 0).join();
      if (stamp !== streetsStamp) { streetsStamp = stamp; state.suggestCache.clear(); }
      const live = state.obs.filter((o) => o.where);
      const next = pendingSuggestions({ obs: live, tracks: state.tracks, dismissed: state.dismissals.map((d) => d.obsId), contextOf: suggestContext, cache: state.suggestCache });
      const changed = next.map((s) => s.id).join() !== state.suggestions.map((s) => s.id).join();
      state.suggestions = next;
      renderSuggestBadge();
      if (changed) refreshAnalyze();
    } catch (e) { console.error('suggestions failed', e); }
  }, delay);
}

function renderSuggestBadge() {
  const n = state.suggestions.length, tab = $('tab-analyze');
  tab.innerHTML = n ? `Analyze <span class="badge uncertain" id="analyze-badge" title="Suggested re-files waiting for you">${n}</span>` : 'Analyze';
}

// Accept = what tools/refile.mjs writes: a NEW observation (sync merges taps by id, never overwriting one) + a tombstone for the old id.
async function acceptSuggestion(id) {
  const s = state.suggestions.find((x) => x.id === id), o = state.obs.find((x) => x.id === id);
  if (!s || !o) return;
  const { newObs, tombstone } = refileOf(o, s);
  await store.refileObservation(o.id, newObs, tombstone);
  state.obs = [...state.obs.filter((x) => x.id !== o.id), newObs];
  if (state.lastObs?.id === o.id) state.lastObs = null;
  state.suggestions = state.suggestions.filter((x) => x.id !== id);
  noteLastTaps();
  scheduleRecompute();
  scheduleSuggest(0); renderSuggestBadge(); refreshAnalyze(); tick();
}

async function dismissSuggestion(id) {
  const d = { id: `dis_${id}`, obsId: id, at: Date.now() };
  await store.putDismissal(d);
  state.dismissals = [...state.dismissals.filter((x) => x.id !== d.id), d];
  state.suggestions = state.suggestions.filter((x) => x.id !== id);
  renderSuggestBadge(); refreshAnalyze();
}

function syncApi() {
  return {
    getBundle: () => store.exportAll(),
    applyMerged: async (merged) => { await store.applyMerged(merged); await reloadData(); },
    exportText: async () => JSON.stringify(await store.exportAll(), null, 2),
    // Import merges exactly like sync (newest edit wins, tombstones honored) —
    // it used to overwrite intersections with the file's copies blindly.
    importBundle: async (bundle) => {
      const { merged } = mergeBundles(await store.exportAll(), bundle);
      await store.applyMerged(merged);
      await reloadData();
    },
  };
}


// Car layout: in landscape (same query as the CSS) Live is a borderless map plus a
// rail. While it shows, body.live-car is set and the tabs, GPS note and countdown
// move into the rail (one instance of each, so their handlers keep working); leaving
// Live or rotating moves them back.
const carMq = window.matchMedia('(min-width: 600px) and (min-height: 450px) and (min-aspect-ratio: 1/1)');
function syncCarLive() {
  const on = carMq.matches && $('view-live').classList.contains('active');
  if (document.body.classList.contains('live-car') === on) return;
  document.body.classList.toggle('live-car', on);
  const rail = document.querySelector('.live-side'), tabs = document.querySelector('.tabs'), hud = document.querySelector('.scene-hud');
  if (on) rail.append(tabs, $('gps-sub'), hud);
  else { document.querySelector('.topbar').append($('gps-sub'), tabs); document.querySelector('.scene-wrap').append(hud); }
}
carMq.addEventListener('change', syncCarLive);
syncCarLive(); // before the first paint: the module runs before boot's awaits resume

function showView(name) {
  for (const v of ['live', 'capture', 'edit', 'analyze', 'sync']) {
    $(`view-${v}`).classList.toggle('active', name === v);
    $(`tab-${v}`).setAttribute('aria-selected', String(name === v));
  }
  syncCarLive();
  syncLoop();
  if (name === 'edit') refreshEditor();
  if (name === 'analyze') refreshAnalyze();
}
