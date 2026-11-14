// Semak Premis: keep the field view and its static assets available offline. Data (premises, rules,
// unsent records) lives in IndexedDB; API calls are never cached here.
const CACHE = 'semak-shell-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/periksa', '/manifest.webmanifest', '/icon-192.png'])).catch(() => undefined).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const isStatic = url.pathname.startsWith('/_next/static/');
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isStatic) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
    }
    try {
      const res = await fetch(e.request);
      // Only successful, non-redirected pages are kept (a redirect to /login must not replace /periksa).
      if (res.ok && !res.redirected && (isStatic || e.request.mode === 'navigate')) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request)) || (e.request.mode === 'navigate' ? cache.match('/periksa') : Response.error());
    }
  })());
});
