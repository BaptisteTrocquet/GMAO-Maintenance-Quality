"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import DashboardKpiCards from "./dashboard-kpi-cards";

type DashboardData = {
  metrics: {
    openWork: number;
    blockedWork: number;
    overdueWork: number;
    dueSoonWork: number;
    urgentWork: number;
    pendingApprovals: number;
  };
  workOrders: Array<{
    id: string;
    number: string;
    title: string;
    status: string;
    priority: string;
    plannedStart: string | null;
    dueAt: string | null;
    asset: { code: string } | null;
    team: { name: string } | null;
  }>;
  approvals: Array<{
    id: string;
    documentId: string;
    code: string;
    title: string;
    revision: string;
  }>;
};

type DashboardResponse = {
  data?: DashboardData;
  error?: { message?: string };
};

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function PersonalDashboardClient({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!organizationId || !siteId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const params = new URLSearchParams({ organizationId, siteId });
    setLoading(true);
    setError(null);
    void fetch(`/api/dashboard/personal?${params.toString()}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const body = (await response.json()) as DashboardResponse;
        if (!response.ok) throw new Error(body.error?.message ?? "Dashboard failed to load");
        setData(body.data ?? null);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setData(null);
        setError(fetchError instanceof Error ? fetchError.message : "Dashboard failed to load");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [organizationId, siteId]);

  if (!organizationId || !siteId) {
    return <section className="card"><p>Select an organization and site to view your dashboard.</p></section>;
  }
  if (loading && !data) return <section className="card" role="status">Loading your dashboard…</section>;
  if (error) return <section className="card" role="alert">{error}</section>;
  if (!data) return null;

  return (
    <>
      <DashboardKpiCards
        organizationId={organizationId}
        siteId={siteId}
        metrics={data.metrics}
      />

      <div className="grid grid-2 section">
        <section className="card responsive-table">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <h2 style={{ marginTop: 0 }}>My work</h2>
            <Link className="table-link" href="/maintenance/kanban">Open Kanban</Link>
          </div>
          {data.workOrders.length ? (
            <table className="table">
              <thead><tr><th>WO</th><th>Status</th><th>Priority</th><th>Due</th></tr></thead>
              <tbody>
                {data.workOrders.map((workOrder) => (
                  <tr key={workOrder.id}>
                    <td>
                      <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                        {workOrder.number} · {workOrder.title}
                      </Link>
                      <div className="muted">{workOrder.asset?.code ?? "No asset"}{workOrder.team?.name ? ` · ${workOrder.team.name}` : ""}</div>
                    </td>
                    <td><span className="badge">{workOrder.status}</span></td>
                    <td>{workOrder.priority}</td>
                    <td>{formatDate(workOrder.dueAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">No open work is assigned to you or your teams.</p>}
        </section>

        <section className="card">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
            <h2 style={{ marginTop: 0 }}>My document approvals</h2>
            <Link className="table-link" href="/documents">Documents</Link>
          </div>
          {data.approvals.length ? (
            <div className="stack-list">
              {data.approvals.map((approval) => (
                <div key={approval.id}>
                  <Link className="table-link" href={`/documents/${approval.documentId}`}>
                    <strong>{approval.code}</strong> · {approval.title}
                  </Link>
                  <div className="muted">Revision {approval.revision} · awaiting your approval</div>
                </div>
              ))}
            </div>
          ) : <p className="muted">No document approvals are waiting for you.</p>}
        </section>
      </div>
    </>
  );
}
