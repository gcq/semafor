import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overpassQuery, parseOverpass, fetchStreets } from '../src/osm/streets.js';

const center = { lat: 41.4, lon: 2.17 };
// ~0.001° lat ≈ 111.2 m; ~0.001° lon at 41.4° ≈ 83.4 m
const fixture = {
  elements: [
    { type: 'way', id: 1, tags: { highway: 'primary', name: 'Carrer de Mallorca', lanes: '3', oneway: 'yes' },
      geometry: [{ lat: 41.4, lon: 2.169 }, { lat: 41.4, lon: 2.171 }] },
    { type: 'way', id: 2, tags: { highway: 'footway', crossing: 'traffic_signals' },
      geometry: [{ lat: 41.3995, lon: 2.17 }, { lat: 41.4005, lon: 2.17 }] },
    { type: 'way', id: 3, tags: { highway: 'motorway' },
      geometry: [{ lat: 41.4, lon: 2.17 }, { lat: 41.401, lon: 2.17 }] },
    { type: 'way', id: 4, tags: { highway: 'residential' }, geometry: [{ lat: 41.4, lon: 2.17 }] },
    { type: 'node', id: 5, lat: 41.401, lon: 2.171, tags: { highway: 'traffic_signals' } },
  ],
};

test('overpassQuery targets highways and signal nodes around the centre', () => {
  const q = overpassQuery(center, 120);
  assert.match(q, /way\(around:120,41\.4,2\.17\)\[highway\]/);
  assert.match(q, /node\(around:120,41\.4,2\.17\)\[highway=traffic_signals\]/);
  assert.match(q, /out tags geom;$/);
});

test('parseOverpass converts to local metres and flags', () => {
  const s = parseOverpass(fixture, center, 123);
  assert.equal(s.v, 1);
  assert.equal(s.fetchedAt, 123);
  assert.equal(s.ways.length, 3); // 1-point way skipped
  const [a, b, m] = s.ways;
  assert.equal(a.name, 'Carrer de Mallorca');
  assert.equal(a.lanes, 3);
  assert.equal(a.oneway, true);
  assert.equal(a.crossing, '');
  assert.ok(Math.abs(a.pts[0][0] + 83.4) < 0.5 && a.pts[0][1] === 0, JSON.stringify(a.pts));
  assert.ok(Math.abs(a.pts[1][0] - 83.4) < 0.5);
  for (const p of s.ways.flatMap((w) => w.pts)) for (const v of p) assert.equal(v, Math.round(v * 10) / 10);
  assert.equal(b.crossing, 'traffic_signals');
  assert.equal(b.lanes, 0);
  assert.equal(b.oneway, false);
  assert.ok(Math.abs(b.pts[1][1] - 55.6) < 0.5); // 0.0005° north
  assert.equal(m.oneway, true); // implied by motorway
  assert.equal(s.signals.length, 1);
  assert.ok(Math.abs(s.signals[0][1] - 111.2) < 0.5 && Math.abs(s.signals[0][0] - 83.4) < 0.5);
});

const resp = (status, body) => ({ status, json: async () => { if (body === undefined) throw new SyntaxError('bad json'); return body; } });

test('fetchStreets falls through failing endpoints', async () => {
  const calls = [];
  const fake = async (url, opts) => {
    calls.push(url);
    assert.equal(opts.method, 'POST');
    assert.match(opts.body.get('data'), /^\[out:json\]/);
    return calls.length === 1 ? resp(502) : resp(200, fixture);
  };
  const s = await fetchStreets(center, { fetch: fake, endpoints: ['https://a.test/x', 'https://b.test/x'] });
  assert.deepEqual(calls, ['https://a.test/x', 'https://b.test/x']);
  assert.equal(s.ways.length, 3);
});

test('fetchStreets treats non-JSON 200 as failure and throws when all fail', async () => {
  const fake = async () => resp(200, undefined);
  await assert.rejects(fetchStreets(center, { fetch: fake, endpoints: ['https://a.test/x', 'https://b.test/x'] }), /Overpass unavailable.*a\.test.*b\.test/);
});
