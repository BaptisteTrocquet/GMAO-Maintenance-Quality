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
  enqueueTechnicianWrite,
  flushTechnicianWrites,
  isTechnicianQueuePartition,
  listTechnicianWrites,
  projectTechnicianWrites,
} from "@/lib/pwa/technician-write-queue-client";

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
  const [laborMinutes, setLaborMinutes] = useState("0");
  const [downtimeMinutes, setDowntimeMinutes] = useState("0");
  const [completionNote, setCompletionNote] = useState("");
  const [checkItems, setCheckItems] = useState<CheckItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const [queuedWrites, setQueuedWrites] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [offlineRead, setOfflineRead] = useState(false);
  const [cachedAt, setCachedAt] = useState("");
  const [online, setOnline] = useState(true);
  const [cachePartition, setCachePartition] = useState(offlinePartition);

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

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ organizationId, siteId });
    const endpoint = `/api/work-orders/technician/${encodeURIComponent(workOrderId)}?${query.toString()}`;
    try {
      const response = await fetchTechnicianRead(endpoint, cachePartition);
      const body = (await response.json()) as ApiResponse<{ workOrder: TechnicianWorkOrderData }>;
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

      let next = body.data.workOrder;
      if (isTechnicianQueuePartition(activePartition)) {
        const queued = await listTechnicianWrites(activePartition);
        setQueuedWrites(queued.length);
        next = projectTechnicianWrites(next, queued) as TechnicianWorkOrderData;
      } else {
        setQueuedWrites(0);
      }
      applyWorkOrder(next);

      const fromCache = response.headers.get(OFFLINE_SOURCE_HEADER) === "cache";
      setOfflineRead(fromCache);
      setCachedAt(fromCache ? response.headers.get(OFFLINE_CACHED_AT_HEADER) ?? "" : "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load technician work order");
    } finally {
      setLoading(false);
    }
  }, [applyWorkOrder, cachePartition, organizationId, siteId, workOrderId]);

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

  const syncQueue = useCallback(async () => {
    if (!online || !isTechnicianQueuePartition(cachePartition) || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setError("");
    try {
      const result = await flushTechnicianWrites(cachePartition);
      setQueuedWrites(result.remaining);
      if (result.blocked) {
        setError(`Queued change needs attention: ${result.message ?? "server rejected the change"}`);
        return;
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
  }, [cachePartition, load, online]);

  useEffect(() => {
    if (!online || !isTechnicianQueuePartition(cachePartition)) return;
    void (async () => {
      const count = await refreshQueueCount();
      if (count > 0) void syncQueue();
    })();
  }, [cachePartition, online, refreshQueueCount, syncQueue]);

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
  const writesDisabled = (!online || offlineRead) && !queueAvailable;

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
          body: { organizationId, siteId, status },
        });
        await refreshQueueCount();
        setWorkOrder((current) => current ? { ...current, status } : current);
        setMessage(
          status === "COMPLETED"
            ? "Completion queued. It will sync after reconnection."
            : `Status ${status} queued for sync after reconnection.`,
        );
        return;
      }

      if (status === "COMPLETED") {
        const saved = await saveExecution(false);
        if (!saved) return;
      }
      await patchJson(`/api/work-orders/${encodeURIComponent(workOrder.id)}`, {
        organizationId,
        siteId,
        status,
      });
      setMessage(
        status === "IN_PROGRESS"
          ? workOrder.status === "BLOCKED" ? "Work resumed." : "Work started."
          : status === "BLOCKED"
            ? "Work order blocked."
            : status === "COMPLETED"
              ? "Work order completed."
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
  const canComplete = workOrder.status === "IN_PROGRESS" && allChecklistComplete && completionNote.trim().length > 0;
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
              {queueMode
                ? "Offline edits are stored on this device and sync automatically when the connection returns."
                : writesDisabled
                  ? "Offline data is read-only until an authenticated queue partition is available."
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
              onClick={() => void syncQueue()}
              disabled={!online || syncing || queuedWrites === 0}
              style={buttonStyle}
            >
              {syncing ? "Syncing…" : "Sync queued changes"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading || busy || syncing}
              style={buttonStyle}
            >
              {loading ? "Refreshing…" : "Refresh work order"}
            </button>
          </div>
        </div>
      </section>

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
                {queueMode ? "Queue completion" : "Complete work"}
              </button>
            </>
          ) : null}
          {workOrder.status === "BLOCKED" ? (
            <button type="button" disabled={busy || writesDisabled} onClick={() => void transition("IN_PROGRESS")} style={buttonStyle}>
              {queueMode ? "Queue resume" : "Resume work"}
            </button>
          ) : null}
        </div>
        {workOrder.status === "REQUESTED" ? <p className="muted">Waiting for approval before work can start.</p> : null}
        {workOrder.status === "COMPLETED" ? <p className="muted">This work order is completed or queued for completion.</p> : null}
        {workOrder.status === "CANCELLED" ? <p className="muted">This work order is cancelled.</p> : null}
        {queueMode ? (
          <p className="muted">Status changes are queued in order and replayed after reconnection.</p>
        ) : workOrder.status === "IN_PROGRESS" && !canComplete ? (
          <p className="muted">Complete every checklist item and add a completion note before closing.</p>
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
