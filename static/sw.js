// Service worker: always go to the network when online; fall back to the cache only when offline.
// (Cache-first risked serving a stale mix of old and new files, e.g. new HTML with old CSS.)
const VERSION = "v4";
const SHELL_CACHE = `cc-shell-${VERSION}`;
const API_CACHE = `cc-api-${VERSION}`;
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  // cache: "reload" bypasses the browser HTTP cache so we never precache stale files.
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL_CACHE, API_CACHE].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const cacheName = url.pathname.startsWith("/api/") ? API_CACHE : SHELL_CACHE;
  event.respondWith(networkFirst(req, cacheName));
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    // The server sends Cache-Control: no-cache, so this revalidates with the server (cheap 304s).
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    if (req.mode === "navigate") {
      const shell = await cache.match("/index.html");
      if (shell) return shell;
    }
    throw err;
  }
}
