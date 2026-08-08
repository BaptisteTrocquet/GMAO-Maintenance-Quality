import { describe, expect, it } from "vitest";
import {
  isRetryableTechnicianWriteStatus,
  isTechnicianQueuePartition,
  projectTechnicianWrites,
  technicianRetryDelayMs,
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
    sequence: 1,
    createdAt: "2026-08-08T06:00:00.000Z",
    attempts: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
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

  it("uses bounded exponential retry delays for temporary sync failures", () => {
    expect(technicianRetryDelayMs(1)).toBe(1_000);
    expect(technicianRetryDelayMs(2)).toBe(2_000);
    expect(technicianRetryDelayMs(3)).toBe(4_000);
    expect(technicianRetryDelayMs(6)).toBe(30_000);
    expect(technicianRetryDelayMs(20)).toBe(30_000);
  });

  it("retries only transient HTTP statuses", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableTechnicianWriteStatus(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableTechnicianWriteStatus(status)).toBe(false);
    }
  });

  it("projects queued execution and status writes by monotone sequence", () => {
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
        id: "write-3",
        sequence: 3,
        kind: "transition",
        body: { status: "IN_PROGRESS" },
      }),
      queuedWrite({
        id: "write-1",
        sequence: 1,
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
        sequence: 2,
        kind: "transition",
        body: { status: "BLOCKED" },
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
