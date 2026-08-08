"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type BacklogPayload = {
  generatedAt: string;
  empty: boolean;
  totalOpen: number;
  overdue: number;
  unplanned: number;
  urgent: number;
  status: {
    REQUESTED: number;
    APPROVED: number;
    PLANNED: number;
    IN_PROGRESS: number;
    BLOCKED: number;
  };
  aging: {
    DAYS_0_6: number;
    DAYS_7_29: number;
    DAYS_30_89: number;
    DAYS_90_PLUS: number;
  };
  oldest: Array<{
    id: string;
    number: string;
    title: string;
    status: string;
    priority: string;
    requestedAt: string;
    dueAt: string | null;
    asset: { code: string; name: string } | null;
  }>;
};

type ApiResponse = { data?: BacklogPayload; error?: { message?: string } };

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

export default function BacklogClient({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const [payload, setPayload] = useState<BacklogPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!organizationId || !siteId) return;
    const params = new URLSearchParams({ organizationId, siteId });
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/analytics/backlog?${params.toString()}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "Unable to load backlog analytics");
      }
      setPayload(body.data);
    } catch (loadError) {
      setPayload(null);
      setError(loadError instanceof Error ? loadError.message : "Unable to load backlog analytics");
    } finally {
      setLoading(false);
    }
  }, [organizationId, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!organizationId || !siteId) {
    return <section className="card"><p>Select an organization and site to view backlog analytics.</p></section>;
  }

  return (
    <>
      <section className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <strong>Backlog health</strong>
            <div className="muted">Open work only. Completed and cancelled work orders are excluded.</div>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {payload ? <div className="muted" style={{ marginTop: 8 }}>Generated {new Date(payload.generatedAt).toLocaleString()}</div> : null}
      </section>

      {error ? <section className="card" role="alert">{error}</section> : null}
      {payload?.empty ? (
        <section className="card" role="status">
          No open work orders in the selected site. Backlog KPIs are zero rather than undefined.
        </section>
      ) : null}

      {payload ? (
        <>
          <div className="grid grid-4">
            <section className="card"><div className="muted">Open backlog</div><div className="title">{payload.totalOpen}</div></section>
            <section className="card"><div className="muted">Overdue</div><div className="title">{payload.overdue}</div></section>
            <section className="card"><div className="muted">Unplanned</div><div className="title">{payload.unplanned}</div></section>
            <section className="card"><div className="muted">Urgent</div><div className="title">{payload.urgent}</div></section>
          </div>

          <div className="grid grid-2 section">
            <section className="card responsive-table">
              <h2>Workflow status</h2>
              <table className="table">
                <thead><tr><th>Status</th><th>Count</th></tr></thead>
                <tbody>
                  {Object.entries(payload.status).map(([status, count]) => (
                    <tr key={status}><td>{status.replaceAll("_", " ")}</td><td>{count}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="card responsive-table">
              <h2>Backlog age</h2>
              <table className="table">
                <thead><tr><th>Age</th><th>Count</th></tr></thead>
                <tbody>
                  <tr><td>0–6 days</td><td>{payload.aging.DAYS_0_6}</td></tr>
                  <tr><td>7–29 days</td><td>{payload.aging.DAYS_7_29}</td></tr>
                  <tr><td>30–89 days</td><td>{payload.aging.DAYS_30_89}</td></tr>
                  <tr><td>90+ days</td><td>{payload.aging.DAYS_90_PLUS}</td></tr>
                </tbody>
              </table>
            </section>
          </div>

          <section className="card responsive-table section">
            <h2>Oldest open work</h2>
            {payload.oldest.length ? (
              <table className="table">
                <thead>
                  <tr><th>Work order</th><th>Asset</th><th>Status</th><th>Priority</th><th>Requested</th><th>Due</th></tr>
                </thead>
                <tbody>
                  {payload.oldest.map((workOrder) => (
                    <tr key={workOrder.id}>
                      <td><Link className="table-link" href={`/maintenance/${workOrder.id}`}>{workOrder.number} · {workOrder.title}</Link></td>
                      <td>{workOrder.asset?.code ?? "—"}</td>
                      <td>{workOrder.status}</td>
                      <td>{workOrder.priority}</td>
                      <td>{formatDate(workOrder.requestedAt)}</td>
                      <td>{formatDate(workOrder.dueAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted">No open work orders.</p>}
          </section>
        </>
      ) : null}
    </>
  );
}
