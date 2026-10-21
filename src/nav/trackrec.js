// GPS track recorder for taps. Pure + DOM-free: the app feeds it fixes and taps, it hands back
// compact track records (see encodeTrack) when a tap's junction is behind you.
//
// A single fix + heading files a tap under the wrong light surprisingly often (three junctions
// within ~120 m, parallel roads, two heads on one approach). The road you came in on and the one
// you left on say much more, so every tap opens (or joins) a PENDING track: the last 30 s of fixes
// from a rolling buffer, then every fix until you are clear of the junction. The tap itself is
// stored by the app first and independently of all this; losing a track costs a suggestion, never a tap.

import { distanceM } from './proximity.js';

export const TRACK = {
  ringMs: 60000,     // rolling buffer of recent fixes
  preMs: 30000,      // a pending track starts this long before its first tap
  capMs: 360000,     // hard cap on a pending track (covers a long red)
  minGapMs: 900,     // ~1 Hz: closer fixes are dropped (storage)
  maxFixes: 450,     // stored length cap
  passM: 40,         // a junction this close to your path counts as one you passed
  riseM: 15,         // passed = this much further than the closest point ...
  clearM: 85,        // ... and at least this far from its centre (the matcher reads the exit from 28-85 m)
  waitM: 150,        // the tapped junction, if not yet near the path, is waited for while it is this close
  idleMs: 20000,     // nothing within waitM this long after the tap: no junction to clear, stop
};

/**
 * @typedef {{t:number, lat:number, lon:number, heading?:number|null, speed?:number|null, acc?:number|null}} Fix
 * @typedef {{id:string, obsIds:string[], t0:number, v:1, p:number[]}} TrackRecord  flat ints, 6 per fix (see encodeTrack)
 */

const finite = Number.isFinite;

/**
 * Rolling buffer + pending-track state machine.
 * @param {{junctions:()=>Array<{id:string,lat:number,lon:number}>, onDone:(rec:TrackRecord, why:string)=>void}} o
 */
export function createRecorder({ junctions, onDone }) {
  let ring = [], pending = null;

  const stats = (p, f) => {
    for (const j of junctions()) {
      const d = distanceM(f, j);
      const s = p.js.get(j.id) ?? { min: Infinity, cur: Infinity };
      s.cur = d; if (d < s.min) s.min = d;
      p.js.set(j.id, s);
    }
  };
  const finish = (why) => {
    if (!pending) return;
    const p = pending; pending = null;
    if (!p.fixes.length) return;
    onDone(encodeTrack(p.obsIds, p.fixes), why);
  };
  // Cleared when every junction on the path (or the tapped one, while it is near) is behind you.
  const check = (f) => {
    const p = pending;
    if (f.t - p.openedAt >= TRACK.capMs) return finish('cap');
    if (p.fixes.length >= TRACK.maxFixes) return finish('cap');
    const rel = [...p.js].filter(([id, s]) => s.min <= TRACK.passM || (id === p.tapIx && s.cur <= TRACK.waitM));
    if (!rel.length) { if (f.t - p.tapT >= TRACK.idleMs) finish('far'); return; }
    if (rel.every(([, s]) => s.cur - s.min >= TRACK.riseM && s.cur >= TRACK.clearM)) finish('cleared');
  };

  return {
    /** A GPS fix (any rate; kept at ~1 Hz). */
    fix(f) {
      if (!finite(f?.lat) || !finite(f.lon) || !finite(f.t)) return;
      const last = ring.at(-1);
      if (last && f.t - last.t < TRACK.minGapMs) return;
      const fx = { t: f.t, lat: f.lat, lon: f.lon, heading: finite(f.heading) ? f.heading : null, speed: finite(f.speed) ? f.speed : null, acc: finite(f.acc) ? f.acc : null };
      ring.push(fx);
      while (ring.length && fx.t - ring[0].t > TRACK.ringMs) ring.shift();
      if (pending) { pending.fixes.push(fx); stats(pending, fx); check(fx); }
    },
    /** A tap was stored. Taps while a track is pending share it (one stop, one track). */
    tap({ id, t, intersectionId }) {
      if (pending) { pending.obsIds.push(id); return; }
      const fixes = ring.filter((f) => f.t >= t - TRACK.preMs);
      pending = { obsIds: [id], tapT: t, tapIx: intersectionId, openedAt: t, fixes, js: new Map() };
      for (const f of fixes) stats(pending, f);
      if (fixes.length) check(fixes.at(-1));
    },
    /** Call on the render tick: the hard time cap must fire even when GPS goes quiet. */
    poll(now) { if (pending && now - pending.openedAt >= TRACK.capMs) finish('cap'); },
    /** App hidden / closing: save what there is. */
    flush() { finish('hidden'); },
    get pending() { return pending ? { obsIds: [...pending.obsIds], fixes: pending.fixes.length } : null; },
  };
}

/**
 * Pack fixes into a small record: ~1 Hz, coordinates in 1e-6° (~0.1 m) delta-coded, heading in whole
 * degrees, speed in 0.1 m/s, accuracy in whole metres (-1 = unknown), time in 0.1 s steps.
 * Id = `trk_` + first tap id; once written a record never changes (sync merges tracks by id).
 * @returns {TrackRecord}
 */
export function encodeTrack(obsIds, fixes) {
  const fs = fixes.slice(0, TRACK.maxFixes);
  const p = [];
  let pt = fs[0].t, pla = 0, plo = 0;
  for (const f of fs) {
    const la = Math.round(f.lat * 1e6), lo = Math.round(f.lon * 1e6);
    const dt = Math.round((f.t - pt) / 100);
    p.push(dt, la - pla, lo - plo,
      finite(f.heading) ? Math.round(((f.heading % 360) + 360) % 360) % 360 : -1,
      finite(f.speed) ? Math.round(f.speed * 10) : -1,
      finite(f.acc) ? Math.round(f.acc) : -1);
    pt += dt * 100; pla = la; plo = lo; // follow the DECODED clock, so rounding never drifts
  }
  return { id: `trk_${obsIds[0]}`, obsIds: [...obsIds], t0: fs[0].t, v: 1, p };
}

/** Inverse of encodeTrack (times are exact to 0.1 s per step). @param {TrackRecord} rec @returns {Fix[]} */
export function decodeTrack(rec) {
  const out = [], p = rec?.p ?? [];
  let t = rec?.t0 ?? 0, la = 0, lo = 0;
  for (let i = 0; i + 5 < p.length; i += 6) {
    t += p[i] * 100; la += p[i + 1]; lo += p[i + 2];
    out.push({ t, lat: la / 1e6, lon: lo / 1e6, heading: p[i + 3] >= 0 ? p[i + 3] : null, speed: p[i + 4] >= 0 ? p[i + 4] / 10 : null, acc: p[i + 5] >= 0 ? p[i + 5] : null });
  }
  return out;
}
