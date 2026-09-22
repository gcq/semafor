// Onda UI controller. Thin glue: it reads the pure core (predict, nav) and the
// store, and paints the DOM on a timer. No framework.

import * as store from '../store/db.js';
import { activePlan, predictHead, timeToAspect } from '../predict/state.js';
import { rankNext, bearingDeg, distanceM, headForApproach } from '../nav/proximity.js';
import { reconstructPlan, reconstructionToPlan } from '../inference/reconstruct.js';
import { uid } from '../domain/model.js';
import { mergeBundles } from '../sync/merge.js';
import { drawScene } from './live-scene.js';
import { mountEditor, refreshEditor } from './editor.js';
import { mountAnalyze, refreshAnalyze } from './analyze.js';
import { mountSync, autoJoinFromUrl } from './sync.js';

const ASPECT_LABEL = { green: 'Green', 'flash-amber': 'Flashing amber', amber: 'Amber', red: 'Red', off: 'Off' };
// Live re-anchor window: fold recent taps so the current session's cycle/phase
// dominate any older, drifted observations (see the TeslaMate long-span finding).
const LIVE_WINDOW_MS = 6 * 3600 * 1000;

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
  live: { ixId: null, plan: null, rec: null }, // live reconstruction cache
  lastObs: null,           // { id, ixId } for undo
  sceneBoxes: [],          // canvas hit boxes from the last draw
  lastTap: {},             // headId -> { aspect, t } of your last tap (onset vs presence)
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
  safe('sync-url', () => { if (autoJoinFromUrl()) showView('sync'); });
  setInterval(() => safe('render', tick), 250);
  safe('render', tick);
})();

// Register the worker so updates land on a normal reload:
//  - updateViaCache:'none' → the browser never HTTP-caches sw.js (GitHub Pages
//    sets max-age=600 which otherwise pins the old worker for 10 min);
//  - reg.update() on load forces an immediate check;
//  - a one-shot reload when a new worker takes control pulls the fresh assets.
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then((reg) => { reg.update().catch(() => {}); })
    .catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return; reloaded = true; location.reload();
  });
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
      $('gps-sub').textContent = state.speed >= 1.5
        ? `${Math.round(state.speed * 3.6)} km/h · ${Math.round(state.heading ?? 0)}°`
        : 'stationary';
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
  // On changing intersection, drop the manual head pick and refresh the live
  // reconstruction (async; the render below uses whatever's cached meanwhile).
  if (ix && state.live.ixId !== ix.id) { state.sceneHead = null; refreshLiveModel(ix); }
  renderLive(ix);
  renderCapture();
}

// Reconstruct a live plan from this intersection's observations (recent-window
// re-anchored) so predictions update as you tap — this is the per-session anchor.
async function refreshLiveModel(ix) {
  const ixId = ix.id;
  state.live.ixId = ixId; // claim now so tick() doesn't re-fire every frame
  try {
    const obs = await store.observationsFor(ixId);
    const rec = reconstructPlan(obs, headsOf(ix).map((h) => h.id), { recentWindowMs: LIVE_WINDOW_MS, now: Date.now() });
    if (state.live.ixId !== ixId) return; // switched away during the await
    state.live = { ixId, plan: rec ? reconstructionToPlan(rec) : null, rec };
  } catch { if (state.live.ixId === ixId) state.live = { ixId, plan: null, rec: null }; }
}

// Live reconstruction first; else a saved plan — but only one that actually
// predicts these heads (legacy plans keyed by movement id predict nothing and
// would show a bogus "Off").
function livePlanFor(ix, now) {
  if (state.live.ixId === ix.id && state.live.plan) return state.live.plan;
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
  $('live-hint').textContent = state.selectedId
    ? 'Manually selected — tap it again to auto-follow GPS.'
    : (active ? 'Tap a color as it changes. Tap a pole to switch heads.' : '');
}

// Headline: seconds until the active head next turns green (or green time left).
function renderCountdown(plan, active, now) {
  const num = $('count-num'), cap = $('count-cap'), ind = $('ind-label'), count = $('count');
  count.classList.remove('range');
  if (!plan || !active) {
    ind.textContent = plan ? '—' : 'learning';
    num.textContent = '--';
    cap.textContent = plan ? '' : 'tap colors to learn';
    return;
  }
  const pred = predictHead(plan, active.id, now);
  ind.textContent = ASPECT_LABEL[pred?.aspect] ?? '—';
  if (pred?.aspect === 'green') {
    if (pred.uncertain && pred.range) { count.classList.add('range'); num.textContent = `${pred.range[0]}–${pred.range[1]}`; }
    else num.textContent = pred.secToChange;
    cap.textContent = pred.uncertain ? 'green · est. left' : 'green — time left';
    return;
  }
  const tg = timeToAspect(plan, active.id, now, 'green');
  if (!tg) { num.textContent = '--'; cap.textContent = 'no green in model'; return; }
  if (tg.range) { count.classList.add('range'); num.textContent = `${tg.range[0]}–${tg.range[1]}`; }
  else num.textContent = tg.uncertain ? `~${tg.secToAspect}` : tg.secToAspect;
  cap.textContent = tg.range ? 'to green · actuated, range' : tg.uncertain ? 'to green · estimate' : 'to green';
}

function renderLiveMeta(ix, plan, active) {
  const rec = state.live.ixId === ix.id ? state.live.rec : null;
  const verdict = active && rec?.headVerdicts?.[active.id];
  const parts = [];
  const conf = plan?.confidence?.level;
  if (conf) parts.push(`<span class="badge ${conf}">confidence: ${conf}</span>`);
  if (verdict === 'fixed') parts.push('<span class="badge high">fixed · predictable</span>');
  else if (verdict === 'actuated') parts.push('<span class="badge uncertain">actuated · range only</span>');
  else if (verdict === 'insufficient') parts.push('<span class="badge">need more taps</span>');
  if (active) parts.push(`<span class="badge">${esc(active.label)}</span>`);
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
    <div class="ah-top"><span class="ah-name">${esc(active.label)}</span></div>
    <div class="ah-lamps">
      <button class="cap green" data-asp="green">Green</button>
      <button class="cap yellow" data-asp="amber">Amber</button>
      <button class="cap red" data-asp="red">Red</button>
    </div>
    <div class="ah-more">
      <button class="cap flashYel small" data-asp="flash-amber">Flashing amber</button>
      <button class="cap dark small" data-asp="off">Off / dark</button>
    </div>
    <p class="ah-hint">Tap a color the instant it changes. Tapping the current color just logs presence.</p>
    <button class="ah-undo" data-act="undo" ${canUndo ? '' : 'disabled'}>↶ undo last tap</button>`;
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
  const ix = state.intersections.find((i) => i.id === ixId);
  if (ix) await refreshLiveModel(ix);
  tick();
}

const ASPECT_BTNS = [
  ['green', 'Green', 'green'], ['amber', 'Amber', 'yellow'],
  ['flash-amber', 'Flash', 'flashYel'], ['red', 'Red', 'red'], ['off', 'Off', 'dark'],
];
function colorButtonsHtml(small) {
  return ASPECT_BTNS.map(([a, label, cls]) =>
    `<button class="cap ${cls}${small ? ' small' : ''}" data-aspect="${a}">${label}</button>`).join('');
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
    const h = ix.heads?.find((x) => x.id === m.headId);
    const label = h?.name || (m.label || `${m.from}→${m.to}`);
    out.push({ id: m.headId, label });
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
      + state.intersections.map((i) => `<option value="${i.id}" ${i.id === state.selectedId ? 'selected' : ''}>${esc(i.name)}</option>`).join('');
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
      box.innerHTML = colorButtonsHtml(false);
      box.querySelectorAll('.cap').forEach((b) => (b.onclick = () => logAspect(ix.id, state.captureHead.id, b.dataset.aspect)));
    }
  }

  const log = $('cap-log');
  const logKey = String(state.captureLog.length);
  if (log.dataset.key !== logKey) {
    log.dataset.key = logKey;
    log.innerHTML = state.captureLog.slice(-12).reverse()
      .map((l) => `<div>${new Date(l.t).toLocaleTimeString()} · <b>${esc(l.aspect)}</b> · ${esc(l.head)} @ ${esc(l.ix)}</div>`).join('');
  }
}

// Is this tap a boundary (onset) or just "it's showing X" (presence)? Only an
// onset if there's evidence the head was showing something else a moment ago:
// your previous tap on it (within a max cycle) was a different color, or — with
// no recent tap — the model says it was showing another color (the re-anchor
// case). With neither, it's presence: the first "what it shows now" tap of a
// learning session must never plant a false boundary.
const TAP_MEMORY_MS = 200000;
function tapKind(ix, headId, aspect, now) {
  const last = state.lastTap[headId];
  if (last && now - last.t <= TAP_MEMORY_MS) return last.aspect === aspect ? 'presence' : 'onset';
  const plan = livePlanFor(ix, now);
  const cur = plan ? predictHead(plan, headId, now)?.aspect : null;
  return cur && cur !== aspect ? 'onset' : 'presence';
}

// Append one aspect observation for a head. `kind` (onset|presence) is inferred
// from whether the tapped color matches what the model currently shows.
async function logAspect(intersectionId, headId, aspect, kind) {
  const ix = state.intersections.find((i) => i.id === intersectionId); if (!ix || !headId) return;
  if (!kind) kind = tapKind(ix, headId, aspect, Date.now());
  const ev = {
    id: uid('obs'), intersectionId, headId, aspect, kind, t: Date.now(),
    where: state.pos ?? undefined, heading: state.heading ?? undefined,
  };
  await store.addObservation(ev);
  state.lastObs = { id: ev.id, ixId: intersectionId };
  state.lastTap[headId] = { aspect, t: ev.t };
  const head = headsOf(ix).find((h) => h.id === headId);
  state.captureLog.push({ t: ev.t, aspect: kind === 'presence' ? `${aspect} (now)` : aspect, head: head?.label ?? headId, ix: ix.name });
  if (navigator.vibrate) navigator.vibrate(30);
  await refreshLiveModel(ix);
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
}

// Reload the intersection set from the store and refresh every view.
async function reloadData() {
  state.intersections = await store.allIntersections();
  // New data (sync/import/edit) must reach the Live countdown now, not only
  // after the next intersection change.
  recomputeRanking();
  const ix = currentIntersection();
  if (ix) await refreshLiveModel(ix);
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
    onChange: reloadData,
  };
}

function analyzeApi() {
  return {
    list: () => state.intersections,
    get: (id) => state.intersections.find((i) => i.id === id),
    observationsAll: () => store.allObservationsByIntersection(),
    nowMs: () => Date.now(),
    saveIntersection: async (ix) => { await store.putIntersection(ix); },
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

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function showView(name) {
  for (const v of ['live', 'capture', 'edit', 'analyze', 'sync']) {
    $(`view-${v}`).classList.toggle('active', name === v);
    $(`tab-${v}`).setAttribute('aria-selected', String(name === v));
  }
  if (name === 'edit') refreshEditor();
  if (name === 'analyze') refreshAnalyze();
}
