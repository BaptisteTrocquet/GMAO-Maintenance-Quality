import { describe, expect, it } from "vitest";
import {
  buildPlanningCalendarWhere,
  buildUnscheduledWorkOrderWhere,
  currentPlanningMonth,
  groupPlanningEvents,
  localDateKey,
  monthGridDays,
  parsePlanningMonth,
  planningMonthKey,
  planningMonthRange,
  shiftPlanningMonth,
  type MaintenancePlanningEvent,
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

  it("scopes calendar and unscheduled queries by organization/site and active workflow status", () => {
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
        { plannedStart: { gte: new Date("2026-07-31T22:00:00.000Z"), lt: new Date("2026-08-31T22:00:00.000Z") } },
        { dueAt: { gte: new Date("2026-07-31T22:00:00.000Z"), lt: new Date("2026-08-31T22:00:00.000Z") } },
      ],
    });
    expect(buildUnscheduledWorkOrderWhere({ organizationId: "org-a", siteId: "site-a" })).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
      plannedStart: null,
    });
  });

  it("maps instants to local dates and groups planning events deterministically", () => {
    expect(localDateKey(new Date("2026-08-08T22:30:00.000Z"), "Europe/Paris")).toBe("2026-08-09");
    const events: MaintenancePlanningEvent[] = [
      {
        id: "due",
        sourceId: "wo-1",
        kind: "WORK_ORDER_DUE",
        date: new Date("2026-08-09T12:00:00.000Z"),
        title: "Synthetic WO",
        label: "Due",
        href: "/maintenance/wo-1",
        status: "PLANNED",
        priority: "NORMAL",
        assetCode: "ASSET-001",
      },
      {
        id: "plan",
        sourceId: "plan-1",
        kind: "PLAN_DUE",
        date: new Date("2026-08-09T08:00:00.000Z"),
        title: "Synthetic PM",
        label: "Plan due",
        href: "/maintenance",
        status: "PLAN_DUE",
        priority: null,
        assetCode: "ASSET-001",
      },
      {
        id: "start",
        sourceId: "wo-2",
        kind: "WORK_ORDER_START",
        date: new Date("2026-08-09T10:00:00.000Z"),
        title: "Synthetic start",
        label: "Start",
        href: "/maintenance/wo-2",
        status: "PLANNED",
        priority: "HIGH",
        assetCode: "ASSET-002",
      },
    ];
    expect(groupPlanningEvents(events, "Europe/Paris").get("2026-08-09")?.map((event) => event.id)).toEqual([
      "plan",
      "start",
      "due",
    ]);
  });

  it("builds a Monday-first complete-week month grid", () => {
    const august = monthGridDays({ year: 2026, month: 8 });
    expect(august.slice(0, 6)).toEqual([null, null, null, null, null, 1]);
    expect(august.length % 7).toBe(0);
    expect(august.filter((day) => day !== null).at(-1)).toBe(31);
  });
});
