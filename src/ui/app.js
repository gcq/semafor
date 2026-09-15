// Onda UI controller. Thin glue: it reads the pure core (predict, nav) and the
// store, and paints the DOM on a timer. No framework.

import * as store from '../store/db.js';
import { predictIntersection, activePlan } from '../predict/state.js';
import { rankNext } from '../nav/proximity.js';
import { uid } from '../domain/model.js';
import { mountEditor, refreshEditor } from './editor.js';
import { mountAnalyze, refreshAnalyze } from './analyze.js';
import { mountSync, autoJoinFromUrl } from './sync.js';

const ASPECT_LABEL = { green: 'Green', 'flash-amber': 'Flashing amber', amber: 'Amber', red: 'Red', off: 'Off' };

const $ = (id) => document.getElementById(id);
const state = {
  intersections: [],
  ranked: [],
  selectedId: null,        // manual override of "next"
  pos: null,               // {lat, lon}
  heading: null,
  speed: 0,
  captureHead: null,       // { ixId, id } head being watched in Capture
  captureLog: [],
};

// ---------- boot ----------
(async function boot() {
  state.intersections = await store.allIntersections();
  state.selectedId = store.getPref('selectedId', null);
  startGps();
  wireUi();
  mountEditor(document.getElementById('editor-root'), editorApi());
  mountAnalyze(document.getElementById('analyze-root'), analyzeApi());
  mountSync(document.getElementById('sync-root'), syncApi());
  if (autoJoinFromUrl()) showView('sync');
  tick();
  setInterval(tick, 250);
  registerSW();
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
  renderLive();
  renderCapture();
}

function renderLive() {
  const ix = currentIntersection();
  const disc = $('disc');
  if (!ix) { $('ix-name').textContent = 'No intersections'; return; }

  const mv = ix.movements?.find((m) => !m.unsignalized) ?? ix.movements?.[0];
  const pred = predictIntersection(ix, { movementId: mv?.id });
  $('ix-name').textContent = ix.name;

  if (!pred) {
    disc.className = 'disc'; $('ind-label').textContent = 'no active plan';
    $('count-num').textContent = '--'; $('meta').innerHTML = ''; return;
  }

  disc.className = `disc ${pred.color}`;
  $('ind-label').textContent = ASPECT_LABEL[pred.aspect] ?? pred.aspect;

  const countEl = $('count');
  if (pred.uncertain && pred.range) {
    countEl.classList.add('range');
    $('count-num').textContent = `${pred.range[0]}–${pred.range[1]}`;
  } else {
    countEl.classList.remove('range');
    $('count-num').textContent = pred.secToChange;
  }

  const plan = activePlan(ix.plans, Date.now());
  const conf = plan?.confidence?.level ?? 'low';
  const parts = [`<span class="badge ${conf}">confidence: ${conf}</span>`];
  if (plan?.name) parts.push(`<span class="badge">${plan.name}</span>`);
  if (pred.uncertain) parts.push(`<span class="badge uncertain">sensor-based · estimate</span>`);
  if (mv) parts.push(`<span class="badge">${esc(mv.label || (mv.from + '→' + mv.to))}</span>`);
  $('meta').innerHTML = parts.join('');

  // Quick color-log buttons for the head you're approaching, to keep refining.
  const head = mv?.headId;
  const box = $('live-log');
  if (head) {
    $('phase-now').innerHTML = `Log what you see for <b>${esc(mv.label || (mv.from + '→' + mv.to))}</b>:`;
    box.hidden = false;
    box.innerHTML = colorButtonsHtml(true);
    box.querySelectorAll('.cap').forEach((b) => b.onclick = () => logAspect(ix.id, head, b.dataset.aspect));
  } else {
    $('phase-now').textContent = ''; box.hidden = true;
  }

  renderUpcoming(ix);
  $('live-hint').textContent = state.selectedId ? 'Manually selected — tap it again to auto-follow GPS.' : '';
}

const ASPECT_BTNS = [
  ['green', 'Green', 'green'], ['amber', 'Amber', 'yellow'],
  ['flash-amber', 'Flash', 'flashYel'], ['red', 'Red', 'red'], ['off', 'Off', 'dark'],
];
function colorButtonsHtml(small) {
  return ASPECT_BTNS.map(([a, label, cls]) =>
    `<button class="cap ${cls}${small ? ' small' : ''}" data-aspect="${a}">${label}</button>`).join('');
}

function renderUpcoming(currentIx) {
  const list = $('upcoming-list');
  const rows = state.ranked.slice(0, 5);
  list.innerHTML = rows.map(({ intersection: ix, etaSec }) => {
    const pred = predictIntersection(ix, {});
    const color = pred?.color ?? 'dark';
    const eta = etaSec == null ? '' : etaSec > 90 ? `${Math.round(etaSec / 60)} min` : `${Math.round(etaSec)}s`;
    const sel = ix.id === currentIx.id ? ' sel' : '';
    return `<div class="row${sel}" data-id="${ix.id}">
      <span class="dot ${color}"></span>
      <span class="name">${ix.name}</span>
      <span class="eta">${eta}</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.row').forEach((r) => r.onclick = () => {
    const id = r.dataset.id;
    state.selectedId = state.selectedId === id ? null : id; // toggle manual/auto
    store.setPref('selectedId', state.selectedId);
    tick();
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
  $('cap-name').textContent = ix?.name ?? '—';
  const heads = ix ? headsOf(ix) : [];
  const sel = $('cap-head');

  if (!heads.length) {
    sel.innerHTML = '<option>—</option>';
    $('cap-buttons').innerHTML = '<p class="hint">Add signalized movements/heads in the Edit tab first.</p>';
  } else {
    if (state.captureHead?.ixId !== ix.id || !heads.find((h) => h.id === state.captureHead?.id))
      state.captureHead = { ixId: ix.id, id: heads[0].id };
    sel.innerHTML = heads.map((h) => `<option value="${h.id}" ${h.id === state.captureHead.id ? 'selected' : ''}>${esc(h.label)}</option>`).join('');
    sel.onchange = () => { state.captureHead = { ixId: ix.id, id: sel.value }; };
    const box = $('cap-buttons');
    box.innerHTML = colorButtonsHtml(false);
    box.querySelectorAll('.cap').forEach((b) => b.onclick = () => logAspect(ix.id, state.captureHead.id, b.dataset.aspect));
  }

  $('cap-log').innerHTML = state.captureLog.slice(-12).reverse()
    .map((l) => `<div>${new Date(l.t).toLocaleTimeString()} · <b>${esc(l.aspect)}</b> · ${esc(l.head)} @ ${esc(l.ix)}</div>`).join('');
}

// Append one aspect observation for a head.
async function logAspect(intersectionId, headId, aspect) {
  const ix = state.intersections.find((i) => i.id === intersectionId); if (!ix || !headId) return;
  const ev = {
    id: uid('obs'), intersectionId, headId, aspect, t: Date.now(),
    where: state.pos ?? undefined, heading: state.heading ?? undefined,
  };
  await store.addObservation(ev);
  const head = headsOf(ix).find((h) => h.id === headId);
  state.captureLog.push({ t: ev.t, aspect, head: head?.label ?? headId, ix: ix.name });
  if (navigator.vibrate) navigator.vibrate(30);
  renderCapture();
}

// ---------- wiring ----------
function wireUi() {
  $('tab-live').onclick = () => showView('live');
  $('tab-capture').onclick = () => showView('capture');
  $('tab-edit').onclick = () => showView('edit');
  $('tab-analyze').onclick = () => showView('analyze');
  $('tab-sync').onclick = () => showView('sync');
}

// Reload the intersection set from the store and refresh every view.
async function reloadData() {
  state.intersections = await store.allIntersections();
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
    importBundle: async (bundle) => { await store.importAll(bundle, { merge: true }); await reloadData(); },
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
