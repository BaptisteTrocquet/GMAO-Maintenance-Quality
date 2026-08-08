import { expect, it } from "vitest";
import { buildPlanningCalendarWhere } from "@/lib/maintenance/planning-calendar";

it("scopes planning-calendar queries to the active tenant site and visible date window", () => {
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
