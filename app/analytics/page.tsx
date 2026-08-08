import Link from "next/link";
import { headers } from "next/headers";
import { BacklogAnalyticsError, getBacklogAnalytics } from "@/lib/analytics/backlog";
import { db } from "@/lib/db";

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatUtc(value: Date | null) {
  return value ? value.toISOString().replace("T", " ").slice(0, 16) : "—";
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";
  const query = await searchParams;
  const fromDate = first(query.fromDate) ?? "";
  const toDate = first(query.toDate) ?? "";
  const assetId = first(query.assetId) ?? "";

  if (!organizationId || !siteId) {
    return (
      <>
        <div className="header">
          <div>
            <div className="title">Analytics</div>
            <div className="muted">Trusted maintenance and reliability indicators.</div>
          </div>
        </div>
        <section className="card">Select an organization and site to view analytics.</section>
      </>
    );
  }

  const assets = await db.asset.findMany({
    where: {
      siteId,
      site: { organizationId, active: true },
    },
    select: { id: true, code: true, name: true, archivedAt: true },
    orderBy: { code: "asc" },
  });

  let analytics: Awaited<ReturnType<typeof getBacklogAnalytics>> | null = null;
  let rangeError: string | null = null;
  try {
    analytics = await getBacklogAnalytics({
      organizationId,
      siteId,
      assetId: assetId || null,
      fromDate: fromDate || null,
      toDate: toDate || null,
    });
  } catch (error) {
    if (error instanceof BacklogAnalyticsError) rangeError = error.message;
    else throw error;
  }

  const csv = new URLSearchParams({ organizationId, siteId, format: "csv" });
  if (assetId) csv.set("assetId", assetId);
  if (fromDate) csv.set("fromDate", fromDate);
  if (toDate) csv.set("toDate", toDate);

  return (
    <>
      <div className="header">
        <div>
          <div className="title">Analytics · Backlog</div>
          <div className="muted">Current open work, aged and prioritized for the selected site.</div>
        </div>
        <Link className="button" href={`/api/analytics/backlog?${csv.toString()}`}>
          Export CSV
        </Link>
      </div>

      <section className="card">
        <form method="get" className="grid grid-2">
          <label>
            <span className="muted">Requested from (UTC)</span>
            <input type="date" name="fromDate" defaultValue={fromDate} />
          </label>
          <label>
            <span className="muted">Requested to (UTC)</span>
            <input type="date" name="toDate" defaultValue={toDate} />
          </label>
          <label>
            <span className="muted">Asset</span>
            <select name="assetId" defaultValue={assetId}>
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
            <div>Site {siteId}</div>
          </div>
          <div>
            <button className="button" type="submit">Apply filters</button>
            <Link className="button" href="/analytics">Reset</Link>
          </div>
        </form>
        <p className="muted">
          Definition: backlog includes work orders whose current status is neither COMPLETED nor CANCELLED.
          Date filters apply to the work order request date (`requestedAt`); they are not a historical backlog snapshot.
        </p>
        {rangeError ? <p role="alert">{rangeError}</p> : null}
      </section>

      {analytics ? (
        <>
          <div className="grid grid-2 section">
            <section className="card"><div className="muted">Open backlog</div><div className="title">{analytics.metrics.total}</div></section>
            <section className="card"><div className="muted">Overdue</div><div className="title">{analytics.metrics.overdue}</div></section>
            <section className="card"><div className="muted">Urgent</div><div className="title">{analytics.metrics.urgent}</div></section>
            <section className="card"><div className="muted">Unassigned</div><div className="title">{analytics.metrics.unassigned}</div></section>
          </div>

          <div className="grid grid-2 section">
            <section className="card responsive-table">
              <h2>Backlog age</h2>
              <table className="table">
                <thead><tr><th>Age at {analytics.asOf.slice(0, 10)} UTC</th><th>Work orders</th></tr></thead>
                <tbody>
                  <tr><td>0–7 days</td><td>{analytics.ageBuckets.days0To7}</td></tr>
                  <tr><td>8–30 days</td><td>{analytics.ageBuckets.days8To30}</td></tr>
                  <tr><td>31–90 days</td><td>{analytics.ageBuckets.days31To90}</td></tr>
                  <tr><td>&gt; 90 days</td><td>{analytics.ageBuckets.over90Days}</td></tr>
                </tbody>
              </table>
            </section>

            <section className="card responsive-table">
              <h2>Current status</h2>
              {Object.keys(analytics.byStatus).length ? (
                <table className="table">
                  <thead><tr><th>Status</th><th>Work orders</th></tr></thead>
                  <tbody>
                    {Object.entries(analytics.byStatus).map(([status, count]) => (
                      <tr key={status}><td>{status}</td><td>{count ?? 0}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <p className="muted">No work orders match this scope.</p>}
            </section>
          </div>

          <section className="card responsive-table section">
            <h2>Oldest open work orders</h2>
            {analytics.oldest.length ? (
              <table className="table">
                <thead>
                  <tr><th>WO</th><th>Title</th><th>Status</th><th>Priority</th><th>Requested UTC</th><th>Due UTC</th><th>Asset</th><th>Owner</th></tr>
                </thead>
                <tbody>
                  {analytics.oldest.map((workOrder) => (
                    <tr key={workOrder.id}>
                      <td><Link href={`/maintenance/${workOrder.id}`}>{workOrder.number}</Link></td>
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
            {analytics.detailTruncated ? (
              <p className="muted">Showing the {analytics.detailLimit} oldest rows. Use CSV export for the bounded full extract.</p>
            ) : null}
          </section>
        </>
      ) : null}
    </>
  );
}
