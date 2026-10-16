// Petit « service worker » : permet d'installer FC27 Companion comme une appli et de l'ouvrir sans connexion.
// Règle simple et sûre : on demande TOUJOURS la version en ligne d'abord (donc jamais de vieux prix quand on a du réseau).
// Sans réseau seulement, on montre la dernière version enregistrée sur l'appareil.
const CACHE = 'fc27-v3';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== self.location.origin) return;   // seulement les fichiers du site lui-même
  e.respondWith(
    fetch(r).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(r, copy)).catch(() => { }); }
      return res;
    }).catch(() => caches.match(r, { ignoreSearch: true }).then((m) => m || (r.mode === 'navigate' ? caches.match('./index.html').then((x) => x || caches.match('./')) : undefined)).then((m) => m || new Response('Hors connexion', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })))
  );
});
