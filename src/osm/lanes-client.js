// Main-thread side of lanes-worker.js: one lazily created module worker,
// requests matched by id, a timeout so a stuck wasm can't wedge the queue.
// Rejects (never throws silently) when workers/modules/wasm are unavailable;
// the street feed then falls back to plain lines.

let worker = null, seq = 0;
const pending = new Map();

function failAll(message) {
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(message)); }
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  const w = worker = new Worker(new URL('./lanes-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id); clearTimeout(p.timer);
    if (data.ok) { console.log('[streets] osm2streets worker ms', data.ms); p.resolve(data.data); } else p.reject(new Error(data.error));
  };
  w.onerror = (e) => { // load/parse failure of the worker or its wasm
    failAll(e.message || 'lanes worker failed');
    w.terminate(); if (worker === w) worker = null;
  };
  return w;
}

/** @returns {Promise<Object>} compact lane data (see compactLanes) */
export function computeLanes(osmBytes, bbox, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = getWorker(); } catch (e) { reject(e); return; }
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id); reject(new Error('lanes worker timeout'));
      w.terminate(); if (worker === w) worker = null; // stuck: start fresh next time
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const buf = osmBytes.buffer.slice(osmBytes.byteOffset, osmBytes.byteOffset + osmBytes.byteLength);
    w.postMessage({ id, osmXml: buf, bbox }, [buf]);
  });
}
