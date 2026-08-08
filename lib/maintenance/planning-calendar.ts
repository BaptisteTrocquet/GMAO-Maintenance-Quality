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

export type CalendarSchedule = {
  plannedStart: Date;
  dueAt: Date | null;
};

type ZonedDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const PRIORITY_RANK: Record<Priority, number> = {
  URGENT: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

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

function formatter(timeZone: string) {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, created);
  return created;
}

function zonedParts(date: Date, timeZone: string): ZonedDateTimeParts {
  const parts = formatter(timeZone).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

function dateKeyFromParts(parts: Pick<ZonedDateTimeParts, "year" | "month" | "day">) {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function parseDateKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function localParts(date: Date, timeZone: string) {
  const parts = zonedParts(date, timeZone);
  return {
    dateKey: dateKeyFromParts(parts),
    time: `${pad(parts.hour)}:${pad(parts.minute)}`,
  };
}

export function dateKeyInTimeZone(date: Date, timeZone: string) {
  return dateKeyFromParts(zonedParts(date, timeZone));
}

export function currentCalendarMonth(now: Date, timeZone: string): PlanningCalendarMonth {
  const parts = zonedParts(now, timeZone);
  return normalizeMonth(parts.year, parts.month);
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

export function addDaysToDateKey(dateKey: string, days: number) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) throw new Error(`Invalid date key: ${dateKey}`);
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function dayDifference(fromDateKey: string, toDateKey: string) {
  const from = parseDateKey(fromDateKey);
  const to = parseDateKey(toDateKey);
  if (!from || !to) throw new Error("Date keys must use YYYY-MM-DD");
  const fromUtc = Date.UTC(from.year, from.month - 1, from.day);
  const toUtc = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

export function zonedDateTimeToUtc(parts: ZonedDateTimeParts, timeZone: string) {
  const desiredAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let guess = desiredAsUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = desiredAsUtc - actualAsUtc;
    if (correction === 0) break;
    guess += correction;
  }

  return new Date(guess);
}

export function shiftInstantByLocalDays(date: Date, days: number, timeZone: string) {
  const original = zonedParts(date, timeZone);
  const shiftedDate = parseDateKey(addDaysToDateKey(dateKeyFromParts(original), days));
  if (!shiftedDate) throw new Error("Unable to shift local date");
  return zonedDateTimeToUtc(
    {
      ...shiftedDate,
      hour: original.hour,
      minute: original.minute,
      second: original.second,
    },
    timeZone,
  );
}

export function rescheduleWorkOrderForDate(input: {
  plannedStart: Date | null;
  dueAt: Date | null;
  targetDateKey: string;
  timeZone: string;
  defaultHour?: number;
}): CalendarSchedule {
  const target = parseDateKey(input.targetDateKey);
  if (!target) throw new Error(`Invalid target date: ${input.targetDateKey}`);

  if (!input.plannedStart) {
    const defaultHour = input.defaultHour ?? 8;
    if (!Number.isInteger(defaultHour) || defaultHour < 0 || defaultHour > 23) {
      throw new Error("Default planning hour must be between 0 and 23");
    }
    return {
      plannedStart: zonedDateTimeToUtc(
        { ...target, hour: defaultHour, minute: 0, second: 0 },
        input.timeZone,
      ),
      dueAt: input.dueAt,
    };
  }

  const deltaDays = dayDifference(
    dateKeyInTimeZone(input.plannedStart, input.timeZone),
    input.targetDateKey,
  );
  return {
    plannedStart: shiftInstantByLocalDays(input.plannedStart, deltaDays, input.timeZone),
    dueAt: input.dueAt ? shiftInstantByLocalDays(input.dueAt, deltaDays, input.timeZone) : null,
  };
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
