import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  buildWorkOrderBoard,
  isWorkOrderOverdue,
  matchesDueFilter,
  type WorkOrderDueFilter,
} from "@/lib/maintenance/board";
import WorkOrderCard from "./work-order-card";

const FILTERS: Array<{ value: WorkOrderDueFilter; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "DUE_7_DAYS", label: "Due ≤ 7 days" },
  { value: "NO_DUE_DATE", label: "No due date" },
];

function dueFilter(value: string | undefined): WorkOrderDueFilter {
  return FILTERS.some((filter) => filter.value === value) ? (value as WorkOrderDueFilter) : "ALL";
}

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

export default async function WorkOrderKanbanPage({
  searchParams,
}: {
  searchParams: Promise<{ due?: string }>;
}) {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";
  const { due } = await searchParams;
  const selectedFilter = dueFilter(due);

  if (!organizationId || !siteId) {
    return (
      <>
        <div className="header">
          <div>
            <div className="title">Work-order Kanban</div>
            <div className="muted">Select an organization and site to plan maintenance work.</div>
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

  const workOrders = await db.workOrder.findMany({
    where: {
      siteId,
      site: { organizationId, active: true },
    },
    include: {
      asset: { select: { code: true } },
      assignee: { select: { displayName: true } },
      team: { select: { name: true } },
    },
    orderBy: { requestedAt: "desc" },
  });

  const now = new Date();
  const items = workOrders.map((workOrder) => ({
    id: workOrder.id,
    number: workOrder.number,
    title: workOrder.title,
    status: workOrder.status,
    priority: workOrder.priority,
    dueAt: workOrder.dueAt,
    plannedStart: workOrder.plannedStart,
    requestedAt: workOrder.requestedAt,
    assetCode: workOrder.asset?.code ?? null,
    assigneeName: workOrder.assignee?.displayName ?? null,
    teamName: workOrder.team?.name ?? null,
  }));
  const board = buildWorkOrderBoard({ workOrders: items, dueFilter: selectedFilter, now });
  const activeItems = items.filter((item) => item.status !== "CANCELLED");
  const overdueCount = activeItems.filter((item) => isWorkOrderOverdue(item, now)).length;
  const dueSoonCount = activeItems.filter((item) => matchesDueFilter(item, "DUE_7_DAYS", now)).length;
  const noDueCount = activeItems.filter((item) => item.dueAt === null).length;

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/maintenance">← Maintenance</Link>
          <div className="title">Work-order Kanban</div>
          <div className="muted">{site.code} · {site.name} · workflow-safe status planning</div>
        </div>
      </div>

      <section className="card" aria-label="Work-order board filters">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {FILTERS.map((filter) => {
            const selected = filter.value === selectedFilter;
            return (
              <Link
                key={filter.value}
                href={`/maintenance/kanban?due=${filter.value}`}
                aria-current={selected ? "page" : undefined}
                className="badge"
                style={{
                  textDecoration: "none",
                  outline: selected ? "2px solid currentColor" : undefined,
                  outlineOffset: 2,
                }}
              >
                {filter.label}
              </Link>
            );
          })}
        </div>
        <div className="muted" style={{ marginTop: 10 }}>
          {activeItems.length} active · {overdueCount} overdue · {dueSoonCount} due within 7 days · {noDueCount} without due date
        </div>
      </section>

      <div
        className="section"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 14,
          alignItems: "start",
        }}
      >
        {board.map((column) => {
          const headingId = `kanban-${column.status.toLowerCase()}`;
          return (
            <section
              key={column.status}
              aria-labelledby={headingId}
              style={{ minWidth: 0, display: "grid", gap: 10 }}
            >
              <div className="card" style={{ padding: 12 }}>
                <h2 id={headingId} style={{ margin: 0, fontSize: 16, textTransform: "capitalize" }}>
                  {statusLabel(column.status)} · {column.items.length}
                </h2>
              </div>
              {column.items.map((workOrder) => (
                <WorkOrderCard
                  key={workOrder.id}
                  organizationId={organizationId}
                  siteId={siteId}
                  workOrder={{
                    id: workOrder.id,
                    number: workOrder.number,
                    title: workOrder.title,
                    status: workOrder.status,
                    priority: workOrder.priority,
                    dueAt: workOrder.dueAt?.toISOString() ?? null,
                    plannedStart: workOrder.plannedStart?.toISOString() ?? null,
                    assetCode: workOrder.assetCode,
                    assigneeName: workOrder.assigneeName,
                    teamName: workOrder.teamName,
                    overdue: isWorkOrderOverdue(workOrder, now),
                  }}
                />
              ))}
              {column.items.length === 0 ? (
                <div className="card muted" style={{ padding: 14 }}>No work orders in this column.</div>
              ) : null}
            </section>
          );
        })}
      </div>
    </>
  );
}
