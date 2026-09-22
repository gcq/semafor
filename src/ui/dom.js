// Small shared UI helpers — one copy of each instead of one per tab.

/** Escape text for innerHTML. */
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Signal colors as hex, for inline swatches and map icons. */
export const ASPECT_HEX = { green: '#1ea966', amber: '#e0a800', 'flash-amber': '#e0a800', red: '#e23b3b', off: '#8a93a3' };

// Stroke icons (24×24, currentColor) — replaces the mixed Unicode glyphs
// (◀ ▶ ✕ ↶ ＋ →) that rendered differently on every browser.
const PATHS = {
  close: 'M6 6l12 12M18 6L6 18',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  arrow: 'M5 12h14M13 6l6 6-6 6',
};
/** @param {keyof typeof PATHS} name */
export const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;

/** <option>s for an intersection picker (every tab had its own copy). */
export const intersectionOptions = (list, selectedId) =>
  list.map((i) => `<option value="${i.id}" ${i.id === selectedId ? 'selected' : ''}>${esc(i.name)}</option>`).join('');
