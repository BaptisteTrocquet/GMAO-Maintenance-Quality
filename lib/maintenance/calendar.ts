import type { MaintenanceFrequencyUnit } from "@prisma/client";

export type CalendarFrequencyUnit = Exclude<MaintenanceFrequencyUnit, "METER">;

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
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeMonth(year: number, month: number) {
  const zeroBased = month - 1;
  const normalizedYear = year + Math.floor(zeroBased / 12);
  const normalizedMonth = ((zeroBased % 12) + 12) % 12 + 1;
  return { year: normalizedYear, month: normalizedMonth };
}

function addCalendarUnits(
  value: LocalDateTime,
  frequencyValue: number,
  frequencyUnit: CalendarFrequencyUnit,
): LocalDateTime {
  if (frequencyUnit === "DAY" || frequencyUnit === "WEEK") {
    const days = frequencyUnit === "DAY" ? frequencyValue : frequencyValue * 7;
    const utc = new Date(
      Date.UTC(value.year, value.month - 1, value.day + days, value.hour, value.minute, value.second),
    );
    return {
      year: utc.getUTCFullYear(),
      month: utc.getUTCMonth() + 1,
      day: utc.getUTCDate(),
      hour: value.hour,
      minute: value.minute,
      second: value.second,
    };
  }

  const monthIncrement = frequencyUnit === "MONTH" ? frequencyValue : frequencyValue * 12;
  const normalized = normalizeMonth(value.year, value.month + monthIncrement);
  return {
    ...value,
    year: normalized.year,
    month: normalized.month,
    day: Math.min(value.day, daysInMonth(normalized.year, normalized.month)),
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
    throw new Error("Unable to resolve preventive due date in configured timezone");
  }
  return candidate;
}

export function advanceCalendarDue(input: {
  currentDueAt: Date;
  frequencyValue: number;
  frequencyUnit: CalendarFrequencyUnit;
  timeZone: string;
}) {
  if (!Number.isInteger(input.frequencyValue) || input.frequencyValue <= 0) {
    throw new Error("frequencyValue must be a positive integer");
  }

  const currentLocal = localParts(input.currentDueAt, input.timeZone);
  const nextLocal = addCalendarUnits(currentLocal, input.frequencyValue, input.frequencyUnit);
  return localDateTimeToUtc(nextLocal, input.timeZone);
}

export function calendarDueSequence(input: {
  firstDueAt: Date;
  frequencyValue: number;
  frequencyUnit: CalendarFrequencyUnit;
  timeZone: string;
  count: number;
}) {
  const dates = [input.firstDueAt];
  while (dates.length < input.count) {
    dates.push(
      advanceCalendarDue({
        currentDueAt: dates[dates.length - 1]!,
        frequencyValue: input.frequencyValue,
        frequencyUnit: input.frequencyUnit,
        timeZone: input.timeZone,
      }),
    );
  }
  return dates;
}
