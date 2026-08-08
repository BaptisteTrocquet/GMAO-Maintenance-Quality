import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  buildCalendarGrid,
  buildPlanningCalendar,
  calendarSearchRange,
  currentCalendarMonth,
  parseCalendarMonth,
  PLANNING_CALENDAR_LIMIT,
  shiftCalendarMonth,
  UNSCHEDULED_WORK_ORDER_LIMIT,
} from "@/lib/maintenance/planning-calendar";
import {
  CalendarDayDropZone,
  RescheduleControls,
} from "./calendar-rescheduling";

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
  const currentMonth = currentCalendarMonth(now, site.organization.timezone);
  const emptyGrid = buildCalendarGrid(month);
  const range = calendarSearchRange(emptyGrid);
  const previous = shiftCalendarMonth(month, -1);
  const next = shiftCalendarMonth(month, 1);

  const [workOrders, unscheduled] = await Promise.all([
    db.workOrder.findMany({
      where: {
        siteId,
        site: { organizationId, active: true },
        status: { not: "CANCELLED" },
        OR: [
          { plannedStart: { gte: range.start, lte: range.end } },
          { dueAt: { gte: range.start, lte: range.end } },
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
        assignee: { select: { displayName: true } },
        team: { select: { name: true } },
      },
      orderBy: [{ plannedStart: "asc" }, { dueAt: "asc" }, { number: "asc" }],
      take: PLANNING_CALENDAR_LIMIT + 1,
    }),
    db.workOrder.findMany({
      where: {
        siteId,
        site: { organizationId, active: true },
        plannedStart: null,
        status: { notIn: ["COMPLETED", "CANCELLED"] },
      },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        dueAt: true,
        asset: { select: { code: true } },
        assignee: { select: { displayName: true } },
        team: { select: { name: true } },
      },
      orderBy: [{ dueAt: "asc" }, { requestedAt: "asc" }],
      take: UNSCHEDULED_WORK_ORDER_LIMIT + 1,
    }),
  ]);

  const truncated = workOrders.length > PLANNING_CALENDAR_LIMIT;
  const unscheduledTruncated = unscheduled.length > UNSCHEDULED_WORK_ORDER_LIMIT;
  const visibleUnscheduled = unscheduled.slice(0, UNSCHEDULED_WORK_ORDER_LIMIT);
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
  const scheduledCount = calendar.reduce(
    (sum, day) => sum + day.items.filter((item) => item.planned).length,
    0,
  );
  const dueCount = calendar.reduce(
    (sum, day) => sum + day.items.filter((item) => item.due).length,
    0,
  );
  const moveContext = {
    organizationId,
    siteId,
    timeZone: site.organization.timezone,
  };

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
          <span className="badge">{visibleUnscheduled.length} unscheduled</span>
          {truncated ? <span className="badge">Calendar truncated</span> : null}
        </div>
      </div>

      <section className="card" aria-label="Calendar month navigation">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <Link className="table-link" href={`/maintenance/calendar?month=${previous.key}`}>
            ← {previous.key}
          </Link>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>{monthLabel(month.year, month.month)}</h2>
            {month.key !== currentMonth.key ? (
              <Link className="table-link" href={`/maintenance/calendar?month=${currentMonth.key}`}>
                Current month
              </Link>
            ) : null}
          </div>
          <Link className="table-link" href={`/maintenance/calendar?month=${next.key}`}>
            {next.key} →
          </Link>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Drag a work-order handle onto another day, or use the date field and Move button. Both paths use the existing permission-checked, audited work-order API. Existing local start times are preserved across timezone and DST changes; due dates move by the same local-day delta.
        </p>
        {truncated ? (
          <p className="muted" role="status" style={{ marginBottom: 0 }}>
            Calendar rendering is bounded to {PLANNING_CALENDAR_LIMIT} matching work orders for predictable performance.
          </p>
        ) : null}
      </section>

      <section className="section" aria-label="Monthly maintenance calendar" style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 980 }}>
          <div
            aria-hidden="true"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(140px, 1fr))",
              gap: 8,
              marginBottom: 8,
            }}
          >
            {WEEKDAYS.map((weekday) => (
              <div
                key={weekday}
                className="card"
                style={{ padding: 10, textAlign: "center", fontWeight: 700 }}
              >
                {weekday}
              </div>
            ))}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7, minmax(140px, 1fr))",
              gap: 8,
            }}
          >
            {calendar.map((day) => (
              <CalendarDayDropZone
                key={day.dateKey}
                {...moveContext}
                dateKey={day.dateKey}
                label={`${day.dateKey}, ${day.items.length} work-order marker${day.items.length === 1 ? "" : "s"}`}
                style={{
                  minHeight: 180,
                  padding: 10,
                  opacity: day.inMonth ? 1 : 0.62,
                  alignSelf: "stretch",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <strong>{day.dayOfMonth}</strong>
                  {day.items.length ? <span className="badge">{day.items.length}</span> : null}
                </div>

                <div style={{ display: "grid", gap: 8 }}>
                  {day.items.map((item) => (
                    <article
                      key={`${day.dateKey}-${item.id}`}
                      style={{
                        border: "1px solid #e5e7eb",
                        borderRadius: 8,
                        padding: 8,
                        display: "grid",
                        gap: 5,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 6,
                          alignItems: "start",
                        }}
                      >
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
                      <RescheduleControls
                        {...moveContext}
                        disabled={item.status === "COMPLETED" || item.status === "CANCELLED"}
                        workOrder={{
                          id: item.id,
                          number: item.number,
                          plannedStart: item.plannedStart?.toISOString() ?? null,
                          dueAt: item.dueAt?.toISOString() ?? null,
                        }}
                      />
                    </article>
                  ))}
                </div>
              </CalendarDayDropZone>
            ))}
          </div>
        </div>
      </section>

      <section className="section card responsive-table" aria-labelledby="unscheduled-title">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h2 id="unscheduled-title" style={{ marginTop: 0 }}>Unscheduled work</h2>
            <div className="muted">Open work orders without a planned start date.</div>
          </div>
          {unscheduledTruncated ? (
            <span className="badge">First {UNSCHEDULED_WORK_ORDER_LIMIT} shown</span>
          ) : null}
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>WO</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Asset</th>
              <th>Owner</th>
              <th>Due</th>
              <th>Planning</th>
            </tr>
          </thead>
          <tbody>
            {visibleUnscheduled.map((workOrder) => (
              <tr key={workOrder.id}>
                <td>
                  <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                    {workOrder.number} · {workOrder.title}
                  </Link>
                </td>
                <td>{workOrder.priority}</td>
                <td><span className="badge">{statusLabel(workOrder.status)}</span></td>
                <td>{workOrder.asset?.code ?? "—"}</td>
                <td>{workOrder.assignee?.displayName ?? workOrder.team?.name ?? "Unassigned"}</td>
                <td>{workOrder.dueAt ? workOrder.dueAt.toISOString().slice(0, 10) : "—"}</td>
                <td>
                  <RescheduleControls
                    {...moveContext}
                    workOrder={{
                      id: workOrder.id,
                      number: workOrder.number,
                      plannedStart: null,
                      dueAt: workOrder.dueAt?.toISOString() ?? null,
                    }}
                  />
                </td>
              </tr>
            ))}
            {visibleUnscheduled.length === 0 ? (
              <tr><td colSpan={7}>No unscheduled open work orders.</td></tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
