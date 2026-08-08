import { describe, expect, it } from "vitest";
import {
  buildPlanningCalendarWhere,
  currentPlanningMonth,
  localDateKey,
  monthGridDays,
  parsePlanningDate,
  parsePlanningMonth,
  planningMonthKey,
  planningMonthRange,
  reschedulePlanningDates,
  shiftPlanningMonth,
} from "@/lib/maintenance/planning-calendar";

describe("maintenance planning calendar", () => {
  it("uses the organization timezone for the current planning month", () => {
    const instant = new Date("2026-08-31T23:30:00.000Z");
    expect(currentPlanningMonth(instant, "Europe/Paris")).toEqual({ year: 2026, month: 9 });
    expect(currentPlanningMonth(instant, "America/New_York")).toEqual({ year: 2026, month: 8 });
  });

  it("parses and shifts month keys across year boundaries", () => {
    expect(parsePlanningMonth("2026-08", { year: 2026, month: 7 })).toEqual({ year: 2026, month: 8 });
    expect(parsePlanningMonth("invalid", { year: 2026, month: 7 })).toEqual({ year: 2026, month: 7 });
    expect(shiftPlanningMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftPlanningMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(planningMonthKey({ year: 2026, month: 8 })).toBe("2026-08");
  });

  it("validates local planning date keys", () => {
    expect(parsePlanningDate("2026-08-31")).toEqual({ year: 2026, month: 8, day: 31 });
    expect(parsePlanningDate("2026-02-29")).toBeNull();
    expect(parsePlanningDate("not-a-date")).toBeNull();
  });

  it("resolves local month boundaries through daylight-saving offsets", () => {
    const march = planningMonthRange({ year: 2026, month: 3 }, "Europe/Paris");
    expect(march.start.toISOString()).toBe("2026-02-28T23:00:00.000Z");
    expect(march.end.toISOString()).toBe("2026-03-31T22:00:00.000Z");

    const october = planningMonthRange({ year: 2026, month: 10 }, "Europe/Paris");
    expect(october.start.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(october.end.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });

  it("reschedules a planned work order by local calendar date across DST", () => {
    const result = reschedulePlanningDates({
      plannedStart: new Date("2026-10-23T06:30:00.000Z"),
      dueAt: new Date("2026-10-24T15:00:00.000Z"),
      targetDate: "2026-10-25",
      timeZone: "Europe/Paris",
    });

    expect(result.plannedStart.toISOString()).toBe("2026-10-25T07:30:00.000Z");
    expect(result.dueAt?.toISOString()).toBe("2026-10-26T16:00:00.000Z");
  });

  it("assigns 08:00 local when dragging an unplanned work order", () => {
    const result = reschedulePlanningDates({
      plannedStart: null,
      dueAt: null,
      targetDate: "2026-08-10",
      timeZone: "Europe/Paris",
    });
    expect(result.plannedStart.toISOString()).toBe("2026-08-10T06:00:00.000Z");
    expect(result.dueAt).toBeNull();
  });

  it("scopes calendar queries by organization/site and active workflow status", () => {
    const where = buildPlanningCalendarWhere({
      organizationId: "org-a",
      siteId: "site-a",
      month: { year: 2026, month: 8 },
      timeZone: "Europe/Paris",
    });

    expect(where).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
      OR: [
        {
          plannedStart: {
            gte: new Date("2026-07-31T22:00:00.000Z"),
            lt: new Date("2026-08-31T22:00:00.000Z"),
          },
        },
        {
          dueAt: {
            gte: new Date("2026-07-31T22:00:00.000Z"),
            lt: new Date("2026-08-31T22:00:00.000Z"),
          },
        },
      ],
    });
  });

  it("maps instants to local calendar date keys", () => {
    expect(localDateKey(new Date("2026-08-08T22:30:00.000Z"), "Europe/Paris")).toBe("2026-08-09");
  });

  it("builds a complete Monday-first month grid", () => {
    const august = monthGridDays({ year: 2026, month: 8 });
    expect(august.slice(0, 6)).toEqual([null, null, null, null, null, 1]);
    expect(august.length % 7).toBe(0);
    expect(august.filter((day) => day === 31)).toHaveLength(1);
  });
});
