// Sync tab UI. Create a room (shows a code + QR/URL) or join one; once both
// devices are in it, data reconciles automatically over WebRTC. DOM only —
// transport in sync/net.js, reconciliation in sync/merge.js.

import { joinSync, makeRoomCode, webrtcSelfTest, SYNC_BUILD } from '../sync/net.js';

let ctx = null;      // { root, api }
let session = null;  // { leave }

export function mountSync(root, api) {
  ctx = { root, api };
  root.addEventListener('click', onClick);
  render();
}

/** If the app was opened from a scanned sync URL (?sync=CODE), auto-join. */
export function autoJoinFromUrl() {
  const code = new URLSearchParams(location.search).get('sync');
  if (code) start(code.toUpperCase(), false);
  return !!code;
}

function render(state = {}) {
  ctx.root.innerHTML = `
    <div class="ed-section">
      <h3>Sync with another device <span class="tag" style="float:right">build ${esc(SYNC_BUILD)}</span></h3>
      <p class="muted-note" style="margin-top:-4px">Peer-to-peer via a public broker — no server, nothing stored online. Both devices merge: nothing is lost, newest edits win, all observations are kept. <b>Both devices must show the same build.</b></p>
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
    <div class="field"><input id="sync-code-in" placeholder="or enter a code" style="text-transform:uppercase" />
      <button class="sbtn" data-act="join">Join</button></div>
    <button class="sbtn" data-act="webrtc-test" style="margin-top:10px">Test WebRTC on this network</button>
    <div id="sync-webrtc" class="muted-note" style="margin-top:6px"></div>`;
}

function sessionHtml() {
  const url = `${location.origin}${location.pathname}?sync=${session.code}`;
  const qr = qrSvg(url);
  return `
    <div style="text-align:center">
      ${session.host ? `<div style="margin:6px 0">${qr}</div>
        <div style="font-size:32px;font-weight:800;letter-spacing:4px">${session.code}</div>
        <p class="muted-note">On the other device, scan this or tap Join and enter this code.</p>` : ''}
      ${session.host ? '' : `<p class="muted-note">Joined <b>${session.code}</b> — the other device must show the same code.</p>`}
      <div id="sync-status" class="muted-note" style="margin-top:8px">starting…</div>
      <div id="sync-peers" class="muted-note"></div>
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
  code = code.trim().toUpperCase();
  session = { code, host, leave: null };
  render();
  const set = (id, html) => { const n = document.getElementById(id); if (n) n.innerHTML = html; };
  try {
    const s = await joinSync(code, {
      getBundle: () => ctx.api.getBundle(),
      applyMerged: (m) => ctx.api.applyMerged(m),
      onStatus: (msg) => set('sync-status', esc(msg)),
      onPeers: (n) => set('sync-peers', n ? `${n} device${n === 1 ? '' : 's'} connected` : ''),
      onSynced: (st) => set('sync-result',
        `<div class="verdict linked"><div class="head" style="color:var(--green)">synced ✓</div>
         <div class="muted-note">+${st.obsAdded} observations, +${st.ixAdded} intersections, ${st.ixUpdated} updated, ${st.ixDeleted} removed</div></div>`),
    }, host);
    if (session) session.leave = s.leave;
  } catch (e) {
    set('sync-status', 'could not start: ' + esc(e.message));
  }
}

function onClick(e) {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  switch (btn.dataset.act) {
    case 'create': start(makeRoomCode(), true); break;
    case 'join': {
      const code = (document.getElementById('sync-code-in')?.value || '').trim().toUpperCase();
      if (code) start(code, false); break;
    }
    case 'leave': session?.leave?.(); session = null; render(); break;
    case 'webrtc-test': runWebrtcTest(); break;
    case 'export': doExport(); break;
    case 'import': doImport(); break;
  }
}

async function runWebrtcTest() {
  const box = document.getElementById('sync-webrtc'); if (!box) return;
  box.textContent = 'testing WebRTC…';
  const r = await webrtcSelfTest();
  if (r.error) { box.innerHTML = `<span style="color:var(--red)">WebRTC unavailable: ${esc(r.error)}</span>`; return; }
  const t = r.types;
  const has = (x) => t.includes(x);
  let verdict, color;
  if (!t.length) { verdict = 'WebRTC appears blocked — sync can’t work on this network (VPN/firewall?).'; color = 'var(--red)'; }
  else if (!has('srflx') && !has('relay')) { verdict = 'Only local candidates — STUN/TURN blocked (very likely a VPN/corporate firewall). P2P won’t connect across networks. Turn off the VPN and retry.'; color = 'var(--red)'; }
  else if (has('relay')) { verdict = 'TURN reachable ✓ — should connect even across strict networks.'; color = 'var(--green)'; }
  else { verdict = 'STUN reachable ✓ — should connect on most networks.'; color = 'var(--green)'; }
  box.innerHTML = `<div>candidates: ${t.map(esc).join(', ') || 'none'}</div><div style="color:${color}">${verdict}</div>`;
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
