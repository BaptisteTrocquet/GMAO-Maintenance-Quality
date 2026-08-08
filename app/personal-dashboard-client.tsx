"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type DashboardWorkOrder = {
  id: string;
  number: string;
  title: string;
  status: string;
  priority: string;
  plannedStart: string | null;
  dueAt: string | null;
  requestedAt: string;
  asset: { code: string; name: string } | null;
  assignee: { id: string; displayName: string } | null;
  team: { id: string; name: string } | null;
};

type DashboardData = {
  site: { id: string; code: string; name: string };
  dashboard: {
    teamCount: number;
    openCount: number;
    overdueCount: number;
    dueSoonCount: number;
    unscheduledCount: number;
    workOrders: DashboardWorkOrder[];
  };
};

type ResponseBody = {
  data?: DashboardData;
  error?: { message?: string };
};

function dateLabel(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));
}

export default function PersonalDashboardClient({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ organizationId, siteId });
    const response = await fetch(`/api/dashboard/personal?${query.toString()}`, { signal });
    const body = (await response.json()) as ResponseBody;
    if (!response.ok) throw new Error(body.error?.message ?? "Dashboard could not be loaded");
    setData(body.data ?? null);
  }, [organizationId, siteId]);

  useEffect(() => {
    if (!organizationId || !siteId) {
      setData(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void load(controller.signal)
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Dashboard could not be loaded");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, organizationId, siteId]);

  if (!organizationId || !siteId) {
    return <section className="card"><p>Select an organization and site to load your dashboard.</p></section>;
  }
  if (loading && !data) return <section className="card muted">Loading your dashboard…</section>;
  if (error) return <section className="card" role="alert">{error}</section>;
  if (!data) return <section className="card muted">No dashboard data is available.</section>;

  const dashboard = data.dashboard;
  return (
    <>
      <div className="header asset-header">
        <div>
          <div className="title">My dashboard</div>
          <div className="muted">{data.site.code} · {data.site.name} · work assigned to you or your teams</div>
        </div>
        <div className="asset-status">
          <span className="badge">{dashboard.teamCount} teams</span>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setError(null);
              void load()
                .catch((loadError: unknown) => {
                  setError(loadError instanceof Error ? loadError.message : "Dashboard could not be loaded");
                })
                .finally(() => setLoading(false));
            }}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="grid grid-4">
        <Link className="card" href="/maintenance/kanban" style={{ textDecoration: "none" }}>
          <div className="muted">My open work</div>
          <div className="metric">{dashboard.openCount}</div>
        </Link>
        <Link className="card" href="/maintenance/kanban?due=OVERDUE" style={{ textDecoration: "none" }}>
          <div className="muted">Overdue</div>
          <div className="metric">{dashboard.overdueCount}</div>
        </Link>
        <Link className="card" href="/maintenance/kanban?due=DUE_7_DAYS" style={{ textDecoration: "none" }}>
          <div className="muted">Due next 7 days</div>
          <div className="metric">{dashboard.dueSoonCount}</div>
        </Link>
        <Link className="card" href="/maintenance/calendar" style={{ textDecoration: "none" }}>
          <div className="muted">Unscheduled</div>
          <div className="metric">{dashboard.unscheduledCount}</div>
        </Link>
      </div>

      <section className="section card responsive-table">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 style={{ marginTop: 0 }}>My current work</h2>
            <div className="muted">Nearest due work assigned directly to you or one of your maintenance teams.</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link className="table-link" href="/maintenance/kanban">Open Kanban</Link>
            <Link className="table-link" href="/maintenance/calendar">Open Calendar</Link>
            <Link className="table-link" href="/search">Search</Link>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>WO</th>
              <th>Asset</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Owner</th>
              <th>Planned</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            {dashboard.workOrders.map((workOrder) => (
              <tr key={workOrder.id}>
                <td><Link className="table-link" href={`/maintenance/${workOrder.id}`}>{workOrder.number} · {workOrder.title}</Link></td>
                <td>{workOrder.asset?.code ?? "—"}</td>
                <td><span className="badge">{workOrder.status}</span></td>
                <td>{workOrder.priority}</td>
                <td>{workOrder.assignee?.displayName ?? workOrder.team?.name ?? "Unassigned"}</td>
                <td>{dateLabel(workOrder.plannedStart)}</td>
                <td>{dateLabel(workOrder.dueAt)}</td>
              </tr>
            ))}
            {dashboard.workOrders.length === 0 ? (
              <tr><td colSpan={7}>No open work is assigned to you or your teams.</td></tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
