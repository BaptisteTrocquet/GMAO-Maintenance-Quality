import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  buildWorkOrderBoard,
  buildWorkOrderBoardWhere,
  isWorkOrderOverdue,
  WORK_ORDER_BOARD_LIMIT,
  type WorkOrderDueFilter,
} from "@/lib/maintenance/board";
import WorkOrderCard from "./work-order-card";

const DUE_FILTERS: Array<{ value: WorkOrderDueFilter; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "DUE_7_DAYS", label: "Due in 7 days" },
  { value: "NO_DUE_DATE", label: "No due date" },
];

function parseDueFilter(value: string | string[] | undefined): WorkOrderDueFilter {
  const candidate = Array.isArray(value) ? value[0] : value;
  return DUE_FILTERS.some((filter) => filter.value === candidate)
    ? (candidate as WorkOrderDueFilter)
    : "ALL";
}

function statusLabel(status: string) {
  return status.toLowerCase().replaceAll("_", " ");
}

export default async function WorkOrderBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ due?: string | string[] }>;
}) {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";
  const dueFilter = parseDueFilter((await searchParams).due);

  if (!organizationId || !siteId) {
    return (
      <>
        <div className="header">
          <div>
            <div className="title">Work-order board</div>
            <div className="muted">Kanban planning for the selected maintenance site.</div>
          </div>
        </div>
        <section className="card">
          <p>Select an organization and site to view the work-order board.</p>
        </section>
      </>
    );
  }

  const now = new Date();
  const [site, workOrders, overdueCount] = await Promise.all([
    db.site.findFirst({
      where: { id: siteId, organizationId, active: true },
      select: { id: true, code: true, name: true },
    }),
    db.workOrder.findMany({
      where: buildWorkOrderBoardWhere({ organizationId, siteId, dueFilter, now }),
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        dueAt: true,
        plannedStart: true,
        requestedAt: true,
        asset: { select: { code: true } },
        assignee: { select: { displayName: true } },
        team: { select: { name: true } },
      },
      orderBy: { requestedAt: "asc" },
      take: WORK_ORDER_BOARD_LIMIT + 1,
    }),
    db.workOrder.count({
      where: buildWorkOrderBoardWhere({
        organizationId,
        siteId,
        dueFilter: "OVERDUE",
        now,
      }),
    }),
  ]);
  if (!site) notFound();

  const truncated = workOrders.length > WORK_ORDER_BOARD_LIMIT;
  const boundedWorkOrders = workOrders.slice(0, WORK_ORDER_BOARD_LIMIT);
  const boardItems = boundedWorkOrders.map((workOrder) => ({
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
  const board = buildWorkOrderBoard({ workOrders: boardItems, dueFilter, now });
  const visibleCount = board.reduce((sum, column) => sum + column.items.length, 0);

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/maintenance">← Maintenance</Link>
          <div className="title">Work-order board</div>
          <div className="muted">{site.code} · {site.name} · status, priority and due-date focus</div>
        </div>
        <div className="asset-status">
          <span className="badge">{visibleCount} visible</span>
          <span className="badge">{overdueCount} overdue</span>
          {truncated ? <span className="badge">First {WORK_ORDER_BOARD_LIMIT} shown</span> : null}
        </div>
      </div>

      <section className="card kanban-filter-bar" aria-label="Work-order due filters">
        <strong>Due filter</strong>
        {DUE_FILTERS.map((filter) => (
          <Link
            key={filter.value}
            href={filter.value === "ALL" ? "/maintenance/board" : `/maintenance/board?due=${filter.value}`}
            className="badge kanban-filter"
            aria-current={dueFilter === filter.value ? "page" : undefined}
          >
            {filter.label}
          </Link>
        ))}
        {truncated ? (
          <span className="muted" role="status">
            Board limited to {WORK_ORDER_BOARD_LIMIT} matches; narrow the due filter to focus the list.
          </span>
        ) : null}
      </section>

      <section className="section kanban-board" aria-label="Work-order Kanban board">
        {board.map((column) => {
          const headingId = `board-column-${column.status.toLowerCase()}`;
          return (
            <section className="kanban-column" key={column.status} aria-labelledby={headingId}>
              <div className="kanban-column-header">
                <h2 id={headingId}>{statusLabel(column.status)}</h2>
                <span className="badge">{column.items.length}</span>
              </div>
              <div className="kanban-column-items">
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
                {column.items.length === 0 ? <p className="muted">No work orders.</p> : null}
              </div>
            </section>
          );
        })}
      </section>
    </>
  );
}
