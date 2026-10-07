// Module Web Worker: runs the (pure) clock model off the UI thread.
// In:  { id, observations, intersections }   Out: { id, model } | { id, error }
import { computeModel } from './clock.js';

self.onmessage = (e) => {
  const { id, observations, intersections } = e.data ?? {};
  try { self.postMessage({ id, model: computeModel({ observations, intersections }) }); }
  catch (err) { self.postMessage({ id, error: String(err?.stack || err) }); }
};
