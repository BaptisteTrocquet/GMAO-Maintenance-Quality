export type TechnicianQueuedWriteKind = "execution" | "transition";

export type TechnicianQueuedWrite = {
  id: string;
  partition: string;
  organizationId: string;
  siteId: string;
  workOrderId: string;
  kind: TechnicianQueuedWriteKind;
  endpoint: string;
  body: Record<string, unknown>;
  sequence: number;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
};

export type TechnicianQueueFlushResult = {
  synced: number;
  remaining: number;
  blocked: TechnicianQueuedWrite | null;
  message: string | null;
  retryAt: string | null;
};

const DATABASE_NAME = "opengmao-technician-offline";
const DATABASE_VERSION = 1;
const STORE_NAME = "writeQueue";
const PARTITION_PATTERN = /^[a-f0-9]{32}$/;
const MAX_RETRY_DELAY_MS = 30_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function queueSupported() {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open offline write queue"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  if (!queueSupported()) throw new Error("Offline write queue is unavailable in this browser");
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let settled = false;
    const done = (value: T) => {
      settled = true;
      resolve(value);
    };
    const fail = (error: unknown) => {
      settled = true;
      reject(error);
    };
    transaction.onerror = () => fail(transaction.error ?? new Error("Offline write queue transaction failed"));
    transaction.onabort = () => fail(transaction.error ?? new Error("Offline write queue transaction aborted"));
    transaction.oncomplete = () => {
      database.close();
      if (!settled) reject(new Error("Offline write queue transaction completed unexpectedly"));
    };
    run(store, done, fail);
  });
}

export function isTechnicianQueuePartition(value: string) {
  return PARTITION_PATTERN.test(value);
}

export function technicianRetryDelayMs(attempts: number) {
  const exponent = Math.max(0, Math.min(10, Math.floor(attempts) - 1));
  return Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** exponent);
}

export function isRetryableTechnicianWriteStatus(status: number) {
  return RETRYABLE_STATUS.has(status);
}

function normalizeWrite(value: TechnicianQueuedWrite): TechnicianQueuedWrite {
  return {
    ...value,
    attempts: Number.isFinite(value.attempts) ? value.attempts : 0,
    lastAttemptAt: typeof value.lastAttemptAt === "string" ? value.lastAttemptAt : null,
    nextAttemptAt: typeof value.nextAttemptAt === "string" ? value.nextAttemptAt : null,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
  };
}

export async function enqueueTechnicianWrite(input: {
  partition: string;
  organizationId: string;
  siteId: string;
  workOrderId: string;
  kind: TechnicianQueuedWriteKind;
  endpoint: string;
  body: Record<string, unknown>;
}) {
  if (!isTechnicianQueuePartition(input.partition)) {
    throw new Error("Offline writes require an authenticated cache partition");
  }
  if (!input.endpoint.startsWith("/api/work-orders/")) {
    throw new Error("Offline write endpoint is not allowed");
  }

  const operation: TechnicianQueuedWrite = {
    ...input,
    id: crypto.randomUUID(),
    sequence: 0,
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lastError: null,
  };

  await withStore<void>("readwrite", (store, done, fail) => {
    // Read/write transactions on one object store are serialized by IndexedDB,
    // so assigning max(sequence)+1 here provides a stable order across tabs.
    const existingRequest = store.getAll();
    existingRequest.onerror = () =>
      fail(existingRequest.error ?? new Error("Unable to order offline write"));
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result as TechnicianQueuedWrite[];
      operation.sequence = existing.reduce(
        (maximum, item) => Math.max(maximum, Number.isFinite(item.sequence) ? item.sequence : 0),
        0,
      ) + 1;
      const addRequest = store.add(operation);
      addRequest.onsuccess = () => done(undefined);
      addRequest.onerror = () => fail(addRequest.error ?? new Error("Unable to enqueue offline write"));
    };
  });
  return operation;
}

export async function listTechnicianWrites(partition: string, workOrderId?: string) {
  if (!isTechnicianQueuePartition(partition) || !queueSupported()) return [];
  return withStore<TechnicianQueuedWrite[]>("readonly", (store, done, fail) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const writes = (request.result as TechnicianQueuedWrite[])
        .map(normalizeWrite)
        .filter(
          (item) =>
            item.partition === partition &&
            (!workOrderId || item.workOrderId === workOrderId),
        )
        .sort((a, b) => a.sequence - b.sequence);
      done(writes);
    };
    request.onerror = () => fail(request.error ?? new Error("Unable to read offline write queue"));
  });
}

async function removeTechnicianWrite(id: string) {
  return withStore<void>("readwrite", (store, done, fail) => {
    const request = store.delete(id);
    request.onsuccess = () => done(undefined);
    request.onerror = () => fail(request.error ?? new Error("Unable to remove synced offline write"));
  });
}

async function updateTechnicianWrite(
  id: string,
  update: (current: TechnicianQueuedWrite) => TechnicianQueuedWrite,
) {
  return withStore<TechnicianQueuedWrite | null>("readwrite", (store, done, fail) => {
    const getRequest = store.get(id);
    getRequest.onerror = () => fail(getRequest.error ?? new Error("Unable to read queued write"));
    getRequest.onsuccess = () => {
      const raw = getRequest.result as TechnicianQueuedWrite | undefined;
      if (!raw) return done(null);
      const next = update(normalizeWrite(raw));
      const request = store.put(next);
      request.onsuccess = () => done(next);
      request.onerror = () => fail(request.error ?? new Error("Unable to update queued write"));
    };
  });
}

async function markTechnicianWriteError(id: string, message: string) {
  return updateTechnicianWrite(id, (current) => ({
    ...current,
    lastError: message,
    nextAttemptAt: null,
  }));
}

async function markTechnicianWriteRetry(id: string, message: string, now: Date) {
  return updateTechnicianWrite(id, (current) => {
    const attempts = current.attempts + 1;
    return {
      ...current,
      attempts,
      lastAttemptAt: now.toISOString(),
      nextAttemptAt: new Date(now.getTime() + technicianRetryDelayMs(attempts)).toISOString(),
      lastError: message,
    };
  });
}

export function projectTechnicianWrites<T extends {
  id: string;
  status: string;
  laborMinutes: number | null;
  downtimeMinutes: number | null;
  completionNote: string | null;
  checkItems: Array<{ id: string; completed: boolean; note: string | null }>;
}>(workOrder: T, writes: TechnicianQueuedWrite[]): T {
  const projected = {
    ...workOrder,
    checkItems: workOrder.checkItems.map((item) => ({ ...item })),
  } as T;

  for (const write of [...writes].sort((a, b) => a.sequence - b.sequence)) {
    if (write.workOrderId !== workOrder.id) continue;
    if (write.kind === "execution") {
      if (typeof write.body.laborMinutes === "number") projected.laborMinutes = write.body.laborMinutes;
      if (typeof write.body.downtimeMinutes === "number") projected.downtimeMinutes = write.body.downtimeMinutes;
      if (typeof write.body.completionNote === "string") projected.completionNote = write.body.completionNote;
      const updates = Array.isArray(write.body.checklistUpdates)
        ? (write.body.checklistUpdates as Array<{ id?: unknown; completed?: unknown; note?: unknown }>)
        : [];
      projected.checkItems = projected.checkItems.map((item) => {
        const update = updates.find((candidate) => candidate.id === item.id);
        if (!update) return item;
        return {
          ...item,
          ...(typeof update.completed === "boolean" ? { completed: update.completed } : {}),
          ...(typeof update.note === "string" || update.note === null ? { note: update.note as string | null } : {}),
        };
      });
    } else if (write.kind === "transition" && typeof write.body.status === "string") {
      (projected as { status: string }).status = write.body.status;
    }
  }

  return projected;
}

function responseErrorMessage(body: unknown, fallback: string) {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return fallback;
}

export async function flushTechnicianWrites(
  partition: string,
  options: { force?: boolean; now?: Date } = {},
): Promise<TechnicianQueueFlushResult> {
  if (!isTechnicianQueuePartition(partition)) {
    return {
      synced: 0,
      remaining: 0,
      blocked: null,
      message: "No authenticated offline queue is available.",
      retryAt: null,
    };
  }
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const remaining = (await listTechnicianWrites(partition)).length;
    return {
      synced: 0,
      remaining,
      blocked: null,
      message: "Device is offline.",
      retryAt: null,
    };
  }

  const writes = await listTechnicianWrites(partition);
  let synced = 0;

  for (const write of writes) {
    const now = options.now ?? new Date();
    if (
      !options.force &&
      write.nextAttemptAt &&
      Date.parse(write.nextAttemptAt) > now.getTime()
    ) {
      return {
        synced,
        remaining: writes.length - synced,
        blocked: null,
        message: "Queued write is waiting for its retry window.",
        retryAt: write.nextAttemptAt,
      };
    }

    try {
      const response = await fetch(write.endpoint, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": write.id,
        },
        body: JSON.stringify(write.body),
      });
      const body = await response.json().catch(() => null);

      if (response.ok) {
        await removeTechnicianWrite(write.id);
        synced += 1;
        continue;
      }

      // Compatibility for queues created before server idempotency receipts existed.
      if (
        write.kind === "transition" &&
        response.status === 400 &&
        body &&
        typeof body === "object" &&
        "error" in body &&
        body.error &&
        typeof body.error === "object" &&
        "code" in body.error &&
        body.error.code === "NO_CHANGES"
      ) {
        await removeTechnicianWrite(write.id);
        synced += 1;
        continue;
      }

      const message = responseErrorMessage(body, `Queued write failed with HTTP ${response.status}`);
      if (isRetryableTechnicianWriteStatus(response.status)) {
        const retried = await markTechnicianWriteRetry(write.id, message, now);
        const remaining = (await listTechnicianWrites(partition)).length;
        return {
          synced,
          remaining,
          blocked: null,
          message,
          retryAt: retried?.nextAttemptAt ?? null,
        };
      }

      const blocked = await markTechnicianWriteError(write.id, message);
      const remaining = (await listTechnicianWrites(partition)).length;
      return {
        synced,
        remaining,
        blocked: blocked ?? { ...write, lastError: message },
        message,
        retryAt: null,
      };
    } catch {
      const now = options.now ?? new Date();
      const message = "Network unavailable while syncing queued work.";
      const retried = await markTechnicianWriteRetry(write.id, message, now);
      const remaining = (await listTechnicianWrites(partition)).length;
      return {
        synced,
        remaining,
        blocked: null,
        message,
        retryAt: retried?.nextAttemptAt ?? null,
      };
    }
  }

  return { synced, remaining: 0, blocked: null, message: null, retryAt: null };
}
