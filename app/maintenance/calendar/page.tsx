import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  buildCalendarGrid,
  buildPlanningCalendar,
  buildPlanningCalendarWhere,
  calendarSearchRange,
  currentCalendarMonth,
  parseCalendarMonth,
  PLANNING_CALENDAR_LIMIT,
  shiftCalendarMonth,
} from "@/lib/maintenance/planning-calendar";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function statusLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

export default async function MaintenanceCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
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
            <div className="muted">Select an organization and site to plan work by date.</div>
          </div>
        </div>
        <section className="card"><p>Organization and site context are required.</p></section>
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

  const now = new Date();
  const { month: requestedMonth } = await searchParams;
  const month = parseCalendarMonth(requestedMonth, {
    now,
    timeZone: site.organization.timezone,
  });
  const emptyGrid = buildCalendarGrid(month);
  const range = calendarSearchRange(emptyGrid);
  const previous = shiftCalendarMonth(month, -1);
  const next = shiftCalendarMonth(month, 1);
  const current = currentCalendarMonth(now, site.organization.timezone);

  const workOrders = await db.workOrder.findMany({
    where: buildPlanningCalendarWhere({ organizationId, siteId, range }),
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      priority: true,
      plannedStart: true,
      dueAt: true,
      asset: { select: { code: true } },
      assignee: { select: { displayName: true } },
      team: { select: { name: true } },
    },
    orderBy: [{ plannedStart: "asc" }, { dueAt: "asc" }, { number: "asc" }],
    take: PLANNING_CALENDAR_LIMIT + 1,
  });

  const truncated = workOrders.length > PLANNING_CALENDAR_LIMIT;
  const calendar = buildPlanningCalendar({
    month,
    timeZone: site.organization.timezone,
    workOrders: workOrders.slice(0, PLANNING_CALENDAR_LIMIT).map((workOrder) => ({
      id: workOrder.id,
      number: workOrder.number,
      title: workOrder.title,
      status: workOrder.status,
      priority: workOrder.priority,
      plannedStart: workOrder.plannedStart,
      dueAt: workOrder.dueAt,
      assetCode: workOrder.asset?.code ?? null,
      assigneeName: workOrder.assignee?.displayName ?? null,
      teamName: workOrder.team?.name ?? null,
    })),
  });
  const scheduledCount = calendar.reduce((sum, day) => sum + day.items.filter((item) => item.planned).length, 0);
  const dueCount = calendar.reduce((sum, day) => sum + day.items.filter((item) => item.due).length, 0);

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/maintenance">← Maintenance</Link>
          <div className="title">Maintenance calendar</div>
          <div className="muted">
            {site.code} · {site.name} · {site.organization.timezone}
          </div>
        </div>
        <div className="asset-status">
          <span className="badge">{scheduledCount} planned</span>
          <span className="badge">{dueCount} due markers</span>
          {truncated ? <span className="badge">First {PLANNING_CALENDAR_LIMIT} work orders</span> : null}
        </div>
      </div>

      <section className="card" aria-label="Calendar month navigation">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <Link className="table-link" href={`/maintenance/calendar?month=${previous.key}`}>← {previous.key}</Link>
          <div style={{ textAlign: "center" }}>
            <h2 style={{ margin: 0 }}>{monthLabel(month.year, month.month)}</h2>
            {month.key !== current.key ? (
              <Link className="table-link" href={`/maintenance/calendar?month=${current.key}`}>Current month</Link>
            ) : null}
          </div>
          <Link className="table-link" href={`/maintenance/calendar?month=${next.key}`}>{next.key} →</Link>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Planned start and due dates are rendered in the selected organization timezone. Moving dates remains a separate drag-and-drop story.
        </p>
        {truncated ? (
          <p className="muted" role="status" style={{ marginBottom: 0 }}>
            Rendering is bounded to {PLANNING_CALENDAR_LIMIT} matching work orders for predictable performance.
          </p>
        ) : null}
      </section>

      <section className="section" aria-label="Monthly maintenance calendar" style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 980 }}>
          <div
            aria-hidden="true"
            style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(140px, 1fr))", gap: 8, marginBottom: 8 }}
          >
            {WEEKDAYS.map((weekday) => (
              <div key={weekday} className="card" style={{ padding: 10, textAlign: "center", fontWeight: 700 }}>
                {weekday}
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(140px, 1fr))", gap: 8 }}>
            {calendar.map((day) => (
              <section
                key={day.dateKey}
                className="card"
                aria-label={day.dateKey}
                style={{
                  minHeight: 180,
                  padding: 10,
                  opacity: day.inMonth ? 1 : 0.62,
                  alignSelf: "stretch",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                  <strong>{day.dayOfMonth}</strong>
                  {day.items.length ? <span className="badge">{day.items.length}</span> : null}
                </div>

                <div style={{ display: "grid", gap: 8 }}>
                  {day.items.map((item) => (
                    <article
                      key={`${day.dateKey}-${item.id}`}
                      style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 8, display: "grid", gap: 5 }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "start" }}>
                        <Link className="table-link" href={`/maintenance/${item.id}`}>
                          <strong>{item.number}</strong>
                        </Link>
                        <span className="badge">{item.priority}</span>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 650 }}>{item.title}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {item.assetCode ?? "No asset"} · {item.assigneeName ?? item.teamName ?? "Unassigned"}
                      </div>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {item.planned ? <span className="badge">START {item.plannedTime}</span> : null}
                        {item.due ? <span className="badge">DUE {item.dueTime}</span> : null}
                        <span className="badge">{statusLabel(item.status)}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
