// Lane-level street geometry for the Live tab, built by osm2streets (vendored
// wasm, see vendor/osm2streets/README.md). This file is the pure, DOM-free half:
// the OSM XML fetch (main OSM API map call, Overpass as fallback), the clip polygon, running a street network
// and squeezing its four GeoJSON outputs into the compact local-metre structure
// the renderer draws. The wasm itself is loaded by lanes-worker.js (browser) or
// by the tests (initSync), so nothing here touches it directly.

import { fetchOverpass } from './streets.js';

const R = 6371000;
const RAD = Math.PI / 180;

export const OSM2STREETS_OPTS = {
  debug_each_step: false,
  dual_carriageway_experiment: true,
  sidepath_zipping_experiment: false,
  inferred_sidewalks: false, // MUST stay false: true drops the separately mapped footways + crossing ways (no zebras)
  inferred_kerbs: true,
  date_time: null,
  override_driving_side: 'Right',
};

// Dynamic zoom follows ego out to 200 m (live-scene MAX_FOLLOW_M), so streets must reach that far.
export const CLIP_HALF_M = 200;
// Lane arrows are only kept this close to a stop line (clutter otherwise).
export const ARROW_NEAR_STOP_M = 25;
/**
 * [south, west, north, east] (degrees) of the bounding box of `points` expanded by
 * `halfM` metres on every side. One point -> the ±halfM square around it; a
 * cluster of junctions -> one shared area.
 */
export function areaBbox(points, halfM = CLIP_HALF_M) {
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  const south = Math.min(...lats), north = Math.max(...lats), west = Math.min(...lons), east = Math.max(...lons);
  const dLat = halfM / (R * RAD), dLon = halfM / (R * RAD * Math.cos(((south + north) / 2) * RAD));
  return [south - dLat, west - dLon, north + dLat, east + dLon];
}

export const bboxCenter = ([s, w, n, e]) => ({ lat: (s + n) / 2, lon: (w + e) / 2 });

/** Overpass QL (XML): every highway way touching the bbox + all their nodes (crossings are tagged nodes). */
export function overpassXmlQuery(bbox) {
  return `[out:xml][timeout:25];(way(${bbox.map((v) => v.toFixed(6)).join(',')})[highway];);(._;>;);out body;`;
}

/** One-Polygon FeatureCollection (what osm2streets wants) of the bbox. */
export function clipGeojson([south, west, north, east]) {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon',
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] } }],
  });
}

// The main OSM API serves any bbox up to this area (deg²) and answers HTTP 400 beyond
// it, or when it holds more than 50,000 nodes. Cluster bboxes are ~1.5 km, far below.
export const OSM_API_MAP_URL = 'https://api.openstreetmap.org/api/0.6/map';
export const OSM_API_MAX_AREA_DEG2 = 0.25;
export const OSM_API_TIMEOUT_MS = 30000;

const looksLikeOsm = (bytes) => /<osm[\s>]/.test(new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096))));

/**
 * PRIMARY source: the OSM API `map` call over the bbox. Full OSM XML (buildings etc. too,
 * which osm2streets ignores), fast, CORS-enabled and not subject to Overpass's queueing.
 * Throws on a too-large bbox, any non-200 (400 = too many nodes), junk, or timeout.
 */
export async function fetchOsmApiXml([south, west, north, east], { fetch = globalThis.fetch, timeoutMs = OSM_API_TIMEOUT_MS } = {}) {
  if ((north - south) * (east - west) > OSM_API_MAX_AREA_DEG2) throw new Error('OSM API: bbox too large');
  const url = `${OSM_API_MAP_URL}?bbox=${[west, south, east, north].map((v) => v.toFixed(6)).join(',')}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!looksLikeOsm(bytes)) throw new Error('unexpected response');
    return bytes;
  } catch (e) {
    throw new Error(`OSM API: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
  } finally { clearTimeout(timer); }
}

/** FALLBACK source: OSM XML (highway ways + nodes only) from Overpass, as bytes. */
export function fetchOverpassXml(bbox, opts = {}) {
  return fetchOverpass(overpassXmlQuery(bbox), async (res) => {
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Overpass reports runtime errors / timeouts inside a 200 response
    if (!looksLikeOsm(bytes)) throw new Error('unexpected response');
    const tail = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 1024)));
    if (/<remark>[^<]*(error|timed out|out of memory)/i.test(tail)) throw new Error('Overpass runtime error');
    return bytes;
  }, opts);
}

/**
 * Fetch the OSM XML for an area as bytes (osm2streets wants a Uint8Array): the OSM API
 * first, then Overpass (its endpoints in turn). Throws one Error naming every failure.
 */
export async function fetchOsmXml(bbox, { fetch = globalThis.fetch, osmApi = {}, overpass = {} } = {}) {
  try { return await fetchOsmApiXml(bbox, { fetch, ...osmApi }); } catch (apiErr) {
    try { return await fetchOverpassXml(bbox, { fetch, ...overpass }); } catch (e) {
      throw new Error(`${apiErr.message}; ${e.message}`);
    }
  }
}

const baseType = (t) => String(t ?? '').replace(/\(.*\)/, '');
const KIND = {
  Driving: 'drive', Bus: 'drive', SharedLeftTurn: 'drive',
  Parking: 'park', Shoulder: 'park', Construction: 'park', LightRail: 'park',
  Biking: 'bike',
  Sidewalk: 'walk', Footway: 'walk', SharedUse: 'walk', Buffer: 'walk',
};
const laneKind = (t) => KIND[baseType(t)] ?? 'park';

const asJson = (x) => (typeof x === 'string' ? JSON.parse(x) : x ?? { features: [] });

/** Exterior rings of a (Multi)Polygon geometry (holes never occur in osm2streets output). */
const rings = (g) => (g?.type === 'Polygon' ? [g.coordinates[0]] : g?.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : []);

/**
 * osm2streets outputs -> compact drawable structure, in integer centimetres east/north of `center`.
 * @param {{lanes:string|Object, markings:string|Object, imarkings:string|Object, plain:string|Object}} outputs
 * @param {{lat:number,lon:number}} center
 * @returns {{layers:Array<{z:number, lanes:Array<{k:string,r:number[],a?:number,b?:number}>, ints:number[][], corner:number[][],
 *   sep:number[][], mid:number[][], stop:number[][], arrow:number[][], zebra:number[][], appr?:number[][]}>}}
 *   every ring `r` is a flat [x0,y0,x1,y1,…] (cm), not closed; layer 0 may carry `appr` (see linkApproaches),
 *   referenced by its incoming driving lanes' `a`; layer-0 driving lanes also carry their travel bearing `b` (deg)
 */
export function compactLanes(outputs, center) {
  const kx = R * RAD * Math.cos(center.lat * RAD) * 100, ky = R * RAD * 100;
  const layers = new Map();
  const layer = (z) => {
    if (!layers.has(z)) layers.set(z, { z, lanes: [], ints: [], corner: [], sep: [], mid: [], stop: [], arrow: [], zebra: [] });
    return layers.get(z);
  };
  const flat = (ring) => {
    const out = [];
    for (const [lon, lat] of ring) {
      const x = Math.round((lon - center.lon) * kx), y = Math.round((lat - center.lat) * ky);
      if (out.length >= 2 && out[out.length - 2] === x && out[out.length - 1] === y) continue; // rounding collapsed it
      out.push(x, y);
    }
    if (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2; // GeoJSON closes rings
    return out.length >= 6 ? out : null;
  };
  const each = (fc, fn) => {
    for (const f of asJson(fc).features) for (const g of rings(f.geometry)) { const r = flat(g); if (r) fn(f.properties ?? {}, r); }
  };

  // Incoming driving lanes (layer 0) are remembered for the approach linkage below.
  const incoming = [];
  each(outputs.lanes, (p, r) => {
    const lane = { k: laneKind(p.type), r };
    layer(p.layer ?? 0).lanes.push(lane);
    const bt = baseType(p.type);
    if ((p.layer ?? 0) === 0 && (bt === 'Driving' || bt === 'Bus') && (p.direction === 'Forward' || p.direction === 'Backward') && p.road != null) {
      incoming.push({ lane, r, road: p.road, fwd: p.direction === 'Forward', way: p.osm_way_ids?.[0] ?? 0 });
    }
  });
  const roadEnds = new Map(), ixCentre = new Map(); // road id -> [src, dst] intersection ids; intersection id -> centroid (cm)
  for (const f of asJson(outputs.plain).features) if (f.properties?.type === 'road') roadEnds.set(f.properties.id, [f.properties.src_i, f.properties.dst_i]);
  each(outputs.plain, (p, r) => {
    if (p.type !== 'intersection') return;
    layer(p.layer ?? 0).ints.push(r);
    ixCentre.set(p.id, centroid(r));
  });

  // Stop lines first: arrows are kept only near one. Stop lines carry no layer (→ 0).
  const stops = [];
  each(outputs.markings, (p, r) => {
    if (p.type === 'vehicle stop line') { layer(0).stop.push(r); stops.push(centroid(r)); }
  });
  const near = ARROW_NEAR_STOP_M * 100;
  each(outputs.markings, (p, r) => {
    const z = p.layer ?? 0;
    if (p.type === 'lane separator') layer(z).sep.push(r);
    else if (p.type === 'center line') layer(z).mid.push(r);
    else if (p.type === 'lane arrow') {
      const [cx, cy] = centroid(r);
      if (stops.some(([sx, sy]) => Math.hypot(cx - sx, cy - sy) <= near)) layer(z).arrow.push(r);
    } // parking hatches, sidewalk lines and path outlines are noise: not kept
  });
  each(outputs.imarkings, (p, r) => {
    if (p.type === 'marked crossing line') layer(0).zebra.push(r);
    else if (p.type === 'sidewalk corner') layer(0).corner.push(r);
  });

  for (const c of incoming) {
    const [src, dst] = roadEnds.get(c.road) ?? [], from = ixCentre.get(c.fwd ? src : dst), to = ixCentre.get(c.fwd ? dst : src);
    if (from && to) c.lane.b = laneBearing(c.r, from, to);
  }
  if (incoming.length) linkApproaches(layer(0), incoming, roadEnds, ixCentre);

  return { layers: [...layers.values()].sort((a, b) => a.z - b.z) };
}

// Travel bearing (compass deg) of a driving lane: its long axis (the two ring vertices furthest
// apart), signed to run from the intersection it starts at towards the one it ends at.
function laneBearing(r, from, to) {
  let ax = 0, ay = 0, d2 = -1;
  for (let i = 0; i < r.length; i += 2) for (let j = i + 2; j < r.length; j += 2) {
    const dx = r[j] - r[i], dy = r[j + 1] - r[i + 1], d = dx * dx + dy * dy;
    if (d > d2) { d2 = d; ax = dx; ay = dy; }
  }
  if (ax * (to[0] - from[0]) + ay * (to[1] - from[1]) < 0) { ax = -ax; ay = -ay; }
  return (Math.round(Math.atan2(ax, ay) / RAD) + 360) % 360;
}

// A lane's end is the edge of its ring nearest the intersection it runs into: the two
// ring vertices closest to that intersection's centroid. Travel direction = that edge's
// normal pointing at the centroid (a curved lane's whole-ring direction would be skewed).
function laneEnd(r, ic) {
  const v = [];
  for (let i = 0; i < r.length; i += 2) v.push([r[i], r[i + 1]]);
  v.sort((a, b) => Math.hypot(a[0] - ic[0], a[1] - ic[1]) - Math.hypot(b[0] - ic[0], b[1] - ic[1]));
  const [p, q] = v, mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
  const toIc = [ic[0] - mx, ic[1] - my], tl = Math.hypot(...toIc) || 1;
  let nx = -(q[1] - p[1]), ny = q[0] - p[0];
  const nl = Math.hypot(nx, ny);
  if (nx * toIc[0] + ny * toIc[1] < 0) { nx = -nx; ny = -ny; }
  // a degenerate edge, or one not facing the centroid (> 60° off): just point at the centroid
  if (nl < 30 || (nx * toIc[0] + ny * toIc[1]) / (nl * tl) < 0.5) { nx = toIc[0]; ny = toIc[1]; }
  const l = Math.hypot(nx, ny) || 1;
  return { x: mx, y: my, ux: nx / l, uy: ny / l };
}

/**
 * Approach linkage for tinting: incoming driving lanes of the same road that run into the
 * same osm2streets intersection form one approach. (Not gated on a stop line: OSM often
 * maps stop lines on one arm only, e.g. Pont. Which approaches have a head is decided
 * later by the Onda masts, src/osm/approaches.js.)
 * Writes `layer.appr` = [[x, y, bearing, wayId], …] (lane-end point cm, travel compass
 * bearing deg, first OSM way) and tags each lane `a` = its approach index.
 */
function linkApproaches(l0, incoming, roadEnds, ixCentre) {
  const groups = new Map();
  for (const c of incoming) {
    const e = roadEnds.get(c.road)?.[c.fwd ? 1 : 0], ic = ixCentre.get(e);
    if (!ic) continue;
    const key = `${c.road}|${e}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ c, end: laneEnd(c.r, ic) });
  }
  const appr = [];
  for (const g of groups.values()) {
    const x = g.reduce((s, o) => s + o.end.x, 0) / g.length, y = g.reduce((s, o) => s + o.end.y, 0) / g.length;
    const ux = g.reduce((s, o) => s + o.end.ux, 0), uy = g.reduce((s, o) => s + o.end.uy, 0);
    appr.push([Math.round(x), Math.round(y), (Math.round(Math.atan2(ux, uy) / RAD) + 360) % 360, g[0].c.way]);
    for (const o of g) o.c.lane.a = appr.length - 1;
  }
  if (appr.length) l0.appr = appr;
}

/** Mean of a flat ring's vertices. */
export function centroid(r) {
  let x = 0, y = 0;
  for (let i = 0; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; }
  return [x / (r.length / 2), y / (r.length / 2)];
}

/**
 * Run osm2streets on OSM XML bytes (clipped to `bbox`) and compact the result around the bbox centre. `JsStreetNetwork` is
 * injected (the wasm glue is loaded by the caller: worker or Node test).
 * @returns {{data:Object, ms:{import:number,outputs:number,compact:number}}}
 */
export function buildLanes(JsStreetNetwork, osmBytes, bbox) {
  const center = bboxCenter(bbox);
  const t0 = performance.now();
  const net = new JsStreetNetwork(osmBytes, clipGeojson(bbox), OSM2STREETS_OPTS);
  try {
    const t1 = performance.now();
    const outputs = {
      lanes: net.toLanePolygonsGeojson(), markings: net.toLaneMarkingsGeojson(),
      imarkings: net.toIntersectionMarkingsGeojson(), plain: net.toGeojsonPlain(),
    };
    const t2 = performance.now();
    const data = compactLanes(outputs, center);
    return { data, ms: { import: t1 - t0, outputs: t2 - t1, compact: performance.now() - t2 } };
  } finally { net.free(); }
}
