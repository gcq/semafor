// Editor — STRUCTURE ONLY (phasing is observed, not authored here).
// You define arms, movements, assign each movement to a head (split/merge), and
// place masts. Heads show on the map as colored dots; if the intersection has a
// reconstructed plan you can step its phases to preview, otherwise they're grey.
// DOM + wiring only.

import { makeIntersection, uid, validateIntersection, MOVE_KINDS } from '../domain/model.js';
import { headLabel, ensureHeadsForMovements, reconcileMasts, movementsOfHead } from '../inference/heads.js';
import { esc, ASPECT_HEX, icon, intersectionOptions } from './dom.js';

let ctx = null, draft = null, editId = null;
let dirty = false; // unsaved edits in the draft (drives the sticky save bar)
let map = null, centerMarker = null, mastMarkers = {}, previewPhase = 0;

export function mountEditor(root, api) {
  ctx = { root, api };
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);
  refreshEditor();
}

export function refreshEditor() {
  if (!ctx) return;
  const list = ctx.api.list();
  if (!editId || !list.find((i) => i.id === editId)) editId = list[0]?.id ?? null;
  loadDraft();
  rerender();
  syncMap();
}

function loadDraft() {
  previewPhase = 0;
  dirty = false;
  clearMasts();
  const ix = editId ? ctx.api.get(editId) : null;
  draft = ix ? structuredClone(ix) : null;
  if (draft) ensureHeadsForMovements(draft, () => uid('head'), (i) => `Light ${i + 1}`);
}

const armName = (id) => draft.arms.find((a) => a.id === id)?.name || id;
const headIds = () => [...new Set(draft.movements.filter((m) => !m.unsignalized && m.headId).map((m) => m.headId))];
const plan = () => (draft ? ctx.api.model(draft.id) : null); // the auto-rebuilt model, never a saved copy
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// ---------- map ----------
function mapReady() { return typeof L !== 'undefined' && document.getElementById('view-edit')?.classList.contains('active'); }

function ensureMap() {
  if (map || !mapReady()) return map;
  const el = document.getElementById('ed-map'); if (!el) return null;
  map = L.map(el, { zoomControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '© OpenStreetMap' }).addTo(map);
  const pin = L.divIcon({ className: '', html: '<div class="onda-pin"></div>', iconSize: [20, 20], iconAnchor: [10, 20] });
  centerMarker = L.marker([0, 0], { draggable: true, icon: pin }).addTo(map);
  centerMarker.on('dragend', () => { const ll = centerMarker.getLatLng(); draft.location = { lat: round6(ll.lat), lon: round6(ll.lng) }; updateCoords(); markDirty(); });
  map.on('click', (e) => { centerMarker.setLatLng(e.latlng); draft.location = { lat: round6(e.latlng.lat), lon: round6(e.latlng.lng) }; updateCoords(); markDirty(); });
  return map;
}

// head aspect for the previewed phase (grey if no reconstructed plan yet)
function headAspect(headId) {
  const p = plan();
  if (!p?.stages?.length) return 'off';
  const ph = p.stages[Math.min(previewPhase, p.stages.length - 1)];
  return ph?.states?.[headId] ?? 'off';
}

function mastIcon(aspects) {
  const dots = aspects.map((a) => `<i class="pole-dot${a === 'flash-amber' ? ' flash' : ''}" style="background:${ASPECT_HEX[a] ?? ASPECT_HEX.off}"></i>`).join('');
  const w = aspects.length * 18 + 4; // a pole's lights in a row, left -> right as you face them
  return L.divIcon({ className: '', iconSize: [w, 20], iconAnchor: [w / 2, 10], html: `<div class="pole-icon">${dots}</div>` });
}

function defaultPos(center, i, n) {
  const R = 0.00025, ang = (i / Math.max(1, n)) * 2 * Math.PI - Math.PI / 2;
  const cosLat = Math.cos((center.lat * Math.PI) / 180) || 1;
  return { lat: round6(center.lat + R * Math.cos(ang)), lon: round6(center.lon + (R * Math.sin(ang)) / cosLat) };
}

function clearMasts() { if (map) for (const id of Object.keys(mastMarkers)) map.removeLayer(mastMarkers[id]); mastMarkers = {}; }

function reconcile() {
  if (!draft) return;
  draft.masts = reconcileMasts(draft.masts, headIds(), (i, n) => defaultPos(draft.location, i, n), () => uid('mast'));
}

function syncMap() {
  if (!ensureMap() || !draft) return;
  const { lat, lon } = draft.location;
  const has = Number.isFinite(lat) && (lat !== 0 || lon !== 0);
  const gps = ctx.api.gpsNow();
  const other = ctx.api.list().find((i) => i.location && (i.location.lat || i.location.lon))?.location;
  const guess = gps ?? other;
  const c = has ? [lat, lon] : guess ? [guess.lat, guess.lon] : [20, 0];
  centerMarker.setLatLng(c);
  map.setView(c, has ? 18 : guess ? 16 : 2);
  rebuildMasts();
  setTimeout(() => map.invalidateSize(), 0);
}

function rebuildMasts() {
  if (!map || !draft) return;
  reconcile();
  const ids = new Set(draft.masts.map((m) => m.id));
  for (const id of Object.keys(mastMarkers)) if (!ids.has(id)) { map.removeLayer(mastMarkers[id]); delete mastMarkers[id]; }
  for (const mast of draft.masts) {
    const aspects = mast.headIds.map((hid) => headAspect(hid));
    const label = mast.headIds.map((hid) => headLabel(draft, hid)).join(' · ');
    let m = mastMarkers[mast.id];
    if (!m) {
      const mastId = mast.id; // reconcile() clones draft.masts each render, so
      m = L.marker([mast.pos.lat, mast.pos.lon], { draggable: true, icon: mastIcon(aspects) }).addTo(map);
      m.bindTooltip(label, { permanent: true, direction: 'right', offset: [11, 0], className: 'onda-tip' });
      m.on('dragend', () => {                       // look the mast up fresh by id
        const ll = m.getLatLng();
        const cur = draft.masts.find((x) => x.id === mastId);
        if (cur) { cur.pos = { lat: round6(ll.lat), lon: round6(ll.lng) }; markDirty(); }
      });
      mastMarkers[mast.id] = m;
    } else {
      m.setLatLng([mast.pos.lat, mast.pos.lon]); m.setIcon(mastIcon(aspects)); m.setTooltipContent(label);
    }
  }
}

function updateCoords() { const el = document.getElementById('ed-coords'); if (el && draft) el.textContent = `${draft.location.lat}, ${draft.location.lon}`; }

// ---------- render ----------
function rerender() {
  const list = ctx.api.list();
  if (!draft) {
    ctx.root.innerHTML = `<div class="card"><p class="note">No intersection yet.</p>
      <button class="btn primary" data-act="new">${icon('plus')} New intersection</button></div>`;
    return;
  }
  reconcile();
  const p = plan();
  const N = p?.stages?.length ?? 0;
  const lights = headIds();
  ctx.root.innerHTML = `
    <div class="card">
      <div class="field"><label for="ed-pick">Editing</label>
        <select id="ed-pick" class="grow" data-act="edit-pick">${intersectionOptions(list, editId)}</select></div>
      <div class="actions">
        <button class="btn" data-act="new">${icon('plus')} New</button>
        <button class="btn danger" data-act="delete">Delete</button>
      </div>
    </div>

    ${N ? `<div class="card stepper">
      <span class="note grow">Preview the learned timing on the map</span>
      <button class="btn icon" data-act="phase-prev" aria-label="Previous phase">${icon('left')}</button>
      <span class="pos">${previewPhase + 1} / ${N}</span>
      <button class="btn icon" data-act="phase-next" aria-label="Next phase">${icon('right')}</button>
    </div>` : '<div class="card"><p class="note">No timing learned yet — capture a few cycles of taps and it’s rebuilt automatically. Lights show grey until then.</p></div>'}

    <div class="card">
      <h3>Intersection</h3>
      <div class="field"><label for="ed-name">Name</label><input id="ed-name" class="grow" data-act="name" value="${esc(draft.name)}" /></div>
      <div class="field"><label>Location</label>
        <span id="ed-coords" class="note grow">${draft.location.lat}, ${draft.location.lon}</span>
        <button class="btn" data-act="use-gps">Use GPS</button></div>
      <p class="note small">Tap the map or drag the pin to move it. Dots are lights, one row per pole.</p>
    </div>

    <div class="card">
      <h3>Roads meeting the junction</h3>
      ${draft.arms.map((a) => `<div class="field">
        <input class="grow" data-act="arm-name" data-id="${a.id}" value="${esc(a.name || '')}" placeholder="Road name" />
        <button class="btn icon danger" data-act="del-arm" data-id="${a.id}" aria-label="Remove road">${icon('close')}</button></div>`).join('') || '<p class="note">No roads yet.</p>'}
      <button class="btn" data-act="add-arm">${icon('plus')} Add road</button>
    </div>

    <div class="card">
      <h3>Movements</h3>
      <p class="note small">Each movement is controlled by one light. Choose “New light” to give a movement its own light — e.g. a separate left-turn lane.</p>
      ${draft.arms.length < 2 ? '<p class="note">Add at least two roads first.</p>'
        : draft.movements.map((m, i) => movementHtml(m, i)).join('') || '<p class="note">No movements yet.</p>'}
      ${draft.arms.length >= 2 ? `<button class="btn" data-act="add-move">${icon('plus')} Add movement</button>` : ''}
    </div>

    <div class="card">
      <h3>Lights (${lights.length})</h3>
      ${lights.map((hid) => {
        const h = draft.heads.find((x) => x.id === hid) || { id: hid };
        const movs = movementsOfHead(draft, hid).map((m) => `${armName(m.from)} → ${armName(m.to)}`).join(', ');
        return `<div class="light-row">
          <span class="swatch" style="background:${ASPECT_HEX[headAspect(hid)]}"></span>
          <input data-act="head-name" data-id="${hid}" value="${esc(h.name || '')}" placeholder="Light name" />
          <span class="note ellipsis">${esc(movs)}</span>
        </div>`;
      }).join('') || '<p class="note">Lights appear as you add movements.</p>'}
    </div>

    ${mastsSectionHtml()}

    <div class="save-bar${dirty ? ' dirty' : ''}" id="ed-savebar">
      <span class="note" id="ed-status">${dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      <button class="btn primary" data-act="save">Save</button>
    </div>`;
  rebuildMasts();
}

function movementHtml(m, i) {
  const armOpts = (sel) => draft.arms.map((a) => `<option value="${a.id}" ${sel === a.id ? 'selected' : ''}>${esc(a.name || a.id)}</option>`).join('');
  const headOpts = () => headIds().map((hid) => {
    const h = draft.heads.find((x) => x.id === hid);
    return `<option value="${hid}" ${m.headId === hid ? 'selected' : ''}>${esc(h?.name || headLabel(draft, hid))}</option>`;
  }).join('') + '<option value="__new">New light (split)</option>';
  return `<div class="sub-card">
    <div class="mv-route">
      <select data-act="mv-from" data-i="${i}" aria-label="From">${armOpts(m.from)}</select>
      ${icon('arrow')}
      <select data-act="mv-to" data-i="${i}" aria-label="To">${armOpts(m.to)}</select>
      <button class="btn icon danger" data-act="del-move" data-i="${i}" aria-label="Remove movement">${icon('close')}</button>
    </div>
    <div class="mv-opts">
      ${m.unsignalized
        ? '<div class="fld"><span>Light</span><div class="note">None — not captured</div></div>'
        : `<label class="fld"><span>Light</span><select data-act="mv-head" data-i="${i}">${headOpts()}</select></label>`}
      <label class="fld"><span>Label (optional)</span><input data-act="mv-label" data-i="${i}" value="${esc(m.label || '')}" placeholder="bus, lane 2…" /></label>
      <label class="fld narrow"><span>Kind</span><select data-act="mv-kind" data-i="${i}">${MOVE_KINDS.map((k) => `<option value="${k}" ${(m.kind || 'vehicle') === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" data-act="mv-unsig" data-i="${i}" ${m.unsignalized ? 'checked' : ''}/> No light</label>
    </div>
  </div>`;
}

function mastsSectionHtml() {
  const hids = headIds();
  if (!hids.length) return '';
  return `<div class="card">
    <h3>Poles on the map (${draft.masts.length})</h3>
    <p class="note small">Tick which lights each pole carries. One light on two poles (e.g. a median) is fine.</p>
    ${draft.masts.map((mast, mi) => `
      <div class="sub-card">
        <div class="pole-head">
          <span class="idx">${mi + 1}</span>
          <span class="note">${mast.headIds.length} light${mast.headIds.length === 1 ? '' : 's'}</span>
          <button class="btn" data-act="dup-mast" data-mid="${mast.id}">Duplicate</button>
          <button class="btn icon danger" data-act="del-mast" data-mid="${mast.id}" aria-label="Remove pole">${icon('close')}</button>
        </div>
        ${hids.map((hid) => `<label class="check">
          <input type="checkbox" data-act="mast-head" data-mid="${mast.id}" data-hid="${hid}" ${mast.headIds.includes(hid) ? 'checked' : ''}/>
          <span>${esc(headLabel(draft, hid))}</span>
        </label>`).join('')}
        ${mast.headIds.length > 1 ? `
          <p class="note small">Order on this pole — left to right as you face it:</p>
          <div class="actions">${mast.headIds.map((hid, i) => `
            <span class="order">
              <button class="btn icon" data-act="mast-move" data-mid="${mast.id}" data-hid="${hid}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move left">${icon('left')}</button>
              <span>${i + 1}. ${esc(headLabel(draft, hid))}</span>
              <button class="btn icon" data-act="mast-move" data-mid="${mast.id}" data-hid="${hid}" data-dir="1" ${i === mast.headIds.length - 1 ? 'disabled' : ''} aria-label="Move right">${icon('right')}</button>
            </span>`).join('')}
          </div>` : ''}
      </div>`).join('')}
    <button class="btn" data-act="add-mast">${icon('plus')} Add pole</button>
  </div>`;
}

// ---------- input ----------
function onInput(e) {
  const el = e.target, act = el.dataset.act; if (!act || !draft) return;
  const i = Number(el.dataset.i);
  switch (act) {
    case 'name': draft.name = el.value; break;
    case 'arm-name': { const a = draft.arms.find((x) => x.id === el.dataset.id); if (a) a.name = el.value; break; }
    case 'mv-label': draft.movements[i].label = el.value; break;
    case 'head-name': { const h = draft.heads.find((x) => x.id === el.dataset.id); if (h) h.name = el.value; break; }
    default: return;
  }
  markDirty();
}

// ---------- change ----------
function onChange(e) {
  const el = e.target, act = el.dataset.act; if (!act || !draft) return;
  const i = Number(el.dataset.i);
  if (act !== 'edit-pick') dirty = true; // every other change edits the draft
  switch (act) {
    case 'edit-pick':
      if (dirty && !confirm(`Discard unsaved changes to “${draft.name}”?`)) { el.value = editId; return; }
      editId = el.value; loadDraft(); rerender(); syncMap(); return;
    case 'mv-from': draft.movements[i].from = el.value; rerender(); break;
    case 'mv-to': draft.movements[i].to = el.value; rerender(); break;
    case 'mv-kind': draft.movements[i].kind = el.value; break;
    case 'mv-unsig': draft.movements[i].unsignalized = el.checked;
      ensureHeadsForMovements(draft, () => uid('head'), (k) => `Light ${k + 1}`); rerender(); break;
    case 'mv-head': {
      if (el.value === '__new') { const id = uid('head'); draft.heads.push({ id, name: '' }); draft.movements[i].headId = id; }
      else draft.movements[i].headId = el.value;
      ensureHeadsForMovements(draft, () => uid('head'), (k) => `Light ${k + 1}`); rerender(); break;
    }
    case 'mast-head': {
      const mast = draft.masts.find((m) => m.id === el.dataset.mid); if (!mast) break;
      const hid = el.dataset.hid;
      if (el.checked) { if (!mast.headIds.includes(hid)) mast.headIds.push(hid); }
      else mast.headIds = mast.headIds.filter((k) => k !== hid);
      rerender(); break;
    }
  }
}

// ---------- click ----------
async function onClick(e) {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const act = btn.dataset.act, i = Number(btn.dataset.i);
  if (['name','arm-name','mv-label','head-name','edit-pick','mv-from','mv-to','mv-kind','mv-unsig','mv-head','mast-head'].includes(act)) return;
  const N = (draft && plan()?.stages?.length) || 1;
  const edits = ['use-gps', 'add-arm', 'del-arm', 'add-move', 'del-move', 'add-mast', 'dup-mast', 'del-mast', 'mast-move'];
  if (edits.includes(act)) dirty = true;
  switch (act) {
    case 'phase-prev': previewPhase = (previewPhase - 1 + N) % N; rerender(); break;
    case 'phase-next': previewPhase = (previewPhase + 1) % N; rerender(); break;
    case 'new': {
      if (dirty && !confirm(`Discard unsaved changes to “${draft.name}”?`)) break;
      const loc = ctx.api.gpsNow() ?? { lat: 0, lon: 0 };
      const ix = makeIntersection({ name: 'New intersection', location: loc });
      await ctx.api.save(ix); editId = ix.id; await ctx.api.onChange(); loadDraft(); rerender(); syncMap(); status('Created — add roads, then movements.'); break;
    }
    case 'delete': if (draft && confirm(`Delete “${draft.name}”?`)) { await ctx.api.remove(draft.id); editId = null; ctx.api.onChange(); refreshEditor(); } break;
    case 'save': return save();
    case 'use-gps': { const loc = ctx.api.gpsNow(); if (loc) { draft.location = { ...loc }; rerender(); syncMap(); status('Filled from GPS.'); } else status('No GPS fix.'); break; }
    case 'add-arm': draft.arms.push({ id: uid('arm'), name: `Road ${draft.arms.length + 1}` }); rerender(); break;
    case 'del-arm': {
      const id = btn.dataset.id;
      draft.arms = draft.arms.filter((a) => a.id !== id);
      draft.movements = draft.movements.filter((m) => m.from !== id && m.to !== id);
      ensureHeadsForMovements(draft, () => uid('head'), (k) => `Light ${k + 1}`); rerender(); break;
    }
    case 'add-move': {
      const a = draft.arms, hid = uid('head');
      draft.heads.push({ id: hid, name: '' });
      draft.movements.push({ id: uid('mv'), from: a[0].id, to: a[1]?.id ?? a[0].id, kind: 'vehicle', label: '', headId: hid });
      rerender(); break;
    }
    case 'del-move': draft.movements.splice(i, 1); ensureHeadsForMovements(draft, () => uid('head'), (k) => `Light ${k + 1}`); rerender(); break;
    case 'add-mast': { const hs = headIds(); draft.masts.push({ id: uid('mast'), pos: defaultPos(draft.location, draft.masts.length, draft.masts.length + 1), headIds: hs[0] ? [hs[0]] : [] }); rerender(); break; }
    case 'dup-mast': {
      const src = draft.masts.find((m) => m.id === btn.dataset.mid); if (!src) break;
      const cosLat = Math.cos((draft.location.lat * Math.PI) / 180) || 1;
      draft.masts.push({ id: uid('mast'), pos: { lat: round6(src.pos.lat), lon: round6(src.pos.lon + 0.00012 / cosLat) }, headIds: [...src.headIds] });
      rerender(); break;
    }
    case 'del-mast': draft.masts = draft.masts.filter((m) => m.id !== btn.dataset.mid); rerender(); break;
    case 'mast-move': {
      const mast = draft.masts.find((m) => m.id === btn.dataset.mid); if (!mast) break;
      const i = mast.headIds.indexOf(btn.dataset.hid), j = i + Number(btn.dataset.dir);
      if (i < 0 || j < 0 || j >= mast.headIds.length) break;
      [mast.headIds[i], mast.headIds[j]] = [mast.headIds[j], mast.headIds[i]];
      rerender(); break;
    }
  }
}

async function save() {
  draft.updatedAt = Date.now();
  draft.rev = (draft.rev ?? 0) + 1; // bump so sync knows this edit is newer
  const errs = validateIntersection(draft);
  if (errs.length) { status('Cannot save: ' + errs[0], true); return; }
  await ctx.api.save(structuredClone(draft));
  await ctx.api.onChange(); // re-renders the editor (and clears `dirty`), so set the status after
  status('Saved ✓');
}

function markDirty() {
  dirty = true;
  const bar = document.getElementById('ed-savebar');
  if (bar) { bar.classList.add('dirty'); bar.querySelector('#ed-status').textContent = 'Unsaved changes'; }
}

function status(msg, bad = false) {
  const el = document.getElementById('ed-status');
  if (el) { el.textContent = msg; el.classList.toggle('error', bad); }
}
