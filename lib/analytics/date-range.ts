const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class AnalyticsDateRangeError extends Error {
  constructor(
    public readonly code: "INVALID_DATE" | "INVALID_RANGE" | "INVALID_TIMEZONE",
    message: string,
  ) {
    super(message);
    this.name = "AnalyticsDateRangeError";
  }
}

function parseDateParts(value: string) {
  if (!DATE_PATTERN.test(value)) {
    throw new AnalyticsDateRangeError("INVALID_DATE", "Analytics dates must use YYYY-MM-DD");
  }

  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new AnalyticsDateRangeError("INVALID_DATE", `Invalid calendar date: ${value}`);
  }
  return { year, month, day };
}

function formatterFor(timeZone: string, withTime: boolean) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(withTime
        ? {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23" as const,
          }
        : {}),
    });
  } catch {
    throw new AnalyticsDateRangeError("INVALID_TIMEZONE", `Invalid IANA timezone: ${timeZone}`);
  }
}

function localPartsAt(instant: Date, timeZone: string) {
  const values = new Map(
    formatterFor(timeZone, true).formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

function timezoneOffsetMs(instant: Date, timeZone: string) {
  const local = localPartsAt(instant, timeZone);
  return (
    Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) -
    instant.getTime()
  );
}

export function localDateStartUtc(value: string, timeZone: string) {
  const { year, month, day } = parseDateParts(value);
  const desiredAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let instant = new Date(desiredAsUtc);

  // Re-evaluate the offset around DST boundaries until the local midnight converges.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = new Date(desiredAsUtc - timezoneOffsetMs(instant, timeZone));
    if (next.getTime() === instant.getTime()) break;
    instant = next;
  }

  const local = localPartsAt(instant, timeZone);
  if (
    local.year !== year ||
    local.month !== month ||
    local.day !== day ||
    local.hour !== 0 ||
    local.minute !== 0 ||
    local.second !== 0
  ) {
    throw new AnalyticsDateRangeError(
      "INVALID_TIMEZONE",
      `Could not resolve local midnight for ${value} in ${timeZone}`,
    );
  }
  return instant;
}

export function shiftCalendarDate(value: string, days: number) {
  const { year, month, day } = parseDateParts(value);
  if (!Number.isInteger(days)) {
    throw new AnalyticsDateRangeError("INVALID_DATE", "Calendar date shifts must use whole days");
  }
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function localCalendarDate(instant: Date, timeZone: string) {
  const local = localPartsAt(instant, timeZone);
  return `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
}

export function resolveAnalyticsDateRange(input: {
  from?: string | null;
  to?: string | null;
  timeZone: string;
}) {
  if (input.from) parseDateParts(input.from);
  if (input.to) parseDateParts(input.to);
  if (input.from && input.to && input.from > input.to) {
    throw new AnalyticsDateRangeError("INVALID_RANGE", "from must be on or before to");
  }

  const from = input.from ? localDateStartUtc(input.from, input.timeZone) : null;
  const toExclusive = input.to
    ? localDateStartUtc(shiftCalendarDate(input.to, 1), input.timeZone)
    : null;

  return {
    from,
    toExclusive,
    timeZone: input.timeZone,
    input: { from: input.from ?? null, to: input.to ?? null },
  };
}
