import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  buildPlanningCalendarWhere,
  buildUnscheduledWorkOrderWhere,
  currentPlanningMonth,
  groupPlanningEvents,
  localDateKey,
  monthGridDays,
  parsePlanningMonth,
  planningMonthKey,
  planningMonthRange,
  PLANNING_CALENDAR_LIMIT,
  shiftPlanningMonth,
  UNSCHEDULED_WORK_ORDER_LIMIT,
  type MaintenancePlanningEvent,
} from "@/lib/maintenance/planning-calendar";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function searchValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function eventBadge(event: MaintenancePlanningEvent) {
  if (event.kind === "PLAN_DUE") return "PM";
  if (event.kind === "WORK_ORDER_START") return "START";
  return "DUE";
}

export default async function MaintenanceCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string | string[] }>;
}) {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";

  if (!organizationId || !siteId) {
    return (
      <>
        <div className="header">
          <div>
            <div className="title">Maintenance calendar</div>
            <div className="muted">Planned work and preventive maintenance for the selected site.</div>
          </div>
        </div>
        <section className="card">
          <p>Select an organization and site to view the maintenance calendar.</p>
        </section>
      </>
    );
  }

  const site = await db.site.findFirst({
    where: { id: siteId, organizationId, active: true },
    select: {
      id: true,
      code: true,
      name: true,
      organization: { select: { timezone: true } },
    },
  });
  if (!site) notFound();

  const timeZone = site.organization.timezone;
  const now = new Date();
  const fallbackMonth = currentPlanningMonth(now, timeZone);
  const selectedMonth = parsePlanningMonth(searchValue((await searchParams).month), fallbackMonth);
  const range = planningMonthRange(selectedMonth, timeZone);
  const previousKey = planningMonthKey(shiftPlanningMonth(selectedMonth, -1));
  const nextKey = planningMonthKey(shiftPlanningMonth(selectedMonth, 1));
  const selectedMonthKey = planningMonthKey(selectedMonth);

  const [workOrders, maintenancePlans, unscheduledWorkOrders] = await Promise.all([
    db.workOrder.findMany({
      where: buildPlanningCalendarWhere({
        organizationId,
        siteId,
        month: selectedMonth,
        timeZone,
      }),
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        plannedStart: true,
        dueAt: true,
        requestedAt: true,
        asset: { select: { code: true } },
      },
      orderBy: { requestedAt: "asc" },
      take: PLANNING_CALENDAR_LIMIT + 1,
    }),
    db.maintenancePlan.findMany({
      where: {
        active: true,
        nextDueAt: { gte: range.start, lt: range.end },
        asset: {
          archivedAt: null,
          siteId,
          site: { organizationId, active: true },
        },
      },
      select: {
        id: true,
        name: true,
        nextDueAt: true,
        asset: { select: { code: true, name: true } },
      },
      orderBy: { nextDueAt: "asc" },
      take: PLANNING_CALENDAR_LIMIT + 1,
    }),
    db.workOrder.findMany({
      where: buildUnscheduledWorkOrderWhere({ organizationId, siteId }),
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        dueAt: true,
        requestedAt: true,
        asset: { select: { code: true } },
        assignee: { select: { displayName: true } },
        team: { select: { name: true } },
      },
      orderBy: { requestedAt: "asc" },
      take: UNSCHEDULED_WORK_ORDER_LIMIT + 1,
    }),
  ]);

  const truncated =
    workOrders.length > PLANNING_CALENDAR_LIMIT || maintenancePlans.length > PLANNING_CALENDAR_LIMIT;
  const unscheduledTruncated = unscheduledWorkOrders.length > UNSCHEDULED_WORK_ORDER_LIMIT;
  const events: MaintenancePlanningEvent[] = [];

  for (const workOrder of workOrders.slice(0, PLANNING_CALENDAR_LIMIT)) {
    if (workOrder.plannedStart && workOrder.plannedStart >= range.start && workOrder.plannedStart < range.end) {
      events.push({
        id: `${workOrder.id}:start`,
        sourceId: workOrder.id,
        kind: "WORK_ORDER_START",
        date: workOrder.plannedStart,
        title: workOrder.title,
        label: workOrder.number,
        href: `/maintenance/${workOrder.id}`,
        status: workOrder.status,
        priority: workOrder.priority,
        assetCode: workOrder.asset?.code ?? null,
      });
    }
    if (workOrder.dueAt && workOrder.dueAt >= range.start && workOrder.dueAt < range.end) {
      events.push({
        id: `${workOrder.id}:due`,
        sourceId: workOrder.id,
        kind: "WORK_ORDER_DUE",
        date: workOrder.dueAt,
        title: workOrder.title,
        label: workOrder.number,
        href: `/maintenance/${workOrder.id}`,
        status: workOrder.status,
        priority: workOrder.priority,
        assetCode: workOrder.asset?.code ?? null,
      });
    }
  }

  for (const plan of maintenancePlans.slice(0, PLANNING_CALENDAR_LIMIT)) {
    if (!plan.nextDueAt) continue;
    events.push({
      id: `${plan.id}:plan`,
      sourceId: plan.id,
      kind: "PLAN_DUE",
      date: plan.nextDueAt,
      title: plan.name,
      label: plan.asset.code,
      href: "/maintenance",
      status: "PLAN_DUE",
      priority: null,
      assetCode: plan.asset.code,
    });
  }

  const grouped = groupPlanningEvents(events, timeZone);
  const grid = monthGridDays(selectedMonth);

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/maintenance">← Maintenance</Link>
          <div className="title">Maintenance calendar</div>
          <div className="muted">
            {site.code} · {site.name} · {timeZone} · work-order starts, due dates and PM due dates
          </div>
        </div>
        <div className="asset-status">
          <span className="badge">{events.length} events</span>
          <span className="badge">{Math.min(unscheduledWorkOrders.length, UNSCHEDULED_WORK_ORDER_LIMIT)} unscheduled</span>
          {truncated ? <span className="badge">Calendar bound reached</span> : null}
        </div>
      </div>

      <section className="card" aria-label="Calendar month navigation">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <Link className="badge" href={`/maintenance/calendar?month=${previousKey}`}>← Previous</Link>
          <h2 style={{ margin: 0 }}>{monthLabel(selectedMonth.year, selectedMonth.month)}</h2>
          <Link className="badge" href={`/maintenance/calendar?month=${nextKey}`}>Next →</Link>
        </div>
        {truncated ? (
          <p className="muted" role="status" style={{ marginBottom: 0, marginTop: 10 }}>
            This month reached the {PLANNING_CALENDAR_LIMIT}-record safety bound for at least one source. Use the Kanban filters for a narrower operational view.
          </p>
        ) : null}
      </section>

      <section className="section responsive-table" aria-label={`${monthLabel(selectedMonth.year, selectedMonth.month)} maintenance calendar`}>
        <div style={{ minWidth: 980 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(140px, 1fr))", gap: 8, marginBottom: 8 }}>
            {WEEKDAYS.map((weekday) => (
              <div className="card" key={weekday} style={{ padding: 10, textAlign: "center", fontWeight: 700 }}>
                {weekday}
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(140px, 1fr))", gap: 8 }}>
            {grid.map((day, index) => {
              if (day === null) {
                return <div aria-hidden="true" key={`empty-${index}`} style={{ minHeight: 150 }} />;
              }
              const key = `${selectedMonthKey}-${String(day).padStart(2, "0")}`;
              const dayEvents = grouped.get(key) ?? [];
              return (
                <section
                  className="card"
                  key={key}
                  aria-label={`${key}, ${dayEvents.length} maintenance events`}
                  style={{ minHeight: 150, padding: 10 }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <strong>{day}</strong>
                    {dayEvents.length ? <span className="badge">{dayEvents.length}</span> : null}
                  </div>
                  <div className="stack-list" style={{ marginTop: 8 }}>
                    {dayEvents.map((event) => (
                      <Link
                        className="table-link"
                        href={event.href}
                        key={event.id}
                        style={{ display: "block", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                          <span className="badge">{eventBadge(event)}</span>
                          {event.priority ? <span className="badge">{event.priority}</span> : null}
                        </div>
                        <strong style={{ display: "block", marginTop: 5 }}>{event.label}</strong>
                        <span style={{ display: "block" }}>{event.title}</span>
                        <span className="muted">{event.assetCode ?? "No asset"} · {event.status.replaceAll("_", " ")}</span>
                      </Link>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </section>

      <section className="card section" aria-labelledby="unscheduled-heading">
        <div className="header" style={{ marginBottom: 10 }}>
          <div>
            <h2 id="unscheduled-heading" style={{ margin: 0 }}>Unscheduled work</h2>
            <div className="muted">Active work orders without a planned start date.</div>
          </div>
          <Link className="badge" href="/maintenance/kanban">Open Kanban</Link>
        </div>
        {unscheduledTruncated ? (
          <p className="muted" role="status">Showing the first {UNSCHEDULED_WORK_ORDER_LIMIT} unscheduled work orders.</p>
        ) : null}
        <div className="responsive-table">
          <table className="table">
            <thead>
              <tr>
                <th>WO</th>
                <th>Priority</th>
                <th>Asset</th>
                <th>Title</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              {unscheduledWorkOrders.slice(0, UNSCHEDULED_WORK_ORDER_LIMIT).map((workOrder) => (
                <tr key={workOrder.id}>
                  <td><Link className="table-link" href={`/maintenance/${workOrder.id}`}>{workOrder.number}</Link></td>
                  <td>{workOrder.priority}</td>
                  <td>{workOrder.asset?.code ?? "—"}</td>
                  <td>{workOrder.title}</td>
                  <td><span className="badge">{workOrder.status}</span></td>
                  <td>{workOrder.assignee?.displayName ?? workOrder.team?.name ?? "Unassigned"}</td>
                  <td>{workOrder.dueAt ? localDateKey(workOrder.dueAt, timeZone) : "—"}</td>
                </tr>
              ))}
              {unscheduledWorkOrders.length === 0 ? (
                <tr><td colSpan={7}>No unscheduled active work orders.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
