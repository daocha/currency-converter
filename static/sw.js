// Service worker: always go to the network when online; fall back to the cache only when offline.
// (Cache-first risked serving a stale mix of old and new files, e.g. new HTML with old CSS.)
// Paths resolve against the worker's scope, so this works at "/" and under a sub-path like "/fx/".
const VERSION = "v18";
const SHELL_CACHE = `cc-shell-${VERSION}`;
const API_CACHE = `cc-api-${VERSION}`;
const SCOPE = self.registration.scope; // e.g. "https://example.com/fx/"
const scoped = (path) => new URL(path, SCOPE).href;
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "calc.js",
  "i18n.js",
  "app.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
].map(scoped);
const API_PREFIX = scoped("api/");

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
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith("cc-") && ![SHELL_CACHE, API_CACHE].includes(k)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || !req.url.startsWith(SCOPE)) return;
  const cacheName = req.url.startsWith(API_PREFIX) ? API_CACHE : SHELL_CACHE;
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
      const shell = await cache.match(scoped("index.html"));
      if (shell) return shell;
    }
    throw err;
  }
}
