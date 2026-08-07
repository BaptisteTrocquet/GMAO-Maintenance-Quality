import { describe, expect, it } from "vitest";
import { calculateMaintenanceForecast } from "@/lib/maintenance/forecast";

const now = new Date("2026-08-07T12:00:00.000Z");

function calendarPlan(input: Partial<{
  id: string;
  active: boolean;
  nextDueAt: Date;
}> = {}) {
  return {
    id: input.id ?? "calendar-1",
    name: "Monthly inspection",
    active: input.active ?? true,
    frequencyValue: 1,
    frequencyUnit: "MONTH",
    nextDueAt: input.nextDueAt ?? new Date("2026-08-10T12:00:00.000Z"),
    nextDueMeterValue: null,
    asset: { code: "A-100" },
    meter: null,
  };
}

function meterPlan(input: Partial<{
  id: string;
  current: number;
  threshold: number;
}> = {}) {
  return {
    id: input.id ?? "meter-plan-1",
    name: "Hours inspection",
    active: true,
    frequencyValue: 100,
    frequencyUnit: "METER",
    nextDueAt: null,
    nextDueMeterValue: input.threshold ?? 1000,
    asset: { code: "A-200" },
    meter: {
      code: "HOURS",
      unit: "h",
      readings: [{ value: input.current ?? 950, readingAt: now }],
    },
  };
}

describe("maintenance forecast", () => {
  it("classifies overdue and due-soon calendar work", () => {
    const result = calculateMaintenanceForecast({
      now,
      horizonDays: 30,
      plans: [
        calendarPlan({ id: "overdue-plan", nextDueAt: new Date("2026-08-01T12:00:00.000Z") }),
        calendarPlan({ id: "soon-plan", nextDueAt: new Date("2026-08-20T12:00:00.000Z") }),
      ],
      workOrders: [
        {
          id: "wo-overdue",
          number: "PM-001",
          title: "Inspect pump",
          dueAt: new Date("2026-08-05T12:00:00.000Z"),
          asset: { code: "A-300" },
        },
      ],
    });

    expect(result.entries.map((entry) => [entry.id, entry.state])).toEqual([
      ["overdue-plan", "OVERDUE"],
      ["wo-overdue", "OVERDUE"],
      ["soon-plan", "DUE_SOON"],
    ]);
    expect(result.health.overduePlans).toBe(1);
    expect(result.health.overdueWorkOrders).toBe(1);
    expect(result.health.dueSoon).toBe(1);
    expect(result.health.score).toBe(73);
    expect(result.health.status).toBe("WATCH");
  });

  it("uses remaining meter capacity to forecast meter maintenance", () => {
    const result = calculateMaintenanceForecast({
      now,
      horizonDays: 30,
      plans: [
        meterPlan({ id: "meter-due", current: 1010, threshold: 1000 }),
        meterPlan({ id: "meter-soon", current: 985, threshold: 1000 }),
        meterPlan({ id: "meter-upcoming", current: 700, threshold: 1000 }),
      ],
      workOrders: [],
    });

    expect(result.entries.map((entry) => [entry.id, entry.state, entry.remainingMeterValue])).toEqual([
      ["meter-due", "OVERDUE", -10],
      ["meter-soon", "DUE_SOON", 15],
      ["meter-upcoming", "UPCOMING", 300],
    ]);
  });

  it("counts paused plans without penalizing health", () => {
    const result = calculateMaintenanceForecast({
      now,
      horizonDays: 30,
      plans: [calendarPlan({ active: false, nextDueAt: new Date("2026-07-01T12:00:00.000Z") })],
      workOrders: [],
    });

    expect(result.entries).toEqual([]);
    expect(result.health.pausedPlans).toBe(1);
    expect(result.health.score).toBe(100);
    expect(result.health.status).toBe("HEALTHY");
  });

  it("caps penalties and never returns a negative score", () => {
    const workOrders = Array.from({ length: 10 }, (_, index) => ({
      id: `wo-${index}`,
      number: `PM-${index}`,
      title: "Overdue PM",
      dueAt: new Date("2026-07-01T12:00:00.000Z"),
      asset: null,
    }));
    const result = calculateMaintenanceForecast({ now, horizonDays: 30, plans: [], workOrders });

    expect(result.health.score).toBe(40);
    expect(result.health.status).toBe("AT_RISK");
  });
});
