// Analyze view: what the clock model (the one every other view uses) believes,
// in plain words — read-only, nothing to save. "Not enough data to tell" is a
// normal answer here, not an error.

import { headLabel } from '../inference/heads.js';
import { esc } from './dom.js';
import { ASPECT_INFO } from '../domain/model.js';

let ctx = null;

export function mountAnalyze(root, api) { ctx = { root, api }; render(); }
export function refreshAnalyze() { if (ctx) render(); }

const fmt = (x, d = 1) => (Number.isFinite(x) ? String(Math.round(x * 10 ** d) / 10 ** d) : '?');
const hhmm = (min) => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const aspectName = (a) => (ASPECT_INFO[a]?.label ?? a).toLowerCase();
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function render() {
  const model = ctx.api.model();
  const taps = ctx.api.taps();
  const status = ctx.api.status();
  const list = ctx.api.list();
  const ixOf = (id) => list.find((i) => i.id === id);
  const lightName = (hid) => {
    const ix = ixOf(model?.lights?.[hid]?.intersectionId);
    return ix ? `${ix.name} · ${headLabel(ix, hid)}` : hid;
  };
  const tapById = new Map(taps.map((t) => [t.id, t]));

  const head = `<div class="card">
    <p class="note">${plural(taps.length, 'tap')} logged · model ${status === 'uptodate' ? 'up to date' : status === 'recomputing' ? 'recomputing…' : 'not computed yet'}.
      Everything below is worked out again from your taps and the map; nothing here is saved or edited by hand.</p>
    ${model ? globalHtml(model) : '<p class="note">No model yet. In Capture, watch a light and tap its color the instant it changes, for a few cycles.</p>'}
  </div>`;
  const groups = model ? (model.groups ?? []).map((g) => groupHtml(g, model, { ixOf, lightName, tapById })).join('') : '';
  ctx.root.innerHTML = head + groups;
}

function globalHtml(model) {
  const lag = model.lag;
  const why = {};
  for (const d of model.dropped ?? []) why[d.reason] = (why[d.reason] ?? 0) + 1;
  const dropped = Object.entries(why).map(([r, n]) => `${n} ${esc(r)}`).join(' · ');
  return `
    ${lag ? `<p class="note small">Learned tap lag: your taps land about ${fmt(lag.medianSec)} s after the light changes${lag.p90Sec ? ` (9 in 10 within ${fmt(lag.p90Sec)} s)` : ''}.</p>` : ''}
    ${dropped ? `<p class="note small">${plural((model.dropped ?? []).length, 'tap')} left out: ${dropped}.</p>` : '<p class="note small">No taps left out.</p>'}
    ${(model.groups ?? []).length ? '' : '<p class="note">Not enough taps yet to find a cycle anywhere.</p>'}`;
}

function clockWords(c) {
  if (!c) return 'No clock fitted yet.';
  const days = `${plural(c.days ?? 0, 'day')} of taps`;
  if (c.hypothesis === 'steady') return `Steady clock: the same timing every day (${days}). A tap today is not needed.`;
  if (c.hypothesis === 'nudged') return `The clock drifts about ±${fmt(c.nudgeSigmaSec)} s from one day to the next (${days}); a tap today tightens the prediction.`;
  return (c.days ?? 0) < 3
    ? `Not enough data to tell if the timing repeats from day to day (${days}, need 3). For now each day needs its own tap.`
    : `Days look unrelated (${days}): this light needs a tap each day before it can be predicted.`;
}

function groupHtml(g, model, { ixOf, lightName, tapById }) {
  const members = g.intersectionIds.map((id) => esc(ixOf(id)?.name ?? id)).join(' + ');
  const aspectOfKey = (k) => k.split('|');
  const useful = (model.usefulTaps ?? []).filter((u) => g.headIds.includes(u.headId));
  const plans = (g.plans ?? []).map((p) => {
    const win = (p.windows ?? []).map((w) => `${hhmm(w.fromMin)}–${hhmm(w.toMin)}`).join(', ') || 'all day';
    const dc = p.dayClass && p.dayClass !== 'all' ? ` · ${p.dayClass}s` : '';
    const c = p.clock;
    const marks = Object.entries(p.marks ?? {}).sort((a, b) => a[1].posSec - b[1].posSec).map(([k, m]) => {
      const [hid, asp] = aspectOfKey(k);
      return `<div class="kv"><span class="k">${esc(lightName(hid))} → ${esc(aspectName(asp))}</span>
        <span>${m.actuated ? '<span class="st-actuated">sensor-controlled · not predicted</span>'
          : `at ${fmt(m.posSec)} s${m.spreadSec >= 0.5 ? ` ±${fmt(m.spreadSec)}` : ''} · ${plural(m.n, 'tap')}`}</span></div>`;
    }).join('');
    return `
      <div class="sub-card">
        <div class="kv"><span class="k">${esc(win)}${esc(dc)}</span>
          <span>cycle ${p.cycleSec ? `${fmt(p.cycleSec)}${p.cycleSigmaSec >= 0.05 ? ` ±${fmt(p.cycleSigmaSec, 2)}` : ''} s` : 'unknown'}</span></div>
        <p class="note small">${esc(clockWords(c))}</p>
        <p class="note small">Drift within a day: ${c?.driftSecPerHour == null ? 'unknown (needs taps at least 2 h apart on one day)' : `${fmt(c.driftSecPerHour, 2)} s per hour`}.
          Held-out error: ${c?.heldOutErrSec == null ? 'not tested yet (needs taps on 3+ days)' : `${fmt(c.heldOutErrSec)} s typical when predicting a day it hadn't seen`}.</p>
        ${marks ? `<h3 class="section-gap">Marks</h3>${marks}` : '<p class="note small">No colour positions known yet.</p>'}
      </div>`;
  }).join('');

  const outliers = (model.outliers ?? []).filter((o) => {
    const t = tapById.get(o.tapId);
    return t && g.headIds.includes(t.headId);
  }).map((o) => {
    const t = tapById.get(o.tapId);
    return `<div class="kv"><span class="k">${new Date(t.t).toLocaleString()} · ${esc(lightName(t.headId))} ${esc(aspectName(t.aspect))}</span>
      <span class="small">removing this tap improves the fix by ${fmt(o.gainSec)} s</span></div>`;
  }).join('');

  return `<div class="card">
    <h3>${members || 'Group'} ${g.corridor ? '<span class="tag fixed">corridor</span>' : ''}</h3>
    ${g.corridor ? '<p class="note small">These junctions run on one shared clock: a tap at any of them helps all.</p>' : ''}
    ${plans || '<p class="note small">No plan found yet — not enough data to tell.</p>'}
    ${outliers ? `<h3 class="section-gap">Taps that look off</h3>${outliers}<p class="note small">They are left out of the fit, not deleted.</p>` : ''}
    ${useful.length ? `<h3 class="section-gap">Most useful next tap</h3>${useful.slice(0, 2).map((u) =>
      `<p class="note small"><b>${esc(lightName(u.headId))} → ${esc(aspectName(u.aspect))}</b>: ${esc(u.why ?? '')}${u.gainSec ? ` (could sharpen the fix by ~${fmt(u.gainSec)} s)` : ''}</p>`).join('')}` : ''}
  </div>`;
}
