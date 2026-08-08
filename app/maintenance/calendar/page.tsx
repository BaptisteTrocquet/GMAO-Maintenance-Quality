import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  buildPlanningCalendarWhere,
  currentPlanningMonth,
  localDateKey,
  monthGridDays,
  parsePlanningMonth,
  planningMonthKey,
  shiftPlanningMonth,
} from "@/lib/maintenance/planning-calendar";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ACTIVE_STATUSES = ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] as const;
const CALENDAR_LIMIT = 500;
const UNPLANNED_LIMIT = 50;

function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatTime(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
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
            <div className="muted">Select an organization and site to plan maintenance work.</div>
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

  const timeZone = site.organization.timezone;
  const fallbackMonth = currentPlanningMonth(new Date(), timeZone);
  const selectedMonth = parsePlanningMonth((await searchParams).month, fallbackMonth);
  const previousMonth = shiftPlanningMonth(selectedMonth, -1);
  const nextMonth = shiftPlanningMonth(selectedMonth, 1);

  const [calendarRows, unplannedRows] = await Promise.all([
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
        asset: { select: { code: true } },
        assignee: { select: { displayName: true } },
        team: { select: { name: true } },
      },
      orderBy: [{ plannedStart: "asc" }, { dueAt: "asc" }, { priority: "desc" }],
      take: CALENDAR_LIMIT + 1,
    }),
    db.workOrder.findMany({
      where: {
        siteId,
        site: { organizationId, active: true },
        status: { in: [...ACTIVE_STATUSES] },
        plannedStart: null,
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
      orderBy: [{ dueAt: "asc" }, { priority: "desc" }],
      take: UNPLANNED_LIMIT + 1,
    }),
  ]);

  const truncated = calendarRows.length > CALENDAR_LIMIT;
  const unplannedTruncated = unplannedRows.length > UNPLANNED_LIMIT;
  const workOrders = calendarRows.slice(0, CALENDAR_LIMIT);
  const unplanned = unplannedRows.slice(0, UNPLANNED_LIMIT);

  type CalendarEntry = {
    key: string;
    kind: "START" | "DUE";
    workOrder: (typeof workOrders)[number];
    at: Date;
  };
  const entriesByDate = new Map<string, CalendarEntry[]>();
  const addEntry = (entry: CalendarEntry) => {
    const key = localDateKey(entry.at, timeZone);
    entriesByDate.set(key, [...(entriesByDate.get(key) ?? []), entry]);
  };

  for (const workOrder of workOrders) {
    if (workOrder.plannedStart) {
      addEntry({
        key: `${workOrder.id}-start`,
        kind: "START",
        workOrder,
        at: workOrder.plannedStart,
      });
    }
    if (workOrder.dueAt) {
      addEntry({
        key: `${workOrder.id}-due`,
        kind: "DUE",
        workOrder,
        at: workOrder.dueAt,
      });
    }
  }

  const gridDays = monthGridDays(selectedMonth);
  while (gridDays.length % 7 !== 0) gridDays.push(null);
  const weeks = Array.from({ length: gridDays.length / 7 }, (_, index) =>
    gridDays.slice(index * 7, index * 7 + 7),
  );

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/maintenance">← Maintenance</Link>
          <div className="title">Maintenance calendar</div>
          <div className="muted">
            {site.code} · {site.name} · {timeZone}
          </div>
        </div>
        <div className="asset-status">
          <Link className="table-link" href={`/maintenance/calendar?month=${planningMonthKey(previousMonth)}`}>← Previous</Link>
          <span className="badge">{monthLabel(selectedMonth.year, selectedMonth.month)}</span>
          <Link className="table-link" href={`/maintenance/calendar?month=${planningMonthKey(nextMonth)}`}>Next →</Link>
        </div>
      </div>

      <section className="card responsive-table" aria-label="Monthly maintenance planning calendar">
        {truncated ? (
          <p className="muted" role="status">
            The calendar is bounded to the first {CALENDAR_LIMIT} matching work orders. Narrow the planning scope before rescheduling large backlogs.
          </p>
        ) : null}
        <table className="table" style={{ minWidth: 1050, tableLayout: "fixed" }}>
          <thead>
            <tr>
              {WEEKDAYS.map((weekday) => <th key={weekday} scope="col">{weekday}</th>)}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, weekIndex) => (
              <tr key={weekIndex}>
                {week.map((day, dayIndex) => {
                  if (day === null) {
                    return <td key={`empty-${dayIndex}`} aria-hidden="true" style={{ minHeight: 140 }} />;
                  }
                  const key = dateKey(selectedMonth.year, selectedMonth.month, day);
                  const entries = entriesByDate.get(key) ?? [];
                  return (
                    <td key={key} style={{ verticalAlign: "top", minHeight: 140, padding: 8 }}>
                      <div style={{ fontWeight: 700, marginBottom: 8 }}>{day}</div>
                      <div className="stack-list" style={{ gap: 6 }}>
                        {entries.map((entry) => (
                          <Link
                            key={entry.key}
                            href={`/maintenance/${entry.workOrder.id}`}
                            className="table-link"
                            style={{
                              display: "block",
                              border: "1px solid #e5e7eb",
                              borderRadius: 8,
                              padding: 7,
                              textDecoration: "none",
                            }}
                          >
                            <strong>{entry.kind === "START" ? "Start" : "Due"} {formatTime(entry.at, timeZone)}</strong>
                            <div>{entry.workOrder.number} · {entry.workOrder.title}</div>
                            <div className="muted">
                              {entry.workOrder.asset?.code ?? "No asset"} · {entry.workOrder.assignee?.displayName ?? entry.workOrder.team?.name ?? "Unassigned"}
                            </div>
                            <span className="badge">{entry.workOrder.priority}</span>
                          </Link>
                        ))}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card section responsive-table">
        <div className="header" style={{ marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>Unplanned backlog</h2>
            <div className="muted">Active work orders without a planned start date.</div>
          </div>
          <span className="badge">{unplanned.length}{unplannedTruncated ? "+" : ""}</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>WO</th>
              <th>Priority</th>
              <th>Asset</th>
              <th>Owner</th>
              <th>Due</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {unplanned.map((workOrder) => (
              <tr key={workOrder.id}>
                <td>
                  <Link className="table-link" href={`/maintenance/${workOrder.id}`}>
                    {workOrder.number} · {workOrder.title}
                  </Link>
                </td>
                <td>{workOrder.priority}</td>
                <td>{workOrder.asset?.code ?? "—"}</td>
                <td>{workOrder.assignee?.displayName ?? workOrder.team?.name ?? "Unassigned"}</td>
                <td>{workOrder.dueAt ? localDateKey(workOrder.dueAt, timeZone) : "—"}</td>
                <td><span className="badge">{workOrder.status}</span></td>
              </tr>
            ))}
            {unplanned.length === 0 ? (
              <tr><td colSpan={6}>No unplanned active work orders.</td></tr>
            ) : null}
          </tbody>
        </table>
        {unplannedTruncated ? (
          <p className="muted" role="status" style={{ marginBottom: 0 }}>
            Showing the first {UNPLANNED_LIMIT} unplanned work orders.
          </p>
        ) : null}
      </section>
    </>
  );
}