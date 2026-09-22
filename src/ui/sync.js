// Sync tab UI. Create a room (shows a code + QR/URL) or join one; both devices
// then reconcile through the encrypted ntfy.sh relay. DOM only — transport in
// sync/net.js, reconciliation in sync/merge.js.

import { startSync, makeRoomCode, normalizeCode, formatCode, isValidCode, SYNC_BUILD } from '../sync/net.js';

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

function render(state = {}) {
  ctx.root.innerHTML = `
    <div class="ed-section">
      <h3>Sync with another device <span class="tag" style="float:right">build ${esc(SYNC_BUILD)}</span></h3>
      <p class="muted-note" style="margin-top:-4px">Works on any network (car LTE included). Data goes through the public ntfy.sh relay <b>end-to-end encrypted</b> with the room code; the relay only sees ciphertext and drops it within 3 h. The other device can join any time in that window. Both sides merge: nothing is lost, newest edits win. <b>Both devices must show the same build.</b></p>
      ${session ? sessionHtml() : idleHtml()}
    </div>
    <div class="ed-section">
      <h3>Or transfer a file</h3>
      <p class="muted-note" style="margin-top:-4px">Offline fallback: Export on one device, Import (merges) on the other.</p>
      <div class="row-actions">
        <button class="sbtn" data-act="export">Export</button>
        <button class="sbtn" data-act="import">Import</button>
      </div>
      <div id="sync-file-status" class="muted-note" style="margin-top:8px"></div>
    </div>`;
}

function idleHtml() {
  return `
    <button class="sbtn primary" data-act="create" style="width:100%;padding:14px;margin:8px 0">Create a sync room</button>
    <div class="field"><input id="sync-code-in" placeholder="or enter a code (XXXX-XXXX-XXXX-XXXX)" autocapitalize="characters" autocomplete="off" spellcheck="false" style="text-transform:uppercase" />
      <button class="sbtn" data-act="join">Join</button></div>
    <div id="sync-join-err" class="muted-note" style="color:var(--red)"></div>`;
}

function sessionHtml() {
  const url = `${location.origin}${location.pathname}#sync=${session.code}`;
  const qr = qrSvg(url);
  return `
    <div style="text-align:center">
      ${session.host ? `<div style="margin:6px 0">${qr}</div>
        <div style="font-size:24px;font-weight:800;letter-spacing:2px;font-variant-numeric:tabular-nums">${formatCode(session.code)}</div>
        <p class="muted-note">On the other device, scan this or tap Join and type this code. Keep it private — it's the encryption key.</p>` : ''}
      ${session.host ? '' : `<p class="muted-note">In room <b>${formatCode(session.code)}</b> — the other device must show the same code.</p>`}
      <div id="sync-status" class="muted-note" style="margin-top:8px">starting…</div>
      <div id="sync-result" style="margin-top:8px"></div>
      <div class="row-actions" style="justify-content:center;margin-top:10px">
        <button class="sbtn danger" data-act="leave">Stop sync</button>
      </div>
    </div>`;
}

function qrSvg(text) {
  try {
    if (typeof qrcode === 'undefined') return '<p class="muted-note">(QR needs a connection the first time)</p>';
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return `<div style="display:inline-block;background:#fff;padding:8px;border-radius:8px">${qr.createSvgTag({ cellSize: 4, margin: 0 })}</div>`;
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
          `<div class="verdict linked"><div class="head" style="color:var(--green)">synced ✓ ${new Date().toLocaleTimeString()}</div>
           <div class="muted-note">received so far: +${total.obsAdded} observations${total.obsRemoved ? ` (−${total.obsRemoved} undone)` : ''}, +${total.ixAdded} intersections, ${total.ixUpdated} updated, ${total.ixDeleted} removed</div></div>`);
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
      else { const n = document.getElementById('sync-join-err'); if (n) n.textContent = 'A code has 16 letters/digits (dashes optional).'; }
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

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
