"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

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

export default function TechnicianWorkQueue({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const [workOrders, setWorkOrders] = useState<QueueWorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      const query = new URLSearchParams({ organizationId, siteId });
      try {
        const response = await fetch(`/api/work-orders/technician?${query.toString()}`, {
          cache: "no-store",
        });
        const body = (await response.json()) as QueueResponse;
        if (!response.ok || !body.data) {
          throw new Error(body.error?.message ?? "Unable to load assigned work orders");
        }
        if (!cancelled) setWorkOrders(body.data.workOrders);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Unable to load assigned work orders");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [organizationId, siteId]);

  const ordered = useMemo(
    () => [...workOrders].sort((a, b) => statusRank[a.status] - statusRank[b.status]),
    [workOrders],
  );

  if (loading) {
    return <section className="card"><p aria-live="polite">Loading assigned work…</p></section>;
  }
  if (error) {
    return <section className="card"><p role="alert">{error}</p></section>;
  }
  if (!ordered.length) {
    return (
      <section className="card">
        <h2>No assigned work</h2>
        <p className="muted">There are no open work orders assigned directly to you or your teams at this site.</p>
      </section>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
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
    </div>
  );
}
