import { describe, expect, it } from "vitest";
import { movePlannedStartToDate } from "@/lib/maintenance/planning-calendar";

describe("maintenance calendar rescheduling", () => {
  it("preserves the local planned time when moving across a DST offset change", () => {
    const moved = movePlannedStartToDate({
      plannedStart: new Date("2026-10-24T06:15:00.000Z"),
      targetDateKey: "2026-10-26",
      timeZone: "Europe/Paris",
    });

    expect(moved.toISOString()).toBe("2026-10-26T07:15:00.000Z");
  });

  it("uses 08:00 in the site timezone for previously unscheduled work", () => {
    const moved = movePlannedStartToDate({
      plannedStart: null,
      targetDateKey: "2026-08-12",
      timeZone: "Europe/Paris",
    });

    expect(moved.toISOString()).toBe("2026-08-12T06:00:00.000Z");
  });

  it("rejects a target local time that does not exist during the spring DST jump", () => {
    expect(() =>
      movePlannedStartToDate({
        plannedStart: new Date("2026-03-28T01:30:00.000Z"),
        targetDateKey: "2026-03-29",
        timeZone: "Europe/Paris",
      }),
    ).toThrow(/does not exist/i);
  });
});
