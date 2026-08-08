import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  addDaysToDateKey,
  calendarDateKeys,
  dateKeyInTimeZone,
  isDateKey,
  PLANNING_CALENDAR_DAYS,
  PLANNING_CALENDAR_LIMIT,
  startOfDateKeyInTimeZone,
} from "@/lib/maintenance/planning-calendar";
import CalendarPlanner from "./calendar-planner";

const ACTIVE_STATUSES = ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] as const;
const UNSCHEDULED_LIMIT = 60;

function dateLabel(dateKey: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${dateKey}T00:00:00.000Z`));
}

export default async function MaintenanceCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ start?: string }>;
}) {
  const requestHeaders = await headers();
  const organizationId = requestHeaders.get("x-organization-id") ?? "";
  const siteId = requestHeaders.get("x-site-id") ?? "";
  const { start } = await searchParams;

  if (!organizationId || !siteId) {
    return (
      <>
        <div className="header">
          <div>
            <div className="title">Calendar planning</div>
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
  const todayKey = dateKeyInTimeZone(new Date(), timeZone);
  const startKey = start && isDateKey(start) ? start : todayKey;
  const endKey = addDaysToDateKey(startKey, PLANNING_CALENDAR_DAYS);
  const rangeStart = startOfDateKeyInTimeZone(startKey, timeZone);
  const rangeEnd = startOfDateKeyInTimeZone(endKey, timeZone);
  const dayKeys = calendarDateKeys(startKey);

  const scope = {
    siteId,
    site: { organizationId, active: true },
    status: { in: [...ACTIVE_STATUSES] },
  } as const;

  const [scheduledRows, unscheduledRows] = await Promise.all([
    db.workOrder.findMany({
      where: {
        ...scope,
        plannedStart: { gte: rangeStart, lt: rangeEnd },
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
      orderBy: [{ plannedStart: "asc" }, { priority: "desc" }],
      take: PLANNING_CALENDAR_LIMIT + 1,
    }),
    db.workOrder.findMany({
      where: {
        ...scope,
        plannedStart: null,
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
      orderBy: [{ priority: "desc" }, { dueAt: "asc" }, { requestedAt: "asc" }],
      take: UNSCHEDULED_LIMIT + 1,
    }),
  ]);

  const scheduledTruncated = scheduledRows.length > PLANNING_CALENDAR_LIMIT;
  const unscheduledTruncated = unscheduledRows.length > UNSCHEDULED_LIMIT;

  function serialize(row: (typeof scheduledRows)[number]) {
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      status: row.status,
      priority: row.priority,
      plannedStart: row.plannedStart?.toISOString() ?? null,
      dueAt: row.dueAt?.toISOString() ?? null,
      assetCode: row.asset?.code ?? null,
      assigneeName: row.assignee?.displayName ?? null,
      teamName: row.team?.name ?? null,
    };
  }

  const days = dayKeys.map((key) => ({ key, label: dateLabel(key) }));
  const previousStart = addDaysToDateKey(startKey, -PLANNING_CALENDAR_DAYS);
  const nextStart = addDaysToDateKey(startKey, PLANNING_CALENDAR_DAYS);

  return (
    <>
      <div className="header asset-header">
        <div>
          <Link className="muted" href="/maintenance">← Maintenance</Link>
          <div className="title">Calendar planning</div>
          <div className="muted">
            {site.code} · {site.name} · {timeZone} · {dateLabel(startKey)} → {dateLabel(addDaysToDateKey(endKey, -1))}
          </div>
        </div>
        <div className="asset-status">
          <span className="badge">{Math.min(scheduledRows.length, PLANNING_CALENDAR_LIMIT)} planned</span>
          <span className="badge">{Math.min(unscheduledRows.length, UNSCHEDULED_LIMIT)} unplanned</span>
        </div>
      </div>

      <nav className="card" aria-label="Calendar range" style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <Link className="table-link" href={`/maintenance/calendar?start=${previousStart}`}>← Previous 14 days</Link>
          <Link className="table-link" href={`/maintenance/calendar?start=${todayKey}`}>Today</Link>
          <Link className="table-link" href={`/maintenance/calendar?start=${nextStart}`}>Next 14 days →</Link>
        </div>
        {scheduledTruncated || unscheduledTruncated ? (
          <p className="muted" role="status" style={{ marginBottom: 0 }}>
            Rendering is bounded to {PLANNING_CALENDAR_LIMIT} scheduled and {UNSCHEDULED_LIMIT} unplanned work orders for predictable performance.
          </p>
        ) : null}
      </nav>

      <CalendarPlanner
        organizationId={organizationId}
        siteId={siteId}
        timeZone={timeZone}
        days={days}
        workOrders={scheduledRows.slice(0, PLANNING_CALENDAR_LIMIT).map(serialize)}
        unscheduled={unscheduledRows.slice(0, UNSCHEDULED_LIMIT).map(serialize)}
      />
    </>
  );
}
