// Live junction view. A zero-dependency Canvas 2D chase-cam of the upcoming
// intersection (Leaflet can't rotate, hence hand-rolled): rotated so your
// direction of travel points up, zoomed on the JUNCTION (not fit-to-everything,
// which collapsed it to a speck when you were still 200 m away), with you drawn
// on the approach road below — clamped to the bottom edge with a distance label
// while you're further out. Masts render as Spanish 3-aspect lights lit from the
// current prediction.
//
// It's display + a head picker: drawScene() returns hit boxes {headId, x0..y1}
// so a tap on a pole can make that head active. Color taps happen on the big
// upright panel below the canvas, so tap targets never shrink with the zoom.
// Arms carry no positions in real exports, so only the approach road (which we
// do know: from you to the centre) is drawn — no invented street geometry.

const R = 6371000;
const RAD = Math.PI / 180;

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

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

  const { intersection: ix, ego, upDeg, aspectOf, activeHeadId } = scene;
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
  const scale = radiusPx / radiusM; // px per metre — fixed on the junction, not on you
  const jx = W / 2, jy = H * (tall ? 0.64 : 0.60);
  const labelPx = W > 500 ? 18 : 12;
  const screen = (p) => ({ x: jx + p.l * scale, y: jy - p.f * scale });

  // Ego: true position if it's on screen, otherwise pinned to the bottom edge
  // along the approach, labelled with the distance.
  let egoPt = null, egoLabel = '';
  if (ego && typeof ego.lat === 'number') {
    const p = fl(toEN(ego, c));
    const s = screen(p);
    const distM = Math.hypot(p.f, p.l);
    const bottom = H - 22;
    if (s.y > bottom || s.x < 12 || s.x > W - 12) {
      // walk from the junction toward ego until we hit the frame
      const k = Math.min(Math.abs((bottom - jy) / Math.max(1e-6, s.y - jy)), Math.abs((W / 2 - 14) / Math.max(1e-6, Math.abs(s.x - jx))));
      egoPt = { x: jx + (s.x - jx) * k, y: jy + (s.y - jy) * k };
      egoLabel = distM >= 1000 ? `${(distM / 1000).toFixed(1)} km` : `${Math.round(distM / 10) * 10} m`;
    } else egoPt = s;
  }

  // approach road: from the frame edge through ego to the junction
  const road = cssVar('--panel2');
  const roadW = Math.max(20, Math.min(46, 7 * scale));
  ctx.lineCap = 'round';
  ctx.strokeStyle = road;
  ctx.lineWidth = roadW;
  ctx.beginPath();
  if (egoPt) { ctx.moveTo(jx + (egoPt.x - jx) * 1.6, jy + (egoPt.y - jy) * 1.6); }
  else ctx.moveTo(jx, H + 20);
  ctx.lineTo(jx, jy); ctx.stroke();

  // junction pad
  ctx.fillStyle = road;
  ctx.beginPath(); ctx.arc(jx, jy, radiusPx * 0.62, 0, 7); ctx.fill();
  ctx.strokeStyle = cssVar('--line'); ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
  ctx.beginPath(); ctx.arc(jx, jy, radiusPx * 0.62, 0, 7); ctx.stroke(); ctx.setLineDash([]);

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
  for (const { m, p } of masts) {
    const s = screen(p);
    const ids = m.headIds?.length ? m.headIds : [null];
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
  return boxes;
}
