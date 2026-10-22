/* Panel Mapper service worker: keeps the app usable with no internet at the venue. */
const CACHE = 'panel-mapper-v2';
const CORE = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page sends every asset it loaded, so one online visit is enough to work offline.
self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'CACHE_URLS') return;
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(e.data.urls.map((u) => c.add(u).catch(() => null))))
      .then(() => e.source && e.source.postMessage({ type: 'CACHED' }))
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Pages: network first so updates arrive, cached copy when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // Each page under its own address, so visiting /remote can't replace the cached app.
          const copy = res.clone();
          if (res.ok) caches.open(CACHE).then((c) => c.put(url.pathname, copy));
          return res;
        })
        .catch(() => caches.match(url.pathname).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  // Hashed build assets and icons never change for a given URL: cache first.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
