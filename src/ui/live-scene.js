// Live chase-cam scene. A zero-dependency Canvas 2D view of the modelled
// intersection, drawn ego-down and rotated so the direction of travel points up
// (Leaflet can't rotate, hence hand-rolled). Masts render as Spanish 3-aspect
// lights lit from the current prediction. It is display + a mast picker; the
// actual color taps happen on the big upright panel the app pops out of the tilt,
// so tap targets never shrink with perspective.
//
// drawScene() returns hit boxes {headId, x0,y0,x1,y1} so the app can turn a tap
// on a pole into "make this head active".

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

const ASPECT_VAR = { red: '--red', amber: '--yellow', 'flash-amber': '--yellow', green: '--green' };

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
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const { intersection: ix, ego, upDeg, aspectOf, activeHeadId } = scene;
  const ref = ego || ix.location;
  if (!ref || typeof ref.lat !== 'number') return [];

  const masts = (ix.masts || []).filter((m) => m.pos);
  const arms = (ix.arms || []).filter((a) => a.pos);
  const ixEN = toEN(ix.location, ref);
  const mastEN = masts.map((m) => ({ m, en: toEN(m.pos, ref) }));
  const armEN = arms.map((a) => ({ a, en: toEN(a.pos, ref) }));

  // forward/lateral in the travel frame (heading -> +forward/up)
  const th = (upDeg ?? 0) * RAD;
  const fl = (en) => ({ f: en.e * Math.sin(th) + en.n * Math.cos(th), l: en.e * Math.cos(th) - en.n * Math.sin(th) });

  const cx = W / 2;
  const egoY = H * 0.78; // ego low: bias the canvas toward the road ahead
  const pts = [ixEN, ...mastEN.map((x) => x.en), ...armEN.map((x) => x.en)].map(fl);
  const maxF = Math.max(12, ...pts.map((p) => Math.abs(p.f)));
  const maxL = Math.max(8, ...pts.map((p) => Math.abs(p.l)));
  const scale = Math.min((egoY - H * 0.14) / maxF, (W * 0.40) / maxL);
  const screen = (en) => { const p = fl(en); return { x: cx + p.l * scale, y: egoY - p.f * scale }; };

  // roads: the approach under ego up to the junction, and stubs to each mast/arm
  const ixP = screen(ixEN);
  ctx.strokeStyle = cssVar('--panel2');
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(14, 26 * scale / 4);
  ctx.beginPath(); ctx.moveTo(cx, egoY + 10); ctx.lineTo(ixP.x, ixP.y); ctx.stroke();
  for (const { en } of [...armEN, ...mastEN]) {
    const p = screen(en);
    ctx.beginPath(); ctx.moveTo(ixP.x, ixP.y); ctx.lineTo(p.x, p.y); ctx.stroke();
  }

  // junction node
  ctx.fillStyle = cssVar('--line');
  ctx.beginPath(); ctx.arc(ixP.x, ixP.y, 5, 0, 7); ctx.fill();

  if (!mastEN.length) {
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Place masts on the map (Edit) to see heads here', cx, H * 0.30);
  }

  // lights: one per head on each mast; depth scales size a little (perspective)
  const boxes = [];
  const drawLight = (x, y, size, litAspect, active, headId) => {
    const w = size * 0.52, h = size * 1.4, r = w * 0.28;
    const bx = x - w / 2, by = y - h / 2;
    roundRect(ctx, bx, by, w, h, r);
    ctx.fillStyle = '#0e0e12'; ctx.fill();
    if (active) { ctx.lineWidth = 2.5; ctx.strokeStyle = cssVar('--accent'); ctx.stroke(); }
    const cr = w * 0.30;
    [['red', '--red'], ['amber', '--yellow'], ['green', '--green']].forEach(([asp, varn], i) => {
      const cyy = by + h * (0.22 + 0.28 * i);
      const on = litAspect === asp || (litAspect === 'flash-amber' && asp === 'amber');
      ctx.beginPath(); ctx.arc(x, cyy, cr, 0, 7);
      ctx.fillStyle = on ? cssVar(varn) : cssVar('--dark');
      ctx.globalAlpha = on ? 1 : 0.35; ctx.fill(); ctx.globalAlpha = 1;
    });
    boxes.push({ headId, x0: bx - 10, y0: by - 10, x1: bx + w + 10, y1: by + h + 10 });
  };

  for (const { m, en } of mastEN) {
    const p = screen(en);
    const depth = Math.max(0.55, Math.min(1.15, 1 - (fl(en).f * scale) / (H * 2)));
    const base = 46 * depth;
    const ids = m.headIds && m.headIds.length ? m.headIds : [null];
    ids.forEach((hid, i) => {
      const ox = p.x + (i - (ids.length - 1) / 2) * base * 0.6;
      drawLight(ox, p.y, base, hid ? aspectOf(hid) : 'off', hid && hid === activeHeadId, hid);
    });
  }

  // ego chevron
  ctx.fillStyle = cssVar('--accent');
  ctx.beginPath();
  ctx.moveTo(cx, egoY - 14); ctx.lineTo(cx - 12, egoY + 12);
  ctx.lineTo(cx, egoY + 4); ctx.lineTo(cx + 12, egoY + 12);
  ctx.closePath(); ctx.fill();

  return boxes;
}
