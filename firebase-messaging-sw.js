importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
importScripts('firebase-config.js');

firebase.initializeApp(FIREBASE_CONFIG);
const messaging = firebase.messaging();

// Notification reçue quand l'app est fermée ou en arrière-plan
messaging.onBackgroundMessage((payload) => {
  const d = payload.data || {};
  return self.registration.showNotification(d.title || 'Vision Streaming', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.tag || 'vision',
    data: { url: d.url || './' }
  });
});

// Un tap sur la notification ouvre l'app (ou la page de paiement du compte)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Lien externe (page de paiement Netflix, Prime, Crunchyroll) : on l'ouvre toujours
      const external = new URL(url, self.location.href).origin !== self.location.origin;
      if (!external) { for (const c of list) { if ('focus' in c) return c.focus(); } }
      return self.clients.openWindow(url);
    })
  );
});

/* ============ Mode hors ligne : l'app s'ouvre même sans réseau ============ */
const CACHE = 'vision-v1';
const PRECACHE = [
  'index.html', 'firebase-config.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];
const CDN_HOSTS = ['www.gstatic.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fichiers de l'app : le réseau d'abord (pour avoir toujours la dernière version), le cache si pas de réseau ou réseau trop lent
function networkFirst(req, isNav) {
  return new Promise((resolve) => {
    let done = false;
    const answer = (r) => { if (!done) { done = true; resolve(r); } };
    const fromCache = () => caches.match(req, { ignoreSearch:true }).then((r) => r || (isNav ? caches.match('index.html') : null));
    const timer = setTimeout(() => fromCache().then((r) => { if (r) answer(r); }), 4000);
    fetch(req).then((res) => {
      clearTimeout(timer);
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(isNav ? 'index.html' : req, copy)); }
      answer(res);
    }).catch(() => {
      clearTimeout(timer);
      fromCache().then((r) => answer(r || Response.error()));
    });
  });
}
// Bibliothèques externes (versions figées) : le cache d'abord
function cacheFirst(req) {
  return caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }));
}
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('firebase-messaging-sw.js')) return;
    event.respondWith(networkFirst(req, req.mode === 'navigate'));
  } else if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req));
  }
});
