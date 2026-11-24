const CACHE = 'finances-shell-v8';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'house.js', 'investments.js',
    'investment-math.js', 'date-utils.js', 'supabase-config.js', 'manifest.webmanifest',
    'icons/home-finances-logo.svg'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
        .then(() => self.clients.claim()));
});

// Network first for the app shell so updates appear immediately; cache only as an offline fallback.
// Cross-origin requests (Supabase, APIs, CDNs) are never intercepted, so data is never served stale.
self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
    event.respondWith(fetch(request).then(response => {
        if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
    }).catch(() => caches.match(request, { ignoreSearch: true })));
});
