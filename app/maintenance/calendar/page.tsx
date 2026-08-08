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
import SavedPlanningViews from "@/app/maintenance/saved-planning-views";
import PlanningCalendarClient from "./planning-calendar-client";

function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
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

  const clientDays = calendar.map((day) => ({
    dateKey: day.dateKey,
    dayOfMonth: day.dayOfMonth,
    inMonth: day.inMonth,
    items: day.items.map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title,
      status: item.status,
      priority: item.priority,
      plannedStart: item.plannedStart?.toISOString() ?? null,
      dueAt: item.dueAt?.toISOString() ?? null,
      assetCode: item.assetCode,
      assigneeName: item.assigneeName,
      teamName: item.teamName,
      planned: item.planned,
      due: item.due,
      plannedTime: item.plannedTime,
      dueTime: item.dueTime,
    })),
  }));
  const clientUnscheduled = visibleUnscheduled.map((workOrder) => ({
    id: workOrder.id,
    number: workOrder.number,
    title: workOrder.title,
    status: workOrder.status,
    priority: workOrder.priority,
    plannedStart: null,
    dueAt: workOrder.dueAt?.toISOString() ?? null,
    assetCode: workOrder.asset?.code ?? null,
    assigneeName: workOrder.assignee?.displayName ?? null,
    teamName: workOrder.team?.name ?? null,
  }));

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
          Drag a planned work order to another day, or use its date field and Move button. All changes go through the existing permission-checked, audited work-order API.
        </p>
        <SavedPlanningViews
          organizationId={organizationId}
          siteId={siteId}
          surface="CALENDAR"
          currentConfig={{ month: month.key }}
        />
        {truncated ? (
          <p className="muted" role="status" style={{ marginBottom: 0 }}>
            Calendar rendering is bounded to {PLANNING_CALENDAR_LIMIT} matching work orders for predictable performance.
          </p>
        ) : null}
      </section>

      <PlanningCalendarClient
        organizationId={organizationId}
        siteId={siteId}
        timeZone={site.organization.timezone}
        days={clientDays}
        unscheduled={clientUnscheduled}
        unscheduledTruncated={unscheduledTruncated}
        unscheduledLimit={UNSCHEDULED_WORK_ORDER_LIMIT}
      />
    </>
  );
}
