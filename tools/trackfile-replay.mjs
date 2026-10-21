// Replay the track matcher on REAL data, report only (nothing is asserted, nothing is modified).
//
//   docker run --rm -v "$PWD":/app -w /app node:22-alpine node tools/trackfile-replay.mjs \
//     [out/room-bundle.json] [positions.ndjson] [out/trackfile-report.md]
//
// Inputs: the user's synced bundle (their real taps + junctions) and the TeslaMate GPS log
// (positions.ndjson: one {date, lat, lon, speed km/h} per fix; ~1 Hz while driving, one per few minutes
// when parked; no heading). Street geometry: test/data/pont.osm.xml (the same OSM extract the tests use).
//
// 1. Per tap: build a track from the TeslaMate fixes around the tap time (30 s before .. 3 min after), run the
//    matcher + the suggestion rule, and set the outcome beside what tools/refile.mjs decides for the same bundle
//    (run as a child process on a copy of the bundle, output to out/scratch).
// 2. Because the app did not record tracks until now, TeslaMate may not cover the taps at all (it does not: see
//    the report). So there is also a section replaying every real PASS through a junction, with the "tap" placed
//    where the in-app rule would judge it (40 m before the centre): it shows how the matcher behaves on real,
//    sampled GPS, without ground truth.

import { readFileSync, createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { initSync, JsStreetNetwork } from '../vendor/osm2streets/osm2streets_js.js';
import { areaBbox, bboxCenter, buildLanes } from '../src/osm/lanes.js';
import { approachCandidates } from '../src/osm/approaches.js';
import { matchTrack } from '../src/osm/trackmatch.js';
import { suggestRefile } from '../src/osm/suggest.js';
import { distanceM } from '../src/nav/proximity.js';

const [bundlePath = 'out/room-bundle.json', posPath = 'positions.ndjson', outPath = 'out/trackfile-report.md'] = process.argv.slice(2);
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
const ixs = bundle.intersections.filter((i) => i.location && i.masts?.length);

// ---- streets ----
initSync({ module: readFileSync(new URL('../vendor/osm2streets/osm2streets_js_bg.wasm', import.meta.url)) });
const bbox = areaBbox(ixs.map((i) => i.location));
const center = bboxCenter(bbox);
const streets = { kind: 'lanes', center, data: buildLanes(JsStreetNetwork, new Uint8Array(readFileSync(new URL('../test/data/pont.osm.xml', import.meta.url))), bbox).data };
const set = approachCandidates(streets, ixs);
const ctx = { set, center, intersections: ixs };

// ---- TeslaMate fixes near the junctions (stream; the file is 50 MB) ----
const [south, west, north, east] = areaBbox(ixs.map((i) => i.location), 300);
const fixes = [];
let total = 0, first = null, last = null;
for await (const line of createInterface({ input: createReadStream(posPath) })) {
  if (!line.trim()) continue;
  const d = JSON.parse(line); total++;
  const t = Date.parse(d.date);
  first ??= t; last = t;
  if (d.lat >= south && d.lat <= north && d.lon >= west && d.lon <= east) fixes.push({ t, lat: d.lat, lon: d.lon, speed: (d.speed ?? 0) / 3.6, heading: null, acc: null });
}
fixes.sort((a, b) => a.t - b.t);
const uniq = fixes.filter((f, i) => !i || f.t - fixes[i - 1].t >= 900); // ~1 Hz, like the app's recorder
const iso = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const lo = (arr, t) => { let a = 0, b = arr.length; while (a < b) { const m = (a + b) >> 1; if (arr[m].t < t) a = m + 1; else b = m; } return a; };
const window = (t0, t1) => uniq.slice(lo(uniq, t0), lo(uniq, t1 + 1));

// ---- refile.mjs on a copy ----
mkdirSync('out/scratch', { recursive: true });
const cmpPath = 'out/scratch/refile-compare.json';
let refileLog = '';
try { refileLog = execFileSync(process.execPath, ['tools/refile.mjs', bundlePath, cmpPath], { encoding: 'utf8' }); } catch (e) { refileLog = `refile.mjs failed: ${e.message}`; }
const cleaned = JSON.parse(readFileSync(cmpPath, 'utf8'));
const kept = new Map(cleaned.observations.map((o) => [o.refiledFrom ? o.id.replace(/_rf$/, '') : o.id, o]));
const dead = new Set((bundle.tombstones ?? []).filter((t) => t.kind === 'obs').map((t) => t.id));
const headIx = new Map(ixs.flatMap((ix) => ix.heads.map((h) => [h.id, ix])));
const label = (hid) => (hid ? `${headIx.get(hid)?.name.split(' ')[0] ?? '?'} / ${headIx.get(hid)?.heads.find((h) => h.id === hid)?.name ?? hid}` : '–');

// ---- 1. per tap ----
const live = bundle.observations.filter((o) => !dead.has(o.id) && o.headId && o.aspect).sort((a, b) => a.t - b.t);
const rows = [];
for (const o of live) {
  const w = window(o.t - 30000, o.t + 180000);
  const row = { o, n: w.length, span: w.length > 1 ? (w.at(-1).t - w[0].t) / 1000 : 0, match: null, sugg: null, refile: 'kept' };
  if (!kept.has(o.id)) row.refile = 'removed';
  else if (kept.get(o.id).refiledFrom) row.refile = `re-filed → ${label(kept.get(o.id).headId)}`;
  if (o.where && w.length >= 2) {
    row.match = matchTrack({ track: w, t: o.t, ...ctx });
    row.sugg = suggestRefile({ tap: o, track: w, ...ctx });
  }
  rows.push(row);
}
const withTrack = rows.filter((r) => r.n >= 2), withWhere = rows.filter((r) => r.o.where);
const gapsOf = (arr) => arr.slice(1).map((f, i) => (f.t - arr[i].t) / 1000).sort((a, b) => a - b);
const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null);

// ---- 2. every real pass through a junction ----
const passes = [];
{
  const segs = []; let cur = [];
  for (const f of uniq) { if (cur.length && f.t - cur.at(-1).t > 5000) { segs.push(cur); cur = []; } cur.push(f); }
  if (cur.length) segs.push(cur);
  for (const s of segs) for (const ix of ixs) {
    const d = s.map((f) => distanceM(f, ix.location)), m = Math.min(...d);
    if (m > 40 || s.length < 10) continue;
    const cpa = d.indexOf(m);
    let k = cpa; while (k > 0 && d[k] < 40) k--;          // the fix 40 m before the centre, like the in-app rule
    const track = s.filter((f) => distanceM(f, ix.location) <= 250);
    const res = matchTrack({ track, t: s[k].t, ...ctx });
    passes.push({ ix, t: s[k].t, n: track.length, res, still: s.slice(Math.max(0, k - 10), k + 10).some((f) => f.speed < 0.5) });
  }
}
const dist = (arr, key) => { const c = {}; for (const x of arr) c[key(x)] = (c[key(x)] ?? 0) + 1; return c; };
const fmt = (c) => Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(' · ') || '–';

// ---- report ----
const L = [];
L.push('# Track matcher replay on real data', '', `Generated ${new Date().toISOString().slice(0, 16)} by tools/trackfile-replay.mjs. Report only: nothing here is asserted and neither input is modified.`, '');
L.push('## Inputs', '',
  `- Taps: ${bundlePath}: ${live.length} live taps with a head, ${withWhere.length} with a recorded position (\`where\`), spanning ${iso(live[0].t)} .. ${iso(live.at(-1).t)} UTC.`,
  `- TeslaMate: ${posPath}: ${total} fixes ${iso(first)} .. ${iso(last)} UTC; ${fixes.length} inside the junctions' area (±300 m), ${uniq.length} after keeping ~1 Hz.`,
  `- Sampling: ${(() => { const g = gapsOf(uniq.filter((f) => f.speed > 2)); return `while moving (> 7 km/h) consecutive fixes are ${q(g, 0.5)} s apart at the median, ${q(g, 0.9)} s at p90, ${q(g, 0.99)} s at p99; parked, one fix every few minutes`; })()}. No heading in the log (the matcher does not need one).`,
  `- Streets: test/data/pont.osm.xml through osm2streets (the tests' fixture); ${set.cands.length} mapped approaches at ${ixs.length} junctions.`, '');
L.push('## 1. Per tap: TeslaMate track around the tap', '',
  `**${withTrack.length} of ${rows.length} taps have at least 2 TeslaMate fixes within -30 s .. +3 min** (${withTrack.filter((r) => r.o.where).length} of the ${withWhere.length} taps with a position).`);
if (!withTrack.length) L.push('', `The log ends ${iso(last)} UTC, the first tap with a position is ${iso(withWhere[0]?.t ?? live[0].t)}: **there is no overlap, so no tap can be replayed from TeslaMate.** The suggestion feature starts from the in-app recorder (future taps only, as decided); section 2 shows how the matcher behaves on real GPS meanwhile.`);
L.push('', '| time (UTC) | colour | tapped head | fixes | matched head | confidence | suggestion | refile.mjs |', '|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  const m = r.match;
  L.push(`| ${iso(r.o.t)} | ${r.o.aspect} | ${label(r.o.headId)} | ${r.n} | ${m ? label(m.headId) : r.o.where ? 'no track' : 'no position'} | ${m ? m.confidence + (m.confidence === 'high' ? '' : ` (${m.reason})`) : '–'} | ${r.sugg ? `→ ${r.sugg.toLabel}` : '–'} | ${r.refile} |`);
}
const sug = rows.filter((r) => r.sugg), rf = rows.filter((r) => r.refile.startsWith('re-filed'));
L.push('', `Summary: ${withTrack.length} with a track · ${sug.length} suggestions · refile.mjs re-files ${rf.length} and removes ${rows.filter((r) => r.refile === 'removed').length} (it works from \`where\` + \`heading\` of the tap alone).`);
const both = rows.filter((r) => r.sugg && r.refile.startsWith('re-filed'));
L.push(`Agreement on taps both rules act on: ${both.filter((r) => r.refile.endsWith(label(r.sugg.toHeadId))).length} of ${both.length} point to the same head. Taps refile.mjs would re-file that the track rule leaves alone: ${rf.filter((r) => !r.sugg).length} (${rf.filter((r) => !r.sugg && r.n < 2).length} of them simply have no track).`, '');
L.push('### refile.mjs output on the same bundle', '', '```', refileLog.trim(), '```', '');

L.push('## 2. Real passes through the junctions (no ground truth)', '',
  `Every time a TeslaMate trip came within 40 m of a junction centre with at least 10 fixes (${passes.length} passes), the matcher was asked what it would say for a tap made 40 m before the centre.`, '',
  `- Confidence: ${fmt(dist(passes, (p) => p.res.confidence))}`,
  `- Fixes in the track (within 250 m): median ${q(passes.map((p) => p.n).sort((a, b) => a - b), 0.5)}`,
  `- Why not high: ${fmt(dist(passes.filter((p) => p.res.confidence !== 'high'), (p) => p.res.reason))}`, '',
  '| junction | passes | high | low | none | turns of the high ones |', '|---|---|---|---|---|---|');
for (const ix of ixs) {
  const ps = passes.filter((p) => p.ix.id === ix.id);
  L.push(`| ${ix.name} | ${ps.length} | ${ps.filter((p) => p.res.confidence === 'high').length} | ${ps.filter((p) => p.res.confidence === 'low').length} | ${ps.filter((p) => p.res.confidence === 'none').length} | ${fmt(dist(ps.filter((p) => p.res.confidence === 'high'), (p) => `${ix.arms.find((a) => a.id === p.res.fromArmId)?.name ?? '?'} → ${p.res.turn ?? '?'}`))} |`);
}
L.push('');
mkdirSync(new URL('.', new URL(outPath, `file://${process.cwd()}/`)), { recursive: true });
writeFileSync(outPath, L.join('\n') + '\n');
console.log(`taps ${rows.length} (with position ${withWhere.length}), with a TeslaMate track ${withTrack.length}, suggestions ${sug.length}; refile.mjs re-files ${rf.length}; passes ${passes.length} (${fmt(dist(passes, (p) => p.res.confidence))})\nwrote ${outPath}`);
