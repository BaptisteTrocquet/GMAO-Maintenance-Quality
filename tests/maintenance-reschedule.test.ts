import { describe, expect, it } from "vitest";
import {
  buildSchedulePatch,
  parseLocalDateKey,
  rescheduleInstantToLocalDate,
  scheduleLocalDateAtHour,
} from "@/lib/maintenance/reschedule";

describe("maintenance calendar rescheduling", () => {
  it("preserves local wall-clock time across a daylight-saving transition", () => {
    const moved = rescheduleInstantToLocalDate({
      instant: new Date("2026-03-27T08:30:00.000Z"),
      targetDateKey: "2026-03-30",
      timeZone: "Europe/Paris",
    });

    expect(moved.toISOString()).toBe("2026-03-30T07:30:00.000Z");
  });

  it("plans previously unscheduled work at the default local 08:00", () => {
    const planned = scheduleLocalDateAtHour({
      targetDateKey: "2026-08-12",
      timeZone: "Europe/Paris",
    });

    expect(planned.toISOString()).toBe("2026-08-12T06:00:00.000Z");
  });

  it("builds a field-specific due-date API patch", () => {
    expect(
      buildSchedulePatch({
        field: "dueAt",
        instant: new Date("2026-08-12T14:15:00.000Z"),
        targetDateKey: "2026-08-14",
        timeZone: "Europe/Paris",
      }),
    ).toEqual({ dueAt: "2026-08-14T14:15:00.000Z" });
  });

  it("can preserve the planned-to-due calendar offset when both timestamps move together", () => {
    expect(
      buildSchedulePatch({
        field: "plannedStart",
        instant: new Date("2026-10-23T06:30:00.000Z"),
        dueAt: new Date("2026-10-24T15:00:00.000Z"),
        targetDateKey: "2026-10-25",
        timeZone: "Europe/Paris",
      }),
    ).toEqual({
      plannedStart: "2026-10-25T07:30:00.000Z",
      dueAt: "2026-10-26T16:00:00.000Z",
    });
  });

  it("rejects invalid local calendar dates", () => {
    expect(() => parseLocalDateKey("2026-02-30")).toThrow("valid calendar day");
    expect(() => parseLocalDateKey("08/12/2026")).toThrow("YYYY-MM-DD");
  });

  it("rejects a target wall-clock time that does not exist during the DST jump", () => {
    expect(() =>
      rescheduleInstantToLocalDate({
        instant: new Date("2026-03-28T01:30:00.000Z"),
        targetDateKey: "2026-03-29",
        timeZone: "Europe/Paris",
      }),
    ).toThrow("does not exist");
  });
});
