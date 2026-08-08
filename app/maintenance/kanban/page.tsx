import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { resolveSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import {
  buildWorkOrderBoard,
  buildWorkOrderBoardWhere,
  WORK_ORDER_BOARD_LIMIT,
  type WorkOrderAssignmentFilter,
  type WorkOrderDueFilter,
  type WorkOrderPriorityFilter,
} from "@/lib/maintenance/board";
import SavedViewsControl from "./saved-views-control";
import WorkOrderCard from "./work-order-card";

const DUE_FILTERS: Array<{ value: WorkOrderDueFilter; label: string }> = [
  { value: "ALL", label: "All dates" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "DUE_7_DAYS", label: "Due ≤ 7 days" },
  { value: "NO_DUE_DATE", label: "No due date" },
];

const PRIORITY_FILTERS: Array<{ value: WorkOrderPriorityFilter; label: string }> = [
  { value: "ALL", label: "All priorities" },
  { value: "URGENT", label: "Urgent" },
  { value: "HIGH", label: "High" },
  { value: "NORMAL", label: "Normal" },
  { value: "LOW", label: "Low" },
];

const ASSIGNMENT_FILTERS: Array<{ value: WorkOrderAssignmentFilter; label: string }> = [
  { value: "ALL", label: "All assignments" },
  { value: "UNASSIGNED", label: "Unassigned" },
  { value: "MY_WORK", label: "My work" },
];

function dueFilter(value: string | undefined): WorkOrderDueFilter {
  return DUE_FILTERS.some((filter) => filter.value === value)
    ? (value as WorkOrderDueFilter)
    : "ALL";
}

function priorityFilter(value: string | undefined): WorkOrderPriorityFilter {
  return PRIORITY_FILTERS.some((filter) => filter.value === value)
    ? (value as WorkOrderPriorityFilter)
    : "ALL";
}

function assignmentFilter(
  value: string | undefined,
  currentUserId: string | undefined,
): WorkOrderAssignmentFilter {
  const parsed = ASSIGNMENT_FILTERS.some((filter) => filter.value === value)
    ? (value as WorkOrderAssignmentFilter)
    : "ALL";
  return parsed === "MY_WORK" && !currentUserId ? "ALL" : parsed;
}

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

export default async function WorkOrderKanbanPage({
  searchParams,
}: {
  searchParams: Promise<{ due?: string; priority?: string; assignment?: string }>;
}) {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";
  const authorization = requestHeaders.get("authorization");
  const session = authorization?.startsWith("Bearer ")
    ? await resolveSession(authorization.slice("Bearer ".length).trim())
    : null;
  const currentUserId = session?.user.id;
  const { due, priority, assignment } = await searchParams;
  const selectedDue = dueFilter(due);
  const selectedPriority = priorityFilter(priority);
  const selectedAssignment = assignmentFilter(assignment, currentUserId);

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

  const now = new Date();
  const [workOrders, overdueCount, dueSoonCount, noDueCount] = await Promise.all([
    db.workOrder.findMany({
      where: buildWorkOrderBoardWhere({
        organizationId,
        siteId,
        dueFilter: selectedDue,
        priorityFilter: selectedPriority,
        assignmentFilter: selectedAssignment,
        userId: currentUserId,
        now,
      }),
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
      where: buildWorkOrderBoardWhere({ organizationId, siteId, dueFilter: "OVERDUE", now }),
    }),
    db.workOrder.count({
      where: buildWorkOrderBoardWhere({ organizationId, siteId, dueFilter: "DUE_7_DAYS", now }),
    }),
    db.workOrder.count({
      where: buildWorkOrderBoardWhere({ organizationId, siteId, dueFilter: "NO_DUE_DATE", now }),
    }),
  ]);

  const truncated = workOrders.length > WORK_ORDER_BOARD_LIMIT;
  const boundedWorkOrders = workOrders.slice(0, WORK_ORDER_BOARD_LIMIT);
  const items = boundedWorkOrders.map((workOrder) => ({
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
  const board = buildWorkOrderBoard({ workOrders: items, dueFilter: selectedDue, now });
  const visibleCount = board.reduce((sum, column) => sum + column.items.length, 0);

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/maintenance">← Maintenance</Link>
          <div className="title">Work-order Kanban</div>
          <div className="muted">{site.code} · {site.name} · workflow-safe status planning</div>
        </div>
        <div className="asset-status">
          <span className="badge">{visibleCount} visible</span>
          <span className="badge">{overdueCount} overdue</span>
          {truncated ? <span className="badge">First {WORK_ORDER_BOARD_LIMIT} shown</span> : null}
        </div>
      </div>

      <section className="card" aria-label="Work-order board filters">
        <form method="get" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="muted">Due</span>
            <select name="due" defaultValue={selectedDue}>
              {DUE_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>{filter.label}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="muted">Priority</span>
            <select name="priority" defaultValue={selectedPriority}>
              {PRIORITY_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>{filter.label}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span className="muted">Assignment</span>
            <select name="assignment" defaultValue={selectedAssignment}>
              {ASSIGNMENT_FILTERS.map((filter) => (
                <option
                  key={filter.value}
                  value={filter.value}
                  disabled={filter.value === "MY_WORK" && !currentUserId}
                >
                  {filter.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Apply filters</button>
          <Link className="table-link" href="/maintenance/kanban">Reset</Link>
        </form>

        <div className="muted" style={{ marginTop: 10 }}>
          {overdueCount} overdue · {dueSoonCount} due within 7 days · {noDueCount} without due date
        </div>
        {assignment === "MY_WORK" && !currentUserId ? (
          <p className="muted" role="status" style={{ marginBottom: 0 }}>
            My work requires an authenticated user session; the board is showing all assignments.
          </p>
        ) : null}
        {truncated ? (
          <p className="muted" role="status" style={{ marginBottom: 0, marginTop: 10 }}>
            This board is bounded to {WORK_ORDER_BOARD_LIMIT} matching work orders for predictable rendering. Narrow the filters to focus the list.
          </p>
        ) : null}

        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #e5e7eb" }}>
          <SavedViewsControl
            organizationId={organizationId}
            siteId={siteId}
            dueFilter={selectedDue}
            priorityFilter={selectedPriority}
            assignmentFilter={selectedAssignment}
          />
        </div>
      </section>

      <section className="section" aria-label="Work-order Kanban board">
        <div
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
                      overdue:
                        workOrder.dueAt !== null &&
                        workOrder.dueAt.getTime() < now.getTime() &&
                        workOrder.status !== "COMPLETED",
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
      </section>
    </>
  );
}
