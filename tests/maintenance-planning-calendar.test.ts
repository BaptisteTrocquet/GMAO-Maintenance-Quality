import { describe, expect, it } from "vitest";
import {
  addDaysToDateKey,
  calendarDateKeys,
  dateKeyInTimeZone,
  rescheduleWorkOrderForDate,
  startOfDateKeyInTimeZone,
  zonedDateTimeToUtc,
} from "@/lib/maintenance/planning-calendar";

const PARIS = "Europe/Paris";

describe("maintenance planning calendar", () => {
  it("builds stable date keys independently of browser/server timezone", () => {
    expect(dateKeyInTimeZone(new Date("2026-08-07T22:30:00.000Z"), PARIS)).toBe("2026-08-08");
    expect(addDaysToDateKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(calendarDateKeys("2026-08-08", 3)).toEqual([
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
    ]);
  });

  it("maps local midnight to the correct UTC instant", () => {
    expect(startOfDateKeyInTimeZone("2026-08-08", PARIS).toISOString()).toBe(
      "2026-08-07T22:00:00.000Z",
    );
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

  it("plans an unscheduled work order at 08:00 local time without silently changing its due date", () => {
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

  it("rejects invalid calendar keys", () => {
    expect(() => addDaysToDateKey("2026-02-30", 1)).toThrow("Invalid date key");
  });
});
