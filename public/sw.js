/* OpenGMAO PWA foundation.
 * Offline caching and write queuing are intentionally implemented in later E11 stories.
 */
const VERSION = "opengmao-pwa-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Network behavior remains unchanged until the explicit offline-cache story.
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  if (event.data === "VERSION") event.source?.postMessage({ type: "SW_VERSION", version: VERSION });
});
