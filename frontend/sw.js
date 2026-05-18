'use strict';

// Bump this version string whenever the shell changes meaningfully —
// triggers a fresh fetch on the next install/activate cycle.
const VERSION = 'runn-shell-v1';
const SHELL = ['/', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Drop old caches
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== VERSION).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept dynamic API or the WS upgrade.
  if (url.pathname.startsWith('/cards') ||
      url.pathname.startsWith('/sessions') ||
      url.pathname === '/ws') return;

  // Network-first for the shell so updates land immediately, cache as fallback for offline.
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const copy = fresh.clone();
      caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
      return fresh;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      throw new Error('offline and no cache');
    }
  })());
});
