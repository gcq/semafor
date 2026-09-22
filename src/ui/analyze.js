// Analyze view: the whole-junction picture of the model every other view uses
// (read-only, nothing to save) — each light's status and the learned phase
// table across all lights.

import { characterizeIntersection } from '../inference/characterize.js';
import { headLabel } from '../inference/heads.js';
import { esc, ASPECT_HEX, intersectionOptions } from './dom.js';

const STATUS = {
  fixed: ['st-fixed', 'fixed timing · predicted'],
  actuated: ['st-actuated', 'sensor-controlled · not predicted'],
  insufficient: ['st-other', 'needs more taps'],
  missing: ['st-other', 'not observed yet'],
};

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
    <div class="card">
      <div class="field"><label for="ana-pick">Intersection</label>
        <select id="ana-pick" class="grow" data-act="ana-pick">${intersectionOptions(list, anaId)}</select></div>
      <p class="note">${obs.length} tap${obs.length === 1 ? '' : 's'} logged. This is the same model Live uses; it updates by itself as you tap.</p>
      ${c && ix ? reconstructionHtml(c, ix) : ''}
    </div>`;
}

function reconstructionHtml(c, ix) {
  const rec = c.rec;
  if (!rec) return '<p class="note">Not enough taps yet to find a cycle. In Capture, watch a light and tap its color on each change for a few cycles.</p>';

  const rows = [...rec.observedHeads.map((h) => [h, rec.headVerdicts[h]]), ...rec.missingHeads.map((h) => [h, 'missing'])];
  const lights = rows.map(([h, v]) => {
    const [cls, text] = STATUS[v] ?? STATUS.missing;
    return `<div class="kv"><span class="k">${esc(headLabel(ix, h))}</span><span class="${cls}">${text}</span></div>`;
  }).join('');

  return `
    <div class="actions">
      <span class="tag">${rec.confidence.level} confidence</span>
      <span class="tag">~${rec.cyclesObserved} cycles</span>
      <span class="tag">cycle ${rec.cycleLengthSec} s</span>
    </div>
    <h3 class="section-gap">Lights</h3>
    ${lights}
    ${rec.missingHeads.length ? '<p class="note small">Lights not observed yet: watch each once — you may be cross traffic on another drive.</p>' : ''}
    ${rec.impliedGaps ? '<p class="note small">Some colors were never captured (e.g. amber), so those stretches are estimates.</p>' : ''}
    <h3 class="section-gap">Phases</h3>
    ${rec.phases.map((p, i) => `
      <div class="kv">
        <span class="idx">${i + 1}</span>
        <span class="swatches">${rec.observedHeads.map((h) => `<span class="swatch" style="background:${ASPECT_HEX[p.states[h] ?? 'off']}" title="${esc(headLabel(ix, h))}"></span>`).join('')}</span>
        <span class="dur">${p.durSec} s</span>
        <span class="tag ${p.type}">${p.type === 'actuated' ? 'sensor' : 'fixed'}</span>
      </div>`).join('')}`;
}

function onChange(e) { if (e.target.dataset.act === 'ana-pick') { anaId = e.target.value; render(); } }
