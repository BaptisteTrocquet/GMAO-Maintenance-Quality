import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  buildWorkloadLanes,
  buildWorkloadWhere,
  WORKLOAD_LIMIT,
} from "@/lib/maintenance/workload";

function metric(value: number, label: string) {
  return (
    <span className="badge" aria-label={`${value} ${label}`}>
      {value} {label}
    </span>
  );
}

export default async function MaintenanceWorkloadPage() {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  if (!organizationId || !siteId) {
    return (
      <>
        <div className="header">
          <div>
            <div className="title">Team workload</div>
            <div className="muted">Select an organization and site to review maintenance workload.</div>
          </div>
        </div>
        <section className="card"><p>Organization and site context are required.</p></section>
      </>
    );
  }

  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: { id: true, code: true, name: true },
  });
  if (!site) notFound();

  const now = new Date();
  const workOrders = await db.workOrder.findMany({
    where: buildWorkloadWhere({ organizationId, siteId }),
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      priority: true,
      requestedAt: true,
      plannedStart: true,
      dueAt: true,
      assigneeId: true,
      assignee: { select: { displayName: true } },
      teamId: true,
      team: { select: { name: true } },
    },
    orderBy: [{ priority: "desc" }, { dueAt: "asc" }, { requestedAt: "asc" }],
    take: WORKLOAD_LIMIT + 1,
  });

  const truncated = workOrders.length > WORKLOAD_LIMIT;
  const visible = workOrders.slice(0, WORKLOAD_LIMIT).map((workOrder) => ({
    ...workOrder,
    assigneeName: workOrder.assignee?.displayName ?? null,
    teamName: workOrder.team?.name ?? null,
  }));
  const lanes = buildWorkloadLanes({ workOrders: visible, now });

  const totals = lanes.reduce(
    (sum, lane) => ({
      total: sum.total + lane.total,
      overdue: sum.overdue + lane.overdue,
      blocked: sum.blocked + lane.blocked,
      unplanned: sum.unplanned + lane.unplanned,
    }),
    { total: 0, overdue: 0, blocked: 0, unplanned: 0 },
  );

  return (
    <>
      <div className="header">
        <div>
          <Link className="muted" href="/maintenance">← Maintenance</Link>
          <div className="title">Team workload</div>
          <div className="muted">{site.code} · {site.name} · active maintenance backlog</div>
        </div>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <h2>Site workload</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {metric(totals.total, "active")}
            {metric(totals.overdue, "overdue")}
            {metric(totals.blocked, "blocked")}
            {metric(totals.unplanned, "unplanned")}
          </div>
          {truncated ? (
            <p className="muted" role="status">
              Showing the first {WORKLOAD_LIMIT} active work orders. Narrow the backlog before operational use.
            </p>
          ) : null}
        </section>

        <section className="card">
          <h2>How to read this</h2>
          <p className="muted">
            Rows are assigned to the named person first, then to a maintenance team, otherwise to Unassigned.
            Riskier rows are shown first using overdue, blocked, urgent and near-due work.
          </p>
          <p className="muted" style={{ marginBottom: 0 }}>
            These are workload counts, not capacity percentages. The data model does not yet define contractual hours,
            shift capacity or availability, so this view deliberately avoids inventing utilization figures.
          </p>
        </section>
      </div>

      <section className="card responsive-table section">
        <h2>Assignment workload</h2>
        {lanes.length === 0 ? (
          <p className="muted">No active maintenance work in this site.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Owner</th>
                <th>Type</th>
                <th>Active</th>
                <th>In progress</th>
                <th>Blocked</th>
                <th>Overdue</th>
                <th>Due ≤7d</th>
                <th>Planned ≤14d</th>
                <th>Unplanned</th>
                <th>Urgent</th>
              </tr>
            </thead>
            <tbody>
              {lanes.map((lane) => (
                <tr key={lane.key}>
                  <td><strong>{lane.label}</strong></td>
                  <td>{lane.kind}</td>
                  <td>{lane.total}</td>
                  <td>{lane.inProgress}</td>
                  <td>{lane.blocked}</td>
                  <td>{lane.overdue}</td>
                  <td>{lane.dueSoon}</td>
                  <td>{lane.plannedInHorizon}</td>
                  <td>{lane.unplanned}</td>
                  <td>{lane.urgent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}