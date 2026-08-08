import { describe, expect, it } from "vitest";
import {
  OFFLINE_READ_PARTITION_HEADER,
  offlineReadPartitionFromAuthorization,
} from "@/lib/pwa/offline-read-cache";

describe("offline technician read cache partition", () => {
  it("derives a stable opaque partition from the bearer session", () => {
    const first = offlineReadPartitionFromAuthorization("Bearer synthetic-session-token");
    const second = offlineReadPartitionFromAuthorization("Bearer synthetic-session-token");

    expect(OFFLINE_READ_PARTITION_HEADER).toBe("x-opengmao-offline-partition");
    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(first).toBe(second);
    expect(first).not.toContain("synthetic-session-token");
  });

  it("separates sessions and rejects missing bearer credentials", () => {
    expect(offlineReadPartitionFromAuthorization("Bearer session-a")).not.toBe(
      offlineReadPartitionFromAuthorization("Bearer session-b"),
    );
    expect(offlineReadPartitionFromAuthorization(null)).toBe("");
    expect(offlineReadPartitionFromAuthorization("Basic abc")).toBe("");
    expect(offlineReadPartitionFromAuthorization("Bearer   ")).toBe("");
  });
});
