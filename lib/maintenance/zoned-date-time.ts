function parseLocalDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function parseLocalTime(value: string) {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function localParts(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const map = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.get("year")),
    month: Number(map.get("month")),
    day: Number(map.get("day")),
    hour: Number(map.get("hour")),
    minute: Number(map.get("minute")),
  };
}

function partsAsUtc(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

export class ZonedDateTimeError extends Error {
  constructor(
    public readonly code: "INVALID_LOCAL_DATE" | "INVALID_LOCAL_TIME" | "INVALID_TIME_ZONE" | "NONEXISTENT_LOCAL_TIME",
    message: string,
  ) {
    super(message);
    this.name = "ZonedDateTimeError";
  }
}

export function siteLocalDateTimeToUtc(input: {
  localDate: string;
  localTime: string;
  timeZone: string;
}) {
  const date = parseLocalDate(input.localDate);
  if (!date) {
    throw new ZonedDateTimeError("INVALID_LOCAL_DATE", "localDate must be a valid YYYY-MM-DD date");
  }
  const time = parseLocalTime(input.localTime);
  if (!time) {
    throw new ZonedDateTimeError("INVALID_LOCAL_TIME", "localTime must be a valid HH:mm time");
  }

  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format(new Date());
  } catch {
    throw new ZonedDateTimeError("INVALID_TIME_ZONE", "Organization time zone is invalid");
  }

  const desired = { ...date, ...time };
  const desiredUtc = partsAsUtc(desired);
  let candidate = new Date(desiredUtc);

  for (let index = 0; index < 5; index += 1) {
    const actual = localParts(candidate, input.timeZone);
    const delta = desiredUtc - partsAsUtc(actual);
    if (delta === 0) break;
    candidate = new Date(candidate.getTime() + delta);
  }

  const resolved = localParts(candidate, input.timeZone);
  if (
    resolved.year !== desired.year ||
    resolved.month !== desired.month ||
    resolved.day !== desired.day ||
    resolved.hour !== desired.hour ||
    resolved.minute !== desired.minute
  ) {
    throw new ZonedDateTimeError(
      "NONEXISTENT_LOCAL_TIME",
      "The requested local time does not exist in the organization time zone",
    );
  }

  return candidate;
}
