import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, JsStreetNetwork } from '../vendor/osm2streets/osm2streets_js.js';
import {
  overpassXmlQuery, clipGeojson, areaBbox, bboxCenter, compactLanes, buildLanes, centroid, fetchOsmXml, ARROW_NEAR_STOP_M,
} from '../src/osm/lanes.js';

const PONT = { lat: 41.4143, lon: 2.0121 };
initSync({ module: readFileSync(new URL('../vendor/osm2streets/osm2streets_js_bg.wasm', import.meta.url)) });
const BBOX = areaBbox([PONT]);
const osm = new Uint8Array(readFileSync(new URL('./data/pont.osm.xml', import.meta.url)));

test('overpassXmlQuery asks for XML with nodes, over the clip square (bbox)', () => {
  const q = overpassXmlQuery(BBOX);
  assert.match(q, /^\[out:xml\]/);
  assert.match(q, /way\(41\.412501,2\.009702,41\.416099,2\.014498\)\[highway\]/);
  assert.match(q, /\(\._;>;\);out body;$/);
});

test('clipGeojson is a closed ±200 m square around the centre', () => {
  const f = JSON.parse(clipGeojson(BBOX)).features[0].geometry.coordinates[0];
  assert.equal(f.length, 5);
  assert.deepEqual(f[0], f[4]);
  const dLat = (f[2][1] - f[0][1]) * 111195, dLon = (f[2][0] - f[0][0]) * 111195 * Math.cos(PONT.lat * Math.PI / 180);
  assert.ok(Math.abs(dLat - 400) < 0.5 && Math.abs(dLon - 400) < 0.5, `${dLat} x ${dLon}`);
});

const { data, ms } = buildLanes(JsStreetNetwork, osm, BBOX);
const sum = (key) => data.layers.reduce((n, l) => n + l[key].length, 0);

test('Pont: lanes, one junction at the centre, white-marking groups', () => {
  assert.ok(data.layers.length >= 1);
  assert.ok(data.layers.some((l) => l.z === 0));
  assert.deepEqual(data.layers.map((l) => l.z), [...data.layers.map((l) => l.z)].sort((a, b) => a - b));
  const kinds = new Set(data.layers.flatMap((l) => l.lanes.map((x) => x.k)));
  assert.ok(kinds.has('drive'));
  // the junction polygon nearest the centre contains / touches it
  const dists = data.layers[0].ints.map((r) => Math.hypot(...centroid(r)) / 100);
  assert.ok(dists.length >= 1 && Math.min(...dists) < 25, `nearest junction ${Math.min(...dists)} m`);
  for (const key of ['sep', 'mid', 'stop', 'arrow', 'zebra']) assert.ok(sum(key) > 0, `${key} group empty`);
});

test('Pont: at least one crossing (zebra stripe group)', () => {
  const stripes = data.layers[0].zebra;
  assert.ok(stripes.length >= 1);
  // stripes cluster into >= 1 crossing within 6 m
  const cl = [];
  for (const s of stripes) {
    const [x, y] = centroid(s);
    if (!cl.some(([cx, cy]) => Math.hypot(cx - x, cy - y) < 600)) cl.push([x, y]);
  }
  assert.ok(cl.length >= 1);
});

test('Pont: arrows only near stop lines', () => {
  const stops = data.layers.flatMap((l) => l.stop).map(centroid);
  assert.ok(stops.length > 0);
  for (const a of data.layers.flatMap((l) => l.arrow)) {
    const [x, y] = centroid(a);
    const d = Math.min(...stops.map(([sx, sy]) => Math.hypot(sx - x, sy - y))) / 100;
    assert.ok(d <= ARROW_NEAR_STOP_M + 1e-6, `arrow ${d.toFixed(1)} m from a stop line`);
  }
});

test('Pont: rings are flat integer cm, within the clip, and the size fits the budget', () => {
  const rings = data.layers.flatMap((l) => [...l.lanes.map((x) => x.r), ...l.ints, ...l.sep, ...l.mid, ...l.stop, ...l.arrow, ...l.zebra]);
  for (const r of rings) {
    assert.ok(r.length >= 6 && r.length % 2 === 0);
    for (const v of r) { assert.ok(Number.isInteger(v)); assert.ok(Math.abs(v) < 21000, `${v} cm out of the ±200 m clip (+ margin)`); }
  }
  const bytes = JSON.stringify(data).length;
  console.log(`# Pont lanes entry: ${(bytes / 1024).toFixed(1)} KB json; ${ms.import.toFixed(0)}+${ms.outputs.toFixed(0)}+${ms.compact.toFixed(0)} ms (Node)`);
  // the real ±200 m Pont entry is ~165 KB; this trimmed ±100 m fixture is far smaller
  assert.ok(bytes <= 150 * 1024, `${bytes} bytes`);
});

test('areaBbox: bbox of several centres expanded by the clip on every side', () => {
  const b = areaBbox([PONT, { lat: PONT.lat + 0.001, lon: PONT.lon + 0.002 }]);
  const c = bboxCenter(b);
  assert.ok(Math.abs(c.lat - (PONT.lat + 0.0005)) < 1e-9 && Math.abs(c.lon - (PONT.lon + 0.001)) < 1e-9);
  const hM = (b[2] - b[0]) * 111195, wM = (b[3] - b[1]) * 111195 * Math.cos(PONT.lat * Math.PI / 180);
  assert.ok(Math.abs(hM - (400 + 111.2)) < 1 && Math.abs(wM - (400 + 166.8)) < 1, `${hM} x ${wM}`);
});

test('compactLanes tolerates empty outputs', () => {
  const empty = { type: 'FeatureCollection', features: [] };
  assert.deepEqual(compactLanes({ lanes: empty, markings: JSON.stringify(empty), imarkings: empty, plain: empty }, PONT), { layers: [] });
});

test('compactLanes drops closing points / collapsed rings and unwanted marking types', () => {
  const sq = (p) => ({ type: 'Feature', properties: p, geometry: { type: 'Polygon', coordinates: [[[2.0121, 41.4143], [2.0122, 41.4143], [2.0122, 41.4144], [2.0121, 41.4144], [2.0121, 41.4143]]] } });
  const tiny = { type: 'Feature', properties: { type: 'center line', layer: 0 }, geometry: { type: 'Polygon', coordinates: [[[2.0121, 41.4143], [2.0121, 41.4143], [2.0121, 41.4143], [2.0121, 41.4143]]] } };
  const out = compactLanes({
    lanes: { features: [sq({ type: 'Buffer(Planters)', layer: 1 })] },
    markings: { features: [sq({ type: 'parking hatch' }), sq({ type: 'sidewalk line' }), sq({ type: 'lane separator', layer: 0 }), tiny] },
    imarkings: { features: [] }, plain: { features: [] },
  }, PONT);
  assert.deepEqual(out.layers.map((l) => l.z), [0, 1]);
  assert.equal(out.layers[1].lanes[0].k, 'walk');
  assert.equal(out.layers[1].lanes[0].r.length, 8); // 4 corners, closing point dropped
  assert.equal(out.layers[0].sep.length, 1);
  assert.equal(out.layers[0].mid.length, 0); // collapsed to nothing
});

test('fetchOsmXml validates the response and falls through endpoints', async () => {
  const xml = (s) => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(s).buffer });
  const calls = [];
  const fake = async (url, opts) => {
    calls.push(url);
    assert.match(opts.body.get('data'), /^\[out:xml\]/);
    if (calls.length === 1) return xml('<html>busy</html>');
    if (calls.length === 2) return xml('<?xml version="1.0"?><osm><node id="1"/><remark>runtime error: Query timed out</remark></osm>');
    return xml('<?xml version="1.0"?><osm version="0.6"><node id="1" lat="1" lon="1"/></osm>');
  };
  const bytes = await fetchOsmXml(BBOX, { fetch: fake, endpoints: ['https://a.test/x', 'https://b.test/x', 'https://c.test/x'] });
  assert.equal(calls.length, 3);
  assert.ok(bytes instanceof Uint8Array && bytes.length > 20);
});
