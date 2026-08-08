const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_KEY = /^(\d{2}):(\d{2})$/;

export class ReschedulingTimeError extends Error {
  constructor(
    public readonly code: "INVALID_DATE" | "INVALID_TIME" | "INVALID_LOCAL_TIME",
    message: string,
  ) {
    super(message);
    this.name = "ReschedulingTimeError";
  }
}

function partsInZone(date: Date, timeZone: string) {
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
  };
}

function parseDateKey(dateKey: string) {
  const match = DATE_KEY.exec(dateKey);
  if (!match) {
    throw new ReschedulingTimeError("INVALID_DATE", "dateKey must use YYYY-MM-DD");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() + 1 !== month ||
    normalized.getUTCDate() !== day
  ) {
    throw new ReschedulingTimeError("INVALID_DATE", "dateKey is not a valid calendar date");
  }
  return { year, month, day };
}

function parseTime(time: string) {
  const match = TIME_KEY.exec(time);
  if (!match) {
    throw new ReschedulingTimeError("INVALID_TIME", "time must use HH:mm");
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new ReschedulingTimeError("INVALID_TIME", "time is outside the valid clock range");
  }
  return { hour, minute };
}

export function localClockTime(date: Date, timeZone: string) {
  const parts = partsInZone(date, timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function zonedDateTimeToUtc(dateKey: string, time: string, timeZone: string) {
  const date = parseDateKey(dateKey);
  const clock = parseTime(time);
  const desiredWallClock = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    clock.hour,
    clock.minute,
    0,
    0,
  );

  let candidate = desiredWallClock;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = partsInZone(new Date(candidate), timeZone);
    const observedWallClock = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
      0,
    );
    const difference = desiredWallClock - observedWallClock;
    if (difference === 0) break;
    candidate += difference;
  }

  const result = new Date(candidate);
  const observed = partsInZone(result, timeZone);
  if (
    observed.year !== date.year ||
    observed.month !== date.month ||
    observed.day !== date.day ||
    observed.hour !== clock.hour ||
    observed.minute !== clock.minute
  ) {
    throw new ReschedulingTimeError(
      "INVALID_LOCAL_TIME",
      "The requested local time does not exist in the site timezone",
    );
  }

  return result;
}
