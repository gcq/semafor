// Editor — STRUCTURE ONLY (phasing is observed, not authored here).
// You define arms, movements, assign each movement to a head (split/merge), and
// place masts. Heads show on the map as colored dots; if the intersection has a
// reconstructed plan you can step its phases to preview, otherwise they're grey.
// DOM + wiring only.

import { makeIntersection, uid, validateIntersection, MOVE_KINDS, ASPECT_INFO } from '../domain/model.js';
import { headLabel, ensureHeadsForMovements, reconcileMasts, movementsOfHead } from '../inference/heads.js';

const ASPECT_HEX = { green: '#1ea966', amber: '#e0a800', 'flash-amber': '#e0a800', red: '#e23b3b', off: '#8a93a3' };

let ctx = null, draft = null, editId = null;
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
  clearMasts();
  const ix = editId ? ctx.api.get(editId) : null;
  draft = ix ? structuredClone(ix) : null;
  if (draft) ensureHeadsForMovements(draft, () => uid('head'), (i) => `Head ${i + 1}`);
}

const armName = (id) => draft.arms.find((a) => a.id === id)?.name || id;
const headIds = () => [...new Set(draft.movements.filter((m) => !m.unsignalized && m.headId).map((m) => m.headId))];
const plan = () => draft.plans?.[0] ?? null;
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- map ----------
function mapReady() { return typeof L !== 'undefined' && document.getElementById('view-edit')?.classList.contains('active'); }

function ensureMap() {
  if (map || !mapReady()) return map;
  const el = document.getElementById('ed-map'); if (!el) return null;
  map = L.map(el, { zoomControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '© OpenStreetMap' }).addTo(map);
  const pin = L.divIcon({ className: '', html: '<div class="onda-pin"></div>', iconSize: [20, 20], iconAnchor: [10, 20] });
  centerMarker = L.marker([0, 0], { draggable: true, icon: pin }).addTo(map);
  centerMarker.on('dragend', () => { const ll = centerMarker.getLatLng(); draft.location = { lat: round6(ll.lat), lon: round6(ll.lng) }; updateCoords(); });
  map.on('click', (e) => { centerMarker.setLatLng(e.latlng); draft.location = { lat: round6(e.latlng.lat), lon: round6(e.latlng.lng) }; updateCoords(); });
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
  const dots = aspects.map((a) => {
    const dash = a === 'flash-amber' ? 'border-style:dashed;' : '';
    return `<div style="width:16px;height:16px;border-radius:50%;background:${ASPECT_HEX[a] ?? ASPECT_HEX.off};border:2px solid #fff;${dash}"></div>`;
  }).join('');
  const h = aspects.length * 18 + 4;
  return L.divIcon({ className: '', iconSize: [20, h], iconAnchor: [10, h / 2],
    html: `<div style="display:flex;flex-direction:column;gap:2px;align-items:center;padding:2px;background:#2226;border-radius:9px;box-shadow:0 1px 4px #0006">${dots}</div>` });
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
  const c = has ? [lat, lon] : [ctx.api.gpsNow()?.lat ?? -34.6, ctx.api.gpsNow()?.lon ?? -58.42];
  centerMarker.setLatLng(c);
  map.setView(c, has ? 18 : 13);
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
        if (cur) cur.pos = { lat: round6(ll.lat), lon: round6(ll.lng) };
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
    ctx.root.innerHTML = `<div class="ed-section"><p class="muted-note">No intersection yet.</p>
      <button class="sbtn primary" data-act="new">+ New intersection</button></div>`;
    return;
  }
  reconcile();
  const p = plan();
  const N = p?.stages?.length ?? 0;
  ctx.root.innerHTML = `
    ${N ? `<div class="ed-section" style="display:flex;align-items:center;gap:8px">
      <span class="muted-note" style="flex:1">Preview reconstructed phase</span>
      <button class="sbtn" data-act="phase-prev">◀</button>
      <span style="min-width:80px;text-align:center;font-weight:600">${previewPhase + 1}/${N}</span>
      <button class="sbtn" data-act="phase-next">▶</button>
    </div>` : '<div class="ed-section"><p class="muted-note">No phasing yet — capture observations, then Analyze reconstructs it. Heads show grey until then.</p></div>'}

    <div class="ed-section">
      <div class="field"><label>Editing</label>
        <select data-act="edit-pick">${list.map((i) => `<option value="${i.id}" ${i.id === editId ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select>
      </div>
      <div class="row-actions">
        <button class="sbtn" data-act="new">+ New</button>
        <button class="sbtn danger" data-act="delete">Delete</button>
        <button class="sbtn primary" data-act="save" style="margin-left:auto">Save</button>
      </div>
      <div class="muted-note" id="ed-status" style="margin-top:8px"></div>
    </div>

    <div class="ed-section">
      <h3>Intersection</h3>
      <div class="field"><label>Name</label><input data-act="name" value="${esc(draft.name)}" /></div>
      <div class="field"><label>Location</label>
        <span id="ed-coords" class="muted-note" style="flex:1">${draft.location.lat}, ${draft.location.lon}</span>
        <button class="sbtn" data-act="use-gps">Use GPS</button></div>
      <p class="muted-note">Tap the map or drag the ▸ pin. Colored dots = heads (stacked per mast).</p>
    </div>

    <div class="ed-section">
      <h3>Arms (roads meeting the junction)</h3>
      ${draft.arms.map((a) => `<div class="field">
        <input data-act="arm-name" data-id="${a.id}" value="${esc(a.name || '')}" placeholder="e.g. N Córdoba" />
        <button class="sbtn danger" data-act="del-arm" data-id="${a.id}">✕</button></div>`).join('') || '<p class="muted-note">No arms yet.</p>'}
      <button class="sbtn" data-act="add-arm">+ Add arm</button>
    </div>

    <div class="ed-section">
      <h3>Movements → heads</h3>
      <p class="muted-note" style="margin-top:-4px">Pick a head to group movements onto one light; “new head” splits a movement onto its own.</p>
      ${draft.arms.length < 2 ? '<p class="muted-note">Add at least two arms first.</p>'
        : draft.movements.map((m, i) => movementHtml(m, i)).join('') || '<p class="muted-note">No movements yet.</p>'}
      ${draft.arms.length >= 2 ? '<button class="sbtn" data-act="add-move">+ Add movement</button>' : ''}
    </div>

    <div class="ed-section">
      <h3>Heads (${headIds().length})</h3>
      ${headIds().map((hid) => {
        const h = draft.heads.find((x) => x.id === hid) || { id: hid };
        const movs = movementsOfHead(draft, hid).map((m) => `${armName(m.from)}→${armName(m.to)}`).join(', ');
        return `<div class="field">
          <span class="swatch" style="background:${ASPECT_HEX[headAspect(hid)]}"></span>
          <input data-act="head-name" data-id="${hid}" value="${esc(h.name || '')}" placeholder="head name" />
          <span class="muted-note" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(movs)}</span>
        </div>`;
      }).join('') || '<p class="muted-note">Heads appear as you add movements.</p>'}
    </div>

    ${mastsSectionHtml()}`;
  rebuildMasts();
}

function movementHtml(m, i) {
  const armOpts = (sel) => draft.arms.map((a) => `<option value="${a.id}" ${sel === a.id ? 'selected' : ''}>${esc(a.name || a.id)}</option>`).join('');
  const headOpts = () => headIds().map((hid) => {
    const h = draft.heads.find((x) => x.id === hid);
    return `<option value="${hid}" ${m.headId === hid ? 'selected' : ''}>${esc(h?.name || headLabel(draft, hid))}</option>`;
  }).join('') + `<option value="__new">＋ new head (split)</option>`;
  return `<div class="stage">
    <div class="field" style="margin-bottom:6px">
      <select data-act="mv-from" data-i="${i}">${armOpts(m.from)}</select><span>→</span>
      <select data-act="mv-to" data-i="${i}">${armOpts(m.to)}</select>
      <button class="sbtn danger" data-act="del-move" data-i="${i}">✕</button>
    </div>
    <div class="field">
      <input data-act="mv-label" data-i="${i}" value="${esc(m.label || '')}" placeholder="label (bus, lane 2…)" style="width:96px" />
      <select data-act="mv-kind" data-i="${i}" style="width:auto">${MOVE_KINDS.map((k) => `<option value="${k}" ${(m.kind || 'vehicle') === k ? 'selected' : ''}>${k}</option>`).join('')}</select>
      ${m.unsignalized ? '<span class="muted-note" style="flex:1">unsignalized</span>'
        : `<label class="muted-note" style="flex:1">head <select data-act="mv-head" data-i="${i}">${headOpts()}</select></label>`}
      <label class="muted-note" style="display:flex;align-items:center;gap:3px;width:auto"><input type="checkbox" data-act="mv-unsig" data-i="${i}" style="width:auto" ${m.unsignalized ? 'checked' : ''}/> unsig</label>
    </div>
  </div>`;
}

function mastsSectionHtml() {
  const hids = headIds();
  if (!hids.length) return '';
  return `<div class="ed-section">
    <h3>Masts on the map (${draft.masts.length})</h3>
    <p class="muted-note" style="margin-top:-4px">Each pole shows one+ heads. Median (same head, two poles): add a mast and tick that head.</p>
    ${draft.masts.map((mast, mi) => `
      <div class="stage">
        <div class="field" style="margin-bottom:6px">
          <span class="idx">${mi + 1}</span>
          <span class="muted-note" style="flex:1">${mast.headIds.length} head${mast.headIds.length === 1 ? '' : 's'}</span>
          <button class="sbtn" data-act="dup-mast" data-mid="${mast.id}">duplicate</button>
          <button class="sbtn danger" data-act="del-mast" data-mid="${mast.id}">✕</button>
        </div>
        ${hids.map((hid) => `<label class="sg-row" style="cursor:pointer">
          <input type="checkbox" data-act="mast-head" data-mid="${mast.id}" data-hid="${hid}" style="width:auto" ${mast.headIds.includes(hid) ? 'checked' : ''}/>
          <span class="sg-name" style="flex:1">${esc(headLabel(draft, hid))}</span>
        </label>`).join('')}
      </div>`).join('')}
    <button class="sbtn" data-act="add-mast">+ Add mast</button>
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
  }
}

// ---------- change ----------
function onChange(e) {
  const el = e.target, act = el.dataset.act; if (!act || !draft) return;
  const i = Number(el.dataset.i);
  switch (act) {
    case 'edit-pick': editId = el.value; loadDraft(); rerender(); syncMap(); break;
    case 'mv-from': draft.movements[i].from = el.value; rerender(); break;
    case 'mv-to': draft.movements[i].to = el.value; rerender(); break;
    case 'mv-kind': draft.movements[i].kind = el.value; break;
    case 'mv-unsig': draft.movements[i].unsignalized = el.checked;
      ensureHeadsForMovements(draft, () => uid('head'), (k) => `Head ${k + 1}`); rerender(); break;
    case 'mv-head': {
      if (el.value === '__new') { const id = uid('head'); draft.heads.push({ id, name: '' }); draft.movements[i].headId = id; }
      else draft.movements[i].headId = el.value;
      ensureHeadsForMovements(draft, () => uid('head'), (k) => `Head ${k + 1}`); rerender(); break;
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
  switch (act) {
    case 'phase-prev': previewPhase = (previewPhase - 1 + N) % N; rerender(); break;
    case 'phase-next': previewPhase = (previewPhase + 1) % N; rerender(); break;
    case 'new': {
      const loc = ctx.api.gpsNow() ?? { lat: 0, lon: 0 };
      const ix = makeIntersection({ name: 'New intersection', location: loc });
      await ctx.api.save(ix); editId = ix.id; ctx.api.onChange(); loadDraft(); rerender(); syncMap(); status('Created — add arms, then movements.'); break;
    }
    case 'delete': if (draft && confirm(`Delete “${draft.name}”?`)) { await ctx.api.remove(draft.id); editId = null; ctx.api.onChange(); refreshEditor(); } break;
    case 'save': return save();
    case 'use-gps': { const loc = ctx.api.gpsNow(); if (loc) { draft.location = { ...loc }; rerender(); syncMap(); status('Filled from GPS.'); } else status('No GPS fix.'); break; }
    case 'add-arm': draft.arms.push({ id: uid('arm'), name: `Arm ${draft.arms.length + 1}` }); rerender(); break;
    case 'del-arm': {
      const id = btn.dataset.id;
      draft.arms = draft.arms.filter((a) => a.id !== id);
      draft.movements = draft.movements.filter((m) => m.from !== id && m.to !== id);
      ensureHeadsForMovements(draft, () => uid('head'), (k) => `Head ${k + 1}`); rerender(); break;
    }
    case 'add-move': {
      const a = draft.arms, hid = uid('head');
      draft.heads.push({ id: hid, name: '' });
      draft.movements.push({ id: uid('mv'), from: a[0].id, to: a[1]?.id ?? a[0].id, kind: 'vehicle', label: '', headId: hid });
      rerender(); break;
    }
    case 'del-move': draft.movements.splice(i, 1); ensureHeadsForMovements(draft, () => uid('head'), (k) => `Head ${k + 1}`); rerender(); break;
    case 'add-mast': { const hs = headIds(); draft.masts.push({ id: uid('mast'), pos: defaultPos(draft.location, draft.masts.length, draft.masts.length + 1), headIds: hs[0] ? [hs[0]] : [] }); rerender(); break; }
    case 'dup-mast': {
      const src = draft.masts.find((m) => m.id === btn.dataset.mid); if (!src) break;
      const cosLat = Math.cos((draft.location.lat * Math.PI) / 180) || 1;
      draft.masts.push({ id: uid('mast'), pos: { lat: round6(src.pos.lat), lon: round6(src.pos.lon + 0.00012 / cosLat) }, headIds: [...src.headIds] });
      rerender(); break;
    }
    case 'del-mast': draft.masts = draft.masts.filter((m) => m.id !== btn.dataset.mid); rerender(); break;
  }
}

async function save() {
  draft.updatedAt = Date.now();
  draft.rev = (draft.rev ?? 0) + 1; // bump so sync knows this edit is newer
  const errs = validateIntersection(draft);
  if (errs.length) { status('Cannot save: ' + errs[0], true); return; }
  await ctx.api.save(structuredClone(draft));
  ctx.api.onChange();
  status('Saved ✓');
}

function status(msg, bad = false) {
  const el = document.getElementById('ed-status');
  if (el) { el.textContent = msg; el.style.color = bad ? 'var(--red)' : 'var(--muted)'; }
}
