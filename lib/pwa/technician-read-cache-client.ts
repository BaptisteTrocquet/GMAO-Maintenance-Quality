export const OFFLINE_SOURCE_HEADER = "x-opengmao-offline-source";
export const OFFLINE_CACHED_AT_HEADER = "x-opengmao-offline-cached-at";

const READ_CACHE_PREFIX = "opengmao-technician-read-v1:";
const MAX_READ_AGE_MS = 24 * 60 * 60 * 1000;
const PARTITION_PATTERN = /^[a-f0-9]{32}$/;

export function isOfflineReadPartition(value: string) {
  return PARTITION_PATTERN.test(value);
}

export async function readCachedTechnicianResponse(
  endpoint: string,
  partition: string,
): Promise<Response | null> {
  if (!isOfflineReadPartition(partition) || typeof window === "undefined" || !("caches" in window)) {
    return null;
  }

  const cache = await caches.open(`${READ_CACHE_PREFIX}${partition}`);
  const url = new URL(endpoint, window.location.origin).toString();
  const cached = await cache.match(url);
  if (!cached) return null;

  const cachedAt = cached.headers.get(OFFLINE_CACHED_AT_HEADER) ?? "";
  const timestamp = Date.parse(cachedAt);
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > MAX_READ_AGE_MS) {
    await cache.delete(url);
    return null;
  }

  const headers = new Headers(cached.headers);
  headers.set(OFFLINE_SOURCE_HEADER, "cache");
  headers.set(OFFLINE_CACHED_AT_HEADER, cachedAt);
  headers.set("cache-control", "private, no-store");

  return new Response(cached.clone().body, {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  });
}

export async function fetchTechnicianRead(
  endpoint: string,
  partition: string,
): Promise<Response> {
  const headers = isOfflineReadPartition(partition)
    ? { "x-opengmao-offline-partition": partition }
    : undefined;

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const cached = await readCachedTechnicianResponse(endpoint, partition);
    if (cached) return cached;
  }

  try {
    return await fetch(endpoint, { cache: "no-store", headers });
  } catch (error) {
    const cached = await readCachedTechnicianResponse(endpoint, partition);
    if (cached) return cached;
    throw error;
  }
}
