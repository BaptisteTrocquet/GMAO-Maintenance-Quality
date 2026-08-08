import { describe, expect, it } from "vitest";
import {
  buildCalendarGrid,
  buildPlanningCalendar,
  buildPlanningCalendarWhere,
  calendarSearchRange,
  parseCalendarMonth,
  shiftCalendarMonth,
} from "@/lib/maintenance/planning-calendar";

const baseWorkOrder = {
  id: "wo-1",
  number: "WO-0001",
  title: "Inspect generic pump",
  status: "PLANNED" as const,
  priority: "HIGH" as const,
  plannedStart: null as Date | null,
  dueAt: null as Date | null,
  assetCode: "EQ-001",
  assigneeName: "Demo Technician",
  teamName: null,
};

describe("maintenance planning calendar", () => {
  it("parses and shifts calendar months without day overflow", () => {
    const month = parseCalendarMonth("2026-12", {
      now: new Date("2026-08-08T00:00:00.000Z"),
      timeZone: "Europe/Paris",
    });

    expect(month).toEqual({ year: 2026, month: 12, key: "2026-12" });
    expect(shiftCalendarMonth(month, 1)).toEqual({ year: 2027, month: 1, key: "2027-01" });
    expect(shiftCalendarMonth(month, -12)).toEqual({ year: 2025, month: 12, key: "2025-12" });
  });

  it("falls back to the current month in the configured timezone", () => {
    const month = parseCalendarMonth("not-a-month", {
      now: new Date("2026-08-31T22:30:00.000Z"),
      timeZone: "Europe/Paris",
    });

    expect(month.key).toBe("2026-09");
  });

  it("builds a stable six-week Monday-to-Sunday grid", () => {
    const month = parseCalendarMonth("2026-08", {
      now: new Date("2026-08-08T00:00:00.000Z"),
      timeZone: "UTC",
    });
    const days = buildCalendarGrid(month);

    expect(days).toHaveLength(42);
    expect(days[0]?.dateKey).toBe("2026-07-27");
    expect(days[6]?.dateKey).toBe("2026-08-02");
    expect(days[41]?.dateKey).toBe("2026-09-06");
    expect(days.filter((day) => day.inMonth)).toHaveLength(31);
  });

  it("widens the SQL search range enough for extreme local UTC offsets", () => {
    const month = parseCalendarMonth("2026-08", {
      now: new Date("2026-08-08T00:00:00.000Z"),
      timeZone: "UTC",
    });
    const range = calendarSearchRange(buildCalendarGrid(month));

    expect(range.start.toISOString()).toBe("2026-07-26T06:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-09-07T17:59:59.999Z");
  });

  it("builds a strict organization and site scoped database query", () => {
    const range = {
      start: new Date("2026-07-26T06:00:00.000Z"),
      end: new Date("2026-09-07T17:59:59.999Z"),
    };

    expect(
      buildPlanningCalendarWhere({ organizationId: "org-a", siteId: "site-a", range }),
    ).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { not: "CANCELLED" },
      OR: [
        { plannedStart: { gte: range.start, lte: range.end } },
        { dueAt: { gte: range.start, lte: range.end } },
      ],
    });
  });

  it("places UTC timestamps on the correct local site date", () => {
    const month = parseCalendarMonth("2026-09", {
      now: new Date("2026-09-01T00:00:00.000Z"),
      timeZone: "Europe/Paris",
    });
    const calendar = buildPlanningCalendar({
      month,
      timeZone: "Europe/Paris",
      workOrders: [
        {
          ...baseWorkOrder,
          plannedStart: new Date("2026-08-31T22:30:00.000Z"),
        },
      ],
    });

    const septemberFirst = calendar.find((day) => day.dateKey === "2026-09-01");
    expect(septemberFirst?.items).toHaveLength(1);
    expect(septemberFirst?.items[0]).toMatchObject({ planned: true, plannedTime: "00:30" });
  });

  it("merges planned and due markers when both fall on the same local day", () => {
    const month = parseCalendarMonth("2026-08", {
      now: new Date("2026-08-08T00:00:00.000Z"),
      timeZone: "UTC",
    });
    const calendar = buildPlanningCalendar({
      month,
      timeZone: "UTC",
      workOrders: [
        {
          ...baseWorkOrder,
          plannedStart: new Date("2026-08-12T08:00:00.000Z"),
          dueAt: new Date("2026-08-12T16:00:00.000Z"),
        },
      ],
    });

    const day = calendar.find((item) => item.dateKey === "2026-08-12");
    expect(day?.items).toHaveLength(1);
    expect(day?.items[0]).toMatchObject({
      planned: true,
      due: true,
      plannedTime: "08:00",
      dueTime: "16:00",
    });
  });

  it("does not render cancelled work orders", () => {
    const month = parseCalendarMonth("2026-08", {
      now: new Date("2026-08-08T00:00:00.000Z"),
      timeZone: "UTC",
    });
    const calendar = buildPlanningCalendar({
      month,
      timeZone: "UTC",
      workOrders: [
        {
          ...baseWorkOrder,
          status: "CANCELLED",
          plannedStart: new Date("2026-08-12T08:00:00.000Z"),
        },
      ],
    });

    expect(calendar.flatMap((day) => day.items)).toHaveLength(0);
  });
});
