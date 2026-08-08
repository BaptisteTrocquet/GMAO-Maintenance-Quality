import Link from "next/link";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import {
  buildMonthGrid,
  calendarMonthRange,
  dayKey,
  groupCalendarEvents,
  type MaintenanceCalendarEvent,
} from "@/lib/maintenance/calendar-board";

const CALENDAR_QUERY_LIMIT = 1000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function searchValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function monthLabel(value: Date) {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}

function eventBadge(event: MaintenanceCalendarEvent) {
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
  const month = calendarMonthRange(searchValue((await searchParams).month));

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

  const [workOrders, maintenancePlans] = await Promise.all([
    db.workOrder.findMany({
      where: {
        siteId,
        site: { organizationId, active: true },
        status: { not: "CANCELLED" },
        OR: [
          { plannedStart: { gte: month.start, lt: month.end } },
          { dueAt: { gte: month.start, lt: month.end } },
        ],
      },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        plannedStart: true,
        dueAt: true,
        asset: { select: { code: true } },
      },
      orderBy: { requestedAt: "asc" },
      take: CALENDAR_QUERY_LIMIT + 1,
    }),
    db.maintenancePlan.findMany({
      where: {
        active: true,
        nextDueAt: { gte: month.start, lt: month.end },
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
      take: CALENDAR_QUERY_LIMIT + 1,
    }),
  ]);

  const truncated =
    workOrders.length > CALENDAR_QUERY_LIMIT || maintenancePlans.length > CALENDAR_QUERY_LIMIT;
  const events: MaintenanceCalendarEvent[] = [];

  for (const workOrder of workOrders.slice(0, CALENDAR_QUERY_LIMIT)) {
    if (workOrder.plannedStart && workOrder.plannedStart >= month.start && workOrder.plannedStart < month.end) {
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
    if (workOrder.dueAt && workOrder.dueAt >= month.start && workOrder.dueAt < month.end) {
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

  for (const plan of maintenancePlans.slice(0, CALENDAR_QUERY_LIMIT)) {
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

  const grouped = groupCalendarEvents(events);
  const grid = buildMonthGrid(month.start);
  const currentMonth = month.start.getUTCMonth();

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/maintenance">← Maintenance</Link>
          <div className="title">Maintenance calendar</div>
          <div className="muted">Work-order starts, due dates and preventive plan due dates.</div>
        </div>
        <div className="asset-status">
          <span className="badge">{events.length} events</span>
          {truncated ? <span className="badge">Query limit reached</span> : null}
        </div>
      </div>

      <section className="card" aria-label="Calendar month navigation">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <Link className="badge" href={`/maintenance/calendar?month=${month.previousKey}`}>← Previous</Link>
          <h2 style={{ margin: 0 }}>{monthLabel(month.start)}</h2>
          <Link className="badge" href={`/maintenance/calendar?month=${month.nextKey}`}>Next →</Link>
        </div>
        {truncated ? (
          <p className="muted" role="status" style={{ marginBottom: 0, marginTop: 10 }}>
            This month reached the {CALENDAR_QUERY_LIMIT}-record safety bound for at least one source. Use the Kanban and filters for a narrower operational view.
          </p>
        ) : null}
      </section>

      <section className="section responsive-table" aria-label={`${monthLabel(month.start)} maintenance calendar`}>
        <div style={{ minWidth: 980 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(140px, 1fr))", gap: 8, marginBottom: 8 }}>
            {WEEKDAYS.map((weekday) => (
              <div className="card" key={weekday} style={{ padding: 10, textAlign: "center", fontWeight: 700 }}>
                {weekday}
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(140px, 1fr))", gap: 8 }}>
            {grid.map((date) => {
              const key = dayKey(date);
              const dayEvents = grouped.get(key) ?? [];
              const outsideMonth = date.getUTCMonth() !== currentMonth;
              return (
                <section
                  className="card"
                  key={key}
                  aria-label={`${key}, ${dayEvents.length} maintenance events`}
                  style={{ minHeight: 150, padding: 10, opacity: outsideMonth ? 0.55 : 1 }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <strong>{date.getUTCDate()}</strong>
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
    </>
  );
}
