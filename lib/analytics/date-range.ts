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

function localPartsAt(instant: Date, timeZone: string) {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new AnalyticsDateRangeError("INVALID_TIMEZONE", `Invalid IANA timezone: ${timeZone}`);
  }

  const values = new Map(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
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
  const representedAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return representedAsUtc - instant.getTime();
}

export function localDateStartUtc(value: string, timeZone: string) {
  const { year, month, day } = parseDateParts(value);
  const desiredAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let instant = new Date(desiredAsUtc);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    instant = new Date(desiredAsUtc - timezoneOffsetMs(instant, timeZone));
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

export function nextCalendarDate(value: string) {
  const { year, month, day } = parseDateParts(value);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

export function resolveAnalyticsDateRange(input: {
  from?: string | null;
  to?: string | null;
  timeZone: string;
}) {
  const fromDate = input.from?.trim() || null;
  const toDate = input.to?.trim() || null;
  if (fromDate) parseDateParts(fromDate);
  if (toDate) parseDateParts(toDate);
  if (fromDate && toDate && fromDate > toDate) {
    throw new AnalyticsDateRangeError("INVALID_RANGE", "from must be on or before to");
  }

  const from = fromDate ? localDateStartUtc(fromDate, input.timeZone) : null;
  const toExclusive = toDate
    ? localDateStartUtc(nextCalendarDate(toDate), input.timeZone)
    : null;

  return {
    from,
    toExclusive,
    timeZone: input.timeZone,
    input: { from: fromDate, to: toDate },
  };
}
