import { describe, expect, it } from "vitest";
import {
  buildCalendarGrid,
  buildPlanningCalendar,
  buildPlanningCalendarWhere,
  calendarSearchRange,
  currentCalendarMonth,
  parseCalendarMonth,
  shiftCalendarMonth,
  type PlanningCalendarWorkOrder,
} from "@/lib/maintenance/planning-calendar";

const baseWorkOrder: PlanningCalendarWorkOrder = {
  id: "wo-1",
  number: "WO-001",
  title: "Synthetic inspection",
  status: "PLANNED",
  priority: "NORMAL",
  plannedStart: new Date("2026-08-08T08:00:00.000Z"),
  dueAt: new Date("2026-08-09T08:00:00.000Z"),
  assetCode: "ASSET-001",
  assigneeName: "Demo Technician",
  teamName: null,
};

describe("maintenance planning calendar", () => {
  it("uses the organization timezone for the current month", () => {
    const instant = new Date("2026-08-31T23:30:00.000Z");
    expect(currentCalendarMonth(instant, "Europe/Paris").key).toBe("2026-09");
    expect(currentCalendarMonth(instant, "America/New_York").key).toBe("2026-08");
  });

  it("parses and shifts months across year boundaries", () => {
    expect(parseCalendarMonth("2026-08", { now: new Date(), timeZone: "UTC" }).key).toBe("2026-08");
    expect(shiftCalendarMonth({ year: 2026, month: 1, key: "2026-01" }, -1).key).toBe("2025-12");
    expect(shiftCalendarMonth({ year: 2026, month: 12, key: "2026-12" }, 1).key).toBe("2027-01");
  });

  it("builds a stable Monday-first six-week grid", () => {
    const days = buildCalendarGrid({ year: 2026, month: 8, key: "2026-08" });
    expect(days).toHaveLength(42);
    expect(days[0]?.dateKey).toBe("2026-07-27");
    expect(days[5]).toMatchObject({ dateKey: "2026-08-01", dayOfMonth: 1, inMonth: true });
    expect(days.at(-1)?.dateKey).toBe("2026-09-06");
  });

  it("expands the database search range enough for timezone conversion", () => {
    const range = calendarSearchRange(buildCalendarGrid({ year: 2026, month: 8, key: "2026-08" }));
    expect(range.start.toISOString()).toBe("2026-07-26T06:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-09-07T17:59:59.999Z");
  });

  it("builds a tenant/site-scoped database predicate", () => {
    const start = new Date("2026-07-26T06:00:00.000Z");
    const end = new Date("2026-09-07T17:59:59.999Z");
    expect(
      buildPlanningCalendarWhere({
        organizationId: "org-a",
        siteId: "site-a",
        start,
        end,
      }),
    ).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { not: "CANCELLED" },
      OR: [
        { plannedStart: { gte: start, lte: end } },
        { dueAt: { gte: start, lte: end } },
      ],
    });
  });

  it("maps planned and due instants to organization-local dates", () => {
    const calendar = buildPlanningCalendar({
      month: { year: 2026, month: 8, key: "2026-08" },
      timeZone: "Europe/Paris",
      workOrders: [
        {
          ...baseWorkOrder,
          plannedStart: new Date("2026-08-08T22:30:00.000Z"),
          dueAt: new Date("2026-08-09T08:00:00.000Z"),
        },
      ],
    });

    const day = calendar.find((entry) => entry.dateKey === "2026-08-09");
    expect(day?.items).toHaveLength(1);
    expect(day?.items[0]).toMatchObject({ planned: true, due: true, plannedTime: "00:30", dueTime: "10:00" });
  });

  it("excludes cancelled work and sorts visible items by priority", () => {
    const calendar = buildPlanningCalendar({
      month: { year: 2026, month: 8, key: "2026-08" },
      timeZone: "UTC",
      workOrders: [
        baseWorkOrder,
        { ...baseWorkOrder, id: "urgent", number: "WO-002", priority: "URGENT" },
        { ...baseWorkOrder, id: "cancelled", number: "WO-003", status: "CANCELLED" },
      ],
    });

    const day = calendar.find((entry) => entry.dateKey === "2026-08-08");
    expect(day?.items.map((item) => item.id)).toEqual(["urgent", "wo-1"]);
  });
});
