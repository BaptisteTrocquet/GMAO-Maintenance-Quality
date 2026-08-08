"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type AssetOption = {
  id: string;
  code: string;
  name: string;
};

type BacklogAnalytics = {
  scope: {
    organizationId: string;
    siteId: string;
    assetId: string | null;
  };
  range: {
    fromDate: string | null;
    toDate: string | null;
    semantics: "requestedAt";
    timeZone: string;
    fromUtc: string | null;
    toExclusiveUtc: string | null;
  };
  generatedAt: string;
  empty: boolean;
  metrics: {
    total: number;
    overdue: number;
    blocked: number;
    urgent: number;
    unassigned: number;
  };
  byStatus: Record<string, number>;
  ageBuckets: {
    days0To6: number;
    days7To29: number;
    days30To89: number;
    days90Plus: number;
  };
  oldest: Array<{
    id: string;
    number: string;
    title: string;
    status: string;
    priority: string;
    requestedAt: string;
    plannedStart: string | null;
    dueAt: string | null;
    asset: { id: string; code: string; name: string } | null;
    assignee: { displayName: string } | null;
    team: { name: string } | null;
  }>;
  detailLimit: number;
  detailTruncated: boolean;
};

type AnalyticsResponse = {
  data?: {
    site: { id: string; code: string; name: string; timeZone: string };
    analytics: BacklogAnalytics;
  };
  error?: { message?: string };
};

type AssetsResponse = {
  data?: AssetOption[];
};

function formatDate(value: string | null, timeZone?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function buildAnalyticsParams(input: {
  organizationId: string;
  siteId: string;
  from: string;
  to: string;
  assetId: string;
  format?: "json" | "csv";
}) {
  const params = new URLSearchParams({
    organizationId: input.organizationId,
    siteId: input.siteId,
  });
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  if (input.assetId) params.set("assetId", input.assetId);
  if (input.format === "csv") params.set("format", "csv");
  return params;
}

export default function BacklogDashboardClient({
  organizationId,
  siteId,
  initialFrom,
  initialTo,
  initialAssetId,
}: {
  organizationId: string;
  siteId: string;
  initialFrom: string;
  initialTo: string;
  initialAssetId: string;
}) {
  const [payload, setPayload] = useState<AnalyticsResponse["data"] | null>(null);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const analyticsParams = useMemo(
    () =>
      buildAnalyticsParams({
        organizationId,
        siteId,
        from: initialFrom,
        to: initialTo,
        assetId: initialAssetId,
      }),
    [organizationId, siteId, initialFrom, initialTo, initialAssetId],
  );

  const csvHref = useMemo(() => {
    const params = buildAnalyticsParams({
      organizationId,
      siteId,
      from: initialFrom,
      to: initialTo,
      assetId: initialAssetId,
      format: "csv",
    });
    return `/api/analytics/backlog?${params.toString()}`;
  }, [organizationId, siteId, initialFrom, initialTo, initialAssetId]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    void Promise.all([
      fetch(`/api/analytics/backlog?${analyticsParams.toString()}`, {
        signal: controller.signal,
        cache: "no-store",
      }).then(async (response) => {
        const body = (await response.json()) as AnalyticsResponse;
        if (!response.ok || !body.data) {
          throw new Error(body.error?.message ?? "Unable to load backlog analytics");
        }
        return body.data;
      }),
      fetch(
        `/api/assets?${new URLSearchParams({ organizationId, siteId }).toString()}`,
        { signal: controller.signal, cache: "no-store" },
      )
        .then(async (response) => {
          if (!response.ok) return [] as AssetOption[];
          const body = (await response.json()) as AssetsResponse;
          return (body.data ?? []).map((asset) => ({
            id: asset.id,
            code: asset.code,
            name: asset.name,
          }));
        })
        .catch((assetError: unknown) => {
          if (assetError instanceof DOMException && assetError.name === "AbortError") throw assetError;
          return [] as AssetOption[];
        }),
    ])
      .then(([analytics, assetOptions]) => {
        setPayload(analytics);
        setAssets(assetOptions);
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setPayload(null);
        setError(loadError instanceof Error ? loadError.message : "Unable to load backlog analytics");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [analyticsParams, organizationId, siteId]);

  const analytics = payload?.analytics ?? null;
  const site = payload?.site ?? null;

  return (
    <>
      <section className="card" aria-label="Backlog analytics filters">
        <form method="GET" action="/analytics/backlog" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="muted">From requested date</span>
            <input type="date" name="from" defaultValue={initialFrom} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="muted">To requested date</span>
            <input type="date" name="to" defaultValue={initialTo} />
          </label>
          <label style={{ display: "grid", gap: 4, minWidth: 220 }}>
            <span className="muted">Asset</span>
            <select name="assetId" defaultValue={initialAssetId}>
              <option value="">All assets</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.code} · {asset.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Apply filters</button>
          <Link className="table-link" href="/analytics/backlog">Reset</Link>
          <a className="table-link" href={csvHref}>Export CSV</a>
        </form>
        <p className="muted" style={{ marginBottom: 0 }}>
          Open backlog means work orders not completed or cancelled. Date filters apply to the requested date in the site timezone; overdue and aging are calculated at the generated timestamp.
        </p>
      </section>

      {loading && !analytics ? <section className="card section" role="status">Loading backlog analytics…</section> : null}
      {error ? <section className="card section" role="alert">{error}</section> : null}

      {analytics && site ? (
        <>
          <section className="card section">
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <strong>{site.code} · {site.name}</strong>
                <div className="muted">Timezone: {site.timeZone}</div>
              </div>
              <div className="muted">Generated {formatDate(analytics.generatedAt, site.timeZone)}</div>
            </div>
            {(analytics.range.fromDate || analytics.range.toDate || analytics.scope.assetId) ? (
              <div className="muted" style={{ marginTop: 8 }}>
                Requested-date filter: {analytics.range.fromDate ?? "beginning"} → {analytics.range.toDate ?? "now"}
                {analytics.scope.assetId ? " · asset filter active" : ""}
              </div>
            ) : null}
          </section>

          <div className="grid grid-4 section">
            {[
              ["Open backlog", analytics.metrics.total],
              ["Overdue", analytics.metrics.overdue],
              ["Blocked", analytics.metrics.blocked],
              ["Urgent", analytics.metrics.urgent],
              ["Unassigned", analytics.metrics.unassigned],
            ].map(([label, value]) => (
              <div className="card" key={label}>
                <div className="muted">{label}</div>
                <div className="metric">{value}</div>
              </div>
            ))}
          </div>

          {analytics.empty ? (
            <section className="card section" role="status">
              No open work orders match the selected backlog filters.
            </section>
          ) : (
            <>
              <div className="grid grid-2 section">
                <section className="card responsive-table">
                  <h2>By workflow status</h2>
                  <table className="table">
                    <thead><tr><th>Status</th><th>Open WO</th></tr></thead>
                    <tbody>
                      {["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"].map((status) => (
                        <tr key={status}>
                          <td>{status.replaceAll("_", " ")}</td>
                          <td>{analytics.byStatus[status] ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>

                <section className="card responsive-table">
                  <h2>Backlog aging</h2>
                  <table className="table">
                    <thead><tr><th>Age since request</th><th>Open WO</th></tr></thead>
                    <tbody>
                      <tr><td>0–6 days</td><td>{analytics.ageBuckets.days0To6}</td></tr>
                      <tr><td>7–29 days</td><td>{analytics.ageBuckets.days7To29}</td></tr>
                      <tr><td>30–89 days</td><td>{analytics.ageBuckets.days30To89}</td></tr>
                      <tr><td>90+ days</td><td>{analytics.ageBuckets.days90Plus}</td></tr>
                    </tbody>
                  </table>
                </section>
              </div>

              <section className="card section responsive-table">
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <h2 style={{ marginTop: 0 }}>Oldest open work orders</h2>
                  {analytics.detailTruncated ? (
                    <span className="badge">First {analytics.detailLimit} shown</span>
                  ) : null}
                </div>
                <table className="table">
                  <thead>
                    <tr><th>WO</th><th>Asset</th><th>Status</th><th>Priority</th><th>Requested</th><th>Due</th><th>Owner</th></tr>
                  </thead>
                  <tbody>
                    {analytics.oldest.map((workOrder) => (
                      <tr key={workOrder.id}>
                        <td>
                          <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                            {workOrder.number} · {workOrder.title}
                          </Link>
                        </td>
                        <td>{workOrder.asset ? `${workOrder.asset.code} · ${workOrder.asset.name}` : "—"}</td>
                        <td><span className="badge">{workOrder.status}</span></td>
                        <td>{workOrder.priority}</td>
                        <td>{formatDate(workOrder.requestedAt, site.timeZone)}</td>
                        <td>{formatDate(workOrder.dueAt, site.timeZone)}</td>
                        <td>{workOrder.assignee?.displayName ?? workOrder.team?.name ?? "Unassigned"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </>
      ) : null}
    </>
  );
}
