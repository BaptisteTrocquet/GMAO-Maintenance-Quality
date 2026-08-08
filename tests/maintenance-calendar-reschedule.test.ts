import { describe, expect, it } from "vitest";
import {
  localDateKey,
  rescheduleWorkOrderDates,
  zonedDateTimeToUtc,
} from "@/lib/maintenance/calendar-reschedule";

const PARIS = "Europe/Paris";

describe("maintenance calendar rescheduling", () => {
  it("preserves local start and due times across the spring DST boundary", () => {
    const plannedStart = zonedDateTimeToUtc(
      { year: 2026, month: 3, day: 28, hour: 8, minute: 30, second: 0 },
      PARIS,
    );
    const dueAt = zonedDateTimeToUtc(
      { year: 2026, month: 3, day: 28, hour: 17, minute: 0, second: 0 },
      PARIS,
    );

    const result = rescheduleWorkOrderDates({
      plannedStart,
      dueAt,
      targetDateKey: "2026-03-30",
      timeZone: PARIS,
    });

    expect(result.plannedStart.toISOString()).toBe("2026-03-30T06:30:00.000Z");
    expect(result.dueAt?.toISOString()).toBe("2026-03-30T15:00:00.000Z");
    expect(localDateKey(result.plannedStart, PARIS)).toBe("2026-03-30");
  });

  it("plans unplanned work at 08:00 local without silently rewriting its due date", () => {
    const dueAt = new Date("2026-08-10T12:00:00.000Z");
    const result = rescheduleWorkOrderDates({
      plannedStart: null,
      dueAt,
      targetDateKey: "2026-08-09",
      timeZone: PARIS,
    });

    expect(result.plannedStart.toISOString()).toBe("2026-08-09T06:00:00.000Z");
    expect(result.dueAt).toBe(dueAt);
  });

  it("rejects impossible target dates", () => {
    expect(() =>
      rescheduleWorkOrderDates({
        plannedStart: null,
        dueAt: null,
        targetDateKey: "2026-02-30",
        timeZone: PARIS,
      }),
    ).toThrow("Invalid target date");
  });
});
