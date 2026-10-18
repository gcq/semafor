// Live junction view. A zero-dependency Canvas 2D chase-cam of the upcoming
// intersection (Leaflet can't rotate, hence hand-rolled): rotated so your
// direction of travel points up, with the junction anchored at a fixed spot.
// Zoom is dynamic: the closest zoom (ZOOM × junction fit) always shows the whole
// junction, and as you approach from further out it zooms OUT just enough to
// keep you on screen too, down to a floor (MAX_FOLLOW_M). Past that floor you're
// pinned to the bottom edge with a distance label. The scale eases toward its
// target (log space, ~0.8 s) so GPS jumps and 4 Hz redraws don't twitch. Masts
// render as Spanish 3-aspect lights lit from the current prediction, at a
// pixel size independent of the zoom; when zoomed well out those heads would
// pile up on each other, so they collapse to one round dot in the current
// colour (compactLights, with hysteresis). Car roads keep a minimum on-screen
// width so they never thin to hairlines.
//
// It's display + a head picker: drawScene() returns hit boxes {headId, x0..y1}
// so a tap on a pole can make that head active. Color taps happen on the big
// upright panel below the canvas, so tap targets never shrink with the zoom.
// Arms carry no positions in real exports, so street geometry comes from OSM:
// a background cache (src/osm/lanes-cache.js) derives it per intersection and
// hands drawScene a `scene.streets` entry, so this never touches the network.
// Entries are either lane polygons from osm2streets (kind 'lanes': asphalt by
// lane type, junction polygons, white markings, drawn layer by layer so bridges
// sit over the roads beneath) or plain lines (kind 'plain', the fallback). With
// streets we draw them under everything else; without, only the approach road
// (which we do know: from you to the centre) and a junction pad — no invented
// street geometry beyond that.
// Intersections in the same cluster share ONE street entry (src/osm/lanes-cache.js),
// so a corridor reads as one piece; the other members' lights are drawn on top of
// it as small display-only dots in their current colour (scene.neighbors).

import { matchApproaches } from '../osm/approaches.js';

const R = 6371000;
const RAD = Math.PI / 180;
const STREET_NOTE = { loading: 'Loading streets…', failed: 'Streets unavailable — retrying', offline: 'No streets offline yet' };
const ZOOM = 0.75; // <1 zooms out from the fit-to-masts view so more of the surrounding streets show

// Beyond this distance behind the junction it shrinks to a speck (at 400 m it
// already did), so we stop zooming out and pin you to the edge with a distance
// label instead.
const MAX_FOLLOW_M = 200;
// Compact (single-dot) lights kick in once the displayed scale is well below the
// fit-to-junction scale: full 3-aspect heads are a fixed pixel size, so at that
// point they overlap. Two thresholds so easing through the boundary doesn't flicker.
export const COMPACT_ENTER = 0.55;
export const COMPACT_LEAVE = 0.65;
// Neighbour lights: compact dots a bit smaller than the current junction's.
const NEIGHBOR_DOT_SCALE = 0.8;
// Car roads never draw thinner than this on screen (px), however far out we zoom.
const MIN_ROAD_FILL_PX = 3;
const MIN_ROAD_CASING_PX = 4.5;

/** Hysteresis for compact lights: enter below 0.55×fit, leave above 0.65×fit. */
export function compactLights(prevCompact, scale, fitScale) {
  const r = scale / fitScale;
  return prevCompact ? r < COMPACT_LEAVE : r < COMPACT_ENTER;
}
const compactState = new WeakMap();
const EGO_MARGIN_BOTTOM = 44; // chevron + distance label
const EGO_MARGIN_SIDE = 24;
const EASE_TAU_S = 0.8;

/**
 * Pure zoom math (px per metre). `fitScale` is the closest zoom allowed; zoom out
 * from it only as far as needed to keep ego (egoF forward / egoL lateral metres
 * from the junction, travel frame) inside the margins, never below the scale at
 * which ego MAX_FOLLOW_M straight behind would just fit.
 * @returns {{target:number, pinned:boolean}} pinned: ego doesn't fit even at the floor
 */
export function sceneScale({ W, H, jy, fitScale, egoF, egoL, tall }) {
  if (typeof egoF !== 'number' || typeof egoL !== 'number') return { target: fitScale, pinned: false };
  const roomBelow = H - jy - EGO_MARGIN_BOTTOM;
  const roomAbove = jy - (tall ? 110 : 70); // the HUD (countdown) sits above the canvas content
  const roomSide = W / 2 - EGO_MARGIN_SIDE;
  const vert = egoF < 0 ? roomBelow / Math.max(1, -egoF) : roomAbove / Math.max(1, egoF);
  const egoScale = Math.min(vert, roomSide / Math.max(1, Math.abs(egoL)));
  const minScale = Math.min(fitScale, roomBelow / MAX_FOLLOW_M);
  return {
    target: Math.max(minScale, Math.min(fitScale, egoScale)),
    pinned: egoScale < minScale - 1e-9,
  };
}

// Displayed scale per canvas, eased toward the target in log space.
const scaleState = new WeakMap();
function easeScale(canvas, id, target) {
  const now = performance.now();
  const st = scaleState.get(canvas);
  if (!st || st.id !== id) { scaleState.set(canvas, { id, t: now, ls: Math.log(target) }); return target; }
  const dt = Math.min(0.5, Math.max(0, (now - st.t) / 1000)); // a backgrounded tab mustn't jump
  st.t = now;
  st.ls += (Math.log(target) - st.ls) * (1 - Math.exp(-dt / EASE_TAU_S));
  return Math.exp(st.ls);
}

const aspectVar = { red: '--red', amber: '--yellow', 'flash-amber': '--yellow', green: '--green' };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

// Non-car ways get a thin line; everything else (incl. service) is a car road.
const NON_CAR = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'track', 'bridleway', 'corridor', 'living_street']);
const LANE_M = 3.2;

// Per-streets-object cache, in local metres around the junction (the street
// centre may differ from the pin if it was moved after fetching, so `off`
// shifts every point). Path2D lets each frame be a few stroke() calls under one
// transform instead of re-projecting hundreds of points at 4 Hz.
const streetCache = new WeakMap();
function buildStreets(streets, off) {
  const car = new Map(), thin = new Path2D(), zebra = new Path2D();
  const trace = (path, pts) => pts.forEach(([e, n], i) => (i ? path.lineTo(e + off.e, n + off.n) : path.moveTo(e + off.e, n + off.n)));
  for (const w of streets.ways) {
    if (w.crossing === 'traffic_signals') { trace(zebra, w.pts); continue; }
    if (NON_CAR.has(w.h)) { trace(thin, w.pts); continue; }
    const wm = Math.max(w.lanes || (w.oneway ? 1 : 2), 1) * LANE_M;
    const key = (w.h === 'motorway' || w.h === 'trunk' ? 'x' : 'c') + wm;
    if (!car.has(key)) car.set(key, { wm, dark: key[0] === 'x', path: new Path2D() });
    trace(car.get(key).path, w.pts);
  }
  return {
    off, thin, zebra,
    car: [...car.values()].sort((a, b) => b.wm - a.wm), // wide first so narrow roads' fill sits on top of their casing
  };
}
const streetsFor = (streets, off) => {
  let c = streetCache.get(streets);
  if (!c || c.off.e !== off.e || c.off.n !== off.n) streetCache.set(streets, c = buildStreets(streets, off));
  return c;
};

// Plain lines (kind 'plain'): `ctx` already carries the metres -> screen transform.
function drawPlain(ctx, st, k) {
  const road = roadPalette().drive;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = cssVar('--line'); // all casings first so a fill never gets cut by a neighbour's casing
  // Widths are in metres under the transform, so floor them at a pixel minimum.
  for (const g of st.car) { ctx.lineWidth = Math.max(g.wm + 1.2, MIN_ROAD_CASING_PX / k); ctx.stroke(g.path); }
  for (const g of st.car) { ctx.strokeStyle = g.dark ? '#1b1b22' : road; ctx.lineWidth = Math.max(g.wm, MIN_ROAD_FILL_PX / k); ctx.stroke(g.path); }
  ctx.strokeStyle = cssVar('--dark'); ctx.lineWidth = 1.8; ctx.stroke(st.thin);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.lineCap = 'butt'; ctx.setLineDash([0.6, 0.6]); ctx.stroke(st.zebra); ctx.setLineDash([]);
}

// Lane polygons (kind 'lanes'): rings are flat integer-cm arrays in metres east/
// north of the entry's centre, so one Path2D per group is built once per entry
// and drawn under the same transform as the plain lines (+ a translate for the
// centre-vs-pin offset).
const lanesCache = new WeakMap();
const ringPath = (path, rings) => {
  for (const r of rings) {
    path.moveTo(r[0] / 100, r[1] / 100);
    for (let i = 2; i < r.length; i += 2) path.lineTo(r[i] / 100, r[i + 1] / 100);
    path.closePath();
  }
  return path;
};
function buildLanes(data) {
  return data.layers.map((l) => {
    const lane = (k) => ringPath(new Path2D(), l.lanes.filter((x) => x.k === k).map((x) => x.r));
    const p = (rings) => ringPath(new Path2D(), rings ?? []);
    return {
      z: l.z, walk: lane('walk'), park: lane('park'), bike: lane('bike'), drive: lane('drive'),
      ints: p(l.ints), corner: p(l.corner), sep: p(l.sep), mid: p(l.mid), stop: p(l.stop), arrow: p(l.arrow), zebra: p(l.zebra),
    };
  });
}

// Approach tinting: the last TINT_M before each controlled approach's lane end is washed
// in its head's current colour. 35 m is roughly the queue / braking stretch you actually
// watch the light over; further out the colour would just clutter the corridor. The wash
// is strongest at the stop line and holds to half of TINT_M before fading out, so there
// is no hard edge across the road.
export const TINT_M = 35;
const TINT_HOLD = 0.5;

// '#rrggbb' + alpha -> 'rgba()'; anything else (the vars are always hex) falls back to grey.
const withAlpha = (c, a) => {
  const m = /^#([0-9a-f]{6})$/i.exec(c), v = parseInt(m ? m[1] : '888888', 16);
  return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`;
};

// Matching approaches to heads is pure (src/osm/approaches.js) and only changes when the
// masts do: cache it per streets entry, keyed by what it depends on (not per frame).
const tintCache = new WeakMap();
const tintSig = (ixs) => ixs.map((i) => `${i.id}@${i.location?.lat},${i.location?.lon}:${(i.masts ?? []).map((m) => `${m.id}/${m.pos?.lat},${m.pos?.lon}/${(m.headIds ?? []).join()}`).join(';')}`).sort().join('|');
function tintsFor(streets, ixs) {
  const sig = tintSig(ixs);
  let c = tintCache.get(streets);
  if (c?.sig === sig) return c.items;
  const { matches } = matchApproaches(streets.data, streets.center, ixs);
  const layers = streets.data.layers;
  const items = matches.filter((m) => layers[m.layer].z === 0 && m.lanes.length).map((m) => ({
    ixId: m.ixId, headId: m.headId, x: m.x, y: m.y, dx: Math.sin(m.bearing * RAD), dy: Math.cos(m.bearing * RAD), // travel direction (east, north)
    path: ringPath(new Path2D(), m.lanes.map((i) => layers[m.layer].lanes[i].r)),
  }));
  tintCache.set(streets, c = { sig, items });
  return items;
}

// '#rrggbb' -> relative luminance (0..1); unknown formats count as dark.
const isLightColor = (c) => {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return false;
  const v = parseInt(m[1], 16);
  return (0.2126 * (v >> 16) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255 > 0.5;
};

// Road palette. The canvas sits on --panel2 -> --panel, so asphalt must differ
// from those, not reuse them: Apple-Maps-dark-like, background darkest, driving
// lanes mid-dark grey, junctions a touch lighter, parking/shoulder darker than
// driving, sidewalks subtle. The light theme inverts it (asphalt darker than the
// pale canvas, sidewalks between), white markings stay legible on both.
const ASPHALT_DARK = { drive: '#3d4553', ints: '#485160', park: '#313846', walk: '#29303c' };
const ASPHALT_LIGHT = { drive: '#7f8898', ints: '#8a93a3', park: '#727b8b', walk: '#b3bac6' };
const roadPalette = () => (isLightColor(cssVar('--panel')) ? ASPHALT_LIGHT : ASPHALT_DARK);

// `ctx` already carries the metres -> screen transform (and the centre offset).
// Spain: every marking is white.
function drawLanes(ctx, data, k, tints = []) {
  let layers = lanesCache.get(data);
  if (!layers) lanesCache.set(data, layers = buildLanes(data));
  const pal = roadPalette();
  const green = cssVar('--green');
  const fill = (path, color, alpha = 1) => { ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.fill(path); };
  const tint = () => { // above the asphalt, below every marking
    ctx.globalAlpha = 1;
    for (const t of tints) {
      const g = ctx.createLinearGradient(t.x, t.y, t.x - t.dx * TINT_M, t.y - t.dy * TINT_M); // stop line -> TINT_M back
      g.addColorStop(0, withAlpha(t.color, t.strength));
      g.addColorStop(TINT_HOLD, withAlpha(t.color, t.strength));
      g.addColorStop(1, withAlpha(t.color, 0));
      ctx.fillStyle = g; ctx.fill(t.path);
    }
  };
  for (const l of layers) { // ascending: a bridge (z>0) paints over the road beneath
    if (l.z > 0) { // dark casing so the deck reads as above
      ctx.globalAlpha = 1; ctx.strokeStyle = '#0b0d11'; ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1.2, 3 / k);
      for (const g of [l.walk, l.park, l.bike, l.drive]) ctx.stroke(g);
    }
    fill(l.walk, pal.walk);                                      // sidewalks / footways
    fill(l.park, pal.park);                                      // parking / shoulder
    fill(l.bike, pal.park); fill(l.bike, green, 0.2);            // bike lanes: faint green
    fill(l.drive, pal.drive);
    fill(l.ints, pal.ints);                                      // junctions read lighter
    fill(l.corner, pal.walk);
    if (l.z === 0) tint();
    fill(l.sep, '#fff', 0.6);
    fill(l.mid, '#fff', 0.85);
    fill(l.arrow, '#fff', 0.85);
    fill(l.stop, '#f2f2f4');
    fill(l.zebra, '#fff', 0.88);
  }
  ctx.globalAlpha = 1;
}

// Local east/north metres of `pt` relative to `ref`.
function toEN(pt, ref) {
  return {
    e: (pt.lon - ref.lon) * Math.cos(ref.lat * RAD) * R * RAD,
    n: (pt.lat - ref.lat) * R * RAD,
  };
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Object} scene
 * @param {import('../domain/model.js').Intersection} scene.intersection
 * @param {{lat:number,lon:number}|null} scene.ego
 * @param {number} scene.upDeg               resolved heading (deg) to orient "up"
 * @param {(headId:string)=>string} scene.aspectOf   current aspect per head
 * @param {string|null} scene.activeHeadId
 * @param {{kind:'lanes'|'plain', center:{lat:number,lon:number}, data:Object}|null} [scene.streets]  cached street geometry (src/osm/lanes-cache.js)
 * @param {'loading'|'failed'|'offline'|null} [scene.streetStatus]  why there are no streets yet (a muted note, bottom-left)
 * @param {Array<{ix:Object, aspectOf:(headId:string)=>string}>} [scene.neighbors]  other intersections of the same cluster: a colour per head, drawn as display-only dots
 * @param {(ixId:string, headId:string)=>({aspect:string, strength:number}|null)} [scene.tintOf]  colour + alpha to wash that head's approach with (lanes only); null = no tint
 * @returns {Array<{headId:string,x0:number,y0:number,x1:number,y1:number}>} hit boxes
 */
export function drawScene(canvas, scene) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 320;
  const H = canvas.clientHeight || 260;
  // Reassigning width/height reallocates the backing store even when unchanged;
  // only do it on a real size change (this runs 4×/s on the car's browser).
  const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const { intersection: ix, ego, upDeg, aspectOf, activeHeadId, streets } = scene;
  const c = ix?.location;
  if (!c || typeof c.lat !== 'number') return [];

  // Everything is placed relative to the junction centre, in the travel frame
  // (forward = up). The junction sits below the HUD band at the top.
  const th = (upDeg ?? 0) * RAD;
  const fl = (en) => ({ f: en.e * Math.sin(th) + en.n * Math.cos(th), l: en.e * Math.cos(th) - en.n * Math.sin(th) });
  const masts = (ix.masts || []).filter((m) => m.pos).map((m) => ({ m, p: fl(toEN(m.pos, c)) }));
  const radiusM = Math.max(15, ...masts.map(({ p }) => Math.hypot(p.f, p.l)));
  // A tall pane (car layout) carries a much bigger countdown on top, so the
  // junction sits lower; labels scale up with the canvas.
  const tall = H > 500;
  const radiusPx = Math.min(W * 0.36, H * (tall ? 0.24 : 0.27));
  const fitScale = (radiusPx / radiusM) * ZOOM; // px per metre when the whole junction just fits — the closest zoom
  const jx = W / 2, jy = H * (tall ? 0.64 : 0.60);
  const labelPx = W > 500 ? 18 : 12;

  // Dynamic zoom: zoom out just enough to keep ego on screen, eased over time.
  const egoP = ego && typeof ego.lat === 'number' ? fl(toEN(ego, c)) : null;
  const { target, pinned } = sceneScale({ W, H, jy, fitScale, egoF: egoP?.f, egoL: egoP?.l, tall });
  const scale = easeScale(canvas, ix.id, target);
  const screen = (p) => ({ x: jx + p.l * scale, y: jy - p.f * scale });

  // Ego: true position if it's on screen, otherwise pinned to the bottom edge
  // along the approach, labelled with the distance (only when even the widest
  // zoom can't hold it, not while the zoom is still easing out).
  let egoPt = null, egoLabel = '';
  if (egoP) {
    const s = screen(egoP);
    const distM = Math.hypot(egoP.f, egoP.l);
    const bottom = H - 22;
    if (s.y > bottom || s.x < 12 || s.x > W - 12) {
      // walk from the junction toward ego until we hit the frame
      const k = Math.min(Math.abs((bottom - jy) / Math.max(1e-6, s.y - jy)), Math.abs((W / 2 - 14) / Math.max(1e-6, Math.abs(s.x - jx))));
      egoPt = { x: jx + (s.x - jx) * k, y: jy + (s.y - jy) * k };
      if (pinned) egoLabel = distM >= 1000 ? `${(distM / 1000).toFixed(1)} km` : `${Math.round(distM / 10) * 10} m`;
    } else egoPt = s;
  }

  // scene.streets: a cache entry { kind, center, data } (src/osm/lanes-cache.js); its
  // centre is the cluster area's, not the pin's, so it is offset against this junction.
  const neighbors = (scene.neighbors ?? []).filter((n) => n.ix?.masts);
  const sd = streets?.center ? streets.data : null;
  const lanes = streets?.kind === 'lanes' && !!sd?.layers?.length;
  const plain = streets?.kind === 'plain' && !!sd?.ways?.length;
  const hasStreets = lanes || plain;
  if (hasStreets) {
    // One transform maps local (east, north) metres straight to the screen:
    // the same rotation as fl() + screen() (forward = up, left stays left) —
    // x = jx + scale·(e·cosθ − n·sinθ), y = jy − scale·(e·sinθ + n·cosθ).
    const k = scale, cs = Math.cos(th), sn = Math.sin(th);
    ctx.save();
    ctx.transform(k * cs, -k * sn, -k * sn, -k * cs, jx, jy);
    const off = toEN(streets.center, c);
    if (lanes) {
      ctx.translate(off.e, off.n);
      // approach tints: only heads the model has a colour for; positions are in the entry's frame, like the lanes
      const tints = [];
      if (scene.tintOf) {
        for (const it of tintsFor(streets, [ix, ...neighbors.map((n) => n.ix)])) {
          const t = scene.tintOf(it.ixId, it.headId), v = t && aspectVar[t.aspect];
          if (v && t.strength > 0) tints.push({ ...it, color: cssVar(v), strength: t.strength });
        }
      }
      drawLanes(ctx, sd, k, tints);
    } else drawPlain(ctx, streetsFor(sd, off), k);
    ctx.restore();
  } else {
    // approach road: from the frame edge through ego to the junction
    const road = cssVar('--panel2');
    const roadW = Math.max(20, Math.min(46, 7 * scale));
    const padR = radiusPx * 0.62 * (scale / fitScale); // the pad is junction-sized, so it follows the zoom
    ctx.lineCap = 'round';
    ctx.strokeStyle = road;
    ctx.lineWidth = roadW;
    ctx.beginPath();
    if (egoPt) { ctx.moveTo(jx + (egoPt.x - jx) * 1.6, jy + (egoPt.y - jy) * 1.6); }
    else ctx.moveTo(jx, H + 20);
    ctx.lineTo(jx, jy); ctx.stroke();

    // junction pad
    ctx.fillStyle = road;
    ctx.beginPath(); ctx.arc(jx, jy, padR, 0, 7); ctx.fill();
    ctx.strokeStyle = cssVar('--line'); ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.arc(jx, jy, padR, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  }

  if (!masts.length) {
    ctx.fillStyle = cssVar('--muted');
    ctx.font = `${labelPx + 2}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('Place masts on the map (Edit) to see heads here', jx, jy);
  }

  // lights: one per head on each mast
  const boxes = [];
  const size = Math.max(34, Math.min(58, radiusPx * 0.46));
  const drawLight = (x, y, litAspect, active, headId) => {
    const w = size * 0.5, h = size * 1.36, r = w * 0.28;
    const bx = x - w / 2, by = y - h / 2;
    if (active) { // halo so the head you're predicting stands out
      ctx.fillStyle = cssVar('--accent'); ctx.globalAlpha = 0.25;
      roundRect(ctx, bx - 6, by - 6, w + 12, h + 12, r + 6); ctx.fill(); ctx.globalAlpha = 1;
    }
    roundRect(ctx, bx, by, w, h, r);
    ctx.fillStyle = '#0e0e12'; ctx.fill();
    if (active) { ctx.lineWidth = 2.5; ctx.strokeStyle = cssVar('--accent'); ctx.stroke(); }
    const cr = w * 0.3;
    [['red', '--red'], ['amber', '--yellow'], ['green', '--green']].forEach(([asp, varn], i) => {
      const cy = by + h * (0.2 + 0.3 * i);
      const on = litAspect === asp || (litAspect === 'flash-amber' && asp === 'amber');
      ctx.beginPath(); ctx.arc(x, cy, cr, 0, 7);
      ctx.fillStyle = on ? cssVar(varn) : cssVar('--dark');
      ctx.globalAlpha = on ? 1 : 0.35; ctx.fill(); ctx.globalAlpha = 1;
    });
    boxes.push({ headId, x0: bx - 12, y0: by - 12, x1: bx + w + 12, y1: by + h + 12 });
  };
  // Zoomed out: one round dot per head in the current colour (no 3-lamp box).
  const compact = compactLights(compactState.get(canvas) ?? false, scale, fitScale);
  compactState.set(canvas, compact);
  const dotR = Math.round(labelPx * 0.8), dotStep = dotR * 2 + 4, tap = Math.max(44, dotStep);
  const drawDot = (x, y, litAspect, active, headId) => {
    if (active) { // accent halo so the head you're predicting stands out
      ctx.fillStyle = cssVar('--accent'); ctx.globalAlpha = 0.3;
      ctx.beginPath(); ctx.arc(x, y, dotR + 6, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    }
    const v = aspectVar[litAspect];
    ctx.beginPath(); ctx.arc(x, y, dotR, 0, 7);
    ctx.fillStyle = v ? cssVar(v) : cssVar('--dark'); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#0e0e12'; ctx.stroke(); // dark ring for contrast on the streets
    if (active) { ctx.lineWidth = 2; ctx.strokeStyle = cssVar('--accent'); ctx.beginPath(); ctx.arc(x, y, dotR + 3, 0, 7); ctx.stroke(); }
    boxes.push({ headId, x0: x - tap / 2, y0: y - tap / 2, x1: x + tap / 2, y1: y + tap / 2 });
  };
  // Neighbouring intersections: one small dot per head, display-only (no hit boxes, no halo).
  const nR = Math.round(dotR * NEIGHBOR_DOT_SCALE), nStep = nR * 2 + 3;
  for (const n of neighbors) {
    for (const m of n.ix.masts ?? []) {
      if (!m.pos) continue;
      const s = screen(fl(toEN(m.pos, c)));
      if (s.x < -nR || s.x > W + nR || s.y < -nR || s.y > H + nR) continue;
      const ids = m.headIds?.length ? m.headIds : [null];
      ids.forEach((hid, i) => {
        const v = hid ? aspectVar[n.aspectOf?.(hid)] : null;
        const x = s.x + (i - (ids.length - 1) / 2) * nStep;
        ctx.beginPath(); ctx.arc(x, s.y, nR, 0, 7);
        ctx.fillStyle = v ? cssVar(v) : cssVar('--dark'); ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = '#0e0e12'; ctx.stroke();
      });
    }
  }
  for (const { m, p } of masts) {
    const s = screen(p);
    const ids = m.headIds?.length ? m.headIds : [null];
    if (compact) {
      ids.forEach((hid, i) => drawDot(s.x + (i - (ids.length - 1) / 2) * dotStep, s.y, hid ? aspectOf(hid) : 'off', !!hid && hid === activeHeadId, hid));
      continue;
    }
    ids.forEach((hid, i) => {
      const ox = s.x + (i - (ids.length - 1) / 2) * size * 0.62;
      drawLight(ox, s.y, hid ? aspectOf(hid) : 'off', !!hid && hid === activeHeadId, hid);
    });
  }

  // ego chevron (+ distance while still far out)
  if (egoPt) {
    ctx.fillStyle = cssVar('--accent');
    ctx.beginPath();
    ctx.moveTo(egoPt.x, egoPt.y - 14); ctx.lineTo(egoPt.x - 12, egoPt.y + 12);
    ctx.lineTo(egoPt.x, egoPt.y + 4); ctx.lineTo(egoPt.x + 12, egoPt.y + 12);
    ctx.closePath(); ctx.fill();
    if (egoLabel) {
      ctx.fillStyle = cssVar('--muted'); ctx.font = `600 ${labelPx}px system-ui, sans-serif`;
      ctx.textAlign = 'left'; ctx.fillText(egoLabel, egoPt.x + 18, egoPt.y + 6);
    }
  }
  if (hasStreets) { // ODbL attribution, always shown with OSM data
    ctx.fillStyle = cssVar('--muted'); ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('© OpenStreetMap contributors', W - 6, H - 6);
  } else if (STREET_NOTE[scene.streetStatus]) {
    ctx.fillStyle = cssVar('--muted'); ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(STREET_NOTE[scene.streetStatus], 6, H - 6);
  }
  return boxes;
}
