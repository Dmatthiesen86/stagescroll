// Offline-first service worker: the app always opens instantly from the device's cache
// (no waiting on flaky venue Wi-Fi), and quietly fetches updates in the background when online.
// Bump CACHE when shipping changes so devices pick them up on the next launch.
const CACHE = 'stagescroll-v13';
const ASSETS = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/store.js', 'js/chordpro.js',
  'js/follow.js', 'js/samples.js', 'js/pdfimport.js', 'js/chordify.js', 'js/timeline.js', 'js/lyricsync.js', 'js/capo.js', 'js/vendor/pdf.min.mjs', 'js/vendor/pdf.worker.min.mjs',
  'manifest.json', 'icon.svg', 'icon-180.png', 'icon-512.png'];
// Text recognition for picture-only PDFs (~15 MB). Downloaded in the background after install
// so PDF import also works offline, without slowing down the first launch.
const OCR_ASSETS = ['js/vendor/ocr/tesseract.esm.min.js', 'js/vendor/ocr/worker.min.js', 'js/vendor/ocr/eng.traineddata.gz',
  'js/vendor/ocr/tesseract-core-lstm.wasm.js', 'js/vendor/ocr/tesseract-core-simd-lstm.wasm.js',
  'js/vendor/ocr/tesseract-core-relaxedsimd-lstm.wasm.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  caches.open(CACHE).then(async c => {
    for (const url of OCR_ASSETS) if (!(await c.match(url))) await c.add(url).catch(() => {});
  });
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (location.hostname === 'localhost') return; // local development: always serve fresh files
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
    const update = fetch(req)
      .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
      .catch(() => undefined);
    if (cached) { e.waitUntil(update); return cached; }
    return (await update) || new Response('Offline', { status: 503 });
  }));
});
