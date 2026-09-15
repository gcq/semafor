// Serverless peer sync over the free public PeerJS broker + public STUN/TURN.
// A short room code pairs two devices: the "host" (Create) registers the code as
// its peer id; the other (Join / scan) connects to it. Then both exchange their
// whole bundle and reconcile with sync/merge.js — symmetric, so they converge.
//
// PeerJS loads from a CDN on first use; the service worker caches it for offline.
// (We tried Trystero's decentralized backends — torrent/nostr/mqtt — first; all
// proved unreliable on real networks, so PeerJS's real broker is the only path.)

import { mergeBundles } from './merge.js';

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/+esm';
export const SYNC_BUILD = 'b22'; // shown in the UI to confirm both devices run the same build
const PEER_TIMEOUT_MS = 25000;

// Public STUN + free public TURN so the WebRTC media path can form across NATs.
const STUN = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

/**
 * WebRTC self-test: gather ICE candidates to see what the network allows, with
 * no peer needed. host = WebRTC on; srflx = STUN reachable; relay = TURN reachable.
 * Only 'host' means STUN/TURN is blocked (VPN/firewall) and cross-network sync
 * can't work here.
 * @returns {Promise<{ ok: boolean, types: string[], error?: string }>}
 */
export function webrtcSelfTest() {
  return new Promise((resolve) => {
    let pc;
    try { pc = new RTCPeerConnection(STUN); }
    catch (e) { resolve({ ok: false, types: [], error: 'RTCPeerConnection unavailable: ' + e.message }); return; }
    const types = new Set();
    const finish = () => { try { pc.close(); } catch { /* */ } resolve({ ok: types.size > 0, types: [...types] }); };
    const timer = setTimeout(finish, 8000);
    pc.onicecandidate = (e) => {
      if (!e.candidate) { clearTimeout(timer); finish(); return; }
      const m = /typ (\w+)/.exec(e.candidate.candidate || '');
      if (m) types.add(m[1]);
    };
    pc.createDataChannel('probe');
    pc.createOffer().then((o) => pc.setLocalDescription(o))
      .catch((e) => { clearTimeout(timer); resolve({ ok: false, types: [...types], error: e.message }); });
  });
}

/** A short, unambiguous room code (no easily-confused chars). */
export function makeRoomCode(len = 6) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const r = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) s += alphabet[r[i] % alphabet.length];
  return s;
}

let _Peer = null;
async function loadPeerJS() {
  if (!_Peer) { const m = await import(/* @vite-ignore */ PEERJS_URL); _Peer = m.Peer || m.default?.Peer || m.default; }
  return _Peer;
}

/**
 * Pair with another device by code and reconcile. Host (Create) registers the
 * code as its id; joiner (Join/scan) connects to it.
 * @param {string} code
 * @param {{
 *   getBundle: () => Promise<object>,
 *   applyMerged: (merged: object) => Promise<void>,
 *   onStatus: (msg: string) => void,
 *   onPeers: (n: number) => void,
 *   onSynced: (stats: object) => void,
 * }} handlers
 * @param {boolean} [isHost=false]
 * @returns {Promise<{ leave: () => void }>}
 */
export async function joinSync(code, handlers, isHost = false) {
  const { getBundle, applyMerged, onStatus, onPeers, onSynced } = handlers;
  let Peer;
  try { onStatus('loading sync…'); Peer = await loadPeerJS(); }
  catch (e) { onStatus('could not load sync library (need a connection the first time): ' + e.message); throw e; }

  const hostId = ('onda-semafor-' + code).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const opts = { config: STUN };
  let peer, done = false;

  const wire = (conn) => {
    conn.on('open', async () => {
      onPeers(1); onStatus('connected — exchanging…');
      try { conn.send(await getBundle()); } catch (e) { onStatus('send failed: ' + e.message); }
    });
    conn.on('data', async (remote) => {
      try {
        const local = await getBundle();
        const { merged, stats } = mergeBundles(local, remote);
        await applyMerged(merged);
        done = true; onSynced(stats); onStatus('synced ✓');
      } catch (e) { onStatus('merge failed: ' + e.message); }
    });
    conn.on('error', (e) => onStatus('connection error: ' + (e?.type || e?.message || 'unknown')));
  };

  if (isHost) {
    peer = new Peer(hostId, opts);
    peer.on('open', () => onStatus('waiting for the other device to join…'));
    peer.on('connection', wire);
  } else {
    peer = new Peer(opts); // random id
    peer.on('open', () => { onStatus('connecting to host…'); wire(peer.connect(hostId, { reliable: true })); });
  }
  peer.on('error', (e) => {
    const t = e?.type || '';
    if (t === 'unavailable-id') onStatus('that code is already hosting elsewhere — pick a new one.');
    else if (t === 'peer-unavailable') onStatus('no host on that code yet — tap Create on the other device first.');
    else onStatus('sync error: ' + (t || e?.message || 'unknown'));
  });

  const watchdog = setTimeout(() => { if (!done) onStatus('still not connected — check both use code ' + code + ', then try again.'); }, PEER_TIMEOUT_MS);
  return { leave: () => { clearTimeout(watchdog); try { peer.destroy(); } catch { /* noop */ } } };
}
