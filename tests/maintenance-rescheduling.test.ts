import { describe, expect, it } from "vitest";
import {
  addDaysToDateKey,
  dateKeyInTimeZone,
  dayDifference,
  rescheduleWorkOrderForDate,
  shiftInstantByLocalDays,
} from "@/lib/maintenance/rescheduling";

describe("maintenance calendar rescheduling", () => {
  it("computes local calendar-day differences across month and year boundaries", () => {
    expect(dayDifference("2026-12-31", "2027-01-02")).toBe(2);
    expect(addDaysToDateKey("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("preserves the local wall-clock start time across a DST boundary", () => {
    const original = new Date("2026-03-27T08:00:00.000Z"); // 09:00 Europe/Paris (CET)
    const shifted = shiftInstantByLocalDays(original, 3, "Europe/Paris");

    expect(shifted.toISOString()).toBe("2026-03-30T07:00:00.000Z"); // 09:00 Europe/Paris (CEST)
    expect(dateKeyInTimeZone(shifted, "Europe/Paris")).toBe("2026-03-30");
  });

  it("moves planned start and due date by the same local-day delta", () => {
    const result = rescheduleWorkOrderForDate({
      plannedStart: new Date("2026-03-27T08:00:00.000Z"),
      dueAt: new Date("2026-03-27T16:00:00.000Z"),
      targetDateKey: "2026-03-30",
      timeZone: "Europe/Paris",
    });

    expect(result.plannedStart.toISOString()).toBe("2026-03-30T07:00:00.000Z");
    expect(result.dueAt?.toISOString()).toBe("2026-03-30T15:00:00.000Z");
  });

  it("plans an unscheduled work order at 08:00 local and leaves an existing due date unchanged", () => {
    const dueAt = new Date("2026-08-20T10:00:00.000Z");
    const result = rescheduleWorkOrderForDate({
      plannedStart: null,
      dueAt,
      targetDateKey: "2026-08-18",
      timeZone: "Europe/Paris",
    });

    expect(result.plannedStart.toISOString()).toBe("2026-08-18T06:00:00.000Z");
    expect(result.dueAt).toEqual(dueAt);
  });

  it("rejects impossible calendar date keys", () => {
    expect(() =>
      rescheduleWorkOrderForDate({
        plannedStart: null,
        dueAt: null,
        targetDateKey: "2026-02-30",
        timeZone: "UTC",
      }),
    ).toThrow(/Invalid target date/);
  });
});
