// Offline support. Files always come from the network when it's available, so
// updates show straight away. The saved copies are only used when offline.
const CACHE = "progress-tracker-v2";
const APP_FILES = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Only the app's own files. Google Fonts and anything else go straight to the network.
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          // Saved without any ?query, so one copy per file instead of one per address.
          const key = new URL(request.url);
          key.search = "";
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(key.href, copy));
        }
        return response;
      })
      .catch(async () => {
        const saved = await caches.match(request, { ignoreSearch: true });
        if (saved) return saved;
        if (request.mode === "navigate") return caches.match("./");
        return Response.error();
      }),
  );
});
