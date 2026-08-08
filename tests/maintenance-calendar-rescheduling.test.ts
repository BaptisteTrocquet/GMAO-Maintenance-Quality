import { describe, expect, it } from "vitest";
import {
  dateKeyInTimeZone,
  rescheduleWorkOrderForDate,
} from "@/lib/maintenance/calendar-rescheduling";

describe("maintenance calendar rescheduling", () => {
  it("plans unscheduled work at 08:00 local time across DST", () => {
    const result = rescheduleWorkOrderForDate({
      plannedStart: null,
      dueAt: null,
      targetDateKey: "2026-03-29",
      timeZone: "Europe/Paris",
    });

    expect(result.plannedStart.toISOString()).toBe("2026-03-29T06:00:00.000Z");
    expect(dateKeyInTimeZone(result.plannedStart, "Europe/Paris")).toBe("2026-03-29");
    expect(result.dueAt).toBeNull();
  });

  it("preserves local start and due times when moving across the spring DST boundary", () => {
    const result = rescheduleWorkOrderForDate({
      plannedStart: new Date("2026-03-28T08:30:00.000Z"),
      dueAt: new Date("2026-03-28T15:00:00.000Z"),
      targetDateKey: "2026-03-29",
      timeZone: "Europe/Paris",
    });

    expect(result.plannedStart.toISOString()).toBe("2026-03-29T07:30:00.000Z");
    expect(result.dueAt?.toISOString()).toBe("2026-03-29T14:00:00.000Z");
  });

  it("preserves local time when moving across the autumn DST boundary", () => {
    const result = rescheduleWorkOrderForDate({
      plannedStart: new Date("2026-10-24T07:15:00.000Z"),
      dueAt: null,
      targetDateKey: "2026-10-25",
      timeZone: "Europe/Paris",
    });

    expect(result.plannedStart.toISOString()).toBe("2026-10-25T08:15:00.000Z");
    expect(dateKeyInTimeZone(result.plannedStart, "Europe/Paris")).toBe("2026-10-25");
  });

  it("keeps an existing schedule unchanged when moved to its current local date", () => {
    const plannedStart = new Date("2026-08-08T06:00:00.000Z");
    const dueAt = new Date("2026-08-08T14:00:00.000Z");
    const result = rescheduleWorkOrderForDate({
      plannedStart,
      dueAt,
      targetDateKey: "2026-08-08",
      timeZone: "Europe/Paris",
    });

    expect(result.plannedStart.toISOString()).toBe(plannedStart.toISOString());
    expect(result.dueAt?.toISOString()).toBe(dueAt.toISOString());
  });

  it("rejects invalid target dates", () => {
    expect(() =>
      rescheduleWorkOrderForDate({
        plannedStart: null,
        dueAt: null,
        targetDateKey: "2026-02-31",
        timeZone: "Europe/Paris",
      }),
    ).toThrow("Invalid target date");
  });
});
