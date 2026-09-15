// Serverless peer sync. Transport = Trystero over public WebTorrent trackers
// (no server to run/pay for) + public STUN for NAT traversal. Pairing is a short
// room code shared as a QR/URL. Once two devices are in the same room, WebRTC
// connects and we exchange full bundles and reconcile with sync/merge.js.
//
// Trystero is loaded from a CDN on first use; the service worker caches it so it
// works offline afterwards.

import { mergeBundles } from './merge.js';

// Rendezvous is entirely over public infra (no server). Which one connects
// depends on the network, so the strategy is selectable:
//  - mqtt:    public MQTT brokers (WSS) — reliable pub/sub delivery. Best default.
//  - torrent: public WebTorrent trackers — zero-dep/decentralized but the public
//             trackers are often down/blocked (silent failure).
//  - nostr:   public relays — but many drop the ephemeral events discovery needs.
// WebRTC (with public STUN) always carries the actual transfer.
const CDN = 'https://cdn.jsdelivr.net/npm/trystero@0.21.5';
const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/+esm';
export const SYNC_BUILD = 'b19'; // bump with the SW cache; shown in UI to confirm both devices match
// Default = PeerJS: a real (free, public) signaling broker that deterministically
// pairs two peers by id. Trystero's decentralized backends proved unreliable
// (tracker peer-dedup, dropped ephemeral events, blocked broker ports), so they
// stay only as fallbacks.
export const STRATEGIES = {
  peerjs: { label: 'PeerJS broker', kind: 'peerjs' },
  mqtt: { label: 'MQTT brokers', kind: 'trystero', url: `${CDN}/mqtt/+esm`, wsProtocol: 'mqtt', relayUrls: ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'] },
  torrent: { label: 'WebTorrent trackers', kind: 'trystero', url: `${CDN}/torrent/+esm`, relayUrls: ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'] },
  nostr: { label: 'Nostr relays', kind: 'trystero', url: `${CDN}/nostr/+esm`, relayUrls: ['wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.damus.io'] },
};
const DEFAULT_STRATEGY = 'peerjs';

// The strategy is encoded as the first char of the room code, so BOTH devices
// always use the same backend — joining a code picks the creator's strategy,
// regardless of each device's own dropdown default.
export const STRAT_PREFIX = { peerjs: 'P', mqtt: 'M', torrent: 'T', nostr: 'N' };
export function strategyFromCode(code) {
  const c = String(code || '').trim().toUpperCase();
  for (const [k, p] of Object.entries(STRAT_PREFIX)) if (c[0] === p) return k;
  return DEFAULT_STRATEGY;
}
const APP_ID = 'onda-signal-sync';
// Public STUN + free public TURN (Open Relay Project). TURN relays the media
// when a direct WebRTC path can't form — essential across NATs, and for two
// browsers on one machine whose mDNS candidates don't resolve to each other.
const STUN = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};
const PEER_TIMEOUT_MS = 25000;

const _mods = {};
async function loadTrystero(stratKey) {
  const s = STRATEGIES[stratKey] ?? STRATEGIES[DEFAULT_STRATEGY];
  if (!_mods[stratKey]) _mods[stratKey] = await import(/* @vite-ignore */ s.url);
  return _mods[stratKey];
}

/**
 * Probe each relay with a raw WebSocket to see if the network allows it. This is
 * the key diagnostic when peers never find each other: if all relays are
 * blocked, sync can't work here; if they connect but no peer joins, it's a
 * code/topic mismatch or the peer isn't actually in the room.
 * @param {(url: string, status: 'ok'|'blocked'|'timeout') => void} onResult
 */
export function probeRelays(stratKey, onResult) {
  const s = STRATEGIES[stratKey] ?? STRATEGIES[DEFAULT_STRATEGY];
  if (!s.relayUrls) { onResult('PeerJS public broker (0.peerjs.com)', 'ok'); return 1; }
  for (const url of s.relayUrls) {
    let done = false;
    const finish = (st) => { if (!done) { done = true; onResult(url, st); } };
    try {
      // MQTT-over-WS needs the 'mqtt' subprotocol or the broker rejects the socket.
      const ws = s.wsProtocol ? new WebSocket(url, s.wsProtocol) : new WebSocket(url);
      const t = setTimeout(() => { finish('timeout'); try { ws.close(); } catch { /* */ } }, 6000);
      ws.onopen = () => { clearTimeout(t); finish('ok'); try { ws.close(); } catch { /* */ } };
      ws.onerror = () => { clearTimeout(t); finish('blocked'); };
    } catch { finish('blocked'); }
  }
  return s.relayUrls.length;
}

/** A short, unambiguous room code (no easily-confused chars). */
export function makeRoomCode(len = 6) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const r = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) s += alphabet[r[i] % alphabet.length];
  return s;
}

/**
 * Join a sync room. On each peer connect we send our whole bundle; on receiving
 * a peer's bundle we merge + apply, then report stats. Symmetric — both sides
 * converge after one exchange.
 * @param {string} code
 * @param {{
 *   getBundle: () => Promise<object>,
 *   applyMerged: (merged: object) => Promise<void>,
 *   onStatus: (msg: string) => void,
 *   onPeers: (n: number) => void,
 *   onSynced: (stats: object) => void,
 * }} handlers
 * @param {string} [stratKey='peerjs']
 * @param {boolean} [isHost=false]  PeerJS needs to know who registers the id
 * @returns {Promise<{ leave: () => void }>}
 */
export async function joinSync(code, handlers, stratKey = DEFAULT_STRATEGY, isHost = false) {
  const strat = STRATEGIES[stratKey] ?? STRATEGIES[DEFAULT_STRATEGY];
  if (strat.kind === 'peerjs') return joinSyncPeerJS(code, handlers, isHost);
  return joinSyncTrystero(code, handlers, stratKey);
}

async function joinSyncTrystero(code, handlers, stratKey) {
  const { getBundle, applyMerged, onStatus, onPeers, onSynced } = handlers;
  const strat = STRATEGIES[stratKey] ?? STRATEGIES[DEFAULT_STRATEGY];
  let mod;
  try { onStatus(`loading sync (${strat.label})…`); mod = await loadTrystero(stratKey); }
  catch (e) { onStatus('could not load sync library (need a connection the first time): ' + e.message); throw e; }

  onStatus('connecting…');
  // relayRedundancy = full list so BOTH peers announce to EVERY relay — otherwise
  // Trystero picks a random subset each and they can miss each other.
  const room = mod.joinRoom(
    { appId: APP_ID, relayUrls: strat.relayUrls, relayRedundancy: strat.relayUrls.length, rtcConfig: STUN },
    code.toUpperCase(),
  );
  const [sendBundle, recvBundle] = room.makeAction('bundle');

  let peers = 0;
  const bump = (d) => { peers = Math.max(0, peers + d); onPeers(peers); };

  // Watchdog: if nobody shows up, say so rather than spinning forever.
  const watchdog = setTimeout(() => {
    if (peers === 0) onStatus('still no other device — check both use code ' + code.toUpperCase() + ', and that the network allows relays/WebRTC.');
  }, PEER_TIMEOUT_MS);

  room.onPeerJoin(async (id) => {
    clearTimeout(watchdog); clearInterval(diag);
    bump(1);
    onStatus('peer connected — exchanging…');
    try { sendBundle(await getBundle(), id); } catch (e) { onStatus('send failed: ' + e.message); }
  });
  room.onPeerLeave(() => bump(-1));

  // Diagnostic poll: distinguish "never discovered" from "discovered but the
  // WebRTC/ICE connection can't form". getPeers() returns peerId -> RTCPeerConnection.
  const diag = setInterval(() => {
    if (peers > 0) return; // already connected; nothing to diagnose
    try {
      const pcs = room.getPeers ? room.getPeers() : {};
      const ids = Object.keys(pcs);
      if (ids.length) {
        const states = ids.map((id) => pcs[id]?.iceConnectionState || pcs[id]?.connectionState || '?').join(', ');
        onStatus(`found ${ids.length} peer — connecting (ICE: ${states})…`);
      }
    } catch { /* getPeers not available in this build */ }
  }, 2000);

  recvBundle(async (remote) => {
    try {
      const local = await getBundle();
      const { merged, stats } = mergeBundles(local, remote);
      await applyMerged(merged);
      onSynced(stats);
      onStatus('synced ✓');
    } catch (e) { onStatus('merge failed: ' + e.message); }
  });

  onStatus('waiting for the other device to join…');
  return { leave: () => { clearTimeout(watchdog); clearInterval(diag); try { room.leave(); } catch { /* noop */ } } };
}

// --- PeerJS transport: free public broker deterministically pairs by id. ---
let _peerjs = null;
async function loadPeerJS() {
  if (!_peerjs) { const m = await import(/* @vite-ignore */ PEERJS_URL); _peerjs = m.Peer || m.default?.Peer || m.default; }
  return _peerjs;
}

async function joinSyncPeerJS(code, handlers, isHost) {
  const { getBundle, applyMerged, onStatus, onPeers, onSynced } = handlers;
  let Peer;
  try { onStatus('loading sync (PeerJS)…'); Peer = await loadPeerJS(); }
  catch (e) { onStatus('could not load sync library: ' + e.message); throw e; }

  const hostId = ('onda-semafor-' + code).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const opts = { config: STUN };
  let peer, done = false;

  const wire = (conn) => {
    conn.on('open', async () => { onPeers(1); onStatus('connected — exchanging…'); try { conn.send(await getBundle()); } catch (e) { onStatus('send failed: ' + e.message); } });
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
    else if (t === 'peer-unavailable') onStatus('no host on that code yet — make sure the other device tapped Create first.');
    else onStatus('sync error: ' + (t || e?.message || 'unknown'));
  });

  // watchdog
  const watchdog = setTimeout(() => { if (!done) onStatus('still not connected — check both use code ' + code + ', and try again.'); }, PEER_TIMEOUT_MS);
  return { leave: () => { clearTimeout(watchdog); try { peer.destroy(); } catch { /* noop */ } } };
}
