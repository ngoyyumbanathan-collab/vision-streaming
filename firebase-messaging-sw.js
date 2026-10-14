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
