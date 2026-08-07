import type { PublicMaintenanceRequestToken } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditCount: vi.fn(),
  submissionFindFirst: vi.fn(),
  workOrderFindFirst: vi.fn(),
  tokenUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: { count: mocks.auditCount, create: mocks.auditCreate },
    publicMaintenanceRequestSubmission: { findFirst: mocks.submissionFindFirst },
    publicMaintenanceRequestToken: { update: mocks.tokenUpdate },
    workOrder: { findFirst: mocks.workOrderFindFirst },
    $transaction: mocks.transaction,
  },
}));

import { getPublicMaintenanceRequestStatus } from "@/lib/public-requests/status";

const token: PublicMaintenanceRequestToken = {
  id: "token-1",
  organizationId: "org-a",
  siteId: "site-a",
  name: "Embedded portal",
  tokenHash: "hash",
  mode: "EMBEDDED",
  allowedOrigins: ["https://portal.example.test"],
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  revokedAt: null,
  createdById: "manager-1",
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  lastUsedAt: null,
};

describe("public maintenance request status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditCount.mockResolvedValue(0);
    mocks.submissionFindFirst.mockResolvedValue({
      id: "submission-1",
      workOrderId: "wo-1",
      createdAt: new Date("2026-08-07T10:00:00.000Z"),
    });
    mocks.workOrderFindFirst.mockResolvedValue({
      number: "WO-P-001",
      status: "IN_PROGRESS",
      requestedAt: new Date("2026-08-07T10:00:00.000Z"),
      plannedStart: new Date("2026-08-07T12:00:00.000Z"),
      dueAt: new Date("2026-08-08T12:00:00.000Z"),
      startedAt: new Date("2026-08-07T12:05:00.000Z"),
      completedAt: null,
      updatedAt: new Date("2026-08-07T12:05:00.000Z"),
    });
    mocks.tokenUpdate.mockResolvedValue({ id: "token-1" });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.transaction.mockResolvedValue([]);
  });

  it("returns only the minimal public status projection inside the token site", async () => {
    const now = new Date("2026-08-07T12:10:00.000Z");
    const result = await getPublicMaintenanceRequestStatus({
      token,
      trackingId: "submission-1",
      origin: "https://portal.example.test",
      now,
    });

    expect(result).toEqual({
      trackingId: "submission-1",
      workOrder: {
        number: "WO-P-001",
        status: "IN_PROGRESS",
        requestedAt: new Date("2026-08-07T10:00:00.000Z"),
        plannedStart: new Date("2026-08-07T12:00:00.000Z"),
        dueAt: new Date("2026-08-08T12:00:00.000Z"),
        startedAt: new Date("2026-08-07T12:05:00.000Z"),
        completedAt: null,
        updatedAt: new Date("2026-08-07T12:05:00.000Z"),
      },
    });
    expect(mocks.submissionFindFirst).toHaveBeenCalledWith({
      where: { id: "submission-1", tokenId: "token-1" },
      select: { id: true, workOrderId: true, createdAt: true },
    });
    expect(mocks.workOrderFindFirst).toHaveBeenCalledWith({
      where: { id: "wo-1", siteId: "site-a" },
      select: expect.objectContaining({ number: true, status: true, updatedAt: true }),
    });
  });

  it("does not allow one scoped token to read another token's tracking id", async () => {
    mocks.submissionFindFirst.mockResolvedValue(null);

    await expect(
      getPublicMaintenanceRequestStatus({ token, trackingId: "foreign-submission" }),
    ).rejects.toMatchObject({ code: "TRACKING_NOT_FOUND" });
    expect(mocks.workOrderFindFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rate limits status polling after 120 views per hour for the token", async () => {
    mocks.auditCount.mockResolvedValue(120);

    await expect(
      getPublicMaintenanceRequestStatus({ token, trackingId: "submission-1" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(mocks.submissionFindFirst).not.toHaveBeenCalled();
  });

  it("audits every successful status view without exposing internal WO fields", async () => {
    const now = new Date("2026-08-07T12:10:00.000Z");
    await getPublicMaintenanceRequestStatus({
      token,
      trackingId: "submission-1",
      origin: "https://portal.example.test",
      now,
    });

    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "PublicMaintenanceRequestToken",
        entityId: "token-1",
        action: "PUBLIC_STATUS_VIEWED",
        createdAt: now,
        afterJson: expect.stringContaining("submission-1"),
      }),
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
});
