// Onda × TeslaMate — infer traffic-light timings from months of GPS traces.
//
// Reusable CLI. Feed it an Onda export (your intersections) and a TeslaMate
// position dump; it reconstructs, per defined head, a cycle length and green/red
// split from queue departures, and writes a report plus app-importable files.
//
//   node tools/teslamate/infer.js \
//     --export onda-export.json \
//     --positions positions.ndjson \
//     --out out/ [--radius 70] [--verbose]
//
// No dependencies (run under the same Docker node the tests use):
//   docker run --rm -v "$PWD":/app -w /app node:22-alpine \
//     node tools/teslamate/infer.js --export onda-export.json --positions positions.ndjson --out out
//
// Position input: NDJSON (one object per line), a JSON array, or CSV with a
// header. Recognised fields (case-insensitive): date|t|time, latitude|lat,
// longitude|lon|lng, speed (km/h; if absent it's derived from distance/time).
// See fetch.sql for the query that produces it from TeslaMate's Postgres.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inferIntersection, boundingBox, buildFetchSql, DEFAULTS } from './gps.js';
import { distanceM } from '../../src/nav/proximity.js';

// ---------- args ----------
function parseArgs(argv) {
  const a = { radius: DEFAULTS.assocRadiusM, out: 'out', pad: 350, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--export') a.export = argv[++i];
    else if (k === '--positions') a.positions = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--radius') a.radius = Number(argv[++i]);
    else if (k === '--since') a.since = Number(argv[++i]);
    else if (k === '--tz') a.tz = Number(argv[++i]);
    else if (k === '--pad') a.pad = Number(argv[++i]);
    else if (k === '--emit-sql') { a.emitSql = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'fetch.local.sql'; }
    else if (k === '--verbose') a.verbose = true;
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

const USAGE = `Onda × TeslaMate timing inference

Generate the dump query from your export:
  node tools/teslamate/infer.js --export <onda.json> --emit-sql [path] [--pad m]

Run the inference on a dump:
  node tools/teslamate/infer.js --export <onda.json> --positions <dump> --out <dir> [--radius m] [--verbose]`;

// ---------- position parsing ----------
const pick = (row, keys) => { for (const k of keys) if (row[k] != null && row[k] !== '') return row[k]; return undefined; };

function toFix(row) {
  const dateRaw = pick(row, ['date', 't', 'time', 'timestamp']);
  const lat = Number(pick(row, ['latitude', 'lat']));
  const lon = Number(pick(row, ['longitude', 'lon', 'lng', 'long']));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let t = typeof dateRaw === 'number' ? dateRaw : Date.parse(dateRaw);
  if (!Number.isFinite(t)) return null;
  if (t < 1e12) t *= 1000; // seconds -> ms
  const kmh = Number(pick(row, ['speed', 'speed_kmh']));
  const speed = Number.isFinite(kmh) ? kmh / 3.6 : NaN; // m/s; NaN => derive later
  return { t, lat, lon, speed };
}

function parsePositions(text, path) {
  const trimmed = text.trimStart();
  let rows;
  if (path.endsWith('.csv') || (!trimmed.startsWith('{') && !trimmed.startsWith('[') && trimmed.includes(','))) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const header = lines.shift().split(',').map((h) => h.trim().toLowerCase());
    rows = lines.map((l) => { const c = splitCsv(l); const o = {}; header.forEach((h, i) => (o[h] = c[i])); return o; });
  } else if (trimmed.startsWith('[')) {
    rows = JSON.parse(text);
  } else {
    rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)); // NDJSON
  }
  const fixes = [];
  for (const r of rows) { const f = toFix(r); if (f) fixes.push(f); }
  fixes.sort((a, b) => a.t - b.t);
  deriveSpeeds(fixes);
  return fixes;
}

// Minimal CSV field splitter (handles simple quoted fields).
function splitCsv(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// Fill missing speeds from consecutive fixes (best-effort; TeslaMate usually has speed).
function deriveSpeeds(fixes) {
  for (let i = 0; i < fixes.length; i++) {
    if (Number.isFinite(fixes[i].speed)) continue;
    const prev = fixes[i - 1], next = fixes[i + 1];
    let v = 0;
    if (prev && next && next.t > prev.t) v = distanceM(prev, next) / ((next.t - prev.t) / 1000);
    else if (prev && fixes[i].t > prev.t) v = distanceM(prev, fixes[i]) / ((fixes[i].t - prev.t) / 1000);
    fixes[i].speed = Number.isFinite(v) ? v : 0;
  }
}

// ---------- report ----------
const VERDICT_TAG = {
  predictable: '✓ predictable', drifting: '~ drifting (re-anchor)', noisy: '~ noisy',
  unstable: '✗ unstable / actuated', 'no-clean-cycle': '✗ no clean cycle (actuated?)', insufficient: 'insufficient data',
};
function fmtHead(id, h, labelFor) {
  const label = labelFor(id) || id;
  const s = h.samples || {};
  const counts = `${s.greenOnsets || 0} departures, ${s.passThroughs || 0} through, ${s.stopArrivals || 0} stops`;
  if (h.cycleSec == null) return `  • ${label}: ${VERDICT_TAG[h.verdict] || h.verdict}  (${counts})`;
  return `  • ${label} [${h.segment || '—'}]: ${VERDICT_TAG[h.verdict] || h.verdict} — cycle ${h.cycleSec}s, green≈${h.greenSec}s / red≈${h.redSec}s`
    + `\n      offset ${h.onsetPhaseSec}s · R=${h.R} · residual ±${h.residualSec}s · drift ${h.driftSecPerDay}s/day · ${counts}`;
}

function buildReport(results, meta) {
  const lines = [];
  lines.push(`# Onda × TeslaMate timing inference`);
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push(`Fixes: ${meta.fixes} · intersections: ${results.length} · assoc radius: ${meta.radius} m · window: last ${meta.since} days, weekday`);
  lines.push('Verdicts: ✓ predictable = stable offset (usable now) · ~ drifting = offset slides, re-anchor · ✗ unstable = actuated / not clock-predictable. residual ± = live-prediction error bar.');
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.name}`);
    lines.push(`passes near this intersection: ${r.passes} · unassigned: ${r.unassigned}`);
    if (!r.armsHavePos && !r.mastsHavePos) lines.push(`⚠ no arm or mast positions in the export → heads can't be identified. Place the masts on the map in the Edit tab and re-export.`);
    else if (!r.armsHavePos) lines.push(`heads matched by mast direction (arms have no positions).`);
    const labelFor = (id) => (meta.headLabels[r.intersectionId] || {})[id];
    const ids = Object.keys(r.heads);
    if (!ids.length) lines.push('  (no per-head data recovered)');
    for (const id of ids) lines.push(fmtHead(id, r.heads[id], labelFor));
    if (r.missingHeads.length) lines.push(`  ✗ no data yet for: ${r.missingHeads.map((h) => labelFor(h) || h).join(', ')}`);
    if (r.plans?.length) lines.push(`  → ${r.plans.length} plan(s): ` + r.plans.map((p) => `${p.name} ${(p.cycleLengthMs / 1000)}s [${p.confidence.level}]`).join(', '));
    lines.push('');
  }
  return lines.join('\n');
}

// map headId -> readable label, for the report
function headLabels(ix) {
  const out = {};
  for (const m of ix.movements || []) {
    if (m.unsignalized || !m.headId) continue;
    const h = (ix.heads || []).find((x) => x.id === m.headId);
    out[m.headId] = h?.name || m.label || `${m.from}→${m.to}`;
  }
  return out;
}

// ---------- main ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.export || (!args.positions && !args.emitSql)) { console.log(USAGE); process.exit(args.help ? 0 : 1); }

  const bundle = JSON.parse(readFileSync(args.export, 'utf8'));
  const intersections = Array.isArray(bundle) ? bundle : (bundle.intersections || []);
  if (!intersections.length) { console.error('No intersections in export.'); process.exit(1); }

  // SQL-generation mode: write a tailored dump query and stop.
  if (args.emitSql) {
    const bbox = boundingBox(intersections, args.pad);
    if (!bbox) { console.error('No intersection locations to bound.'); process.exit(1); }
    writeFileSync(args.emitSql, buildFetchSql(bbox, intersections, args.pad));
    console.log(`Wrote ${args.emitSql} — a dump query bounding ${intersections.length} intersection(s) with ${args.pad} m padding:`);
    console.log(`  box: lat ${bbox.minLat.toFixed(6)}..${bbox.maxLat.toFixed(6)}, lon ${bbox.minLon.toFixed(6)}..${bbox.maxLon.toFixed(6)}`);
    console.log(`Run it against TeslaMate (see the header in the file) to produce positions.ndjson, then re-run with --positions.`);
    return;
  }

  const fixes = parsePositions(readFileSync(args.positions, 'utf8'), args.positions);
  if (!fixes.length) { console.error('No usable positions parsed.'); process.exit(1); }

  const opt = { ...DEFAULTS, assocRadiusM: args.radius,
    sinceDays: args.since ?? DEFAULTS.sinceDays, tzOffsetH: args.tz ?? DEFAULTS.tzOffsetH };
  const results = [];
  const allObs = [];
  const enrichedIx = [];
  const labels = {};

  for (const ix of intersections) {
    labels[ix.id] = headLabels(ix);
    const r = inferIntersection(ix, fixes, opt);
    results.push(r);
    for (const o of r.observations) allObs.push({ id: `obs_tm_${o.headId}_${o.t}`, ...o });
    // attach the inferred plans (leave the user's structure untouched; bump rev so
    // an Import wins). Only replaces plans; heads/movements/masts unchanged.
    if (r.plans?.length) enrichedIx.push({ ...ix, plans: r.plans, rev: (ix.rev ?? 0) + 1, updatedAt: Date.now() });
    else enrichedIx.push(ix);
  }

  mkdirSync(args.out, { recursive: true });
  const report = buildReport(results, { fixes: fixes.length, radius: args.radius, since: opt.sinceDays, headLabels: labels });
  writeFileSync(`${args.out}/report.md`, report);
  writeFileSync(`${args.out}/inferred-plans-export.json`, JSON.stringify({ ...(!Array.isArray(bundle) ? bundle : {}), intersections: enrichedIx }, null, 2));
  writeFileSync(`${args.out}/inferred-observations.json`, JSON.stringify({ observations: allObs }, null, 2));
  if (args.verbose) writeFileSync(`${args.out}/detail.json`, JSON.stringify(results, null, 2));

  console.log(report);
  console.log(`\nWrote:\n  ${args.out}/report.md\n  ${args.out}/inferred-plans-export.json  (Import in the Sync tab to preview predictions)\n  ${args.out}/inferred-observations.json${args.verbose ? `\n  ${args.out}/detail.json` : ''}`);
}

main();
