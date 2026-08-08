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
import PlanningCalendarBoard from "./planning-calendar-board";

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
        plannedStart: true,
        dueAt: true,
        asset: { select: { code: true } },
        assignee: { select: { displayName: true } },
        team: { select: { name: true } },
      },
      orderBy: [{ dueAt: "asc" }, { priority: "desc" }],
      take: UNPLANNED_LIMIT + 1,
    }),
  ]);

  const calendarTruncated = calendarRows.length > CALENDAR_LIMIT;
  const unplannedTruncated = unplannedRows.length > UNPLANNED_LIMIT;
  const workOrders = calendarRows.slice(0, CALENDAR_LIMIT).map((workOrder) => ({
    id: workOrder.id,
    number: workOrder.number,
    title: workOrder.title,
    status: workOrder.status,
    priority: workOrder.priority,
    plannedStart: workOrder.plannedStart?.toISOString() ?? null,
    dueAt: workOrder.dueAt?.toISOString() ?? null,
    plannedDateKey: workOrder.plannedStart ? localDateKey(workOrder.plannedStart, timeZone) : null,
    dueDateKey: workOrder.dueAt ? localDateKey(workOrder.dueAt, timeZone) : null,
    plannedTime: workOrder.plannedStart ? formatTime(workOrder.plannedStart, timeZone) : null,
    assetCode: workOrder.asset?.code ?? null,
    ownerName: workOrder.assignee?.displayName ?? workOrder.team?.name ?? null,
  }));
  const unplanned = unplannedRows.slice(0, UNPLANNED_LIMIT).map((workOrder) => ({
    id: workOrder.id,
    number: workOrder.number,
    title: workOrder.title,
    status: workOrder.status,
    priority: workOrder.priority,
    plannedStart: null,
    dueAt: workOrder.dueAt?.toISOString() ?? null,
    plannedDateKey: null,
    dueDateKey: workOrder.dueAt ? localDateKey(workOrder.dueAt, timeZone) : null,
    plannedTime: null,
    assetCode: workOrder.asset?.code ?? null,
    ownerName: workOrder.assignee?.displayName ?? workOrder.team?.name ?? null,
  }));
  const gridDates = monthGridDays(selectedMonth).map((day) =>
    day === null ? null : dateKey(selectedMonth.year, selectedMonth.month, day),
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

      <PlanningCalendarBoard
        organizationId={organizationId}
        siteId={siteId}
        monthKey={planningMonthKey(selectedMonth)}
        gridDates={gridDates}
        workOrders={workOrders}
        unplanned={unplanned}
        calendarTruncated={calendarTruncated}
        unplannedTruncated={unplannedTruncated}
      />
    </>
  );
}
