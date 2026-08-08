type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

type PlanningDate = Pick<LocalDateTime, "year" | "month" | "day">;

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
    resolved.minute !== value.minute ||
    resolved.second !== value.second
  ) {
    throw new Error("Unable to resolve planning date in configured timezone");
  }
  return candidate;
}

function parsePlanningDate(value: string): PlanningDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
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

function localDayNumber(value: PlanningDate) {
  return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 86_400_000);
}

function shiftPlanningDate(value: PlanningDate, deltaDays: number): PlanningDate {
  const shifted = new Date(Date.UTC(value.year, value.month - 1, value.day + deltaDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function reschedulePlanningDates(input: {
  plannedStart: Date | null;
  dueAt: Date | null;
  targetDate: string;
  timeZone: string;
}) {
  const target = parsePlanningDate(input.targetDate);
  if (!target) throw new Error("Invalid target planning date");

  const originalStart = input.plannedStart ? localParts(input.plannedStart, input.timeZone) : null;
  const targetStart = localDateTimeToUtc(
    {
      ...target,
      hour: originalStart?.hour ?? 8,
      minute: originalStart?.minute ?? 0,
      second: originalStart?.second ?? 0,
    },
    input.timeZone,
  );

  if (!input.dueAt || !originalStart) {
    return { plannedStart: targetStart, dueAt: input.dueAt };
  }

  const originalDue = localParts(input.dueAt, input.timeZone);
  const dueDayOffset = localDayNumber(originalDue) - localDayNumber(originalStart);
  const targetDueDate = shiftPlanningDate(target, dueDayOffset);
  const targetDue = localDateTimeToUtc(
    {
      ...targetDueDate,
      hour: originalDue.hour,
      minute: originalDue.minute,
      second: originalDue.second,
    },
    input.timeZone,
  );
  return { plannedStart: targetStart, dueAt: targetDue };
}
