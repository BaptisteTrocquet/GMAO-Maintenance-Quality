"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

type WorkItem = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  plannedStart: string | null;
  dueAt: string | null;
  assetCode: string | null;
  teamName: string | null;
  ownership: "ASSIGNED" | "TEAM";
  overdue: boolean;
  dueSoon: boolean;
};

type Reminder = {
  id: string;
  title: string;
  assetCode: string | null;
  dueAt: string;
  remindAt: string;
  workOrder: { id: string; number: string };
};

type DashboardPayload = {
  workOrders: WorkItem[];
  reminders: Reminder[];
  counts: {
    active: number;
    overdue: number;
    dueSoon: number;
    blocked: number;
    inProgress: number;
    reminders: number;
  };
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function MyWorkClient({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = useMemo(
    () => `/api/me/dashboard?organizationId=${encodeURIComponent(organizationId)}&siteId=${encodeURIComponent(siteId)}`,
    [organizationId, siteId],
  );

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const body = (await response.json()) as { data?: DashboardPayload; error?: { message?: string } };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load personal dashboard");
      }
      setData(body.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load personal dashboard");
    } finally {
      setBusy(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <section className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <strong>My operational workload</strong>
            <div className="muted">Direct assignments plus unassigned work from your maintenance teams.</div>
          </div>
          <button type="button" onClick={() => void load()} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {data ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <span className="badge">{data.counts.active} active</span>
            <span className="badge">{data.counts.overdue} overdue</span>
            <span className="badge">{data.counts.dueSoon} due 7d</span>
            <span className="badge">{data.counts.blocked} blocked</span>
            <span className="badge">{data.counts.inProgress} in progress</span>
            <span className="badge">{data.counts.reminders} reminders</span>
          </div>
        ) : null}
      </section>

      {error ? <section className="card" role="alert">{error}</section> : null}

      <div className="grid grid-2">
        <section className="card">
          <h2>My work orders</h2>
          {data?.workOrders.length ? (
            <div className="stack-list">
              {data.workOrders.map((workOrder) => (
                <article key={workOrder.id} style={{ display: "grid", gap: 5 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                      <strong>{workOrder.number}</strong> · {workOrder.title}
                    </Link>
                    <span className="badge">{workOrder.priority}</span>
                  </div>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    <span className="badge">{workOrder.status}</span>
                    <span className="badge">{workOrder.ownership === "ASSIGNED" ? "DIRECT" : "TEAM"}</span>
                    {workOrder.overdue ? <span className="badge">OVERDUE</span> : null}
                    {workOrder.dueSoon ? <span className="badge">DUE 7D</span> : null}
                  </div>
                  <div className="muted">
                    {workOrder.assetCode ?? "No asset"} · Due {formatDate(workOrder.dueAt)}
                    {workOrder.teamName ? ` · ${workOrder.teamName}` : ""}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted">No active work assigned to you or your teams.</p>
          )}
        </section>

        <section className="card">
          <h2>My preventive reminders</h2>
          {data?.reminders.length ? (
            <div className="stack-list">
              {data.reminders.map((reminder) => (
                <article key={reminder.id}>
                  <Link className="table-link" href={`/maintenance/${reminder.workOrder.id}`}>
                    <strong>{reminder.title}</strong>
                  </Link>
                  <div className="muted">
                    {reminder.assetCode ? `${reminder.assetCode} · ` : ""}Due {formatDate(reminder.dueAt)}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted">No active preventive reminders for your current workload.</p>
          )}
        </section>
      </div>
    </>
  );
}
