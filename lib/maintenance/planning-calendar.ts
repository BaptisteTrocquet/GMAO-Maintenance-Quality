import { Prisma, type WorkOrderStatus } from "@prisma/client";

export type PlanningMonth = { year: number; month: number };

const ACTIVE_PLANNING_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "PLANNED",
  "IN_PROGRESS",
  "BLOCKED",
] as const satisfies readonly WorkOrderStatus[];

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function localParts(date: Date, timeZone: string): LocalDateTime {
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

export function currentPlanningMonth(now: Date, timeZone: string): PlanningMonth {
  const local = localParts(now, timeZone);
  return { year: local.year, month: local.month };
}

export function normalizePlanningMonth(year: number, month: number): PlanningMonth {
  const zeroBased = month - 1;
  return {
    year: year + Math.floor(zeroBased / 12),
    month: ((zeroBased % 12) + 12) % 12 + 1,
  };
}

export function parsePlanningMonth(value: string | undefined, fallback: PlanningMonth) {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return fallback;
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || year < 2000 || year > 2200 || month < 1 || month > 12) {
    return fallback;
  }
  return { year, month };
}

export function planningMonthKey(month: PlanningMonth) {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

export function shiftPlanningMonth(month: PlanningMonth, delta: number) {
  return normalizePlanningMonth(month.year, month.month + delta);
}

export function planningMonthRange(month: PlanningMonth, timeZone: string) {
  const next = shiftPlanningMonth(month, 1);
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

export function localDateKey(date: Date, timeZone: string) {
  const local = localParts(date, timeZone);
  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
}

export function buildPlanningCalendarWhere(input: {
  organizationId: string;
  siteId: string;
  month: PlanningMonth;
  timeZone: string;
}): Prisma.WorkOrderWhereInput {
  const { start, end } = planningMonthRange(input.month, input.timeZone);
  return {
    siteId: input.siteId,
    site: { organizationId: input.organizationId, active: true },
    status: { in: [...ACTIVE_PLANNING_STATUSES] },
    OR: [
      { plannedStart: { gte: start, lt: end } },
      { dueAt: { gte: start, lt: end } },
    ],
  };
}

export function monthGridDays(month: PlanningMonth) {
  const firstWeekday = new Date(Date.UTC(month.year, month.month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(month.year, month.month, 0)).getUTCDate();
  const mondayOffset = (firstWeekday + 6) % 7;
  return [
    ...Array.from({ length: mondayOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
}
