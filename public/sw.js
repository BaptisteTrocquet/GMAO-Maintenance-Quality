/* OpenGMAO PWA service worker.
 * E11 offline read cache: technician GET data only.
 * Mutations, attachments, HTML and unrelated APIs are always network-only.
 */
const VERSION = "opengmao-pwa-v2";
const READ_CACHE_VERSION = "v1";
const READ_CACHE_PREFIX = `opengmao-technician-read-${READ_CACHE_VERSION}:`;
const LEGACY_READ_CACHE_PREFIX = "opengmao-technician-read-";
const PARTITION_HEADER = "x-opengmao-offline-partition";
const SOURCE_HEADER = "x-opengmao-offline-source";
const CACHED_AT_HEADER = "x-opengmao-offline-cached-at";
const MAX_READ_AGE_MS = 24 * 60 * 60 * 1000;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((names) =>
        Promise.all(
          names
            .filter(
              (name) =>
                name.startsWith(LEGACY_READ_CACHE_PREFIX) &&
                !name.startsWith(READ_CACHE_PREFIX),
            )
            .map((name) => caches.delete(name)),
        ),
      ),
    ]),
  );
});

function technicianReadRequest(request) {
  if (request.method !== "GET") return null;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  if (
    url.pathname !== "/api/work-orders/technician" &&
    !url.pathname.startsWith("/api/work-orders/technician/")
  ) {
    return null;
  }
  if (!url.searchParams.get("organizationId") || !url.searchParams.get("siteId")) return null;

  const partition = request.headers.get(PARTITION_HEADER) ?? "";
  if (!/^[a-f0-9]{32}$/.test(partition)) return null;

  return { partition, url };
}

function cacheKey(url) {
  // Never persist Authorization or other request headers in CacheStorage.
  return new Request(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });
}

function cloneWithHeaders(response, additions) {
  const headers = new Headers(response.headers);
  headers.delete("vary");
  for (const [name, value] of Object.entries(additions)) headers.set(name, value);
  return new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readFreshCached(cache, key) {
  const cached = await cache.match(key);
  if (!cached) return null;

  const cachedAt = cached.headers.get(CACHED_AT_HEADER);
  const timestamp = cachedAt ? Date.parse(cachedAt) : Number.NaN;
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > MAX_READ_AGE_MS) {
    await cache.delete(key);
    return null;
  }

  return cloneWithHeaders(cached, {
    [SOURCE_HEADER]: "cache",
    [CACHED_AT_HEADER]: cachedAt,
    "cache-control": "private, no-store",
  });
}

function offlineMiss() {
  return new Response(
    JSON.stringify({
      error: {
        code: "OFFLINE_CACHE_MISS",
        message: "No fresh offline copy is available for this technician read.",
      },
    }),
    {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function technicianReadNetworkFirst(request, match) {
  const cache = await caches.open(`${READ_CACHE_PREFIX}${match.partition}`);
  const key = cacheKey(match.url);

  try {
    const response = await fetch(request);
    const contentType = response.headers.get("content-type") ?? "";

    if (response.ok && contentType.includes("application/json")) {
      const cachedAt = new Date().toISOString();
      const stamped = cloneWithHeaders(response, {
        [CACHED_AT_HEADER]: cachedAt,
        "cache-control": "private, no-store",
      });
      await cache.put(key, stamped);
    }

    if (response.status >= 500) {
      return (await readFreshCached(cache, key)) ?? response;
    }

    // Never replace authorization failures or other 4xx responses with stale data.
    return response;
  } catch {
    return (await readFreshCached(cache, key)) ?? offlineMiss();
  }
}

self.addEventListener("fetch", (event) => {
  const match = technicianReadRequest(event.request);
  if (!match) return;
  event.respondWith(technicianReadNetworkFirst(event.request, match));
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  if (event.data === "VERSION") event.source?.postMessage({ type: "SW_VERSION", version: VERSION });
});
