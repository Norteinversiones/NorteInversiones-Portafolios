/* ============================================================
   Service worker · Norte Inversiones
   Estrategia: RED PRIMERO. Cada archivo propio (html/css/js/íconos) se pide a la
   red; la caché sólo se usa si no hay conexión. Así nunca se mezclan archivos de
   versiones distintas después de una actualización.
   Los datos (Firestore) nunca pasan por acá.
   Cambiar VERSION en cada deploy para renovar la caché.
   ============================================================ */
var VERSION = 'norte-v202611120130';
var SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css', './css/client.css',
  './js/firebase-config.js', './js/engine.js', './js/db.js', './js/charts.js', './js/ticker.js', './js/app.js',
  './assets/logo-square.png', './assets/logo-original.png', './assets/icon-192.png', './assets/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    // cache: 'reload' → baja cada archivo de la red, sin pasar por la caché HTTP del navegador.
    return Promise.all(SHELL.map(function (u) {
      return fetch(new Request(u, { cache: 'reload' })).then(function (res) { if (res.ok) return c.put(u, res); }).catch(function () { });
    }));
  }).then(function () { return self.skipWaiting(); }));
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
    fetch(e.request).then(function (res) {
      if (res && res.ok) { var copia = res.clone(); caches.open(VERSION).then(function (c) { c.put(e.request, copia); }); }
      return res;
    }).catch(function () {
      // Sin conexión: lo guardado (primero la versión exacta; si no está, la del mismo archivo).
      return caches.match(e.request).then(function (r) { return r || caches.match(e.request, { ignoreSearch: true }); });
    })
  );
});
