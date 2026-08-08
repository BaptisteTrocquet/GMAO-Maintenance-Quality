import { describe, expect, it } from "vitest";
import {
  buildSchedulePatch,
  buildWorkOrderRescheduleRequest,
  parseLocalDateKey,
  rescheduleInstantToLocalDate,
} from "@/lib/maintenance/reschedule";

describe("maintenance schedule rescheduling", () => {
  it("validates local calendar date keys", () => {
    expect(parseLocalDateKey("2026-08-08")).toEqual({ year: 2026, month: 8, day: 8 });
    expect(() => parseLocalDateKey("2026-02-30")).toThrow("valid calendar day");
    expect(() => parseLocalDateKey("08/08/2026")).toThrow("YYYY-MM-DD");
  });

  it("preserves the organization-local clock time while moving to another day", () => {
    const moved = rescheduleInstantToLocalDate({
      instant: new Date("2026-08-08T08:15:30.000Z"),
      targetDateKey: "2026-08-12",
      timeZone: "Europe/Paris",
    });
    expect(moved.toISOString()).toBe("2026-08-12T08:15:30.000Z");
  });

  it("adjusts UTC offset when the target date crosses daylight-saving time", () => {
    const moved = rescheduleInstantToLocalDate({
      instant: new Date("2026-03-28T09:00:00.000Z"),
      targetDateKey: "2026-03-30",
      timeZone: "Europe/Paris",
    });
    expect(moved.toISOString()).toBe("2026-03-30T08:00:00.000Z");
  });

  it("rejects a target local clock time that does not exist during the DST jump", () => {
    expect(() =>
      rescheduleInstantToLocalDate({
        instant: new Date("2026-03-28T01:30:00.000Z"),
        targetDateKey: "2026-03-29",
        timeZone: "Europe/Paris",
      }),
    ).toThrow("does not exist");
  });

  it("builds a PATCH payload only for the selected schedule field", () => {
    expect(
      buildSchedulePatch({
        field: "plannedStart",
        instant: new Date("2026-08-08T08:00:00.000Z"),
        targetDateKey: "2026-08-09",
        timeZone: "UTC",
      }),
    ).toEqual({ plannedStart: "2026-08-09T08:00:00.000Z" });
  });

  it("routes moves through the existing tenant-scoped WorkOrder PATCH endpoint", () => {
    expect(
      buildWorkOrderRescheduleRequest({
        workOrderId: "wo/unsafe id",
        organizationId: "org-a",
        siteId: "site-a",
        field: "plannedStart",
        instant: new Date("2026-08-08T08:00:00.000Z"),
        targetDateKey: "2026-08-09",
        timeZone: "UTC",
      }),
    ).toEqual({
      url: "/api/work-orders/wo%2Funsafe%20id",
      method: "PATCH",
      body: {
        organizationId: "org-a",
        siteId: "site-a",
        plannedStart: "2026-08-09T08:00:00.000Z",
      },
    });
  });
});
