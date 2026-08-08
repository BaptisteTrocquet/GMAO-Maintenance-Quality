import { describe, expect, it } from "vitest";
import {
  buildWorkloadLanes,
  buildWorkloadWhere,
  WORKLOAD_HORIZON_DAYS,
  WORKLOAD_LIMIT,
  type WorkloadWorkOrder,
} from "@/lib/maintenance/workload";

const now = new Date("2026-08-08T12:00:00.000Z");

function workOrder(overrides: Partial<WorkloadWorkOrder> = {}): WorkloadWorkOrder {
  return {
    id: "wo-1",
    number: "WO-001",
    title: "Synthetic work order",
    status: "PLANNED",
    priority: "NORMAL",
    requestedAt: new Date("2026-08-01T12:00:00.000Z"),
    plannedStart: new Date("2026-08-10T08:00:00.000Z"),
    dueAt: new Date("2026-08-12T12:00:00.000Z"),
    assigneeId: "user-1",
    assigneeName: "Demo Technician",
    teamId: null,
    teamName: null,
    ...overrides,
  };
}

describe("maintenance team workload", () => {
  it("uses a bounded large-list policy and explicit 14-day horizon", () => {
    expect(WORKLOAD_LIMIT).toBe(750);
    expect(WORKLOAD_HORIZON_DAYS).toBe(14);
  });

  it("scopes workload rows to organization and site before loading them", () => {
    expect(buildWorkloadWhere({ organizationId: "org-a", siteId: "site-a" })).toEqual({
      siteId: "site-a",
      site: { organizationId: "org-a", active: true },
      status: { in: ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED"] },
    });
  });

  it("groups by assignee first, then team, then unassigned", () => {
    const lanes = buildWorkloadLanes({
      now,
      workOrders: [
        workOrder({ id: "person", assigneeId: "u-1", assigneeName: "Alex", teamId: "t-1", teamName: "Team A" }),
        workOrder({ id: "team", assigneeId: null, assigneeName: null, teamId: "t-1", teamName: "Team A" }),
        workOrder({ id: "none", assigneeId: null, assigneeName: null, teamId: null, teamName: null }),
      ],
    });

    expect(lanes.map((lane) => lane.key).sort()).toEqual(["PERSON:u-1", "TEAM:t-1", "UNASSIGNED"].sort());
  });

  it("calculates overdue, near-due, planned, blocked and unplanned risk counters", () => {
    const [lane] = buildWorkloadLanes({
      now,
      workOrders: [
        workOrder({ id: "overdue", dueAt: new Date("2026-08-07T12:00:00.000Z") }),
        workOrder({ id: "soon", dueAt: new Date("2026-08-10T12:00:00.000Z") }),
        workOrder({ id: "blocked", status: "BLOCKED", priority: "URGENT", plannedStart: null, dueAt: null }),
        workOrder({ id: "future", plannedStart: new Date("2026-09-01T12:00:00.000Z"), dueAt: null }),
      ],
    });

    expect(lane).toMatchObject({
      total: 4,
      blocked: 1,
      overdue: 1,
      dueSoon: 1,
      plannedInHorizon: 2,
      unplanned: 1,
      urgent: 1,
    });
  });

  it("does not include completed or cancelled work in operational workload", () => {
    const lanes = buildWorkloadLanes({
      now,
      workOrders: [
        workOrder({ id: "active" }),
        workOrder({ id: "done", status: "COMPLETED" }),
        workOrder({ id: "cancelled", status: "CANCELLED" }),
      ],
    });

    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.total).toBe(1);
  });

  it("sorts higher-risk lanes before lower-risk workload", () => {
    const lanes = buildWorkloadLanes({
      now,
      workOrders: [
        workOrder({ id: "low", assigneeId: "u-low", assigneeName: "Low", dueAt: new Date("2026-08-20T12:00:00.000Z") }),
        workOrder({ id: "high", assigneeId: "u-high", assigneeName: "High", dueAt: new Date("2026-08-01T12:00:00.000Z") }),
      ],
    });

    expect(lanes.map((lane) => lane.label)).toEqual(["High", "Low"]);
  });
});
