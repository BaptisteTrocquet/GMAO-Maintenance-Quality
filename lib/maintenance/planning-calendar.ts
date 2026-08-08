import type { Priority, WorkOrderStatus } from "@prisma/client";

export const PLANNING_CALENDAR_LIMIT = 1000;
export const UNSCHEDULED_WORK_ORDER_LIMIT = 100;

export type PlanningCalendarMonth = {
  year: number;
  month: number;
  key: string;
};

export type PlanningCalendarWorkOrder = {
  id: string;
  number: string;
  title: string;
  status: WorkOrderStatus;
  priority: Priority;
  plannedStart: Date | null;
  dueAt: Date | null;
  assetCode: string | null;
  assigneeName: string | null;
  teamName: string | null;
};

export type PlanningCalendarItem = PlanningCalendarWorkOrder & {
  dateKey: string;
  planned: boolean;
  due: boolean;
  plannedTime: string | null;
  dueTime: string | null;
};

export type PlanningCalendarDay = {
  dateKey: string;
  dayOfMonth: number;
  inMonth: boolean;
  items: PlanningCalendarItem[];
};

const PRIORITY_RANK: Record<Priority, number> = {
  URGENT: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function monthKey(year: number, month: number) {
  return `${year}-${pad(month)}`;
}

function normalizeMonth(year: number, month: number): PlanningCalendarMonth {
  const normalized = new Date(Date.UTC(year, month - 1, 1));
  const normalizedYear = normalized.getUTCFullYear();
  const normalizedMonth = normalized.getUTCMonth() + 1;
  return {
    year: normalizedYear,
    month: normalizedMonth,
    key: monthKey(normalizedYear, normalizedMonth),
  };
}

function localParts(date: Date, timeZone: string) {
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
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
    second: Number(value("second")),
    dateKey: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}

function resolveLocalDateTime(input: {
  dateKey: string;
  time: string;
  timeZone: string;
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateKey) || !/^\d{2}:\d{2}$/.test(input.time)) {
    throw new Error("Invalid local planning date or time");
  }
  const [year, month, day] = input.dateKey.split("-").map(Number);
  const [hour, minute] = input.time.split(":").map(Number);
  if (
    !year ||
    !month ||
    !day ||
    hour === undefined ||
    minute === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error("Invalid local planning date or time");
  }

  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = new Date(targetAsUtc);
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const actual = localParts(candidate, input.timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      0,
    );
    const delta = targetAsUtc - actualAsUtc;
    if (delta === 0) return candidate;
    candidate = new Date(candidate.getTime() + delta);
  }

  const resolved = localParts(candidate, input.timeZone);
  if (resolved.dateKey !== input.dateKey || resolved.time !== input.time) {
    throw new Error("Selected local planning time does not exist in the configured timezone");
  }
  return candidate;
}

export function movePlannedStartToDate(input: {
  plannedStart: Date | null;
  targetDateKey: string;
  timeZone: string;
  defaultTime?: string;
}) {
  const time = input.plannedStart
    ? localParts(input.plannedStart, input.timeZone).time
    : (input.defaultTime ?? "08:00");
  return resolveLocalDateTime({
    dateKey: input.targetDateKey,
    time,
    timeZone: input.timeZone,
  });
}

export function currentCalendarMonth(now: Date, timeZone: string): PlanningCalendarMonth {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  return normalizeMonth(year, month);
}

export function parseCalendarMonth(
  value: string | undefined,
  input: { now: Date; timeZone: string },
): PlanningCalendarMonth {
  if (value && /^\d{4}-\d{2}$/.test(value)) {
    const [yearText, monthText] = value.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    if (year >= 1970 && year <= 9999 && month >= 1 && month <= 12) {
      return normalizeMonth(year, month);
    }
  }
  return currentCalendarMonth(input.now, input.timeZone);
}

export function shiftCalendarMonth(value: PlanningCalendarMonth, delta: number) {
  return normalizeMonth(value.year, value.month + delta);
}

export function buildCalendarGrid(month: PlanningCalendarMonth): PlanningCalendarDay[] {
  const first = new Date(Date.UTC(month.year, month.month - 1, 1));
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.getTime() - mondayOffset * 24 * 60 * 60 * 1000);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getTime() + index * 24 * 60 * 60 * 1000);
    const year = date.getUTCFullYear();
    const currentMonth = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    return {
      dateKey: `${year}-${pad(currentMonth)}-${pad(day)}`,
      dayOfMonth: day,
      inMonth: year === month.year && currentMonth === month.month,
      items: [],
    };
  });
}

export function calendarSearchRange(days: PlanningCalendarDay[]) {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) throw new Error("Calendar grid cannot be empty");

  const start = new Date(`${first.dateKey}T00:00:00.000Z`);
  const end = new Date(`${last.dateKey}T23:59:59.999Z`);
  // The nominal grid is calendar-local. Widen by 18h to safely cover every IANA UTC offset.
  return {
    start: new Date(start.getTime() - 18 * 60 * 60 * 1000),
    end: new Date(end.getTime() + 18 * 60 * 60 * 1000),
  };
}

function compareItems(left: PlanningCalendarItem, right: PlanningCalendarItem) {
  const byPriority = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
  if (byPriority !== 0) return byPriority;
  if (left.planned !== right.planned) return left.planned ? -1 : 1;
  return left.number.localeCompare(right.number);
}

export function buildPlanningCalendar(input: {
  month: PlanningCalendarMonth;
  timeZone: string;
  workOrders: PlanningCalendarWorkOrder[];
}) {
  const days = buildCalendarGrid(input.month);
  const dayMap = new Map(days.map((day) => [day.dateKey, day]));

  for (const workOrder of input.workOrders) {
    if (workOrder.status === "CANCELLED") continue;

    const planned = workOrder.plannedStart ? localParts(workOrder.plannedStart, input.timeZone) : null;
    const due = workOrder.dueAt ? localParts(workOrder.dueAt, input.timeZone) : null;
    const keys = new Set([planned?.dateKey, due?.dateKey].filter((key): key is string => Boolean(key)));

    for (const dateKey of keys) {
      const day = dayMap.get(dateKey);
      if (!day) continue;
      day.items.push({
        ...workOrder,
        dateKey,
        planned: planned?.dateKey === dateKey,
        due: due?.dateKey === dateKey,
        plannedTime: planned?.dateKey === dateKey ? planned.time : null,
        dueTime: due?.dateKey === dateKey ? due.time : null,
      });
    }
  }

  for (const day of days) day.items.sort(compareItems);
  return days;
}
