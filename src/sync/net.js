// Serverless sync through the free public ntfy.sh relay, end-to-end encrypted.
//
// Why not WebRTC any more: a direct peer link needs a TURN relay to cross the
// car's LTE NAT, and the free public TURN (Open Relay) now requires an account.
// Plain HTTPS works on every network, so instead each device publishes its whole
// bundle — gzipped and AES-GCM encrypted with a key derived from the room code —
// as an ntfy.sh attachment on a topic also derived from the code, and polls that
// topic for the other device's bundles. The relay only ever sees ciphertext.
// Messages are cached ~12 h and attachments 3 h, so the two devices don't even
// need to be online at the same time.
//
// Reconciliation is sync/merge.js (symmetric, idempotent). After merging a
// remote bundle we run the merge in reverse to see whether the OTHER side is
// missing anything of ours, and only then publish back — so two devices converge
// in a couple of messages and never ping-pong.

import { mergeBundles } from './merge.js';

const RELAY = 'https://ntfy.sh';
export const SYNC_BUILD = 'b26'; // shown in the UI to confirm both devices run the same build
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no easily-confused chars
const CODE_LEN = 16;       // ~79 bits: this is the encryption secret, not just a room name
const PBKDF2_ITERS = 150000;
const POLL_MS = 8000;

const utf8 = (s) => new TextEncoder().encode(s);

/** A random room code; doubles as the end-to-end key, so it's long. */
export function makeRoomCode(len = CODE_LEN) {
  const r = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[r[i] % ALPHABET.length];
  return s;
}
export const normalizeCode = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatCode = (c) => (normalizeCode(c).match(/.{1,4}/g) ?? []).join('-');
export const isValidCode = (c) => normalizeCode(c).length === CODE_LEN;

async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Public relay topic for a code (a hash: reveals nothing about the key). */
export async function topicFor(code) {
  return 'onda-' + (await sha256hex('onda-topic:' + normalizeCode(code))).slice(0, 40);
}

/** AES-GCM key for a code (PBKDF2-stretched). */
export async function deriveKey(code) {
  const base = await crypto.subtle.importKey('raw', utf8(normalizeCode(code)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: utf8('onda-sync-v1'), iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

const pipe = async (bytes, stream) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

/** bundle -> iv(12) ‖ AES-GCM(gzip(JSON)) */
export async function sealBundle(bundle, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const packed = await pipe(utf8(JSON.stringify(bundle)), new CompressionStream('gzip'));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, packed));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}

/** Inverse of sealBundle. Throws if the key is wrong or the bytes were tampered with. */
export async function openBundle(bytes, key) {
  const iv = bytes.slice(0, 12);
  const packed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.slice(12)));
  return JSON.parse(new TextDecoder().decode(await pipe(packed, new DecompressionStream('gzip'))));
}

const changed = (st) => st.ixAdded + st.ixUpdated + st.ixDeleted + st.obsAdded + (st.obsRemoved ?? 0) > 0;
// Cheap "has my data changed since I last published?" check.
const fingerprint = (b) => [
  (b.observations ?? []).length,
  (b.intersections ?? []).map((i) => `${i.id}:${i.rev ?? 0}:${i.updatedAt ?? 0}`).sort().join(','),
  (b.tombstones ?? []).length,
].join('|');

/**
 * Join a room and keep syncing until leave(). Symmetric: either device may
 * start first (or hours later, within the relay's 3 h attachment window).
 * @param {string} code
 * @param {{
 *   getBundle: () => Promise<object>,
 *   applyMerged: (merged: object) => Promise<void>,
 *   onStatus: (msg: string) => void,
 *   onSynced: (stats: object) => void,
 * }} handlers
 * @returns {Promise<{ leave: () => void }>}
 */
export async function startSync(code, handlers) {
  const { getBundle, applyMerged, onStatus, onSynced } = handlers;
  if (!isValidCode(code)) throw new Error(`a code has ${CODE_LEN} letters/digits`);
  if (!globalThis.crypto?.subtle) throw new Error('sync needs the secure (https://) version of the app');
  onStatus('preparing encryption…');
  const [topic, key] = await Promise.all([topicFor(code), deriveKey(code)]);
  const me = makeRoomCode(10); // this session's sender id, to skip our own messages
  let stopped = false, timer = null, lastId = null, lastPrint = null;
  const own = new Set();

  async function publish() {
    const bundle = await getBundle();
    const res = await fetch(`${RELAY}/${topic}`, {
      method: 'PUT', body: await sealBundle(bundle, key),
      headers: { 'X-Filename': 'bundle.bin', 'X-Message': me },
    });
    if (!res.ok) throw new Error(`relay said ${res.status}`);
    own.add((await res.json()).id);
    lastPrint = fingerprint(bundle);
  }

  async function poll() {
    const res = await fetch(`${RELAY}/${topic}/json?poll=1&since=${lastId ?? 'all'}`);
    if (!res.ok) throw new Error(`relay said ${res.status}`);
    const msgs = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((m) => m.event === 'message');
    if (msgs.length) lastId = msgs[msgs.length - 1].id;
    // Only the newest bundle from each other session matters (each is complete).
    const latest = new Map();
    for (const m of msgs) if (!own.has(m.id) && m.message !== me && m.attachment?.url) latest.set(m.message, m);
    let theyAreBehind = false;
    for (const m of latest.values()) {
      let remote;
      try { remote = await openBundle(new Uint8Array(await (await fetch(m.attachment.url)).arrayBuffer()), key); }
      catch { continue; } // expired attachment, or not encrypted with our code
      const local = await getBundle();
      const { merged, stats } = mergeBundles(local, remote);
      if (changed(stats)) await applyMerged(merged);
      if (changed(mergeBundles(remote, local).stats)) theyAreBehind = true;
      onSynced(stats);
    }
    // Publish back if the other side lacks something of ours, or if we have new
    // data since our last publish (e.g. taps made while the room is open).
    if (theyAreBehind || fingerprint(await getBundle()) !== lastPrint) await publish();
  }

  const loop = async () => {
    if (stopped) return;
    try { await poll(); onStatus(`in the room — checking every ${POLL_MS / 1000}s`); }
    catch (e) { onStatus('relay unreachable, retrying… (' + e.message + ')'); }
    if (!stopped) timer = setTimeout(loop, POLL_MS);
  };

  onStatus('sending your data…');
  try { await publish(); } catch (e) { onStatus('could not reach the relay: ' + e.message); }
  loop();
  return { leave: () => { stopped = true; clearTimeout(timer); } };
}
