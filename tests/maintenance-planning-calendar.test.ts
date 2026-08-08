import { describe, expect, it } from "vitest";
import {
  buildPlanningCalendarWhere,
  currentPlanningMonth,
  localDateKey,
  monthGridDays,
  parsePlanningMonth,
  planningMonthKey,
  planningMonthRange,
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

  it("resolves local month boundaries through daylight-saving offsets", () => {
    const march = planningMonthRange({ year: 2026, month: 3 }, "Europe/Paris");
    expect(march.start.toISOString()).toBe("2026-02-28T23:00:00.000Z");
    expect(march.end.toISOString()).toBe("2026-03-31T22:00:00.000Z");

    const october = planningMonthRange({ year: 2026, month: 10 }, "Europe/Paris");
    expect(october.start.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(october.end.toISOString()).toBe("2026-10-31T23:00:00.000Z");
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

  it("builds a Monday-first month grid", () => {
    const august = monthGridDays({ year: 2026, month: 8 });
    expect(august.slice(0, 6)).toEqual([null, null, null, null, null, 1]);
    expect(august.at(-1)).toBe(31);
  });
});
