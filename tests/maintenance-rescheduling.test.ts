import { describe, expect, it } from "vitest";
import {
  addDaysToDateKey,
  dateKeyInTimeZone,
  rescheduleWorkOrderForDate,
  zonedDateTimeToUtc,
} from "@/lib/maintenance/rescheduling";

const PARIS = "Europe/Paris";

describe("maintenance calendar rescheduling", () => {
  it("builds stable local date keys and validates calendar dates", () => {
    expect(dateKeyInTimeZone(new Date("2026-08-07T22:30:00.000Z"), PARIS)).toBe("2026-08-08");
    expect(addDaysToDateKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => addDaysToDateKey("2026-02-30", 1)).toThrow("Invalid date key");
  });

  it("preserves local start and due times when moved across a DST boundary", () => {
    const plannedStart = zonedDateTimeToUtc(
      { year: 2026, month: 3, day: 28, hour: 8, minute: 30, second: 0 },
      PARIS,
    );
    const dueAt = zonedDateTimeToUtc(
      { year: 2026, month: 3, day: 28, hour: 17, minute: 0, second: 0 },
      PARIS,
    );

    const result = rescheduleWorkOrderForDate({
      plannedStart,
      dueAt,
      targetDateKey: "2026-03-30",
      timeZone: PARIS,
    });

    expect(result.plannedStart.toISOString()).toBe("2026-03-30T06:30:00.000Z");
    expect(result.dueAt?.toISOString()).toBe("2026-03-30T15:00:00.000Z");
    expect(dateKeyInTimeZone(result.plannedStart, PARIS)).toBe("2026-03-30");
  });

  it("shifts an existing due date by the same local calendar-day delta", () => {
    const result = rescheduleWorkOrderForDate({
      plannedStart: new Date("2026-08-08T06:00:00.000Z"),
      dueAt: new Date("2026-08-09T14:00:00.000Z"),
      targetDateKey: "2026-08-11",
      timeZone: PARIS,
    });

    expect(dateKeyInTimeZone(result.plannedStart, PARIS)).toBe("2026-08-11");
    expect(dateKeyInTimeZone(result.dueAt as Date, PARIS)).toBe("2026-08-12");
  });

  it("plans unscheduled work at 08:00 local without silently changing its due date", () => {
    const dueAt = new Date("2026-08-10T12:00:00.000Z");
    const result = rescheduleWorkOrderForDate({
      plannedStart: null,
      dueAt,
      targetDateKey: "2026-08-09",
      timeZone: PARIS,
    });

    expect(result.plannedStart.toISOString()).toBe("2026-08-09T06:00:00.000Z");
    expect(result.dueAt).toBe(dueAt);
  });
});
