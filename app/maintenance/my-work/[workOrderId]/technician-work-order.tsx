"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import WorkOrderCameraAttachments from "@/app/maintenance/[workOrderId]/work-order-camera-attachments";
import {
  fetchTechnicianRead,
  isOfflineReadPartition,
  OFFLINE_CACHED_AT_HEADER,
  OFFLINE_SOURCE_HEADER,
} from "@/lib/pwa/technician-read-cache-client";
import {
  discardTechnicianWrite,
  enqueueTechnicianWrite,
  flushTechnicianWrites,
  isTechnicianQueuePartition,
  isTechnicianWriteConflict,
  listTechnicianWrites,
  projectTechnicianWrites,
  type TechnicianQueuedWrite,
} from "@/lib/pwa/technician-write-queue-client";
import {
  WORK_ORDER_COMPLETION_ATTESTATION,
  signatureNameMatchesIdentity,
  type WorkOrderCompletionSignature,
} from "@/lib/work-orders/completion-signature";

type WorkOrderStatus =
  | "REQUESTED"
  | "APPROVED"
  | "PLANNED"
  | "IN_PROGRESS"
  | "BLOCKED"
  | "COMPLETED"
  | "CANCELLED";

type CheckItem = {
  id: string;
  label: string;
  completed: boolean;
  note: string | null;
};

type TechnicianWorkOrderData = {
  id: string;
  number: string;
  title: string;
  description: string | null;
  status: WorkOrderStatus;
  priority: string;
  type: string;
  plannedStart: string | null;
  dueAt: string | null;
  startedAt: string | null;
  laborMinutes: number | null;
  downtimeMinutes: number | null;
  completionNote: string | null;
  asset: { id: string; code: string; name: string } | null;
  assignee: { id: string; displayName: string } | null;
  team: { id: string; name: string } | null;
  checkItems: CheckItem[];
};

type TechnicianDetailData = {
  workOrder: TechnicianWorkOrderData;
  signer: { id: string; displayName: string };
  completionSignature: WorkOrderCompletionSignature | null;
};

type ApiResponse<T> = {
  data?: T;
  error?: { code?: string; message?: string };
};

const OFFLINE_PARTITION_HEADER = "x-opengmao-offline-partition";

const buttonStyle = {
  minHeight: 44,
  padding: "10px 14px",
  borderRadius: 9,
  cursor: "pointer",
} as const;

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function cacheLabel(cachedAt: string) {
  const parsed = Date.parse(cachedAt);
  if (!Number.isFinite(parsed)) return "Offline copy";
  return `Offline copy · cached ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(parsed))}`;
}

function queuedWriteSummary(write: TechnicianQueuedWrite) {
  if (write.kind === "transition") {
    return typeof write.body.status === "string"
      ? `Status change → ${write.body.status}`
      : "Queued status change";
  }

  const details: string[] = ["Progress update"];
  if (typeof write.body.laborMinutes === "number") details.push(`labor ${write.body.laborMinutes} min`);
  if (typeof write.body.downtimeMinutes === "number") details.push(`downtime ${write.body.downtimeMinutes} min`);
  if (typeof write.body.completionNote === "string") details.push("completion note");
  if (Array.isArray(write.body.checklistUpdates)) {
    details.push(`${write.body.checklistUpdates.length} checklist item${write.body.checklistUpdates.length === 1 ? "" : "s"}`);
  }
  return details.join(" · ");
}

export default function TechnicianWorkOrder({
  organizationId,
  siteId,
  workOrderId,
  offlinePartition,
}: {
  organizationId: string;
  siteId: string;
  workOrderId: string;
  offlinePartition: string;
}) {
  const [workOrder, setWorkOrder] = useState<TechnicianWorkOrderData | null>(null);
  const [signer, setSigner] = useState<{ id: string; displayName: string } | null>(null);
  const [completionSignature, setCompletionSignature] = useState<WorkOrderCompletionSignature | null>(null);
  const [signatureName, setSignatureName] = useState("");
  const [signatureAttested, setSignatureAttested] = useState(false);
  const [laborMinutes, setLaborMinutes] = useState("0");
  const [downtimeMinutes, setDowntimeMinutes] = useState("0");
  const [completionNote, setCompletionNote] = useState("");
  const [checkItems, setCheckItems] = useState<CheckItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const syncingRef = useRef(false);
  const [queuedWrites, setQueuedWrites] = useState(0);
  const [retryAt, setRetryAt] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [offlineRead, setOfflineRead] = useState(false);
  const [cachedAt, setCachedAt] = useState("");
  const [online, setOnline] = useState(true);
  const [cachePartition, setCachePartition] = useState(offlinePartition);
  const [conflictWrite, setConflictWrite] = useState<TechnicianQueuedWrite | null>(null);
  const [serverConflictWorkOrder, setServerConflictWorkOrder] = useState<TechnicianWorkOrderData | null>(null);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const applyWorkOrder = useCallback((next: TechnicianWorkOrderData) => {
    setWorkOrder(next);
    setLaborMinutes(String(next.laborMinutes ?? 0));
    setDowntimeMinutes(String(next.downtimeMinutes ?? 0));
    setCompletionNote(next.completionNote ?? "");
    setCheckItems(next.checkItems);
  }, []);

  const fetchLiveWorkOrder = useCallback(async () => {
    const query = new URLSearchParams({ organizationId, siteId });
    const response = await fetch(
      `/api/work-orders/technician/${encodeURIComponent(workOrderId)}?${query.toString()}`,
      { cache: "no-store" },
    );
    const body = (await response.json()) as ApiResponse<TechnicianDetailData>;
    if (!response.ok || !body.data) {
      throw new Error(body.error?.message ?? "Unable to load the current server work order");
    }
    return body.data.workOrder;
  }, [organizationId, siteId, workOrderId]);

  const refreshConflictServerVersion = useCallback(async (write: TechnicianQueuedWrite | null) => {
    setConflictWrite(write);
    if (!write || !isTechnicianWriteConflict(write)) {
      setServerConflictWorkOrder(null);
      return;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    try {
      setServerConflictWorkOrder(await fetchLiveWorkOrder());
    } catch (reason) {
      setServerConflictWorkOrder(null);
      setError(reason instanceof Error ? reason.message : "Unable to load the current server work order");
    }
  }, [fetchLiveWorkOrder]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ organizationId, siteId });
    const endpoint = `/api/work-orders/technician/${encodeURIComponent(workOrderId)}?${query.toString()}`;
    try {
      const response = await fetchTechnicianRead(endpoint, cachePartition);
      const body = (await response.json()) as ApiResponse<TechnicianDetailData>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load technician work order");
      }

      const confirmedPartition = response.headers.get(OFFLINE_PARTITION_HEADER) ?? "";
      const activePartition = isOfflineReadPartition(confirmedPartition)
        ? confirmedPartition
        : cachePartition;
      if (activePartition !== cachePartition && isOfflineReadPartition(activePartition)) {
        setCachePartition(activePartition);
      }

      setSigner(body.data.signer);
      setCompletionSignature(body.data.completionSignature);
      let next = body.data.workOrder;
      if (isTechnicianQueuePartition(activePartition)) {
        const queued = await listTechnicianWrites(activePartition);
        setQueuedWrites(queued.length);
        const persistedConflict = queued.find(
          (write) => write.workOrderId === workOrderId && isTechnicianWriteConflict(write),
        ) ?? null;
        await refreshConflictServerVersion(persistedConflict);
        next = projectTechnicianWrites(next, queued) as TechnicianWorkOrderData;
      } else {
        setQueuedWrites(0);
        setConflictWrite(null);
        setServerConflictWorkOrder(null);
      }
      applyWorkOrder(next);
      if (body.data.workOrder.status === "COMPLETED" && body.data.completionSignature) {
        setSignatureName("");
        setSignatureAttested(false);
      }

      const fromCache = response.headers.get(OFFLINE_SOURCE_HEADER) === "cache";
      setOfflineRead(fromCache);
      setCachedAt(fromCache ? response.headers.get(OFFLINE_CACHED_AT_HEADER) ?? "" : "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load technician work order");
    } finally {
      setLoading(false);
    }
  }, [applyWorkOrder, cachePartition, organizationId, refreshConflictServerVersion, siteId, workOrderId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshQueueCount = useCallback(async () => {
    if (!isTechnicianQueuePartition(cachePartition)) {
      setQueuedWrites(0);
      return 0;
    }
    const queued = await listTechnicianWrites(cachePartition);
    setQueuedWrites(queued.length);
    return queued.length;
  }, [cachePartition]);

  const syncQueue = useCallback(async (force = false) => {
    if (!online || !isTechnicianQueuePartition(cachePartition) || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setError("");
    try {
      const result = await flushTechnicianWrites(cachePartition, { force });
      setQueuedWrites(result.remaining);
      setRetryAt(result.retryAt ?? "");
      if (result.blocked) {
        if (isTechnicianWriteConflict(result.blocked)) {
          await refreshConflictServerVersion(result.blocked);
          setMessage("A queued offline change conflicts with the current server version.");
        } else {
          setConflictWrite(null);
          setServerConflictWorkOrder(null);
          setError(`Queued change needs attention: ${result.message ?? "server rejected the change"}`);
        }
        return;
      }
      setConflictWrite(null);
      setServerConflictWorkOrder(null);
      if (result.retryAt) {
        setMessage("Queued change will retry automatically after a temporary sync failure.");
      }
      if (result.synced > 0) {
        setMessage(`${result.synced} queued change${result.synced === 1 ? "" : "s"} synced.`);
        await load();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to sync queued work");
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [cachePartition, load, online, refreshConflictServerVersion]);

  useEffect(() => {
    if (!online || !isTechnicianQueuePartition(cachePartition)) return;
    void (async () => {
      const queued = await listTechnicianWrites(cachePartition);
      setQueuedWrites(queued.length);
      const persistedConflict = queued.find(
        (write) => write.workOrderId === workOrderId && isTechnicianWriteConflict(write),
      ) ?? null;
      if (persistedConflict) {
        await refreshConflictServerVersion(persistedConflict);
        return;
      }
      if (queued.length > 0) void syncQueue();
    })();
  }, [cachePartition, online, refreshConflictServerVersion, syncQueue, workOrderId]);

  useEffect(() => {
    if (!online || !retryAt || queuedWrites === 0 || conflictWrite) return;
    const retryTime = Date.parse(retryAt);
    if (!Number.isFinite(retryTime)) return;
    const delay = Math.max(0, retryTime - Date.now()) + 25;
    const timer = window.setTimeout(() => void syncQueue(), delay);
    return () => window.clearTimeout(timer);
  }, [conflictWrite, online, queuedWrites, retryAt, syncQueue]);

  async function patchJson<T>(url: string, body: Record<string, unknown>) {
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as ApiResponse<T>;
    if (!response.ok || !result.data) {
      throw new Error(result.error?.message ?? "Work order update failed");
    }
    return result.data;
  }

  const queueAvailable = isTechnicianQueuePartition(cachePartition);
  const queueMode = (!online || offlineRead) && queueAvailable;
  const writesDisabled = ((!online || offlineRead) && !queueAvailable) || Boolean(conflictWrite);
  const signatureMatches = signer
    ? signatureNameMatchesIdentity(signatureName, signer.displayName)
    : false;

  function executionPayload() {
    return {
      organizationId,
      siteId,
      laborMinutes: Math.max(0, Number.parseInt(laborMinutes || "0", 10) || 0),
      downtimeMinutes: Math.max(0, Number.parseInt(downtimeMinutes || "0", 10) || 0),
      completionNote,
      checklistUpdates: checkItems.map((item) => ({
        id: item.id,
        completed: item.completed,
        note: item.note,
      })),
    };
  }

  function transitionPayload(status: WorkOrderStatus) {
    return {
      organizationId,
      siteId,
      status,
      ...(status === "COMPLETED"
        ? {
            completionSignature: {
              signerName: signatureName,
              attested: signatureAttested,
            },
          }
        : {}),
    };
  }

  async function queueExecution() {
    if (!workOrder || !queueAvailable) return false;
    await enqueueTechnicianWrite({
      partition: cachePartition,
      organizationId,
      siteId,
      workOrderId: workOrder.id,
      kind: "execution",
      endpoint: `/api/work-orders/${encodeURIComponent(workOrder.id)}/execution`,
      body: executionPayload(),
    });
    setRetryAt("");
    await refreshQueueCount();
    return true;
  }

  async function saveExecution(showSuccess = true) {
    if (!workOrder || !["IN_PROGRESS", "BLOCKED"].includes(workOrder.status)) return false;
    try {
      if (queueMode) {
        const queued = await queueExecution();
        if (queued && showSuccess) setMessage("Progress queued for sync when the connection returns.");
        return queued;
      }

      await patchJson(`/api/work-orders/${encodeURIComponent(workOrder.id)}/execution`, executionPayload());
      if (showSuccess) setMessage("Progress saved.");
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save execution progress");
      return false;
    }
  }

  async function transition(status: WorkOrderStatus) {
    if (!workOrder || busy || writesDisabled) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (queueMode) {
        if (status === "COMPLETED") {
          const saved = await queueExecution();
          if (!saved) return;
        }
        await enqueueTechnicianWrite({
          partition: cachePartition,
          organizationId,
          siteId,
          workOrderId: workOrder.id,
          kind: "transition",
          endpoint: `/api/work-orders/${encodeURIComponent(workOrder.id)}`,
          body: transitionPayload(status),
        });
        setRetryAt("");
        await refreshQueueCount();
        setWorkOrder((current) => current ? { ...current, status } : current);
        setMessage(
          status === "COMPLETED"
            ? "Signed completion queued. It becomes authoritative after authenticated sync."
            : `Status ${status} queued for sync after reconnection.`,
        );
        return;
      }

      if (status === "COMPLETED") {
        const saved = await saveExecution(false);
        if (!saved) return;
      }
      await patchJson(`/api/work-orders/${encodeURIComponent(workOrder.id)}`, transitionPayload(status));
      setMessage(
        status === "IN_PROGRESS"
          ? workOrder.status === "BLOCKED" ? "Work resumed." : "Work started."
          : status === "BLOCKED"
            ? "Work order blocked."
            : status === "COMPLETED"
              ? "Work order completed and signed."
              : "Status updated.",
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update work order status");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (busy || writesDisabled) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await saveExecution(true);
      if (saved && !queueMode) await load();
    } finally {
      setBusy(false);
    }
  }

  async function discardConflict() {
    if (!conflictWrite || resolvingConflict) return;
    setResolvingConflict(true);
    setError("");
    try {
      const discarded = await discardTechnicianWrite(cachePartition, conflictWrite.id);
      if (!discarded) throw new Error("The queued change could not be discarded for this session.");
      setConflictWrite(null);
      setServerConflictWorkOrder(null);
      setRetryAt("");
      setMessage("Local queued change discarded. The current server version is now authoritative.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to discard queued conflict");
    } finally {
      setResolvingConflict(false);
    }
  }

  function keepConflict() {
    if (!conflictWrite) return;
    setMessage("Local queued change kept. It will remain paused until you retry or discard it.");
  }

  function updateCheckItem(id: string, patch: Partial<Pick<CheckItem, "completed" | "note">>) {
    if (writesDisabled) return;
    setCheckItems((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  if (loading && !workOrder) {
    return <section className="card"><p aria-live="polite">Loading work order…</p></section>;
  }
  if (error && !workOrder) {
    return <section className="card"><p role="alert">{error}</p></section>;
  }
  if (!workOrder) return null;

  const active = workOrder.status === "IN_PROGRESS" || workOrder.status === "BLOCKED";
  const allChecklistComplete = checkItems.every((item) => item.completed);
  const canComplete =
    workOrder.status === "IN_PROGRESS" &&
    allChecklistComplete &&
    completionNote.trim().length > 0 &&
    signatureAttested &&
    signatureMatches;
  const cameraDisabled = !online || offlineRead || workOrder.status === "CANCELLED" || workOrder.status === "COMPLETED";
  const cameraDisabledReason = !online || offlineRead
    ? "Photo uploads still require a network connection. Structured maintenance changes can be queued offline."
    : workOrder.status === "COMPLETED"
      ? "Photos are disabled for completed work orders."
      : workOrder.status === "CANCELLED"
        ? "Photos are disabled for cancelled work orders."
        : undefined;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section className="card" style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <strong aria-live="polite">{offlineRead ? cacheLabel(cachedAt) : online ? "Live" : "Offline"}</strong>
            <div className="muted">
              {conflictWrite
                ? "A queued change is paused for conflict resolution before later changes can sync."
                : queueMode
                  ? "Offline edits are stored on this device and sync automatically when the connection returns."
                  : writesDisabled
                    ? "Offline data is read-only until an authenticated queue partition is available."
                    : retryAt && queuedWrites > 0
                      ? "A temporary sync failure is being retried automatically."
                      : queuedWrites > 0
                        ? "Queued maintenance changes are waiting to sync."
                        : "This work order supports cached reads and queued structured edits offline."}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {queuedWrites > 0 ? (
              <span className="badge" data-testid="queued-write-count">
                {queuedWrites} queued
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => void syncQueue(true)}
              disabled={!online || syncing || queuedWrites === 0 || Boolean(conflictWrite)}
              style={buttonStyle}
            >
              {syncing ? "Syncing…" : "Sync queued changes"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading || busy || syncing || resolvingConflict}
              style={buttonStyle}
            >
              {loading ? "Refreshing…" : "Refresh work order"}
            </button>
          </div>
        </div>
      </section>

      {conflictWrite ? (
        <section className="card" data-testid="sync-conflict" style={{ display: "grid", gap: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>Sync conflict</h2>
            <p style={{ marginBottom: 0 }}>
              The server rejected this offline change. Your local change is still stored on this device; later queued changes are paused until you resolve this one.
            </p>
          </div>
          <div role="alert" style={{ display: "grid", gap: 4 }}>
            <strong>{conflictWrite.lastErrorCode ?? "SERVER_CONFLICT"}</strong>
            <span>{conflictWrite.lastError ?? "The server state changed before this queued update could be applied."}</span>
          </div>
          <div className="grid grid-2">
            <div style={{ display: "grid", gap: 6 }}>
              <h3 style={{ margin: 0 }}>Local queued change</h3>
              <strong>{queuedWriteSummary(conflictWrite)}</strong>
              <span className="muted">Queued {formatDate(conflictWrite.createdAt)}</span>
              {conflictWrite.conflictAt ? <span className="muted">Conflict detected {formatDate(conflictWrite.conflictAt)}</span> : null}
            </div>
            <div style={{ display: "grid", gap: 6 }} data-testid="server-conflict-version">
              <h3 style={{ margin: 0 }}>Current server version</h3>
              {serverConflictWorkOrder ? (
                <>
                  <strong>Status: {serverConflictWorkOrder.status}</strong>
                  <span>Labor: {serverConflictWorkOrder.laborMinutes ?? 0} min</span>
                  <span>Downtime: {serverConflictWorkOrder.downtimeMinutes ?? 0} min</span>
                  <span>Checklist: {serverConflictWorkOrder.checkItems.filter((item) => item.completed).length}/{serverConflictWorkOrder.checkItems.length} complete</span>
                  <span>Completion note: {serverConflictWorkOrder.completionNote?.trim() || "—"}</span>
                </>
              ) : (
                <span className="muted">Reconnect or refresh to load the current server version.</span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => void syncQueue(true)}
              disabled={!online || syncing || resolvingConflict}
              style={buttonStyle}
            >
              {syncing ? "Retrying…" : "Retry local change"}
            </button>
            <button
              type="button"
              onClick={keepConflict}
              disabled={resolvingConflict}
              style={buttonStyle}
            >
              Keep local change
            </button>
            <button
              type="button"
              onClick={() => void discardConflict()}
              disabled={resolvingConflict}
              style={buttonStyle}
            >
              {resolvingConflict ? "Discarding…" : "Discard local change and use server"}
            </button>
          </div>
        </section>
      ) : null}

      <section className="card" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>{workOrder.number} · {workOrder.title}</h2>
          <span className="badge">{workOrder.status}</span>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className="badge">{workOrder.priority}</span>
          <span className="badge">{workOrder.type}</span>
          {workOrder.asset ? <span className="badge">{workOrder.asset.code}</span> : null}
        </div>
        {workOrder.description ? <p style={{ margin: 0 }}>{workOrder.description}</p> : null}
        <div className="muted">
          {workOrder.asset ? `${workOrder.asset.name} · ` : ""}
          {workOrder.assignee?.displayName ?? workOrder.team?.name ?? "Assigned work"}
          {` · Due ${formatDate(workOrder.dueAt)}`}
        </div>
        <Link className="table-link" href={`/maintenance/${encodeURIComponent(workOrder.id)}`}>
          Open full work-order record →
        </Link>
      </section>

      {workOrder.status === "COMPLETED" ? (
        <section className="card" data-testid="completion-signature" style={{ display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0 }}>{completionSignature ? "Completion signature" : "Signature pending"}</h2>
          {completionSignature ? (
            <>
              <strong>Signed by {completionSignature.signedByName}</strong>
              <span>Typed signature: {completionSignature.capturedName}</span>
              <span>Signed {formatDate(completionSignature.signedAt)}</span>
              <span className="muted">Authenticated typed-name signature · {WORK_ORDER_COMPLETION_ATTESTATION}</span>
            </>
          ) : queuedWrites > 0 ? (
            <>
              <strong>{signatureName || signer?.displayName || "Technician"}</strong>
              <span className="muted">This signed completion is queued locally. The server identity and timestamp are added only after authenticated sync succeeds.</span>
            </>
          ) : (
            <span className="muted">No typed completion signature is available for this legacy completion record.</span>
          )}
        </section>
      ) : null}

      <section className="card" style={{ display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Work controls</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {(workOrder.status === "APPROVED" || workOrder.status === "PLANNED") ? (
            <button type="button" disabled={busy || writesDisabled} onClick={() => void transition("IN_PROGRESS")} style={buttonStyle}>
              {busy ? "Starting…" : queueMode ? "Queue start" : "Start work"}
            </button>
          ) : null}
          {workOrder.status === "IN_PROGRESS" ? (
            <>
              <button type="button" disabled={busy || writesDisabled} onClick={() => void transition("BLOCKED")} style={buttonStyle}>
                {queueMode ? "Queue block" : "Block work"}
              </button>
              <button type="button" disabled={busy || writesDisabled || !canComplete} onClick={() => void transition("COMPLETED")} style={buttonStyle}>
                {queueMode ? "Queue signed completion" : "Complete and sign"}
              </button>
            </>
          ) : null}
          {workOrder.status === "BLOCKED" ? (
            <button type="button" disabled={busy || writesDisabled} onClick={() => void transition("IN_PROGRESS")} style={buttonStyle}>
              {queueMode ? "Queue resume" : "Resume work"}
            </button>
          ) : null}
        </div>
        {conflictWrite ? <p className="muted">Work controls are paused until the queued conflict above is resolved.</p> : null}
        {workOrder.status === "REQUESTED" ? <p className="muted">Waiting for approval before work can start.</p> : null}
        {workOrder.status === "COMPLETED" ? <p className="muted">This work order is completed or queued for completion.</p> : null}
        {workOrder.status === "CANCELLED" ? <p className="muted">This work order is cancelled.</p> : null}
        {queueMode && !conflictWrite ? (
          <p className="muted">Status changes are queued in order and replayed after reconnection.</p>
        ) : workOrder.status === "IN_PROGRESS" && !canComplete ? (
          <p className="muted">Complete every checklist item, add a completion note, then type and attest your signature before closing.</p>
        ) : null}
      </section>

      {active ? (
        <section className="card" style={{ display: "grid", gap: 14 }}>
          <h2 style={{ margin: 0 }}>Execution</h2>
          <div className="grid grid-2">
            <label style={{ display: "grid", gap: 6 }}>
              <span>Labor minutes</span>
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={laborMinutes}
                disabled={writesDisabled}
                onChange={(event) => setLaborMinutes(event.target.value)}
                style={{ minHeight: 44, padding: 10 }}
              />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span>Downtime minutes</span>
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={downtimeMinutes}
                disabled={writesDisabled}
                onChange={(event) => setDowntimeMinutes(event.target.value)}
                style={{ minHeight: 44, padding: 10 }}
              />
            </label>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            <h3 style={{ margin: 0 }}>Checklist</h3>
            {checkItems.length ? checkItems.map((item) => (
              <div key={item.id} style={{ display: "grid", gap: 8, padding: "10px 0", borderBottom: "1px solid var(--border, #ddd)" }}>
                <label style={{ display: "flex", gap: 10, alignItems: "center", minHeight: 44 }}>
                  <input
                    type="checkbox"
                    checked={item.completed}
                    disabled={writesDisabled}
                    onChange={(event) => updateCheckItem(item.id, { completed: event.target.checked })}
                  />
                  <strong>{item.label}</strong>
                </label>
                <input
                  aria-label={`Note for ${item.label}`}
                  value={item.note ?? ""}
                  disabled={writesDisabled}
                  onChange={(event) => updateCheckItem(item.id, { note: event.target.value })}
                  placeholder="Optional checklist note"
                  style={{ minHeight: 44, padding: 10 }}
                />
              </div>
            )) : <p className="muted">No checklist configured.</p>}
          </div>

          <label style={{ display: "grid", gap: 6 }}>
            <span>Completion note</span>
            <textarea
              value={completionNote}
              disabled={writesDisabled}
              onChange={(event) => setCompletionNote(event.target.value)}
              rows={5}
              maxLength={5000}
              placeholder="Describe the work completed, findings, and remaining concerns."
              style={{ minHeight: 120, padding: 10 }}
            />
          </label>

          <div style={{ display: "grid", gap: 10, paddingTop: 6 }} data-testid="signature-capture">
            <h3 style={{ margin: 0 }}>Completion signature</h3>
            <p className="muted" style={{ margin: 0 }}>
              Authenticated signer: <strong>{signer?.displayName ?? "Loading identity…"}</strong>. Type your name manually; it must match this account.
            </p>
            <label style={{ display: "grid", gap: 6 }}>
              <span>Type your name to sign</span>
              <input
                value={signatureName}
                disabled={writesDisabled || !signer}
                onChange={(event) => setSignatureName(event.target.value)}
                autoComplete="off"
                maxLength={120}
                placeholder={signer?.displayName ?? "Your authenticated name"}
                style={{ minHeight: 44, padding: 10 }}
              />
            </label>
            {signatureName && !signatureMatches ? (
              <p role="status" style={{ margin: 0 }}>Typed signature must match {signer?.displayName}.</p>
            ) : null}
            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", minHeight: 44 }}>
              <input
                type="checkbox"
                checked={signatureAttested}
                disabled={writesDisabled || !signatureMatches}
                onChange={(event) => setSignatureAttested(event.target.checked)}
              />
              <span>{WORK_ORDER_COMPLETION_ATTESTATION}</span>
            </label>
            <p className="muted" style={{ margin: 0 }}>
              {queueMode
                ? "Offline: the signed intent remains local until replay. The authenticated server identity and timestamp are recorded only after sync succeeds."
                : "The server binds this signature to your authenticated account and records the authoritative signing time in the audit trail."}
            </p>
          </div>

          <button type="button" disabled={busy || writesDisabled} onClick={() => void save()} style={buttonStyle}>
            {busy ? "Saving…" : queueMode ? "Queue progress" : "Save progress"}
          </button>
        </section>
      ) : null}

      <section className="card">
        <h2>Photo evidence</h2>
        <WorkOrderCameraAttachments
          organizationId={organizationId}
          siteId={siteId}
          workOrderId={workOrder.id}
          disabled={cameraDisabled}
          disabledReason={cameraDisabledReason}
        />
      </section>

      {message ? <p aria-live="polite" className="card">{message}</p> : null}
      {error ? <p role="alert" className="card">{error}</p> : null}
    </div>
  );
}
