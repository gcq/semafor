// Sync tab UI. Create a room (shows a code + QR/URL) or join one; both devices
// then reconcile through the encrypted ntfy.sh relay. DOM only — transport in
// sync/net.js, reconciliation in sync/merge.js.

import { startSync, makeRoomCode, normalizeCode, formatCode, isValidCode } from '../sync/net.js';
import { esc } from './dom.js';

let ctx = null;      // { root, api }
let session = null;  // { leave }

export function mountSync(root, api) {
  ctx = { root, api };
  root.addEventListener('click', onClick);
  render();
}

/** If the app was opened from a scanned sync URL (?sync=CODE), auto-join. */
export function autoJoinFromUrl() {
  // The code is the encryption secret, so it rides in the #fragment, which the
  // browser never sends to the server (GitHub Pages would log a ?query). ?sync=
  // is still accepted for QR codes made by older builds.
  const code = new URLSearchParams(location.hash.slice(1)).get('sync') ?? new URLSearchParams(location.search).get('sync');
  if (!code) return false;
  history.replaceState(null, '', location.pathname); // and don't keep it in history
  start(code, false);
  return true;
}

// Action first, explanation folded away: the tab used to open with a paragraph.
function render() {
  ctx.root.innerHTML = `
    <div class="card">
      <h3>Sync with another device</h3>
      ${session ? sessionHtml() : idleHtml()}
    </div>
    <div class="card">
      <h3>Transfer a file</h3>
      <p class="note">When neither device is online: export here, import on the other. Importing merges; it never overwrites newer edits.</p>
      <div class="actions">
        <button class="btn" data-act="export">Export</button>
        <button class="btn" data-act="import">Import</button>
      </div>
      <p id="sync-file-status" class="note"></p>
    </div>
    <p class="note small">App version ${esc(self.ONDA_VERSION ?? '?')} — use the same version on both devices.</p>`;
}

function idleHtml() {
  return `
    <button class="btn primary block" data-act="create">Create a sync room</button>
    <p class="or">or join one</p>
    <div class="field">
      <input id="sync-code-in" class="grow" placeholder="Code from the other device" autocapitalize="characters" autocomplete="off" spellcheck="false" />
      <button class="btn" data-act="join">Join</button>
    </div>
    <p id="sync-join-err" class="note error"></p>
    <details>
      <summary>How it works</summary>
      <p>Works on any network, car LTE included. Both devices send their data through the public ntfy.sh relay, end-to-end encrypted with the room code, so the relay only ever sees ciphertext and deletes it within 3 hours. The other device can join any time in that window. Both sides merge: nothing is lost and the newest edits win.</p>
    </details>`;
}

function sessionHtml() {
  const url = `${location.origin}${location.pathname}#sync=${session.code}`;
  return `
    <div class="session">
      ${session.host ? `${qrSvg(url)}
        <div class="code">${formatCode(session.code)}</div>
        <p class="note">Scan this on the other device, or tap Join there and type the code. Keep it private: it's the encryption key.</p>`
      : `<p class="note">In room <b>${formatCode(session.code)}</b>. The other device must show the same code.</p>`}
      <p id="sync-status" class="note">starting…</p>
      <div id="sync-result"></div>
      <div class="actions"><button class="btn danger push" data-act="leave">Stop sync</button></div>
    </div>`;
}

const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;

function qrSvg(text) {
  try {
    if (typeof qrcode === 'undefined') return '<p class="note">(The QR code needs a connection the first time.)</p>';
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return `<div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 0 })}</div>`;
  } catch { return ''; }
}

async function start(code, host) {
  if (session) session.leave?.();
  code = normalizeCode(code);
  session = { code, host, leave: null };
  render();
  const set = (id, html) => { const n = document.getElementById(id); if (n) n.innerHTML = html; };
  const total = { ixAdded: 0, ixUpdated: 0, ixDeleted: 0, obsAdded: 0, obsRemoved: 0 };
  try {
    const s = await startSync(code, {
      getBundle: () => ctx.api.getBundle(),
      applyMerged: (m) => ctx.api.applyMerged(m),
      onStatus: (msg) => set('sync-status', esc(msg)),
      onSynced: (st) => {
        for (const k of Object.keys(total)) total[k] += st[k] ?? 0;
        set('sync-result',
          `<div class="ok-box"><div class="title">Synced ${new Date().toLocaleTimeString()}</div>
           <p class="note">Received so far: ${n(total.obsAdded, 'tap')}${total.obsRemoved ? ` (${total.obsRemoved} undone)` : ''}, ${n(total.ixAdded, 'new intersection')}, ${total.ixUpdated} updated, ${total.ixDeleted} removed.</p></div>`);
      },
    });
    if (session?.code === code) session.leave = s.leave; else s.leave();
  } catch (e) {
    set('sync-status', 'could not start: ' + esc(e.message));
  }
}

function onClick(e) {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  switch (btn.dataset.act) {
    case 'create': start(makeRoomCode(), true); break;
    case 'join': {
      const code = document.getElementById('sync-code-in')?.value || '';
      if (isValidCode(code)) start(code, false);
      else { const n = document.getElementById('sync-join-err'); if (n) n.textContent = 'A code has 16 letters and digits (dashes optional).'; }
      break;
    }
    case 'leave': session?.leave?.(); session = null; render(); break;
    case 'export': doExport(); break;
    case 'import': doImport(); break;
  }
}

async function doExport() {
  const text = await ctx.api.exportText();
  const fstat = (m) => { const n = document.getElementById('sync-file-status'); if (n) n.textContent = m; };
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'onda-export.json'; a.click();
    URL.revokeObjectURL(url);
    fstat('Exported.');
  } catch { try { await navigator.clipboard.writeText(text); fstat('Download blocked — copied to clipboard.'); } catch { fstat('Export failed.'); } }
}

function doImport() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'application/json';
  input.onchange = async () => {
    const file = input.files[0]; if (!file) return;
    try {
      await ctx.api.importBundle(JSON.parse(await file.text()));
      const n = document.getElementById('sync-file-status'); if (n) n.textContent = 'Imported ✓';
    } catch (e) { const n = document.getElementById('sync-file-status'); if (n) n.textContent = 'Import failed: ' + e.message; }
  };
  input.click();
}
