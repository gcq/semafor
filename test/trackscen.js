// Drive scenarios at the user's three Molins de Rei junctions (real OSM geometry, real arms/heads),
// shared by the matcher tests and the noise sweep. Each says where the car stopped, which head the tap was
// filed under, and what the suggestion rule must answer: a head id (move the tap there) or null (leave it).
import { ixs, set, center, route, stopS, drive, record, headId, mastHead, ixNamed, wayPts } from './trackfix.js';
import { suggestRefile } from '../src/osm/suggest.js';
import { matchTrack } from '../src/osm/trackmatch.js';

const VT = 'Verdaguer - Terraple', PONT = 'Pont', PC = 'Nacional - Pere Calders';
const vtStraight = headId(VT, 'Verdaguer N Straight'), vtLeft = headId(VT, 'Verdaguer N Left'), vtTerraN = headId(VT, 'Terraple N');
const pontNacional = mastHead('h9sy6'), pontLateral = mastHead('jw8ph'), pontVerd = mastHead('gjs5y');
const pcNacional = mastHead('660rt'), pcLateral = mastHead('rhyy7');

// APPROACH keys (stop points): see test/trackmatch.test.js, which pins them to the street data
export const KEY = {
  vtN: 'ix_mu3b47nisdule:0:16',        // Verdaguer N at Verdaguer - Terraple, westbound
  pcCarretera: 'ix_mu3atzts02rzm:0:40', // Carretera de Molins de Rei a Caldes at Pere Calders, 335°
  pcAvinguda: 'ix_mu3atzts02rzm:0:12',  // Avinguda de Caldes at Pere Calders, 334°
  pontCarretera: 'ix_mu305j9t1beeb:0:41', // Carretera at Pont
  pontAvinguda: 'ix_mu305j9t1beeb:0:13',  // Avinguda at Pont
  pontVerd: 'ix_mu305j9t1beeb:0:18',      // Verdaguer (eastern arm) at Pont, westbound
};

// westbound on Carrer de Verdaguer: Verdaguer - Terraple, then 92 m on, Pont; both straight, or off north at Terraple
const vtWest = () => route([361648185, 'fwd'], 547228336, 43804107, 47752342, 47752340);
const vtToTerrapleN = () => route(361648185, [675478157, 'rev']);
// Carretera / Avinguda northbound at 335°: Pere Calders, then Pont
const carretera = (exit) => route(230443675, 1410456370, 547228455, 1410456371, ...(exit === 'west' ? [[47752342, 'rev'], [47752340, 'rev']] : exit === 'east' ? [43804107, 547228336] : []));
const avinguda = () => route(296913512, { cut: [-31.5, 18.7] }, { pts: [{ e: -44.3, n: 44.5 }] }, 414832354);
// U-turn at Verdaguer - Terraple: west along Verdaguer to the junction, round, and back east offset 7 m (the other carriageway)
const uTurn = () => {
  const base = route(361648185).pts, c = ixNamed(VT).location;
  const k = 6371000 * Math.PI / 180, centre = { e: (c.lon - center.lon) * Math.cos(center.lat * Math.PI / 180) * k, n: (c.lat - center.lat) * k };
  const back = base.filter((p) => Math.hypot(p.e - centre.e, p.n - centre.n) > 10).reverse().map((p) => ({ e: p.e, n: p.n - 7 }));
  return route({ pts: base }, { pts: [{ e: centre.e - 4, n: centre.n + 1 }, { e: centre.e - 8, n: centre.n - 3 }] }, { pts: back });
};

/**
 * name, r() route, key = approach whose stop line the car waits at, tap = head the tap was filed under,
 * ix = that head's junction, expect = head the rule must suggest (null = nothing), tail = metres of route after the stop line.
 */
export const SCENARIOS = [
  { id: 'vt-straight-tapLeft', name: 'Verdaguer N: straight, tapped Left', r: vtWest, key: KEY.vtN, tap: vtLeft, ix: VT, expect: vtStraight },
  { id: 'vt-straight-tapStraight', name: 'Verdaguer N: straight, tapped Straight', r: vtWest, key: KEY.vtN, tap: vtStraight, ix: VT, expect: null },
  { id: 'vt-turn-tapStraight', name: 'Verdaguer N: turned to Terraple N, tapped Straight', r: vtToTerrapleN, key: KEY.vtN, tap: vtStraight, ix: VT, expect: vtLeft },
  { id: 'vt-turn-tapLeft', name: 'Verdaguer N: turned to Terraple N, tapped Left', r: vtToTerrapleN, key: KEY.vtN, tap: vtLeft, ix: VT, expect: null },
  { id: 'pc-carretera-tapPontNacional', name: 'Carretera at Pere Calders, tapped Pont Nacional', r: () => carretera('west'), key: KEY.pcCarretera, tap: pontNacional, ix: PONT, expect: pcNacional },
  { id: 'pc-carretera-tapPcNacional', name: 'Carretera at Pere Calders, tapped Pere Calders Nacional', r: () => carretera('west'), key: KEY.pcCarretera, tap: pcNacional, ix: PC, expect: null },
  { id: 'pc-avinguda-tapPontLateral', name: 'Avinguda at Pere Calders, tapped Pont Lateral', r: avinguda, key: KEY.pcAvinguda, tap: pontLateral, ix: PONT, expect: pcLateral },
  { id: 'pc-avinguda-tapPcLateral', name: 'Avinguda at Pere Calders, tapped Pere Calders Lateral', r: avinguda, key: KEY.pcAvinguda, tap: pcLateral, ix: PC, expect: null },
  { id: 'pont-carretera-tapPcNacional', name: 'Carretera at Pont (after Pere Calders), tapped Pere Calders Nacional', r: () => carretera('west'), key: KEY.pontCarretera, tap: pcNacional, ix: PC, expect: pontNacional },
  { id: 'pont-carretera-tapPontNacional', name: 'Carretera at Pont, tapped Pont Nacional', r: () => carretera('west'), key: KEY.pontCarretera, tap: pontNacional, ix: PONT, expect: null },
  { id: 'pc-carretera-tapVtStraight', name: 'Carretera at Pere Calders, tapped Verdaguer N Straight (junction off the path)', r: () => carretera('west'), key: KEY.pcCarretera, tap: vtStraight, ix: VT, expect: pcNacional },
  { id: 'cross-pont-verdaguer', name: 'cross traffic: Carretera at Pont, tapped Pont Verdaguer', r: () => carretera('west'), key: KEY.pontCarretera, tap: pontVerd, ix: PONT, expect: null },
  { id: 'cross-vt-terraple', name: 'cross traffic: Verdaguer N, tapped Terraple N', r: vtWest, key: KEY.vtN, tap: vtTerraN, ix: VT, expect: null },
  { id: 'cross-pont-lateral', name: 'cross traffic: Carretera at Pont, tapped Pont Lateral (the parallel road)', r: () => carretera('west'), key: KEY.pontCarretera, tap: pontLateral, ix: PONT, expect: null },
  { id: 'row-vt-tapped-at-pont', name: 'two in a row: Verdaguer westbound at Pont, tapped Verdaguer N Straight', r: vtWest, key: KEY.pontVerd, tap: vtStraight, ix: VT, expect: pontVerd },
  { id: 'row-pont-tapped-at-pont', name: 'two in a row: Verdaguer westbound at Pont, tapped Pont Verdaguer', r: vtWest, key: KEY.pontVerd, tap: pontVerd, ix: PONT, expect: null },
  { id: 'uturn-vt', name: 'U-turn at Verdaguer N, tapped Straight', r: uTurn, key: KEY.vtN, tap: vtStraight, ix: VT, expect: null },
];

/** Run one scenario once. opts: sigma, seed, dwell, frozenHeading, corr, drop, cutBefore (m before the stop line the track ends), noWhere. */
export function run(sc, opts = {}) {
  const r = sc.r(), s0 = stopS(r, sc.key), dwell = opts.dwell ?? 40;
  const d = drive(r, { stopAt: s0, dwell, sigma: opts.sigma ?? 6, seed: opts.seed ?? 1, frozenHeading: opts.frozenHeading ?? null, corr: opts.corr ?? 0, drop: opts.drop ?? 0.12, to: opts.cutBefore != null ? s0 - opts.cutBefore : r.length });
  const tapT = d.dwellStart != null ? d.dwellStart + (opts.tapAfter ?? 8) * 1000 : d.tAt(s0 - 5);
  const tapIx = ixNamed(sc.ix).id;
  const { rec, track } = record(d.fixes, { tapT, tapIx });
  const tap = { id: 'obs_x', intersectionId: tapIx, headId: sc.tap, aspect: 'red', kind: 'onset', t: tapT, where: opts.noWhere ? undefined : { lat: 0, lon: 0 } };
  const match = matchTrack({ track, t: tapT, set, center, intersections: ixs });
  const sugg = suggestRefile({ tap, track, set, center, intersections: ixs });
  return { rec, track, tap, match, sugg, tapT, d };
}
export { ixs, set, center, wayPts };
