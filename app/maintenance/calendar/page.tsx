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
import ReschedulableCalendarDay from "./reschedulable-day";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_DAY_ITEMS = 8;

function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
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
  const serializableDays = days.map((day) => ({
    dateKey: day.dateKey,
    dayOfMonth: day.dayOfMonth,
    inMonth: day.inMonth,
    items: day.items.map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      status: item.status,
      priority: item.priority,
      assetCode: item.assetCode,
      assigneeName: item.assigneeName,
      teamName: item.teamName,
      planned: item.planned,
      due: item.due,
      plannedTime: item.plannedTime,
      dueTime: item.dueTime,
      plannedStart: item.plannedStart?.toISOString() ?? null,
      dueAt: item.dueAt?.toISOString() ?? null,
    })),
  }));
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
        <p className="muted" style={{ marginBottom: 0 }}>
          Drag a START or DUE control onto another day to reschedule it. Keyboard users can activate the same control and enter a local date. The original local clock time is preserved.
        </p>
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
            {serializableDays.map((day) => (
              <ReschedulableCalendarDay
                key={day.dateKey}
                organizationId={organizationId}
                siteId={siteId}
                timeZone={site.organization.timezone}
                day={day}
                maxItems={MAX_DAY_ITEMS}
              />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
