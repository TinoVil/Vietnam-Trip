/* Vietnam 2026 · offline service worker */
/* Bump CACHE on every deploy, otherwise installed phones keep serving the old copy. */
const CACHE = "vn26-v5";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-192.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./sync.js",
  "./builder/",
  "./builder/index.html"
];

/* The Firebase SDK is served from gstatic. Cache it so a signed-in phone with
   no signal still boots the sync layer instead of failing the import. These
   are best-effort: if they fail, the app still runs local-only. */
const SDK = "https://www.gstatic.com/firebasejs/10.13.2";
const CDN_ASSETS = [
  `${SDK}/firebase-app.js`,
  `${SDK}/firebase-auth.js`,
  `${SDK}/firebase-firestore.js`
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS).then(() =>
        /* never let a CDN hiccup fail the whole install */
        Promise.allSettled(CDN_ASSETS.map(u => c.add(new Request(u, { mode: "cors" }))))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Cache-first for same-origin; network-first refresh for navigations so
   a newly deployed version is picked up when online. */
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  /* The Firebase SDK bundles are the only cross-origin thing we serve from
     cache. Everything else off-origin (auth handshakes, Firestore traffic)
     must go straight to the network — caching it would break sync. */
  if (url.origin !== location.origin) {
    if (CDN_ASSETS.some(u => e.request.url.startsWith(u))) {
      e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
    }
    return;
  }
  if (e.request.mode === "navigate") {
    /* Cache each page under its OWN url — the app and /builder/ are different
       documents, so a single shared key would serve one in place of the other. */
    const fallback = url.pathname.includes("/builder") ? "./builder/index.html" : "./index.html";
    e.respondWith(
      fetch(e.request)
        .then(r => {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match(e.request).then(hit => hit || caches.match(fallback)))
    );
    return;
  }
  /* Stale-while-revalidate: answer instantly from cache (so it's fast and works
     offline), but always refetch in the background and store the new copy for
     next launch. Plain cache-first would pin a stale sync.js/app forever if a
     deploy ever forgot to bump CACHE — this self-heals instead. */
  e.respondWith(
    caches.match(e.request).then(hit => {
      const fresh = fetch(e.request).then(r => {
        if (r && r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return r;
      }).catch(() => hit);
      return hit || fresh;
    })
  );
});
