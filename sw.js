// Offline support for the installed app (Add to Home Screen): Pica3DS's own files are kept in a cache so it starts
// quickly and works without a connection. Games are never cached or uploaded: they are read from the device.
// Each request goes to the network first (so updates arrive straight away) and falls back to the cache when the
// network is slow or missing.
'use strict';
const CACHE = 'pica3ds-v19';
const APP = [
  './', 'index.html', 'manifest.webmanifest',
  'assets/icon.svg', 'assets/icon-180.png', 'assets/icon-192.png', 'assets/icon-512.png', 'assets/icon-maskable-512.png',
  'src/memory.js', 'src/wasmjit.js', 'src/cpu.js', 'src/kernel.js', 'src/services.js', 'src/gpu.js', 'src/glrender.js', 'src/audio.js',
  'src/sysdata.js', 'src/loader.js', 'src/emulator.js', 'src/state.js', 'src/demo-rom.js', 'src/main.js',
];
const NETWORK_WAIT_MS = 3000;

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, which could hold older copies
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !fonts) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // The page itself is cached once, whatever its query string (?demo)
    const key = req.mode === 'navigate' ? './' : req;
    const fromNetwork = fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(key, res.clone());
      return res;
    });
    const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    if (!cached) return fromNetwork;
    fromNetwork.catch(() => {}); // offline: the cached copy is used
    const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_WAIT_MS));
    return Promise.race([fromNetwork.catch(() => cached), timeout]);
  })());
});
