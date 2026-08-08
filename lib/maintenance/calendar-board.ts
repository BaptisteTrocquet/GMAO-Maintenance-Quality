import { Prisma, type Priority, type WorkOrderStatus } from "@prisma/client";

export const CALENDAR_QUERY_LIMIT = 1000;

export type PlanningMonth = { year: number; month: number };

export type MaintenanceCalendarEvent = {
  id: string;
  sourceId: string;
  kind: "WORK_ORDER_START" | "WORK_ORDER_DUE" | "PLAN_DUE";
  date: Date;
  title: string;
  label: string;
  href: string;
  status: WorkOrderStatus | "PLAN_DUE";
  priority: Priority | null;
  assetCode: string | null;
};

export type MaintenanceCalendarDay = {
  dateKey: string;
  dayOfMonth: number;
  inMonth: boolean;
};

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function localParts(date: Date, timeZone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const numberPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: numberPart("year"),
    month: numberPart("month"),
    day: numberPart("day"),
    hour: numberPart("hour"),
    minute: numberPart("minute"),
    second: numberPart("second"),
  };
}

function localDateTimeToUtc(value: LocalDateTime, timeZone: string) {
  const targetAsUtc = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
  );
  let candidate = new Date(targetAsUtc);

  for (let iteration = 0; iteration < 6; iteration += 1) {
    const actual = localParts(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const delta = targetAsUtc - actualAsUtc;
    if (delta === 0) return candidate;
    candidate = new Date(candidate.getTime() + delta);
  }

  const resolved = localParts(candidate, timeZone);
  if (
    resolved.year !== value.year ||
    resolved.month !== value.month ||
    resolved.day !== value.day ||
    resolved.hour !== value.hour ||
    resolved.minute !== value.minute
  ) {
    throw new Error("Unable to resolve planning calendar boundary in configured timezone");
  }
  return candidate;
}

export function monthKey(month: PlanningMonth) {
  return `${month.year}-${pad(month.month)}`;
}

function normalizeMonth(year: number, month: number): PlanningMonth {
  const zeroBased = month - 1;
  return {
    year: year + Math.floor(zeroBased / 12),
    month: ((zeroBased % 12) + 12) % 12 + 1,
  };
}

export function shiftCalendarMonth(month: PlanningMonth, delta: number) {
  return normalizeMonth(month.year, month.month + delta);
}

export function currentCalendarMonth(now: Date, timeZone: string): PlanningMonth {
  const local = localParts(now, timeZone);
  return { year: local.year, month: local.month };
}

export function parseCalendarMonth(
  value: string | undefined,
  input: { now: Date; timeZone: string },
): PlanningMonth {
  const fallback = currentCalendarMonth(input.now, input.timeZone);
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return fallback;
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || year < 1970 || year > 9999 || month < 1 || month > 12) {
    return fallback;
  }
  return { year, month };
}

export function calendarMonthRange(month: PlanningMonth, timeZone: string) {
  const next = shiftCalendarMonth(month, 1);
  return {
    start: localDateTimeToUtc(
      { year: month.year, month: month.month, day: 1, hour: 0, minute: 0, second: 0 },
      timeZone,
    ),
    end: localDateTimeToUtc(
      { year: next.year, month: next.month, day: 1, hour: 0, minute: 0, second: 0 },
      timeZone,
    ),
  };
}

export function localDateKey(value: Date, timeZone: string) {
  const local = localParts(value, timeZone);
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`;
}

export function buildMonthGrid(month: PlanningMonth): MaintenanceCalendarDay[] {
  const first = new Date(Date.UTC(month.year, month.month - 1, 1));
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const gridStart = new Date(Date.UTC(month.year, month.month - 1, 1 - mondayOffset));

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    const year = date.getUTCFullYear();
    const calendarMonth = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    return {
      dateKey: `${year}-${pad(calendarMonth)}-${pad(day)}`,
      dayOfMonth: day,
      inMonth: year === month.year && calendarMonth === month.month,
    };
  });
}

export function groupCalendarEvents(events: MaintenanceCalendarEvent[], timeZone: string) {
  const grouped = new Map<string, MaintenanceCalendarEvent[]>();
  for (const event of events) {
    const key = localDateKey(event.date, timeZone);
    const items = grouped.get(key) ?? [];
    items.push(event);
    grouped.set(key, items);
  }
  const kindRank = { PLAN_DUE: 0, WORK_ORDER_START: 1, WORK_ORDER_DUE: 2 } as const;
  for (const items of grouped.values()) {
    items.sort(
      (left, right) =>
        kindRank[left.kind] - kindRank[right.kind] || left.title.localeCompare(right.title),
    );
  }
  return grouped;
}

export function buildCalendarWorkOrderWhere(input: {
  organizationId: string;
  siteId: string;
  month: PlanningMonth;
  timeZone: string;
}): Prisma.WorkOrderWhereInput {
  const range = calendarMonthRange(input.month, input.timeZone);
  return {
    siteId: input.siteId,
    site: { organizationId: input.organizationId, active: true },
    status: { not: "CANCELLED" },
    OR: [
      { plannedStart: { gte: range.start, lt: range.end } },
      { dueAt: { gte: range.start, lt: range.end } },
    ],
  };
}

export function buildCalendarPlanWhere(input: {
  organizationId: string;
  siteId: string;
  month: PlanningMonth;
  timeZone: string;
}): Prisma.MaintenancePlanWhereInput {
  const range = calendarMonthRange(input.month, input.timeZone);
  return {
    active: true,
    nextDueAt: { gte: range.start, lt: range.end },
    asset: {
      archivedAt: null,
      siteId: input.siteId,
      site: { organizationId: input.organizationId, active: true },
    },
  };
}
