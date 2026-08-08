"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import WorkOrderCameraAttachments from "@/app/maintenance/[workOrderId]/work-order-camera-attachments";

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
const OFFLINE_SOURCE_HEADER = "x-opengmao-offline-source";
const OFFLINE_CACHED_AT_HEADER = "x-opengmao-offline-cached-at";
const PARTITION_PATTERN = /^[a-f0-9]{32}$/;

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

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ organizationId, siteId });
    try {
      const response = await fetch(
        `/api/work-orders/technician/${encodeURIComponent(workOrderId)}?${query.toString()}`,
        {
          cache: "no-store",
          headers: cachePartition ? { [OFFLINE_PARTITION_HEADER]: cachePartition } : undefined,
        },
      );
      const body = (await response.json()) as ApiResponse<{ workOrder: TechnicianWorkOrderData }>;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load technician work order");
      }

      const confirmedPartition = response.headers.get(OFFLINE_PARTITION_HEADER) ?? "";
      if (PARTITION_PATTERN.test(confirmedPartition) && confirmedPartition !== cachePartition) {
        setCachePartition(confirmedPartition);
      }

      const next = body.data.workOrder;
      setWorkOrder(next);
      setLaborMinutes(String(next.laborMinutes ?? 0));
      setDowntimeMinutes(String(next.downtimeMinutes ?? 0));
      setCompletionNote(next.completionNote ?? "");
      setCheckItems(next.checkItems);
      const fromCache = response.headers.get(OFFLINE_SOURCE_HEADER) === "cache";
      setOfflineRead(fromCache);
      setCachedAt(fromCache ? response.headers.get(OFFLINE_CACHED_AT_HEADER) ?? "" : "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load technician work order");
    } finally {
      setLoading(false);
    }
  }, [cachePartition, organizationId, siteId, workOrderId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const writesDisabled = !online || offlineRead;

  async function saveExecution(showSuccess = true) {
    if (writesDisabled || !workOrder || !["IN_PROGRESS", "BLOCKED"].includes(workOrder.status)) return false;
    try {
      await patchJson(`/api/work-orders/${encodeURIComponent(workOrder.id)}/execution`, {
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
      });
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
      if (saved) await load();
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
  const cameraDisabled = writesDisabled || workOrder.status === "CANCELLED" || workOrder.status === "COMPLETED";
  const cameraDisabledReason = writesDisabled
    ? "Photo uploads require a network connection. Offline write queuing is not enabled yet."
    : workOrder.status === "COMPLETED"
      ? "Photos are disabled for completed work orders."
      : workOrder.status === "CANCELLED"
        ? "Photos are disabled for cancelled work orders."
        : undefined;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section className="card" style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <strong aria-live="polite">{offlineRead ? cacheLabel(cachedAt) : online ? "Live" : "Offline"}</strong>
          <div className="muted">
            {writesDisabled
              ? "Read-only mode. Reconnect and refresh before recording maintenance work."
              : cachePartition
                ? "This work order is cached after successful online reads."
                : "Offline cache is armed after the first authenticated online read."}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || busy}
          style={buttonStyle}
        >
          {loading ? "Refreshing…" : "Refresh work order"}
        </button>
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
              {busy ? "Starting…" : "Start work"}
            </button>
          ) : null}
          {workOrder.status === "IN_PROGRESS" ? (
            <>
              <button type="button" disabled={busy || writesDisabled} onClick={() => void transition("BLOCKED")} style={buttonStyle}>
                Block work
              </button>
              <button type="button" disabled={busy || writesDisabled || !canComplete} onClick={() => void transition("COMPLETED")} style={buttonStyle}>
                Complete work
              </button>
            </>
          ) : null}
          {workOrder.status === "BLOCKED" ? (
            <button type="button" disabled={busy || writesDisabled} onClick={() => void transition("IN_PROGRESS")} style={buttonStyle}>
              Resume work
            </button>
          ) : null}
        </div>
        {workOrder.status === "REQUESTED" ? <p className="muted">Waiting for approval before work can start.</p> : null}
        {workOrder.status === "COMPLETED" ? <p className="muted">This work order is completed.</p> : null}
        {workOrder.status === "CANCELLED" ? <p className="muted">This work order is cancelled.</p> : null}
        {writesDisabled ? (
          <p className="muted">Offline read cache is active. Status changes are intentionally disabled.</p>
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
            {busy ? "Saving…" : "Save progress"}
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
