export type WorkOrderScheduleField = "plannedStart" | "dueAt";

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

  for (let iteration = 0; iteration < 8; iteration += 1) {
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
    throw new Error("Target local time does not exist in the configured timezone");
  }
  return candidate;
}

export function parseLocalDateKey(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("Date must use YYYY-MM-DD format");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    throw new Error("Date is not a valid calendar day");
  }
  return { year, month, day };
}

export function rescheduleInstantToLocalDate(input: {
  instant: Date;
  targetDateKey: string;
  timeZone: string;
}) {
  if (Number.isNaN(input.instant.getTime())) throw new Error("Original schedule timestamp is invalid");
  const targetDate = parseLocalDateKey(input.targetDateKey);
  const originalLocal = localParts(input.instant, input.timeZone);
  return localDateTimeToUtc(
    {
      ...originalLocal,
      ...targetDate,
    },
    input.timeZone,
  );
}

export function scheduleLocalDateAtHour(input: {
  targetDateKey: string;
  timeZone: string;
  hour?: number;
}) {
  const targetDate = parseLocalDateKey(input.targetDateKey);
  const hour = input.hour ?? 8;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("Planning hour must be between 0 and 23");
  }
  return localDateTimeToUtc(
    { ...targetDate, hour, minute: 0, second: 0 },
    input.timeZone,
  );
}

export function buildSchedulePatch(input: {
  field: WorkOrderScheduleField;
  instant: Date | null;
  targetDateKey: string;
  timeZone: string;
  defaultHour?: number;
}) {
  const value = input.instant
    ? rescheduleInstantToLocalDate({
        instant: input.instant,
        targetDateKey: input.targetDateKey,
        timeZone: input.timeZone,
      })
    : scheduleLocalDateAtHour({
        targetDateKey: input.targetDateKey,
        timeZone: input.timeZone,
        hour: input.defaultHour,
      });
  return { [input.field]: value.toISOString() } as Record<WorkOrderScheduleField, string>;
}
