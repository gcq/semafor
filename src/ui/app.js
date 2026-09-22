// Onda UI controller. Thin glue: it reads the pure core (predict, nav) and the
// store, and paints the DOM on a timer. No framework.

import * as store from '../store/db.js';
import { activePlan, predictHead, timeToAspect } from '../predict/state.js';
import { rankNext, bearingDeg, distanceM, headForApproach } from '../nav/proximity.js';
import { characterizeIntersection } from '../inference/characterize.js';
import { uid, ASPECT_INFO } from '../domain/model.js';
import { headLabel } from '../inference/heads.js';
import { mergeBundles } from '../sync/merge.js';
import { tapKind } from '../inference/taps.js';
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
  models: {},              // ixId -> { rec, plan }: the model every view uses (rebuilt, never saved)
  lastIxId: null,          // to reset the manual head pick when the intersection changes
  lastObs: null,           // { id, ixId } for undo
  sceneBoxes: [],          // canvas hit boxes from the last draw
  taps: [],                // your taps this session { id, headId, aspect, t } — the last one decides onset vs presence
};

// ---------- boot ----------
(async function boot() {
  state.intersections = await store.allIntersections();
  state.selectedId = store.getPref('selectedId', null);
  startGps();
  wireUi();
  // A bug in one tab must never stop boot: a throw here used to skip the render
  // loop entirely (blank Live view) and the SW registration (no self-update).
  const safe = (name, fn) => { try { fn(); } catch (e) { console.error(`${name} failed to mount`, e); } };
  safe('editor', () => mountEditor(document.getElementById('editor-root'), editorApi()));
  safe('analyze', () => mountAnalyze(document.getElementById('analyze-root'), analyzeApi()));
  safe('sync', () => mountSync(document.getElementById('sync-root'), syncApi()));
  registerSW();
  await refreshAllModels();
  setInterval(refreshAllModels, 60000); // the recent window slides with the clock
  safe('sync-url', () => { if (autoJoinFromUrl()) showView('sync'); });
  setInterval(() => safe('render', tick), 250);
  safe('render', tick);
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
      state.heading = Number.isFinite(p.coords.heading) ? p.coords.heading : null;
      // Keep the last real heading: GPS course goes null at a standstill — exactly
      // when you tap — so the scene freezes to it instead of spinning.
      if (state.heading != null && state.speed >= 1.5) state.headingFrozen = state.heading;
      state.speed = Number.isFinite(p.coords.speed) ? p.coords.speed : 0;
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
  return state.ranked[0]?.intersection ?? state.intersections[0] ?? null;
}

function recomputeRanking() {
  if (state.pos) state.ranked = rankNext(state.pos, state.heading, state.speed, state.intersections);
  else state.ranked = state.intersections.map((ix) => ({ intersection: ix, distanceM: null, etaSec: null, offAxis: 0 }));
}

// ---------- render loop ----------
function tick() {
  recomputeRanking();
  const ix = currentIntersection();
  if (ix && ix.id !== state.lastIxId) { state.sceneHead = null; state.lastIxId = ix.id; }
  renderLive(ix);
  renderCapture();
}

// Rebuild one intersection's model from its observations — after a tap/undo
// this is the per-session re-anchor. Nothing is ever "saved": the model is a
// pure function of the observation log.
async function refreshModel(ix) {
  try { state.models[ix.id] = characterizeIntersection(ix, await store.observationsFor(ix.id), Date.now()); }
  catch (e) { console.error('model failed for', ix.name, e); }
}

async function refreshAllModels() {
  try {
    const byIx = await store.allObservationsByIntersection();
    const now = Date.now();
    const models = {};
    for (const ix of state.intersections) models[ix.id] = characterizeIntersection(ix, byIx[ix.id] ?? [], now);
    state.models = models;
  } catch (e) { console.error('models failed', e); }
}

// The reconstructed model; else an imported plan (e.g. from the TeslaMate tool)
// — but only one that actually predicts these heads (legacy plans keyed by
// movement id predict nothing and would show a bogus "Off").
function livePlanFor(ix, now) {
  const m = state.models[ix.id]?.plan;
  if (m) return m;
  const p = activePlan(ix.plans, now);
  const ids = new Set(headsOf(ix).map((h) => h.id));
  return p?.stages?.some((st) => Object.keys(st.states ?? {}).some((k) => ids.has(k))) ? p : null;
}

// Direction you're approaching the junction from. The bearing from you to its
// centre is right even when stopped (GPS course is null then), so prefer it until
// you're basically in the box; fall back to the live/frozen course.
function approachBearing(ix) {
  if (state.pos && distanceM(state.pos, ix.location) > 8) return bearingDeg(state.pos, ix.location);
  return state.heading ?? state.headingFrozen;
}

// Head to predict + capture: a pole you tapped, else the head facing your
// approach (near-side mast), else the first head.
function resolveActiveHead(ix, heads) {
  if (!heads.length) return null;
  if (state.sceneHead?.ixId === ix.id) { const h = heads.find((x) => x.id === state.sceneHead.id); if (h) return h; }
  const facing = headForApproach(ix, approachBearing(ix));
  if (facing) { const h = heads.find((x) => x.id === facing); if (h) return h; }
  const mv = ix.movements?.find((m) => !m.unsignalized && m.headId);
  if (mv?.headId) { const h = heads.find((x) => x.id === mv.headId); if (h) return h; }
  return heads[0];
}

function renderLive(ix) {
  ix = ix ?? currentIntersection();
  if (!ix) { $('ix-name').textContent = 'No intersections'; $('active-head').hidden = true; return; }
  $('ix-name').textContent = ix.name;

  const now = Date.now();
  const plan = livePlanFor(ix, now);
  const heads = headsOf(ix);
  const active = resolveActiveHead(ix, heads);

  // scene
  const aspectOf = (hid) => (plan ? (predictHead(plan, hid, now)?.aspect ?? 'off') : 'off');
  const ego = state.pos;
  const upDeg = approachBearing(ix) ?? 0;
  const canvas = $('live-scene');
  if (canvas && canvas.clientWidth) state.sceneBoxes = drawScene(canvas, { intersection: ix, ego, upDeg, aspectOf, activeHeadId: active?.id ?? null });

  renderCountdown(plan, active, now);
  renderLiveMeta(ix, plan, active);
  renderActiveHead(ix, active);
  renderUpcoming(ix);
  $('live-hint').textContent = state.selectedId ? 'Manually selected — tap it again to auto-follow GPS.' : '';
}

// Headline: seconds until the active head next turns green (or green time left).
// Actuated heads get no number at all: their timing isn't predictable.
function renderCountdown(plan, active, now) {
  const num = $('count-num'), cap = $('count-cap'), ind = $('ind-label');
  // The number takes the current light's color, so it reads at a glance.
  const tint = (aspect) => { $('count').dataset.aspect = aspect ?? ''; };
  tint(null);
  if (!plan || !active) {
    ind.textContent = plan ? '—' : 'Learning';
    num.textContent = '--';
    cap.textContent = plan ? '' : 'tap colors to learn';
    return;
  }
  const pred = predictHead(plan, active.id, now);
  if (!pred || pred.unpredictable) {
    ind.textContent = pred ? 'Sensor-controlled' : '—';
    num.textContent = '--';
    cap.textContent = pred ? 'not predicted' : '';
    return;
  }
  ind.textContent = ASPECT_INFO[pred.aspect]?.label ?? '—';
  tint(pred.aspect);
  if (pred.aspect === 'green') {
    num.textContent = pred.uncertain ? `~${pred.secToChange}` : pred.secToChange; // ~ = estimate
    cap.textContent = 'left';
    return;
  }
  const tg = timeToAspect(plan, active.id, now, 'green');
  if (!tg || tg.unpredictable) { num.textContent = '--'; cap.textContent = tg ? 'not predicted' : 'no green in model'; return; }
  num.textContent = pred.uncertain ? `~${tg.secToAspect}` : tg.secToAspect;
  cap.textContent = 'until green';
}

function renderLiveMeta(ix, plan, active) {
  const rec = state.models[ix.id]?.rec;
  const verdict = active && rec?.headVerdicts?.[active.id];
  const parts = [];
  const conf = plan?.confidence?.level;
  if (conf) parts.push(`<span class="badge ${conf}">${conf} confidence</span>`);
  if (verdict === 'fixed') parts.push('<span class="badge high">fixed timing</span>');
  else if (verdict === 'insufficient') parts.push('<span class="badge">needs more taps</span>');
  $('meta').innerHTML = parts.join('');
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
  const { id, ixId } = state.lastObs;
  await store.deleteObservation(id);
  state.lastObs = null;
  state.taps = state.taps.filter((t) => t.id !== id); // the tap before it decides the next one again
  state.captureLog = state.captureLog.filter((l) => l.id !== id);
  const ix = state.intersections.find((i) => i.id === ixId);
  if (ix) await refreshModel(ix);
  tick();
}

// The one tapping instruction (Live and Capture used to word it differently).
const TAP_HINT = 'Tap the color when you start watching a light, then again the instant it changes — the first tap only records what it shows.';

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
      store.setPref('selectedId', state.selectedId);
      tick();
    }));
  }
  const now = Date.now();
  rows.forEach(({ intersection: ix, etaSec }, i) => {
    const row = list.children[i]; if (!row) return;
    const plan = livePlanFor(ix, now);
    const head = resolveActiveHead(ix, headsOf(ix));
    const pred = plan && head ? predictHead(plan, head.id, now) : null;
    row.querySelector('.dot').className = `dot ${pred?.color ?? 'dark'}`;
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
    ixSel.onchange = () => { state.selectedId = ixSel.value || null; store.setPref('selectedId', state.selectedId); tick(); };
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
      state.captureHead = { ixId: ix.id, id: heads[0].id };
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

// Append one aspect observation for a head. `kind` (onset|presence) comes from
// your previous tap (see inference/taps.js).
async function logAspect(intersectionId, headId, aspect, kind) {
  const ix = state.intersections.find((i) => i.id === intersectionId); if (!ix || !headId) return;
  if (!kind) kind = tapKind(state.taps[state.taps.length - 1], headId, aspect, Date.now());
  const ev = {
    id: uid('obs'), intersectionId, headId, aspect, kind, t: Date.now(),
    where: state.pos ?? undefined, heading: state.heading ?? undefined,
  };
  await store.addObservation(ev);
  state.lastObs = { id: ev.id, ixId: intersectionId };
  state.taps.push({ id: ev.id, headId, aspect, t: ev.t });
  if (state.taps.length > 50) state.taps.shift();
  const head = headsOf(ix).find((h) => h.id === headId);
  state.captureLog.push({ id: ev.id, t: ev.t, aspect: kind === 'presence' ? `${aspect} (now)` : aspect, head: head?.label ?? headId, ix: ix.name });
  if (navigator.vibrate) navigator.vibrate(30);
  await refreshModel(ix);
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
  // New data (sync/import/edit) must reach the Live countdown now, not only
  // after the next intersection change.
  await refreshAllModels();
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
    model: (id) => { const ix = state.intersections.find((i) => i.id === id); return ix ? livePlanFor(ix, Date.now()) : null; },
    onChange: reloadData,
  };
}

function analyzeApi() {
  return {
    list: () => state.intersections,
    get: (id) => state.intersections.find((i) => i.id === id),
    observationsAll: () => store.allObservationsByIntersection(),
    nowMs: () => Date.now(),
    onChange: reloadData,
  };
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


// You can only watch a light change while you're looking at it: leaving the
// view (another tab, locking the phone, another app) means the next tap just
// records what it shows again, never a transition you didn't see.
function stopWatching() { state.taps = []; }
document.addEventListener('visibilitychange', () => { if (document.hidden) stopWatching(); });

function showView(name) {
  const current = ['live', 'capture', 'edit', 'analyze', 'sync'].find((v) => $(`view-${v}`).classList.contains('active'));
  if (current !== name) stopWatching();
  for (const v of ['live', 'capture', 'edit', 'analyze', 'sync']) {
    $(`view-${v}`).classList.toggle('active', name === v);
    $(`tab-${v}`).setAttribute('aria-selected', String(name === v));
  }
  if (name === 'edit') refreshEditor();
  if (name === 'analyze') refreshAnalyze();
}
