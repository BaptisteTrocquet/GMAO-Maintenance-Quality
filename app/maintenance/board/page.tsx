import Link from "next/link";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import {
  buildWorkOrderBoard,
  isWorkOrderOverdue,
  type WorkOrderDueFilter,
} from "@/lib/maintenance/board";

const dueFilters: Array<{ value: WorkOrderDueFilter; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "OVERDUE", label: "Overdue" },
  { value: "DUE_7_DAYS", label: "Due in 7 days" },
  { value: "NO_DUE_DATE", label: "No due date" },
];

function parseDueFilter(value: string | string[] | undefined): WorkOrderDueFilter {
  const candidate = Array.isArray(value) ? value[0] : value;
  return dueFilters.some((filter) => filter.value === candidate)
    ? (candidate as WorkOrderDueFilter)
    : "ALL";
}

function formatDate(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : "—";
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
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
    orderBy: { requestedAt: "asc" },
  });
  const now = new Date();
  const board = buildWorkOrderBoard({
    dueFilter,
    now,
    workOrders: workOrders.map((workOrder) => ({
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
    })),
  });
  const visibleCount = board.reduce((sum, column) => sum + column.items.length, 0);
  const overdueCount = workOrders.filter((workOrder) => isWorkOrderOverdue(workOrder, now)).length;

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/maintenance">← Maintenance</Link>
          <div className="title">Work-order board</div>
          <div className="muted">Status flow, priority and due-date focus for the selected site.</div>
        </div>
        <div className="asset-status">
          <span className="badge">{visibleCount} visible</span>
          <span className="badge">{overdueCount} overdue</span>
        </div>
      </div>

      <section className="card" aria-label="Work-order due filters">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <strong>Due filter</strong>
          {dueFilters.map((filter) => (
            <Link
              key={filter.value}
              href={filter.value === "ALL" ? "/maintenance/board" : `/maintenance/board?due=${filter.value}`}
              className="badge"
              aria-current={dueFilter === filter.value ? "page" : undefined}
            >
              {filter.label}
            </Link>
          ))}
        </div>
      </section>

      <section className="section" aria-label="Work-order Kanban board">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, minmax(240px, 1fr))",
            gap: 12,
            overflowX: "auto",
            paddingBottom: 8,
          }}
        >
          {board.map((column) => (
            <section className="card" key={column.status} style={{ minWidth: 240, alignSelf: "start" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <h2 style={{ margin: 0, fontSize: 16 }}>{statusLabel(column.status)}</h2>
                <span className="badge">{column.items.length}</span>
              </div>
              <div className="stack-list" style={{ marginTop: 12 }}>
                {column.items.map((workOrder) => {
                  const overdue = isWorkOrderOverdue(workOrder, now);
                  return (
                    <article
                      key={workOrder.id}
                      style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                          {workOrder.number}
                        </Link>
                        <span className="badge">{workOrder.priority}</span>
                      </div>
                      <div style={{ fontWeight: 650, marginTop: 6 }}>{workOrder.title}</div>
                      <div className="muted" style={{ marginTop: 6 }}>
                        {workOrder.assetCode ?? "No asset"} · {workOrder.assigneeName ?? workOrder.teamName ?? "Unassigned"}
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <span className="muted">Due {formatDate(workOrder.dueAt)}</span>
                        {overdue ? <span className="badge" style={{ marginLeft: 6 }}>OVERDUE</span> : null}
                      </div>
                    </article>
                  );
                })}
                {column.items.length === 0 ? <p className="muted">No work orders.</p> : null}
              </div>
            </section>
          ))}
        </div>
      </section>
    </>
  );
}
