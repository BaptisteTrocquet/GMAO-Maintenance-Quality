import { describe, expect, it } from "vitest";
import {
  isTechnicianQueuePartition,
  projectTechnicianWrites,
  type TechnicianQueuedWrite,
} from "@/lib/pwa/technician-write-queue-client";

function queuedWrite(
  overrides: Partial<TechnicianQueuedWrite> & Pick<TechnicianQueuedWrite, "id" | "kind" | "body">,
): TechnicianQueuedWrite {
  return {
    partition: "a".repeat(32),
    organizationId: "org-a",
    siteId: "site-a",
    workOrderId: "wo-1",
    endpoint: "/api/work-orders/wo-1",
    createdAt: "2026-08-08T06:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

describe("technician offline write queue", () => {
  it("accepts only opaque 32-character hexadecimal session partitions", () => {
    expect(isTechnicianQueuePartition("a".repeat(32))).toBe(true);
    expect(isTechnicianQueuePartition("A".repeat(32))).toBe(false);
    expect(isTechnicianQueuePartition("a".repeat(31))).toBe(false);
    expect(isTechnicianQueuePartition("session-token".padEnd(32, "x"))).toBe(false);
  });

  it("projects queued execution and status writes in queue order", () => {
    const current = {
      id: "wo-1",
      status: "IN_PROGRESS",
      laborMinutes: 5,
      downtimeMinutes: 0,
      completionNote: null,
      checkItems: [
        { id: "check-1", completed: false, note: null },
        { id: "check-2", completed: false, note: null },
      ],
    };

    const projected = projectTechnicianWrites(current, [
      queuedWrite({
        id: "write-1",
        kind: "execution",
        endpoint: "/api/work-orders/wo-1/execution",
        body: {
          laborMinutes: 37,
          downtimeMinutes: 11,
          completionNote: "Offline inspection update",
          checklistUpdates: [
            { id: "check-1", completed: true, note: "Verified" },
          ],
        },
      }),
      queuedWrite({
        id: "write-2",
        kind: "transition",
        body: { status: "BLOCKED" },
      }),
      queuedWrite({
        id: "write-3",
        kind: "transition",
        body: { status: "IN_PROGRESS" },
      }),
    ]);

    expect(projected).toEqual({
      id: "wo-1",
      status: "IN_PROGRESS",
      laborMinutes: 37,
      downtimeMinutes: 11,
      completionNote: "Offline inspection update",
      checkItems: [
        { id: "check-1", completed: true, note: "Verified" },
        { id: "check-2", completed: false, note: null },
      ],
    });
    expect(current).toEqual({
      id: "wo-1",
      status: "IN_PROGRESS",
      laborMinutes: 5,
      downtimeMinutes: 0,
      completionNote: null,
      checkItems: [
        { id: "check-1", completed: false, note: null },
        { id: "check-2", completed: false, note: null },
      ],
    });
  });

  it("ignores queued writes belonging to another work order", () => {
    const current = {
      id: "wo-1",
      status: "IN_PROGRESS",
      laborMinutes: 5,
      downtimeMinutes: 0,
      completionNote: null,
      checkItems: [],
    };

    const projected = projectTechnicianWrites(current, [
      queuedWrite({
        id: "other-write",
        workOrderId: "wo-2",
        kind: "transition",
        body: { status: "BLOCKED" },
      }),
    ]);

    expect(projected.status).toBe("IN_PROGRESS");
  });
});
