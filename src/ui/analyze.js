// Analyze view: reconstruct phasing from the observation log (read-only), show
// coverage gaps ("watch this to fill in"), and detect coordinated corridors.

import { characterizeIntersection, characterizeNetwork } from '../inference/characterize.js';
import { activePlan } from '../predict/state.js';
import { withCycleLength, ASPECT_INFO } from '../domain/model.js';
import { headLabel } from '../inference/heads.js';

const ASPECT_HEX = { green: '#1ea966', amber: '#e0a800', 'flash-amber': '#e0a800', red: '#e23b3b', off: '#8a93a3' };

let ctx = null, anaId = null, observationsByIx = {};
let network = { corridors: [], verdicts: [], estimates: {} };

export function mountAnalyze(root, api) {
  ctx = { root, api };
  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);
}

export async function refreshAnalyze() {
  if (!ctx) return;
  const list = ctx.api.list();
  if (!anaId || !list.find((i) => i.id === anaId)) anaId = list[0]?.id ?? null;
  observationsByIx = await ctx.api.observationsAll();
  network = characterizeNetwork(list, observationsByIx, (ix) => activePlan(ix.plans, ctx.api.nowMs()) ?? ix.plans[0]);
  render();
}

const nameOf = (id) => ctx.api.get(id)?.name ?? id;

function render() {
  const list = ctx.api.list();
  const ix = anaId ? ctx.api.get(anaId) : null;
  const obs = observationsByIx[anaId] ?? [];
  const c = ix ? characterizeIntersection(ix, obs) : null;

  ctx.root.innerHTML = `
    <div class="ed-section">
      <h3>Reconstructed phasing</h3>
      <div class="field"><label>Intersection</label>
        <select data-act="ana-pick">
          ${list.map((i) => `<option value="${i.id}" ${i.id === anaId ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
        </select>
      </div>
      <p class="muted-note">${obs.length} color observation${obs.length === 1 ? '' : 's'} logged.</p>
      ${c && ix ? reconstructionHtml(c, ix) : ''}
    </div>
    <div class="ed-section">
      <h3>Network coordination</h3>
      ${networkHtml()}
    </div>`;
}

function reconstructionHtml(c, ix) {
  const rec = c.rec;
  if (!rec) return `<p class="muted-note">Not enough observations yet to find a cycle. In Capture, watch a light and tap its color on each change for a few cycles.</p>`;

  const verdict = !rec.modelable
    ? `<div class="verdict independent"><div class="head" style="color:var(--red)">⚠ not time-based</div>
        <div class="muted-note">Timings vary too much to predict — likely a sensor-actuated controller.</div></div>`
    : rec.timeBasedRatio < 1
      ? `<div class="verdict"><div class="head" style="color:var(--yellow)">partly sensor-based</div>
          <div class="muted-note">${Math.round(rec.timeBasedRatio * 100)}% of heads are steady; the rest vary, so their countdowns are estimates.</div></div>`
      : '';

  const gaps = rec.missingHeads.map((h) => headLabel(ix, h)).filter(Boolean);
  const coverage = gaps.length
    ? `<div class="verdict"><div class="head">⧗ coverage gaps</div>
        <div class="muted-note">Never observed: ${gaps.map(esc).join(', ')}. Watch ${gaps.length > 1 ? 'these' : 'this'} once (you may be cross-traffic on another drive) to complete the picture.</div></div>`
    : '';

  return `
    <div style="margin-top:6px">
      <div class="field" style="gap:6px; flex-wrap:wrap">
        <span class="tag ${rec.confidence.level}">confidence: ${rec.confidence.level}</span>
        <span class="tag">~${rec.cyclesObserved} cycles</span>
        <span class="tag">cycle ~${rec.cycleLengthSec}s</span>
        <span class="tag">${rec.observedHeads.length} head${rec.observedHeads.length === 1 ? '' : 's'} seen</span>
      </div>
      ${verdict}${coverage}
      <div style="margin:8px 0">
        ${rec.phases.map((p, i) => `
          <div class="stage-est">
            <span class="pi" style="width:20px;height:20px;border-radius:50%;background:var(--bg);display:grid;place-items:center;font-size:11px;color:var(--muted)">${i + 1}</span>
            <span class="swatches" style="display:flex;gap:3px">${rec.observedHeads.map((h) => `<span class="swatch" style="background:${ASPECT_HEX[p.states[h] ?? 'off']}" title="${esc(headLabel(ix, h))}"></span>`).join('')}</span>
            <span class="dur">${p.durSec}s</span>
            <span class="tag ${p.type}" style="margin-left:auto">${p.type === 'actuated' ? 'sensor' : 'fixed'}</span>
          </div>`).join('')}
      </div>
      ${rec.modelable ? '<button class="sbtn primary" data-act="apply-observed">Save as active plan</button>' : ''}
      <span class="muted-note" id="ana-status" style="margin-left:8px"></span>
    </div>`;
}

function networkHtml() {
  const corridors = network.corridors;
  const linked = network.verdicts.filter((v) => v.linked).sort((a, b) => rank(b.confidence) - rank(a.confidence));
  const independent = network.verdicts.filter((v) => !v.linked);
  return `
    ${corridors.length
      ? `<p class="muted-note">Detected coordinated corridor${corridors.length > 1 ? 's' : ''}:</p>
         ${corridors.map((c) => `<div>${c.map((id) => `<span class="corridor-chip">${esc(nameOf(id))}</span>`).join(' → ')}</div>`).join('')}`
      : '<p class="muted-note">No coordinated corridors detected yet.</p>'}
    <div style="margin-top:10px">
      ${linked.map((v) => verdictHtml(v, true)).join('')}
      ${independent.map((v) => verdictHtml(v, false)).join('')}
    </div>`;
}

function verdictHtml(v, linked) {
  return `<div class="verdict ${linked ? 'linked' : 'independent'}">
    <div class="head">${linked ? '⟷ linked' : '· independent'} <span class="tag ${v.confidence}" style="margin-left:auto">${v.confidence}</span></div>
    <div>${esc(nameOf(v.a))} & ${esc(nameOf(v.b))}</div>
    <div class="muted-note">${esc(v.reason)}</div>
  </div>`;
}

const rank = (c) => ({ low: 0, medium: 1, high: 2 }[c] ?? 0);

function onChange(e) { if (e.target.dataset.act === 'ana-pick') { anaId = e.target.value; render(); } }

async function onClick(e) {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  if (btn.dataset.act !== 'apply-observed') return;
  const ix = ctx.api.get(anaId); if (!ix) return;
  const c = characterizeIntersection(ix, observationsByIx[anaId] ?? []);
  if (!c.plan) return;
  ix.plans = [withCycleLength(c.plan)]; // reconstructed plan becomes the active one
  ix.updatedAt = Date.now();
  await ctx.api.saveIntersection(ix);
  ctx.api.onChange();
  const st = document.getElementById('ana-status');
  if (st) st.textContent = 'Saved ✓';
  await refreshAnalyze();
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
