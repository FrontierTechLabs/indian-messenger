// Service Worker — Offline Message Queue
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'queue_message') {
    // Store message in IndexedDB via the client
    event.ports[0].postMessage({ type: 'store', message: event.data.message });
  }
});

// When online, send queued messages
self.addEventListener('online', () => {
  clients.matchAll({ type: 'window' }).then((clients) => {
    clients.forEach((client) => {
      client.postMessage({ type: 'sync_queued' });
    });
  });
});
