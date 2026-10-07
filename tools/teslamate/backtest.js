// Onda × TeslaMate — cross-check, never input.
//
// GPS queue departures (green onsets) are too imprecise to define the timing
// model, so they must never enter the tap log. They CAN test it: build the clock
// model from TAPS only, then ask whether each GPS-detected departure falls where
// the model says green began. A car leaves AFTER the light turns green (start-up
// ~2 s + ~2 s per car ahead; GPS can't see amber), so the expected lag behind the
// model's most recent predicted green is small and positive.
//
// Pure: no I/O here. infer.js feeds it and writes the report.

import { predictMark } from '../../src/predict/next.js';

export const BACKTEST_DEFAULTS = {
  maxLagSec: 15,        // a departure this long after predicted green still fits (long queues)
  sureSec: 3,           // model uncertainty (±) at or below this counts as "high confidence"
};

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/**
 * Compare GPS green onsets with the model's predicted green.
 * @param model   computeModel() output (built from taps only)
 * @param onsets  [{ headId, t }]  GPS-inferred departures (ms)
 * @returns {{ rows: object[], totals: object, contradictions: object[] }}
 *   per (head, plan): n, fit, inconsistent, contradict, unpredictable by reason, medianLagSec, frontLagSec
 */
export function compareOnsets(model, onsets, opt = {}) {
  const o = { ...BACKTEST_DEFAULTS, ...opt };
  const rows = new Map();
  const contradictions = [];
  const row = (headId, planId) => {
    const k = `${headId}|${planId ?? '-'}`;
    if (!rows.has(k)) rows.set(k, { headId, planId: planId ?? null, n: 0, fit: 0, inconsistent: 0, contradict: 0, unpredictable: {}, lags: [], fitLags: [] });
    return rows.get(k);
  };
  for (const { headId, t } of onsets) {
    const p = predictMark(model, headId, 'green', t);
    if (p.unpredictable) {
      const r = row(headId, null);
      r.n++; r.unpredictable[p.reason] = (r.unpredictable[p.reason] ?? 0) + 1;
      continue;
    }
    const C = p.plan.cycleSec;
    let lag = (t - p.lastMs) / 1000;        // since the previous predicted green
    if (lag > C / 2) lag -= C;              // actually just BEFORE the next predicted green
    const r = row(headId, p.planId);
    r.n++; r.lags.push(lag);
    if (lag >= -p.plusMinus && lag <= o.maxLagSec) { r.fit++; r.fitLags.push(lag); }
    else {
      r.inconsistent++;
      if (p.plusMinus <= o.sureSec) {
        r.contradict++;
        contradictions.push({ headId, planId: p.planId, t, lagSec: r1(lag), plusMinus: p.plusMinus, basis: p.basis });
      }
    }
  }
  const out = [...rows.values()].map((r) => {
    const sorted = [...r.fitLags].sort((a, b) => a - b);
    const front = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 4)));   // earliest quarter = front-of-queue trips
    const unpred = Object.values(r.unpredictable).reduce((a, b) => a + b, 0);
    return { headId: r.headId, planId: r.planId, n: r.n, fit: r.fit, inconsistent: r.inconsistent, contradict: r.contradict,
      unpredictable: unpred, unpredictableReasons: r.unpredictable,
      medianLagSec: r1(median(r.lags)), frontLagSec: sorted.length ? r1(median(front)) : null };
  }).sort((a, b) => (a.headId < b.headId ? -1 : a.headId > b.headId ? 1 : 0));
  const sum = (k) => out.reduce((a, r) => a + r[k], 0);
  return { rows: out, contradictions, totals: { n: sum('n'), fit: sum('fit'), inconsistent: sum('inconsistent'), contradict: sum('contradict'), unpredictable: sum('unpredictable') } };
}

/** Markdown section for report.md. `labelFor(headId)` gives a readable name. */
export function backtestReport(res, labelFor = (h) => h, opt = {}) {
  const o = { ...BACKTEST_DEFAULTS, ...opt };
  const L = [];
  L.push('## Backtest: GPS departures vs. the tap-based clock model');
  L.push(`The model is built from TAPS only; GPS onsets never enter it. A departure fits if it comes ${o.maxLagSec} s or less after the predicted green (or within the model's own ± just before it). Departures where the model can't predict (no taps at that hour/day, needs a tap today, actuated) are counted separately, not as failures. "Contradicts" = outside the window while the model claimed ±${o.sureSec} s or better.`);
  L.push('');
  const t = res.totals;
  L.push(`Total: ${t.n} departures · ${t.fit} fit · ${t.inconsistent} inconsistent (${t.contradict} contradict) · ${t.unpredictable} not predictable`);
  L.push('');
  L.push('| light | plan | n | fit | inconsistent | contradict | not predictable | median lag s | front-of-queue lag s |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of res.rows) {
    L.push(`| ${labelFor(r.headId)} | ${r.planId ?? '—'} | ${r.n} | ${r.fit} | ${r.inconsistent} | ${r.contradict} | ${r.unpredictable} | ${r.medianLagSec ?? '—'} | ${r.frontLagSec ?? '—'} |`);
  }
  const reasons = {};
  for (const r of res.rows) for (const [k, v] of Object.entries(r.unpredictableReasons)) reasons[k] = (reasons[k] ?? 0) + v;
  if (Object.keys(reasons).length) L.push('', 'Not predictable because: ' + Object.entries(reasons).map(([k, v]) => `${k} (${v})`).join('; '));
  if (res.contradictions.length) {
    L.push('', '### Departures that contradict the model');
    for (const c of res.contradictions.slice(0, 40)) L.push(`- ${new Date(c.t).toLocaleString()} · ${labelFor(c.headId)}: ${c.lagSec > 0 ? '+' : ''}${c.lagSec} s from predicted green (model ±${c.plusMinus} s, ${c.basis})`);
    if (res.contradictions.length > 40) L.push(`- … ${res.contradictions.length - 40} more`);
  }
  L.push('');
  return L.join('\n');
}
