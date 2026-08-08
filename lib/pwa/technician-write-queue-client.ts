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
  createdAt: string;
  lastError: string | null;
};

export type TechnicianQueueFlushResult = {
  synced: number;
  remaining: number;
  blocked: TechnicianQueuedWrite | null;
  message: string | null;
};

const DATABASE_NAME = "opengmao-technician-offline";
const DATABASE_VERSION = 1;
const STORE_NAME = "writeQueue";
const PARTITION_PATTERN = /^[a-f0-9]{32}$/;

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
    createdAt: new Date().toISOString(),
    lastError: null,
  };

  await withStore<void>("readwrite", (store, done, fail) => {
    const request = store.add(operation);
    request.onsuccess = () => done(undefined);
    request.onerror = () => fail(request.error ?? new Error("Unable to enqueue offline write"));
  });
  return operation;
}

export async function listTechnicianWrites(partition: string, workOrderId?: string) {
  if (!isTechnicianQueuePartition(partition) || !queueSupported()) return [];
  return withStore<TechnicianQueuedWrite[]>("readonly", (store, done, fail) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const writes = (request.result as TechnicianQueuedWrite[])
        .filter(
          (item) =>
            item.partition === partition &&
            (!workOrderId || item.workOrderId === workOrderId),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

async function markTechnicianWriteError(id: string, message: string) {
  return withStore<void>("readwrite", (store, done, fail) => {
    const getRequest = store.get(id);
    getRequest.onerror = () => fail(getRequest.error ?? new Error("Unable to read queued write"));
    getRequest.onsuccess = () => {
      const current = getRequest.result as TechnicianQueuedWrite | undefined;
      if (!current) return done(undefined);
      const request = store.put({ ...current, lastError: message });
      request.onsuccess = () => done(undefined);
      request.onerror = () => fail(request.error ?? new Error("Unable to update queued write"));
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

  for (const write of writes) {
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

export async function flushTechnicianWrites(partition: string): Promise<TechnicianQueueFlushResult> {
  if (!isTechnicianQueuePartition(partition)) {
    return { synced: 0, remaining: 0, blocked: null, message: "No authenticated offline queue is available." };
  }
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const remaining = (await listTechnicianWrites(partition)).length;
    return { synced: 0, remaining, blocked: null, message: "Device is offline." };
  }

  const writes = await listTechnicianWrites(partition);
  let synced = 0;

  for (const write of writes) {
    try {
      const response = await fetch(write.endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(write.body),
      });
      const body = await response.json().catch(() => null);

      if (response.ok) {
        await removeTechnicianWrite(write.id);
        synced += 1;
        continue;
      }

      // A queued status transition is state-setting. If replay reports no changes,
      // the requested status is already current, so removing it is safe.
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
      await markTechnicianWriteError(write.id, message);
      const remaining = (await listTechnicianWrites(partition)).length;
      return { synced, remaining, blocked: { ...write, lastError: message }, message };
    } catch {
      const remaining = (await listTechnicianWrites(partition)).length;
      return { synced, remaining, blocked: null, message: "Network unavailable while syncing queued work." };
    }
  }

  return { synced, remaining: 0, blocked: null, message: null };
}
