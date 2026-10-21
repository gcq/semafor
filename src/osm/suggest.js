// Suggested re-files: taps whose GPS track says another light was the one in front of you.
// Pure. Same conservative spirit as tools/refile.mjs: act only on a 'high' track match, and never
// touch a tap of a cross-traffic light, which you may well have chosen to watch. Suggestions are
// recomputed from data (taps + tracks + map + streets) and never stored; only the user's DISMISS
// is (a `dismissals` record, so it stays dismissed on both devices).

import { distanceM } from '../nav/proximity.js';
import { decodeTrack } from '../nav/trackrec.js';
import { matchTrack } from './trackmatch.js';

export const ON_PATH_M = 40;   // a junction this close to the track was passed
const ENTER_M = 40;            // the approach to a passed junction is judged at the last fix this far from its centre, before the closest one

// U-turn movements don't count: they are often hung on a neighbouring head (Pont: Nacional -> Nacional on the Verdaguer light)
const servesFrom = (ix, headId, armId) => !!armId && (ix.movements ?? []).some((m) => !m.unsignalized && m.headId === headId && m.from === armId && m.to !== armId);
const armName = (ix, id) => ix.arms?.find((a) => a.id === id)?.name ?? '?';
const headName = (ix, id) => ix.heads?.find((h) => h.id === id)?.name ?? id;

// when the track was about to reach `loc`: the last fix at least ENTER_M from it before the closest fix
function approachTime(track, loc) {
  const d = track.map((f) => distanceM(f, loc)), cpa = d.indexOf(Math.min(...d));
  for (let i = cpa; i >= 0; i--) if (d[i] >= ENTER_M) return track[i].t;
  return track[0].t;
}

/**
 * Should tap `tap` move to another head? Returns the suggestion or null.
 *  (a) the tapped head belongs to the approach you were on, but another movement's head was yours
 *      (Straight vs Left on one pole), or
 *  (b) the tapped head is at another junction, which either was not on your path or whose head for
 *      your direction it is (mirrors refile.mjs: the right light for you stands first ahead elsewhere).
 * A tapped head that does not serve your arm at the junction you were at = cross traffic: never.
 * @param {{tap:Object, track:Array, set:Object, center:{lat:number,lon:number}, intersections:Array<Object>}} o
 */
export function suggestRefile({ tap, track, set, center, intersections }) {
  if (!tap?.headId || !tap.where || !Number.isFinite(tap.where.lat) || (tap.kind && tap.kind !== 'onset') || tap.refiledFrom) return null;
  if (!track?.length || !set) return null;
  const ixT = intersections.find((i) => (i.heads ?? []).some((h) => h.id === tap.headId));
  if (!ixT) return null;
  const m = matchTrack({ track, t: tap.t, set, center, intersections });
  if (m.confidence !== 'high' || !m.headId || m.headId === tap.headId) return null;
  if (m.toArmId && m.toArmId === m.fromArmId) return null; // a U-turn: which light you watched is anyone's guess
  const ixM = intersections.find((i) => i.id === m.ixId);
  if (!ixM) return null;

  let kind, why;
  const turn = { straight: 'went straight on', left: 'turned left', right: 'turned right' }[m.turn] ?? 'went on';
  if (ixT.id === ixM.id) {
    if (!servesFrom(ixT, tap.headId, m.fromArmId)) return null; // cross traffic
    kind = 'head';
    why = `you came from ${armName(ixM, m.fromArmId)} and ${turn}`;
  } else {
    const near = track.filter((f) => distanceM(f, ixT.location) <= ON_PATH_M);
    if (near.length) {
      // passed it: only if the tapped head is the one for your direction there
      const tIn = approachTime(track, ixT.location);
      const mt = matchTrack({ track, t: tIn, set, center, intersections, only: ixT.id });
      if (mt.confidence !== 'high' || !servesFrom(ixT, tap.headId, mt.fromArmId)) return null;
    }
    kind = 'junction';
    why = `you were at ${ixM.name}, coming from ${armName(ixM, m.fromArmId)}; the tap was filed under ${ixT.name}`;
  }
  return {
    id: tap.id, tapId: tap.id, tapT: tap.t, aspect: tap.aspect, kind, why,
    fromIxId: ixT.id, fromHeadId: tap.headId, toIxId: ixM.id, toHeadId: m.headId,
    fromLabel: `${ixT.name} · ${headName(ixT, tap.headId)}`, toLabel: `${ixM.name} · ${headName(ixM, m.headId)}`,
    match: m,
  };
}

/**
 * All pending suggestions, newest first.
 * @param {Object} o
 * @param {Array<Object>} o.obs  live taps
 * @param {Array<Object>} o.tracks  track records (src/nav/trackrec.js)
 * @param {Iterable<string>} [o.dismissed]  tap ids the user dismissed
 * @param {(ixId:string)=>({set:Object, center:Object, intersections:Array<Object>}|null)} o.contextOf  streets + junctions of a tap's cluster
 * @param {Map} [o.cache]  memo (tap id -> result), valid while taps/tracks/map/streets do not change: the caller clears it
 */
export function pendingSuggestions({ obs, tracks, dismissed = [], contextOf, cache = new Map() }) {
  const skip = new Set(dismissed);
  const trackOf = new Map();
  for (const r of tracks ?? []) for (const id of r.obsIds ?? []) trackOf.set(id, r);
  const decoded = new Map();
  const out = [];
  for (const tap of obs ?? []) {
    if (skip.has(tap.id)) continue;
    const rec = trackOf.get(tap.id);
    if (!rec || !tap.where) continue;
    if (!cache.has(tap.id)) {
      let s = null;
      try {
        const ix = contextOf(tap.intersectionId);
        if (ix) { if (!decoded.has(rec.id)) decoded.set(rec.id, decodeTrack(rec)); s = suggestRefile({ tap, track: decoded.get(rec.id), ...ix }); }
      } catch (e) { console.error('suggestRefile failed', e); }
      cache.set(tap.id, s);
    }
    if (cache.get(tap.id)) out.push(cache.get(tap.id));
  }
  return out.sort((a, b) => (b.tapT ?? 0) - (a.tapT ?? 0));
}

/**
 * Accepting a suggestion = what tools/refile.mjs writes: a NEW observation (sync merges observations
 * by id and never overwrites one) plus a tombstone for the old id.
 * @returns {{newObs:Object, tombstone:{id:string,kind:'obs',deletedAt:number}}}
 */
export function refileOf(obs, s, now = Date.now()) {
  return {
    newObs: { ...obs, id: `${obs.id}_rf`, intersectionId: s.toIxId, headId: s.toHeadId, refiledFrom: { intersectionId: obs.intersectionId, headId: obs.headId }, refiledBy: 'track' },
    tombstone: { id: obs.id, kind: 'obs', deletedAt: now },
  };
}
