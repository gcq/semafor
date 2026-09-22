// Analyze view: the whole-junction picture of the model every other view uses
// (read-only, nothing to save) — the phase table across all heads, which heads
// are fixed / actuated (not predicted) / not yet seen, and what's still missing.

import { characterizeIntersection } from '../inference/characterize.js';
import { headLabel } from '../inference/heads.js';

const ASPECT_HEX = { green: '#1ea966', amber: '#e0a800', 'flash-amber': '#e0a800', red: '#e23b3b', off: '#8a93a3' };
const VERDICT = { fixed: 'fixed · predicted', actuated: 'actuated · not predicted', insufficient: 'need more taps' };

let ctx = null, anaId = null, observationsByIx = {};

export function mountAnalyze(root, api) {
  ctx = { root, api };
  root.addEventListener('change', onChange);
}

export async function refreshAnalyze() {
  if (!ctx) return;
  const list = ctx.api.list();
  if (!anaId || !list.find((i) => i.id === anaId)) anaId = list[0]?.id ?? null;
  observationsByIx = await ctx.api.observationsAll();
  render();
}

function render() {
  const list = ctx.api.list();
  const ix = anaId ? ctx.api.get(anaId) : null;
  const obs = observationsByIx[anaId] ?? [];
  const c = ix ? characterizeIntersection(ix, obs, ctx.api.nowMs()) : null;

  ctx.root.innerHTML = `
    <div class="ed-section">
      <h3>Reconstructed phasing</h3>
      <div class="field"><label>Intersection</label>
        <select data-act="ana-pick">
          ${list.map((i) => `<option value="${i.id}" ${i.id === anaId ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
        </select>
      </div>
      <p class="muted-note">${obs.length} color observation${obs.length === 1 ? '' : 's'} logged. This is the same model Live uses — it updates on its own as you tap.</p>
      ${c && ix ? reconstructionHtml(c, ix) : ''}
    </div>`;
}

function reconstructionHtml(c, ix) {
  const rec = c.rec;
  if (!rec) return `<p class="muted-note">Not enough observations yet to find a cycle. In Capture, watch a light and tap its color on each change for a few cycles.</p>`;

  const heads = [...rec.observedHeads.map((h) => [h, rec.headVerdicts[h]]), ...rec.missingHeads.map((h) => [h, 'missing'])];
  const headRows = heads.map(([h, v]) => {
    const color = v === 'fixed' ? 'var(--green)' : v === 'actuated' ? 'var(--yellow)' : 'var(--muted)';
    const text = v === 'missing' ? 'never observed — watch it once (you may be cross-traffic another day)' : VERDICT[v];
    return `<div class="stage-est"><span style="flex:1">${esc(headLabel(ix, h))}</span><span class="muted-note" style="color:${color}">${text}</span></div>`;
  }).join('');

  return `
    <div style="margin-top:6px">
      <div class="field" style="gap:6px; flex-wrap:wrap">
        <span class="tag ${rec.confidence.level}">confidence: ${rec.confidence.level}</span>
        <span class="tag">~${rec.cyclesObserved} cycles</span>
        <span class="tag">cycle ~${rec.cycleLengthSec}s</span>
      </div>
      <div style="margin:8px 0">${headRows}</div>
      ${rec.impliedGaps ? '<p class="muted-note">Some colors were never captured (e.g. amber), so those stretches are marked as estimates.</p>' : ''}
      <div style="margin:8px 0">
        ${rec.phases.map((p, i) => `
          <div class="stage-est">
            <span style="width:20px;height:20px;border-radius:50%;background:var(--bg);display:grid;place-items:center;font-size:11px;color:var(--muted)">${i + 1}</span>
            <span style="display:flex;gap:3px">${rec.observedHeads.map((h) => `<span class="swatch" style="background:${ASPECT_HEX[p.states[h] ?? 'off']}" title="${esc(headLabel(ix, h))}"></span>`).join('')}</span>
            <span class="dur">${p.durSec}s</span>
            <span class="tag ${p.type}" style="margin-left:auto">${p.type === 'actuated' ? 'sensor' : 'fixed'}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function onChange(e) { if (e.target.dataset.act === 'ana-pick') { anaId = e.target.value; render(); } }

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
