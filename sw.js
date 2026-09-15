// Minimal offline cache. Onda has no backend, so caching the shell is enough to
// make it work with no signal — which is the whole point in a moving car.
const CACHE = 'onda-v22';
const ASSETS = [
  '.', 'index.html', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'src/ui/app.js', 'src/ui/editor.js', 'src/ui/analyze.js', 'src/ui/sync.js', 'src/store/db.js',
  'src/predict/state.js', 'src/nav/proximity.js',
  'src/inference/reconstruct.js', 'src/inference/linkage.js', 'src/inference/characterize.js', 'src/inference/heads.js',
  'src/sync/merge.js', 'src/sync/net.js',
  'src/domain/model.js',
];
// Cross-origin libs we DO want cached for offline (loaded from CDN, not vendored).
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first for our own assets AND the CDN libs (so both update online and
// survive offline); everything else (OSM tiles, WebTorrent trackers) passes
// straight through and is never cached.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const ours = url.origin === location.origin;
  const cdnLib = CDN_HOSTS.includes(url.hostname);
  if (!ours && !cdnLib) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || (ours ? caches.match('index.html') : undefined))),
  );
});
