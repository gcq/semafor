// Plain-line OSM street geometry for the Live tab: the FALLBACK when osm2streets
// (src/osm/lanes.js) can't build lane polygons for a junction, plus the shared
// Overpass POST used as the FALLBACK source of the OSM XML. Fetched in the
// background by the street cache (src/osm/lanes-cache.js), never while driving,
// compacted to local metres and kept on-device as derived data.
// Pure + DOM-free: fetch is injectable so tests never touch the network.

const R = 6371000;
const RAD = Math.PI / 180;

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Requests queue on overpass-api.de when it is busy (the query's own [timeout:25]
// only starts once it runs), so it gets a long client timeout; mirrors are last resort.
export const OVERPASS_TIMEOUTS_MS = { 'overpass-api.de': 90000 };
export const OVERPASS_DEFAULT_TIMEOUT_MS = 30000;

/** Overpass QL: every highway way (with geometry) + signal nodes around `center`, or inside `bbox` [s,w,n,e] when given. */
export function overpassQuery(center, radiusM = 150, bbox = null) {
  const a = bbox ? bbox.map((v) => v.toFixed(6)).join(',') : `around:${radiusM},${center.lat},${center.lon}`;
  return `[out:json][timeout:25];(way(${a})[highway];node(${a})[highway=traffic_signals];);out tags geom;`;
}

const round1 = (x) => Math.round(x * 10) / 10;

// Local east/north metres of a lat/lon relative to `ref` (same maths as live-scene's toEN).
const toEN = (lat, lon, ref) => [
  round1((lon - ref.lon) * Math.cos(ref.lat * RAD) * R * RAD),
  round1((lat - ref.lat) * R * RAD),
];

const isYes = (v) => v === 'yes' || v === '1' || v === 'true';

/**
 * Overpass JSON -> compact streets object.
 * @returns {{v:1, center:{lat:number,lon:number}, radiusM:number, fetchedAt:number,
 *   ways:Array<{h:string,name:string,lanes:number,oneway:boolean,crossing:string,pts:number[][]}>, signals:number[][]}}
 */
export function parseOverpass(json, center, fetchedAt = Date.now(), radiusM = 150) {
  const ways = [], signals = [];
  for (const el of json?.elements ?? []) {
    if (el.type === 'way') {
      const geom = (el.geometry ?? []).filter((g) => g && Number.isFinite(g.lat) && Number.isFinite(g.lon));
      if (geom.length < 2) continue;
      const t = el.tags ?? {};
      ways.push({
        h: t.highway ?? '',
        name: t.name ?? '',
        lanes: Number.parseInt(t.lanes, 10) || 0,
        // motorways and roundabouts are one-way even when untagged
        oneway: isYes(t.oneway) || t.highway === 'motorway' || t.junction === 'roundabout',
        crossing: t.crossing ?? '',
        pts: geom.map((g) => toEN(g.lat, g.lon, center)),
      });
    } else if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
      signals.push(toEN(el.lat, el.lon, center));
    }
  }
  return { v: 1, center: { lat: center.lat, lon: center.lon }, radiusM, fetchedAt, ways, signals };
}

/**
 * POST an Overpass QL `query` to each endpoint in turn and return `read(res)`
 * (which validates + decodes the body, throwing on junk) from the first that
 * works; throws a readable Error if all fail. Shared by the plain-line and the
 * osm2streets (XML) fetches.
 */
export async function fetchOverpass(query, read, { fetch = globalThis.fetch, endpoints = OVERPASS_ENDPOINTS, timeoutMs = null } = {}) {
  const body = new URLSearchParams({ data: query });
  const fails = [];
  for (const url of endpoints) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs ?? OVERPASS_TIMEOUTS_MS[new URL(url).hostname] ?? OVERPASS_DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', body, signal: ctl.signal });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return await read(res);
    } catch (e) {
      fails.push(`${new URL(url).hostname}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    } finally { clearTimeout(timer); }
  }
  throw new Error(`Overpass unavailable (${fails.join('; ')})`);
}

/** Plain-line fallback: Overpass JSON -> parseOverpass. */
export function fetchStreets(center, { radiusM = 150, bbox = null, ...opts } = {}) {
  return fetchOverpass(overpassQuery(center, radiusM, bbox), async (res) => {
    const json = await res.json(); // non-JSON (HTML error pages) throws here
    if (!json || !Array.isArray(json.elements)) throw new Error('unexpected response');
    return parseOverpass(json, center, Date.now(), radiusM);
  }, opts);
}
