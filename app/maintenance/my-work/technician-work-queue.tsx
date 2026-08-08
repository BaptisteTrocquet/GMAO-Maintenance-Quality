"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchTechnicianRead,
  isOfflineReadPartition,
  OFFLINE_CACHED_AT_HEADER,
  OFFLINE_SOURCE_HEADER,
} from "@/lib/pwa/technician-read-cache-client";

type QueueWorkOrder = {
  id: string;
  number: string;
  title: string;
  description: string | null;
  status: "REQUESTED" | "APPROVED" | "PLANNED" | "IN_PROGRESS" | "BLOCKED";
  priority: string;
  type: string;
  plannedStart: string | null;
  dueAt: string | null;
  startedAt: string | null;
  updatedAt: string;
  asset: { id: string; code: string; name: string } | null;
  assignee: { id: string; displayName: string } | null;
  team: { id: string; name: string } | null;
  _count: { checkItems: number; attachments: number };
};

type QueueResponse = {
  data?: { workOrders: QueueWorkOrder[] };
  error?: { message?: string };
};

const OFFLINE_PARTITION_HEADER = "x-opengmao-offline-partition";

const statusRank: Record<QueueWorkOrder["status"], number> = {
  IN_PROGRESS: 0,
  BLOCKED: 1,
  PLANNED: 2,
  APPROVED: 3,
  REQUESTED: 4,
};

function formatDate(value: string | null) {
  if (!value) return "No due date";
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

export default function TechnicianWorkQueue({
  organizationId,
  siteId,
  offlinePartition,
}: {
  organizationId: string;
  siteId: string;
  offlinePartition: string;
}) {
  const [workOrders, setWorkOrders] = useState<QueueWorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
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
    const endpoint = `/api/work-orders/technician?${query.toString()}`;
    try {
      const response = await fetchTechnicianRead(endpoint, cachePartition);
      const body = (await response.json()) as QueueResponse;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load assigned work orders");
      }
      setWorkOrders(body.data.workOrders);

      const confirmedPartition = response.headers.get(OFFLINE_PARTITION_HEADER) ?? "";
      if (isOfflineReadPartition(confirmedPartition) && confirmedPartition !== cachePartition) {
        setCachePartition(confirmedPartition);
      }

      const fromCache = response.headers.get(OFFLINE_SOURCE_HEADER) === "cache";
      setOfflineRead(fromCache);
      setCachedAt(fromCache ? response.headers.get(OFFLINE_CACHED_AT_HEADER) ?? "" : "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load assigned work orders");
    } finally {
      setLoading(false);
    }
  }, [cachePartition, organizationId, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  const ordered = useMemo(
    () => [...workOrders].sort((a, b) => statusRank[a.status] - statusRank[b.status]),
    [workOrders],
  );

  if (loading && !ordered.length) {
    return <section className="card"><p aria-live="polite">Loading assigned work…</p></section>;
  }
  if (error && !ordered.length) {
    return <section className="card"><p role="alert">{error}</p></section>;
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <section className="card" style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <strong aria-live="polite">{offlineRead ? cacheLabel(cachedAt) : online ? "Live" : "Offline"}</strong>
          <div className="muted">
            {offlineRead
              ? "Read-only cached data. Reconnect before changing work orders."
              : cachePartition
                ? "Assigned work is cached after a successful online refresh."
                : "Offline cache is armed after the first authenticated online read."}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          style={{ minHeight: 44, padding: "10px 14px", borderRadius: 9, cursor: "pointer" }}
        >
          {loading ? "Refreshing…" : "Refresh assigned work"}
        </button>
      </section>

      {error ? <p role="alert" className="card">{error}</p> : null}

      {!ordered.length ? (
        <section className="card">
          <h2>No assigned work</h2>
          <p className="muted">There are no open work orders assigned directly to you or your teams at this site.</p>
        </section>
      ) : (
        <>
          <div className="muted" aria-live="polite">{ordered.length} assigned open work order{ordered.length === 1 ? "" : "s"}</div>
          {ordered.map((workOrder) => (
            <Link
              key={workOrder.id}
              href={`/maintenance/my-work/${encodeURIComponent(workOrder.id)}`}
              className="card"
              style={{ display: "grid", gap: 10, minHeight: 44, textDecoration: "none", color: "inherit" }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                <strong>{workOrder.number} · {workOrder.title}</strong>
                <span className="badge">{workOrder.status}</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span className="badge">{workOrder.priority}</span>
                <span className="badge">{workOrder.type}</span>
                {workOrder.asset ? <span className="badge">{workOrder.asset.code}</span> : null}
              </div>
              <div className="muted">
                {workOrder.status === "IN_PROGRESS" && workOrder.startedAt
                  ? `Started ${formatDate(workOrder.startedAt)}`
                  : `Due ${formatDate(workOrder.dueAt)}`}
                {` · ${workOrder._count.checkItems} checklist · ${workOrder._count.attachments} attachments`}
              </div>
              <div className="muted">{workOrder.assignee?.displayName ?? workOrder.team?.name ?? "Team assignment"}</div>
            </Link>
          ))}
        </>
      )}
    </div>
  );
}
