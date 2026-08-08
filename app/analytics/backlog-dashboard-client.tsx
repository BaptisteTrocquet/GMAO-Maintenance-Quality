"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type Filters = {
  fromDate: string;
  toDate: string;
  assetId: string;
};

type BacklogData = {
  range: {
    fromDate: string | null;
    toDate: string | null;
    semantics: string;
    timezone: string;
  };
  asOf: string;
  metrics: {
    total: number;
    overdue: number;
    urgent: number;
    unassigned: number;
  };
  byStatus: Record<string, number | undefined>;
  ageBuckets: {
    days0To7: number;
    days8To30: number;
    days31To90: number;
    over90Days: number;
  };
  oldest: Array<{
    id: string;
    number: string;
    title: string;
    status: string;
    priority: string;
    requestedAt: string;
    dueAt: string | null;
    asset: { id: string; code: string; name: string } | null;
    assignee: { displayName: string } | null;
    team: { name: string } | null;
  }>;
  detailLimit: number;
  detailTruncated: boolean;
};

type ApiResponse<T> = {
  data?: T;
  error?: { message?: string };
};

type AssetOption = {
  id: string;
  code: string;
  name: string;
  archivedAt: string | null;
};

const EMPTY_FILTERS: Filters = { fromDate: "", toDate: "", assetId: "" };

function analyticsParams(organizationId: string, siteId: string, filters: Filters) {
  const params = new URLSearchParams({ organizationId, siteId });
  if (filters.fromDate) params.set("fromDate", filters.fromDate);
  if (filters.toDate) params.set("toDate", filters.toDate);
  if (filters.assetId) params.set("assetId", filters.assetId);
  return params;
}

async function fetchBacklog(
  organizationId: string,
  siteId: string,
  filters: Filters,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `/api/analytics/backlog?${analyticsParams(organizationId, siteId, filters).toString()}`,
    { cache: "no-store", signal },
  );
  const body = (await response.json()) as ApiResponse<BacklogData>;
  if (!response.ok) throw new Error(body.error?.message ?? "Backlog analytics failed to load");
  if (!body.data) throw new Error("Backlog analytics returned no data");
  return body.data;
}

function formatUtc(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toISOString().replace("T", " ").slice(0, 16);
}

export default function BacklogDashboardClient({
  organizationId,
  siteId,
}: {
  organizationId: string;
  siteId: string;
}) {
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [data, setData] = useState<BacklogData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setAssets([]);
    setData(null);
    setError(null);

    if (!organizationId || !siteId) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    void Promise.all([
      fetchBacklog(organizationId, siteId, EMPTY_FILTERS, controller.signal),
      fetch(
        `/api/assets?${new URLSearchParams({ organizationId, siteId, includeArchived: "true" }).toString()}`,
        { cache: "no-store", signal: controller.signal },
      )
        .then(async (response) => {
          if (!response.ok) return [] as AssetOption[];
          const body = (await response.json()) as ApiResponse<AssetOption[]>;
          return body.data ?? [];
        })
        .catch((assetError: unknown) => {
          if (assetError instanceof DOMException && assetError.name === "AbortError") throw assetError;
          return [] as AssetOption[];
        }),
    ])
      .then(([backlog, assetOptions]) => {
        setData(backlog);
        setAssets(assetOptions);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") return;
        setError(fetchError instanceof Error ? fetchError.message : "Backlog analytics failed to load");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [organizationId, siteId]);

  async function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const next = await fetchBacklog(organizationId, siteId, draft);
      setApplied(draft);
      setData(next);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Backlog analytics failed to load");
    } finally {
      setLoading(false);
    }
  }

  if (!organizationId || !siteId) {
    return <section className="card">Select an organization and site to view analytics.</section>;
  }

  const csvParams = analyticsParams(organizationId, siteId, applied);
  csvParams.set("format", "csv");

  return (
    <>
      <section className="card">
        <form onSubmit={applyFilters} className="grid grid-2">
          <label>
            <span className="muted">Requested from (UTC)</span>
            <input
              type="date"
              value={draft.fromDate}
              onChange={(event) => setDraft((current) => ({ ...current, fromDate: event.target.value }))}
            />
          </label>
          <label>
            <span className="muted">Requested to (UTC)</span>
            <input
              type="date"
              value={draft.toDate}
              onChange={(event) => setDraft((current) => ({ ...current, toDate: event.target.value }))}
            />
          </label>
          <label>
            <span className="muted">Asset</span>
            <select
              value={draft.assetId}
              onChange={(event) => setDraft((current) => ({ ...current, assetId: event.target.value }))}
            >
              <option value="">All assets</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.code} · {asset.name}{asset.archivedAt ? " (archived)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div>
            <span className="muted">Scope</span>
            <div>Selected site</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="button" type="submit" disabled={loading}>Apply filters</button>
            <button
              className="button"
              type="button"
              disabled={loading}
              onClick={() => setDraft(EMPTY_FILTERS)}
            >
              Clear fields
            </button>
            <a className="button" href={`/api/analytics/backlog?${csvParams.toString()}`}>Export CSV</a>
          </div>
        </form>
        <p className="muted">
          Definition: backlog includes work orders whose current status is neither COMPLETED nor CANCELLED.
          Date filters apply to the request date (requestedAt), not to a reconstructed historical backlog snapshot.
        </p>
        {loading ? <p role="status">Refreshing analytics…</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </section>

      {data ? (
        <>
          <div className="grid grid-4 section">
            {[
              ["Open backlog", data.metrics.total],
              ["Overdue", data.metrics.overdue],
              ["Urgent", data.metrics.urgent],
              ["Unassigned", data.metrics.unassigned],
            ].map(([label, value]) => (
              <section className="card" key={label}>
                <div className="muted">{label}</div>
                <div className="metric">{value}</div>
              </section>
            ))}
          </div>

          <div className="grid grid-2 section">
            <section className="card responsive-table">
              <h2>Backlog age</h2>
              <table className="table">
                <thead><tr><th>Age at {data.asOf.slice(0, 10)} UTC</th><th>Work orders</th></tr></thead>
                <tbody>
                  <tr><td>0–7 days</td><td>{data.ageBuckets.days0To7}</td></tr>
                  <tr><td>8–30 days</td><td>{data.ageBuckets.days8To30}</td></tr>
                  <tr><td>31–90 days</td><td>{data.ageBuckets.days31To90}</td></tr>
                  <tr><td>&gt; 90 days</td><td>{data.ageBuckets.over90Days}</td></tr>
                </tbody>
              </table>
            </section>

            <section className="card responsive-table">
              <h2>Current status</h2>
              {Object.keys(data.byStatus).length ? (
                <table className="table">
                  <thead><tr><th>Status</th><th>Work orders</th></tr></thead>
                  <tbody>
                    {Object.entries(data.byStatus).map(([status, count]) => (
                      <tr key={status}><td>{status}</td><td>{count ?? 0}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted">No work orders match this scope.</p>}
            </section>
          </div>

          <section className="card responsive-table section">
            <h2>Oldest open work orders</h2>
            {data.oldest.length ? (
              <table className="table">
                <thead>
                  <tr><th>WO</th><th>Title</th><th>Status</th><th>Priority</th><th>Requested UTC</th><th>Due UTC</th><th>Asset</th><th>Owner</th></tr>
                </thead>
                <tbody>
                  {data.oldest.map((workOrder) => (
                    <tr key={workOrder.id}>
                      <td><Link className="table-link" href={`/maintenance/${workOrder.id}`}>{workOrder.number}</Link></td>
                      <td>{workOrder.title}</td>
                      <td>{workOrder.status}</td>
                      <td>{workOrder.priority}</td>
                      <td>{formatUtc(workOrder.requestedAt)}</td>
                      <td>{formatUtc(workOrder.dueAt)}</td>
                      <td>{workOrder.asset?.code ?? "—"}</td>
                      <td>{workOrder.assignee?.displayName ?? workOrder.team?.name ?? "Unassigned"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted">No open work orders match the selected filters.</p>}
            {data.detailTruncated ? (
              <p className="muted">Showing the {data.detailLimit} oldest rows. Use CSV export for the bounded full extract.</p>
            ) : null}
          </section>
        </>
      ) : null}
    </>
  );
}
