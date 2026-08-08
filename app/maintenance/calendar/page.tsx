import Link from "next/link";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import {
  buildCalendarGrid,
  buildPlanningCalendar,
  buildPlanningCalendarWhere,
  calendarSearchRange,
  parseCalendarMonth,
  PLANNING_CALENDAR_LIMIT,
  shiftCalendarMonth,
} from "@/lib/maintenance/planning-calendar";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_DAY_ITEMS = 8;

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

function eventTiming(item: {
  planned: boolean;
  due: boolean;
  plannedTime: string | null;
  dueTime: string | null;
}) {
  const values: string[] = [];
  if (item.planned) values.push(`Start${item.plannedTime ? ` ${item.plannedTime}` : ""}`);
  if (item.due) values.push(`Due${item.dueTime ? ` ${item.dueTime}` : ""}`);
  return values.join(" · ");
}

export default async function PlanningCalendarPage({
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
            <div className="title">Planning calendar</div>
            <div className="muted">Monthly planned starts and due dates for work orders.</div>
          </div>
        </div>
        <section className="card">
          <p>Select an organization and site to view the planning calendar.</p>
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
  if (!site) {
    return (
      <section className="card">
        <h1>Planning calendar</h1>
        <p className="muted">The selected site is not available in this organization.</p>
      </section>
    );
  }

  const rawMonth = (await searchParams).month;
  const monthValue = Array.isArray(rawMonth) ? rawMonth[0] : rawMonth;
  const month = parseCalendarMonth(monthValue, {
    now: new Date(),
    timeZone: site.organization.timezone,
  });
  const emptyGrid = buildCalendarGrid(month);
  const range = calendarSearchRange(emptyGrid);

  const matches = await db.workOrder.findMany({
    where: buildPlanningCalendarWhere({
      organizationId,
      siteId,
      start: range.start,
      end: range.end,
    }),
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

  const truncated = matches.length > PLANNING_CALENDAR_LIMIT;
  const workOrders = matches.slice(0, PLANNING_CALENDAR_LIMIT);
  const days = buildPlanningCalendar({
    month,
    timeZone: site.organization.timezone,
    workOrders: workOrders.map((workOrder) => ({
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
  const previous = shiftCalendarMonth(month, -1);
  const next = shiftCalendarMonth(month, 1);

  return (
    <>
      <div className="header asset-header">
        <div>
          <div className="title">Planning calendar</div>
          <div className="muted">
            {site.code} · {site.name} · timezone {site.organization.timezone}
          </div>
        </div>
        <div className="asset-status">
          <span className="badge">{workOrders.length} work orders</span>
          <span className="badge">{monthLabel(month.year, month.month)}</span>
        </div>
      </div>

      <section className="card" aria-label="Calendar month navigation">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <Link className="table-link" href={`/maintenance/calendar?month=${previous.key}`} aria-label={`Previous month, ${monthLabel(previous.year, previous.month)}`}>
            ← {monthLabel(previous.year, previous.month)}
          </Link>
          <strong>{monthLabel(month.year, month.month)}</strong>
          <Link className="table-link" href={`/maintenance/calendar?month=${next.key}`} aria-label={`Next month, ${monthLabel(next.year, next.month)}`}>
            {monthLabel(next.year, next.month)} →
          </Link>
        </div>
      </section>

      {truncated ? (
        <section className="card" role="status">
          <strong>Calendar result limit reached.</strong>{" "}
          <span className="muted">
            Showing the first {PLANNING_CALENDAR_LIMIT} matching work orders for this six-week window.
          </span>
        </section>
      ) : null}

      <section className="section responsive-table" aria-label={`${monthLabel(month.year, month.month)} work-order calendar`}>
        <div style={{ minWidth: 980 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(140px, 1fr))", gap: 8, marginBottom: 8 }}>
            {WEEKDAYS.map((weekday) => (
              <div className="card" key={weekday} style={{ padding: 8, textAlign: "center" }}>
                <strong>{weekday}</strong>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(140px, 1fr))", gap: 8 }}>
            {days.map((day) => {
              const hiddenCount = Math.max(day.items.length - MAX_DAY_ITEMS, 0);
              return (
                <section
                  className="card"
                  key={day.dateKey}
                  aria-label={`${day.dateKey}, ${day.items.length} work-order event${day.items.length === 1 ? "" : "s"}`}
                  style={{ minHeight: 170, padding: 10, opacity: day.inMonth ? 1 : 0.62 }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                    <strong>{day.dayOfMonth}</strong>
                    {day.items.length ? <span className="badge">{day.items.length}</span> : null}
                  </div>
                  <div style={{ display: "grid", gap: 7, marginTop: 8 }}>
                    {day.items.slice(0, MAX_DAY_ITEMS).map((item) => (
                      <article key={`${day.dateKey}-${item.id}`} style={{ borderTop: "1px solid #e5e7eb", paddingTop: 7 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                          <Link className="table-link" href={`/maintenance/${item.id}`}>
                            {item.number}
                          </Link>
                          <span className="badge">{item.priority}</span>
                        </div>
                        <div style={{ fontSize: 13, marginTop: 3 }}>{item.title}</div>
                        <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                          {eventTiming(item)} · {statusLabel(item.status)}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {item.assetCode ?? "No asset"} · {item.assigneeName ?? item.teamName ?? "Unassigned"}
                        </div>
                      </article>
                    ))}
                    {hiddenCount ? <div className="muted">+{hiddenCount} more on this day</div> : null}
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
