'use strict';

// Minimal "installability" service worker.
//
// History: we briefly shipped a shell-caching SW, ripped it out (stale-content
// pain), then ran a killswitch SW that unregistered itself. Now that the app is
// served over TLS we want it *installable* on Android (standalone, no address
// bar) — and Chrome only offers a real install when a SW with a fetch handler
// controls the page.
//
// So this SW does the minimum to qualify and nothing more: it has a fetch
// handler, but that handler is a pure network passthrough. No caching, no
// offline shell — every request still hits the worker, which sends
// `cache-control: no-store`. Installable, but never stale.
const VERSION = 'passthrough-1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try { await self.clients.claim(); } catch {}
    // Belt-and-suspenders: clear any caches a previous SW generation left behind.
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch {}
  })());
});

// Pure passthrough. Present so Chrome considers the app installable; does no
// caching so the page is always fresh from the worker.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request));
});
