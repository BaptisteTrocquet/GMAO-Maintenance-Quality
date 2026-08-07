import { describe, expect, it } from "vitest";
import {
  assertTransitionRequirements,
  deriveTransitionDates,
  transitionPermission,
} from "@/lib/work-orders/workflow";

describe("work order workflow", () => {
  it("requires management permission for approval and cancellation transitions", () => {
    expect(transitionPermission("REQUESTED", "APPROVED")).toBe("work:manage");
    expect(transitionPermission("IN_PROGRESS", "CANCELLED")).toBe("work:manage");
  });

  it("allows execution transitions with work update permission", () => {
    expect(transitionPermission("PLANNED", "IN_PROGRESS")).toBe("work:update");
    expect(transitionPermission("IN_PROGRESS", "BLOCKED")).toBe("work:update");
    expect(transitionPermission("IN_PROGRESS", "COMPLETED")).toBe("work:update");
  });

  it("rejects invalid transitions", () => {
    expect(() => transitionPermission("REQUESTED", "COMPLETED")).toThrowError(
      expect.objectContaining({ code: "INVALID_TRANSITION" }),
    );
  });

  it("requires a planned start before entering PLANNED", () => {
    expect(() =>
      assertTransitionRequirements({ from: "APPROVED", to: "PLANNED", plannedStart: null }),
    ).toThrowError(expect.objectContaining({ code: "PLANNING_REQUIRED" }));
  });

  it("derives start and completion timestamps", () => {
    const now = new Date("2026-08-07T12:00:00.000Z");
    expect(
      deriveTransitionDates({
        from: "PLANNED",
        to: "IN_PROGRESS",
        startedAt: null,
        completedAt: null,
        now,
      }),
    ).toEqual({ startedAt: now, completedAt: null });

    expect(
      deriveTransitionDates({
        from: "IN_PROGRESS",
        to: "COMPLETED",
        startedAt: now,
        completedAt: null,
        now,
      }),
    ).toEqual({ startedAt: now, completedAt: now });
  });
});
