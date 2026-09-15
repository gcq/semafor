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
export const SYNC_BUILD = 'b18'; // bump with the SW cache; shown in UI to confirm both devices match
export const STRATEGIES = {
  mqtt: { label: 'MQTT brokers', url: `${CDN}/mqtt/+esm`, wsProtocol: 'mqtt', relayUrls: ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'] },
  torrent: { label: 'WebTorrent trackers', url: `${CDN}/torrent/+esm`, relayUrls: ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'] },
  nostr: { label: 'Nostr relays', url: `${CDN}/nostr/+esm`, relayUrls: ['wss://nos.lol', 'wss://relay.snort.social', 'wss://relay.damus.io'] },
};
const DEFAULT_STRATEGY = 'mqtt';

// The strategy is encoded as the first char of the room code, so BOTH devices
// always use the same backend — joining a code picks the creator's strategy,
// regardless of each device's own dropdown default.
export const STRAT_PREFIX = { mqtt: 'M', torrent: 'T', nostr: 'N' };
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
 * @param {string} [stratKey='mqtt']
 * @returns {Promise<{ leave: () => void }>}
 */
export async function joinSync(code, handlers, stratKey = DEFAULT_STRATEGY) {
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
