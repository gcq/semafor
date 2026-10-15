// Clean a synced bundle's taps: re-file taps made under the wrong intersection
// (GPS + heading say another junction's light was the one in front of you) and
// drop taps the clock model can never use. Writes a bundle the app can merge:
// re-filed taps get a new id and the old id a tombstone, because sync merges
// observations by id and never overwrites one.
//
//   docker run --rm -v "$PWD":/app -w /app node:22-alpine node tools/refile.mjs \
//     out/room-bundle.json out/cleaned-bundle.json
//
// Re-file rule (deliberately conservative): only when the tapped light serves
// YOUR direction at its junction, or that junction isn't ahead of you at all,
// and a different junction's light for your direction stands first ahead.
// Taps of cross-traffic lights you chose to watch are left alone.

import { readFile, writeFile } from 'node:fs/promises';
import { headForApproach, angularDiff } from '../src/nav/proximity.js';
import { cleanTaps } from '../src/inference/clock.js';

const [inPath = 'out/room-bundle.json', outPath = 'out/cleaned-bundle.json'] = process.argv.slice(2);
const RUN_GAP_MS = 3 * 60 * 1000;      // same-light taps this close form one run
const HEADING_AGREE = 30;              // a run's headings must agree within this, deg
const BEHIND_M = 20;                   // slack: GPS error, and ambers tapped while passing the pole
const LATERAL_M = 30;                  // a mast further off your line isn't on your road
const AHEAD_MAX_M = 300;

const b = JSON.parse(await readFile(inPath, 'utf8'));
const now = Date.now();
const dead = new Set((b.tombstones ?? []).filter((t) => t.kind === 'obs').map((t) => t.id));
const headIx = new Map(b.intersections.flatMap((ix) => ix.heads.map((h) => [h.id, ix])));
const name = (headId) => `${headIx.get(headId)?.name ?? '?'} / ${headIx.get(headId)?.heads.find((h) => h.id === headId)?.name ?? headId}`;

// Local flat metres around the junctions (they're a few hundred metres apart).
const o0 = b.intersections[0].location;
const xy = (p) => [(p.lon - o0.lon) * 111320 * Math.cos(o0.lat * Math.PI / 180), (p.lat - o0.lat) * 110540];
const rel = (from, to, hdg) => {
  const [ax, ay] = xy(from), [bx, by] = xy(to), dx = bx - ax, dy = by - ay;
  const ux = Math.sin(hdg * Math.PI / 180), uy = Math.cos(hdg * Math.PI / 180);
  return { along: dx * ux + dy * uy, lateral: Math.abs(dx * uy - dy * ux) };
};

// On a pole with several lights, your straight-on light is the one whose
// movement leaves on the same street it arrived on.
function ownHead(ix, hdg) {
  const first = headForApproach(ix, hdg);
  if (!first) return null;
  const mast = ix.masts.find((m) => m.headIds.includes(first));
  const arm = (id) => ix.arms.find((a) => a.id === id)?.name.split(' ')[0];
  const straight = mast.headIds.find((h) => ix.movements.some((mv) => mv.headId === h && arm(mv.from) === arm(mv.to)));
  return { headId: straight ?? first, mast };
}

// The first light for your direction ahead of you, at any junction.
function lightAhead(p, hdg) {
  let best = null;
  for (const ix of b.intersections) {
    const own = ownHead(ix, hdg); if (!own) continue;
    const r = rel(p, own.mast.pos, hdg);
    if (r.along < -BEHIND_M || r.along > AHEAD_MAX_M || r.lateral > LATERAL_M) continue;
    if (!best || r.along < best.along) best = { ix, headId: own.headId, along: r.along };
  }
  return best;
}

const removed = [], refiled = [], kept = [];
const live = b.observations.filter((o) => !dead.has(o.id)).sort((a, c) => a.t - c.t);
const withHdg = live.filter((o) => o.where && Number.isFinite(o.heading)); // taps that recorded a course
// GPS course at a standstill is noise (it swings 180° between taps a few
// seconds apart). So judge a RUN — back-to-back taps on the same light — as a
// whole: trust its heading only if most of its taps recorded one and they
// agree. A lone tap counts if it recorded one.
const runOf = new Map();
for (const o of live) {
  const prev = [...runOf.values()].at(-1);
  if (prev && prev.headId === o.headId && o.t - prev.taps.at(-1).t <= RUN_GAP_MS) { prev.taps.push(o); runOf.set(o.id, prev); }
  else runOf.set(o.id, { headId: o.headId, taps: [o] });
}
const runHeading = new Map();
const headingOf = (o) => {
  const run = runOf.get(o.id);
  if (!runHeading.has(run)) {
    const hs = run.taps.map((x) => x.heading).filter(Number.isFinite);
    const agree = (h) => hs.filter((x) => angularDiff(x, h) <= HEADING_AGREE);
    const best = hs.map((h) => agree(h)).sort((a, c) => c.length - a.length)[0] ?? [];
    const ok = hs.length * 2 >= run.taps.length && best.length * 3 >= hs.length * 2;
    const mean = (Math.atan2(...['sin', 'cos'].map((f) => best.reduce((s, h) => s + Math[f](h * Math.PI / 180), 0))) * 180 / Math.PI + 360) % 360;
    runHeading.set(run, ok ? mean : null);
  }
  return runHeading.get(run);
};

for (const o of live) {
  if (!o.headId || !o.aspect) { removed.push([o, `old format (fake intersection ${o.intersectionId})`]); continue; }
  if (o.kind && o.kind !== 'onset') { removed.push([o, `'${o.kind}' tap (current colour, not a change)`]); continue; }
  const ix = headIx.get(o.headId);
  if (!ix) { removed.push([o, `light ${o.headId} no longer exists`]); continue; }
  const hdg = o.where ? headingOf(o) : null;
  const ahead = hdg == null ? null : lightAhead(o.where, hdg);
  if (ahead && ahead.ix.id !== ix.id) {
    const mine = ownHead(ix, hdg)?.headId === o.headId;
    const c = rel(o.where, ix.location, hdg);
    const ixNotAhead = c.along < -BEHIND_M || angularDiff(hdg, (Math.atan2(...(() => { const [ax, ay] = xy(o.where), [bx, by] = xy(ix.location); return [bx - ax, by - ay]; })()) * 180 / Math.PI + 360) % 360) > 60;
    if (mine || ixNotAhead) {
      const n = { ...o, id: `${o.id}_rf`, intersectionId: ahead.ix.id, headId: ahead.headId, refiledFrom: { intersectionId: o.intersectionId, headId: o.headId } };
      refiled.push([o, n, `${mine ? 'your-direction light, but' : 'tapped junction not ahead;'} ${ahead.ix.name} light ${ahead.along.toFixed(0)} m ahead`]);
      kept.push(n);
      continue;
    }
  }
  kept.push(o);
}

// Whatever the model would still throw away (e.g. double taps after re-filing).
const { dropped } = cleanTaps(kept, new Map([...headIx].map(([h, ix]) => [h, ix.id])));
const drop = new Map(dropped.map((d) => [d.tapId, d.reason]));
const final = kept.filter((o) => !drop.has(o.id));
for (const o of kept) if (drop.has(o.id)) removed.push([o, `model ignores it: ${drop.get(o.id)}`]);

const tombstones = [...(b.tombstones ?? [])];
for (const [o] of [...removed, ...refiled]) if (!o.id.endsWith('_rf') || !final.includes(o)) tombstones.push({ id: o.id, kind: 'obs', deletedAt: now });
const out = { ...b, exportedAt: now, observations: final, tombstones };
await writeFile(outPath, JSON.stringify(out, null, 2));

const f = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16);
console.log(`${live.length} live taps → kept ${final.length} (${refiled.length} re-filed), removed ${removed.length}\n`);
const why = {}; for (const [, r] of removed) { const k = r.replace(/ \(.*| ix_.*|head_\w+/g, ''); why[k] = (why[k] ?? 0) + 1; }
console.log('removed:', why, '\n');
for (const [o, n, r] of refiled) console.log(`${f(o.t)} ${o.aspect.padEnd(6)} ${name(o.headId)}  →  ${name(n.headId)}   (${r})`);
console.log(`\nwrote ${outPath}`);
