export type RescheduledWorkOrderDates = {
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

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
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

function pad(value: number) {
  return String(value).padStart(2, "0");
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

export function localDateKey(date: Date, timeZone: string) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function addLocalDateDays(dateKey: string, days: number) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) throw new Error(`Invalid date key: ${dateKey}`);
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function dayDifference(fromDateKey: string, toDateKey: string) {
  const from = parseDateKey(fromDateKey);
  const to = parseDateKey(toDateKey);
  if (!from || !to) throw new Error("Date keys must use YYYY-MM-DD");
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
      86_400_000,
  );
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

function shiftInstantByLocalDays(date: Date, days: number, timeZone: string) {
  const original = zonedParts(date, timeZone);
  const shiftedKey = addLocalDateDays(localDateKey(date, timeZone), days);
  const shiftedDate = parseDateKey(shiftedKey);
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

export function rescheduleWorkOrderDates(input: {
  plannedStart: Date | null;
  dueAt: Date | null;
  targetDateKey: string;
  timeZone: string;
  defaultHour?: number;
}): RescheduledWorkOrderDates {
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

  const deltaDays = dayDifference(localDateKey(input.plannedStart, input.timeZone), input.targetDateKey);
  return {
    plannedStart: shiftInstantByLocalDays(input.plannedStart, deltaDays, input.timeZone),
    dueAt: input.dueAt ? shiftInstantByLocalDays(input.dueAt, deltaDays, input.timeZone) : null,
  };
}
