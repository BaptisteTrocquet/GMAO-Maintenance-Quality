import { describe, expect, it } from "vitest";
import {
  buildCalendarMaintenancePlanWhere,
  buildCalendarWorkOrderWhere,
  buildMonthGrid,
  groupCalendarEvents,
  resolveCalendarMonthWindow,
  type MaintenanceCalendarEvent,
} from "@/lib/maintenance/calendar-board";

describe("maintenance planning calendar", () => {
  it("resolves Europe/Paris month boundaries across DST using local midnight", () => {
    const march = resolveCalendarMonthWindow({
      month: "2026-03",
      timeZone: "Europe/Paris",
      now: new Date("2026-08-08T00:00:00.000Z"),
    });
    expect(march.start.toISOString()).toBe("2026-02-28T23:00:00.000Z");
    expect(march.end.toISOString()).toBe("2026-03-31T22:00:00.000Z");
    expect(march.previousKey).toBe("2026-02");
    expect(march.nextKey).toBe("2026-04");

    const october = resolveCalendarMonthWindow({
      month: "2026-10",
      timeZone: "Europe/Paris",
      now: new Date("2026-08-08T00:00:00.000Z"),
    });
    expect(october.start.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    expect(october.end.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });

  it("falls back to the current local month when the query key is invalid", () => {
    const range = resolveCalendarMonthWindow({
      month: "not-a-month",
      timeZone: "Europe/Paris",
      now: new Date("2026-08-31T22:30:00.000Z"),
    });
    expect(range.key).toBe("2026-09");
  });

  it("builds a six-week Monday-first month grid", () => {
    const grid = buildMonthGrid({ year: 2026, month: 8 });
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual({ year: 2026, month: 7, day: 27, inSelectedMonth: false });
    expect(grid[5]).toEqual({ year: 2026, month: 8, day: 1, inSelectedMonth: true });
    expect(grid[41]).toEqual({ year: 2026, month: 9, day: 6, inSelectedMonth: false });
  });

  it("pushes calendar work-order filtering into tenant/site-scoped SQL conditions", () => {
    const range = resolveCalendarMonthWindow({
      month: "2026-08",
      timeZone: "Europe/Paris",
      now: new Date("2026-08-08T00:00:00.000Z"),
    });
    expect(
      buildCalendarWorkOrderWhere({
        organizationId: "org-a",
        siteId: "site-a",
        start: range.start,
        end: range.end,
      }),
    ).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
      OR: [
        { plannedStart: { gte: range.start, lt: range.end } },
        { dueAt: { gte: range.start, lt: range.end } },
      ],
    });
  });

  it("scopes preventive plan dates through active assets and the selected tenant/site", () => {
    const range = resolveCalendarMonthWindow({
      month: "2026-08",
      timeZone: "Europe/Paris",
      now: new Date("2026-08-08T00:00:00.000Z"),
    });
    expect(
      buildCalendarMaintenancePlanWhere({
        organizationId: "org-a",
        siteId: "site-a",
        start: range.start,
        end: range.end,
      }),
    ).toEqual({
      active: true,
      nextDueAt: { gte: range.start, lt: range.end },
      asset: {
        archivedAt: null,
        siteId: "site-a",
        site: { organizationId: "org-a", active: true },
      },
    });
  });

  it("groups local-day events and sorts preventive due, work start, then work due", () => {
    const events: MaintenanceCalendarEvent[] = [
      {
        id: "wo-due",
        sourceId: "wo-1",
        kind: "WORK_ORDER_DUE",
        date: new Date("2026-08-08T08:00:00.000Z"),
        title: "Due work",
        label: "WO-1",
        href: "/maintenance/wo-1",
        status: "PLANNED",
        priority: "HIGH",
        assetCode: "AS-1",
      },
      {
        id: "plan",
        sourceId: "plan-1",
        kind: "PLAN_DUE",
        date: new Date("2026-08-08T06:00:00.000Z"),
        title: "Preventive plan",
        label: "AS-1",
        href: "/maintenance",
        status: "PLAN_DUE",
        priority: null,
        assetCode: "AS-1",
      },
      {
        id: "wo-start",
        sourceId: "wo-2",
        kind: "WORK_ORDER_START",
        date: new Date("2026-08-08T07:00:00.000Z"),
        title: "Starting work",
        label: "WO-2",
        href: "/maintenance/wo-2",
        status: "PLANNED",
        priority: "NORMAL",
        assetCode: "AS-2",
      },
    ];

    const grouped = groupCalendarEvents(events, "Europe/Paris");
    expect(grouped.get("2026-08-08")?.map((event) => event.kind)).toEqual([
      "PLAN_DUE",
      "WORK_ORDER_START",
      "WORK_ORDER_DUE",
    ]);
  });
});
