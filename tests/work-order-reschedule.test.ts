import { describe, expect, it } from "vitest";
import { reschedulePlanningDates } from "@/lib/work-orders/reschedule";

describe("work-order planning reschedule dates", () => {
  it("preserves local wall-clock time and due-day offset across DST", () => {
    const result = reschedulePlanningDates({
      plannedStart: new Date("2026-10-23T06:30:00.000Z"),
      dueAt: new Date("2026-10-24T15:00:00.000Z"),
      targetDate: "2026-10-25",
      timeZone: "Europe/Paris",
    });

    expect(result.plannedStart.toISOString()).toBe("2026-10-25T07:30:00.000Z");
    expect(result.dueAt?.toISOString()).toBe("2026-10-26T16:00:00.000Z");
  });

  it("schedules previously unplanned work at 08:00 local time", () => {
    const result = reschedulePlanningDates({
      plannedStart: null,
      dueAt: null,
      targetDate: "2026-08-12",
      timeZone: "Europe/Paris",
    });

    expect(result.plannedStart.toISOString()).toBe("2026-08-12T06:00:00.000Z");
    expect(result.dueAt).toBeNull();
  });

  it("rejects impossible calendar dates", () => {
    expect(() =>
      reschedulePlanningDates({
        plannedStart: null,
        dueAt: null,
        targetDate: "2026-02-31",
        timeZone: "UTC",
      }),
    ).toThrow("Invalid target planning date");
  });
});
