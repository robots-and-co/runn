'use strict';

// Killswitch SW — replaced the network-first shell cache after stale-content
// pain during development. Once installed it:
//   1. Claims every controlled tab immediately.
//   2. Bypasses cache for every fetch (always fresh from the worker, which
//      sends `cache-control: no-store`).
//   3. Wipes all caches.
//   4. Unregisters itself.
//   5. Reloads every controlled tab.
//
// After one round-trip the browser has no SW, no caches, and the page is
// loading directly from the worker. The page also no longer registers a SW,
// so the killswitch never comes back.
const VERSION = 'killswitch-2';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try { await self.clients.claim(); } catch {}
    try {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n)));
    } catch {}
    try { await self.registration.unregister(); } catch {}
    try {
      const cs = await self.clients.matchAll({ includeUncontrolled: true });
      for (const c of cs) { try { c.navigate(c.url); } catch {} }
    } catch {}
  })());
});

// During the brief window where this SW controls tabs but the activate handler
// hasn't finished navigating them away, never serve from cache.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() =>
    new Response('', { status: 504, statusText: 'sw-killswitch' })
  ));
});
