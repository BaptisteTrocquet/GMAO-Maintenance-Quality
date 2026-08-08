import { describe, expect, it } from "vitest";
import {
  buildScheduledPlanningWhere,
  buildUnscheduledPlanningWhere,
  PLANNING_ACTIVE_STATUSES,
} from "@/lib/maintenance/planning-calendar-query";

describe("maintenance planning calendar query scope", () => {
  it("scopes scheduled work orders to one active organization/site and date window", () => {
    const rangeStart = new Date("2026-08-07T22:00:00.000Z");
    const rangeEnd = new Date("2026-08-21T22:00:00.000Z");

    expect(
      buildScheduledPlanningWhere({
        organizationId: "org-a",
        siteId: "site-a",
        rangeStart,
        rangeEnd,
      }),
    ).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { in: [...PLANNING_ACTIVE_STATUSES] },
      plannedStart: { gte: rangeStart, lt: rangeEnd },
    });
  });

  it("never loads unplanned work from another site or organization", () => {
    expect(
      buildUnscheduledPlanningWhere({ organizationId: "org-a", siteId: "site-a" }),
    ).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { in: [...PLANNING_ACTIVE_STATUSES] },
      plannedStart: null,
    });
  });
});
