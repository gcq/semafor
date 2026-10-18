// Module worker: runs osm2streets (wasm) off the main thread.
//   in : { id, osmXml: ArrayBuffer, bbox: [south,west,north,east] }
//   out: { id, ok: true, data, ms } | { id, ok: false, error }
// Errors are always posted back, never thrown silently. The wasm is initialised
// once, on the first message.

import init, { JsStreetNetwork } from '../../vendor/osm2streets/osm2streets_js.js';
import { buildLanes } from './lanes.js';

let ready = null;

self.onmessage = async ({ data: { id, osmXml, bbox } }) => {
  try {
    const t0 = performance.now();
    await (ready ??= init());
    const initMs = performance.now() - t0;
    const { data, ms } = buildLanes(JsStreetNetwork, new Uint8Array(osmXml), bbox);
    self.postMessage({ id, ok: true, data, ms: { init: initMs, ...ms } });
  } catch (e) {
    ready = null; // let the next request retry loading the wasm
    self.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
self.onerror = (e) => self.postMessage({ id: null, ok: false, error: String(e?.message ?? e) });
