// Offline shell: the app opens without network; speech needs a connection.
const CACHE = 'asha-vaani-v17';
const ASSETS = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest', '/assets/icon.svg',
  '/js/app.js', '/js/agent.js', '/js/audio.js', '/js/pcm-worklet.js', '/js/store.js', '/js/i18n.js', '/js/echo.js',
  '/js/nlu/translit.js', '/js/nlu/numbers.js', '/js/nlu/dates.js', '/js/nlu/match.js', '/js/nlu/danger.js',
  '/js/nlu/schedule.js', '/js/nlu/registry.js', '/js/nlu/parser.js', '/js/nlu/regional.js', '/js/nlu/interpret.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// network first (so updates land immediately), cache as fallback
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))),
  );
});
