// Receive-only sync peer: open a room the app can join, wait for the other
// device's encrypted bundle, and save it decrypted to out/room-bundle.json for
// offline analysis. Never publishes, so it can't change anything on the device
// (joining an empty room just makes the app publish its bundle and keep polling).
//
//   docker run --rm -v "$PWD":/app -w /app node:22-alpine node tools/room.mjs [CODE]
//
// Reuses src/sync/net.js so the topic/key/crypto can't drift from the app.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { mergeBundles } from '../src/sync/merge.js';
import { makeRoomCode, normalizeCode, formatCode, isValidCode, topicFor, deriveKey, openBundle } from '../src/sync/net.js';

const RELAY = 'https://ntfy.sh';
const APP = 'https://gcq.github.io/semafor/';
const POLL_MS = 8000;
const LINGER_MS = 60000; // after the first bundle, keep listening briefly for a newer one

const code = normalizeCode(process.argv[2] ?? makeRoomCode());
if (!isValidCode(code)) throw new Error('a code has 16 letters/digits');
const [topic, key] = await Promise.all([topicFor(code), deriveKey(code)]);
console.log(`room ${formatCode(code)}\njoin  ${APP}#sync=${code}\nwaiting for a bundle…`);

let lastId = process.argv[3] ?? null, gotAt = 0; // optional: only messages after this ntfy id
for (;;) {
  try {
    const res = await fetch(`${RELAY}/${topic}/json?poll=1&since=${lastId ?? 'all'}`);
    const msgs = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((m) => m.event === 'message' && m.attachment?.url);
    if (msgs.length) lastId = msgs[msgs.length - 1].id;
    for (const m of msgs) {
      let b;
      try { b = await openBundle(new Uint8Array(await (await fetch(m.attachment.url)).arrayBuffer()), key); }
      catch { continue; } // expired attachment, or not ours
      // Merge rather than overwrite: several devices may publish, some empty.
      const prev = await readFile('out/room-bundle.json', 'utf8').then(JSON.parse, () => null);
      const merged = prev ? mergeBundles(prev, b).merged : b;
      await mkdir('out', { recursive: true });
      await writeFile('out/room-bundle.json', JSON.stringify(merged, null, 2));
      gotAt ||= Date.now();
      console.log(`${new Date().toISOString()} from ${m.message}: ${b.observations?.length ?? 0} taps → ` +
        `out/room-bundle.json now ${merged.observations.length} taps, ${merged.intersections.length} intersections`);
    }
  } catch (e) { console.log('relay error, retrying: ' + e.message); }
  if (gotAt && Date.now() - gotAt > LINGER_MS) break;
  await new Promise((r) => setTimeout(r, POLL_MS));
}
