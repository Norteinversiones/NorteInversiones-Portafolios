/* ============================================================
   Service worker · Norte Inversiones
   Estrategia: la cáscara (html/css/js/íconos) se sirve desde caché y se
   actualiza en segundo plano; los datos (Firestore) nunca pasan por acá.
   Cambiar VERSION en cada deploy para renovar la caché.
   ============================================================ */
var VERSION = 'norte-v202609080053';
var SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css', './css/client.css',
  './js/firebase-config.js', './js/engine.js', './js/db.js', './js/charts.js', './js/app.js',
  './assets/logo-square.png', './assets/logo-original.png', './assets/icon-192.png', './assets/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL).catch(function () { }); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Sólo archivos propios y las fuentes; Firebase/Google APIs van directo a la red.
  var propio = url.origin === self.location.origin;
  var fuente = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!propio && !fuente) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: propio }).then(function (cached) {
      var red = fetch(e.request).then(function (res) {
        if (res && res.ok) caches.open(VERSION).then(function (c) { c.put(e.request, res.clone()); });
        return res;
      }).catch(function () { return cached; });
      return cached || red;
    })
  );
});
