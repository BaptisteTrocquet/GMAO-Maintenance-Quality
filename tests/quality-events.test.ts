import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  siteFindFirst: vi.fn(),
  membershipFindFirst: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    create: mocks.auditCreate,
  },
  site: { findFirst: mocks.siteFindFirst },
  organizationMembership: { findFirst: mocks.membershipFindFirst },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    auditLog: {
      findFirst: mocks.auditFindFirst,
      findMany: mocks.auditFindMany,
    },
  },
}));

import {
  completeContainment,
  createQualityEvent,
  startOrUpdateContainment,
  updateQualityEvent,
} from "@/lib/quality/events";
import { queryQualityEvents } from "@/lib/quality/queries";

const createInput = {
  organizationId: "org-a",
  siteId: "site-a",
  eventKey: "line-check-2026-08-08-001",
  type: "NONCONFORMITY" as const,
  severity: "HIGH" as const,
  title: "Synthetic dimensional nonconformity",
  description: "Synthetic quality event used for automated tests.",
  occurredAt: new Date("2026-08-08T00:00:00.000Z"),
  actorId: "quality-1",
};

describe("quality event workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.membershipFindFirst.mockResolvedValue({ id: "membership-1" });
  });

  it("creates an idempotent open quality event with an audit snapshot", async () => {
    const first = await createQualityEvent(createInput);

    expect(first.idempotent).toBe(false);
    expect(first.qualityEvent).toMatchObject({
      organizationId: "org-a",
      siteId: "site-a",
      type: "NONCONFORMITY",
      severity: "HIGH",
      status: "OPEN",
      detectedById: "quality-1",
      containment: null,
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "QualityEvent",
        action: "CREATED",
        actorId: "quality-1",
      }),
    });

    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(first.qualityEvent) });
    mocks.auditCreate.mockClear();

    const retry = await createQualityEvent(createInput);
    expect(retry.idempotent).toBe(true);
    expect(retry.qualityEvent.id).toBe(first.qualityEvent.id);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects reuse of eventKey for a different payload", async () => {
    const first = await createQualityEvent(createInput);
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(first.qualityEvent) });

    await expect(
      createQualityEvent({ ...createInput, title: "Different synthetic event" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("starts containment only with an active organization member as owner", async () => {
    const created = await createQualityEvent(createInput);
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(created.qualityEvent) });
    mocks.auditCreate.mockClear();

    const contained = await startOrUpdateContainment({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: created.qualityEvent.id,
      summary: "Segregate synthetic affected material and hold release.",
      ownerId: "quality-2",
      dueAt: new Date("2026-08-09T12:00:00.000Z"),
      actorId: "quality-1",
    });

    expect(contained.status).toBe("CONTAINMENT");
    expect(contained.containment).toMatchObject({
      ownerId: "quality-2",
      summary: "Segregate synthetic affected material and hold release.",
      completedAt: null,
    });
    expect(mocks.membershipFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-a", userId: "quality-2", active: true }),
      }),
    );
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "CONTAINMENT_STARTED" }),
    });
  });

  it("rejects a containment owner outside the active organization membership", async () => {
    const created = await createQualityEvent(createInput);
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(created.qualityEvent) });
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(
      startOrUpdateContainment({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: created.qualityEvent.id,
        summary: "Synthetic containment",
        ownerId: "user-other-org",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "CONTAINMENT_OWNER_NOT_FOUND" });
  });

  it("requires containment to be started before completion", async () => {
    const created = await createQualityEvent(createInput);
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(created.qualityEvent) });

    await expect(
      completeContainment({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: created.qualityEvent.id,
        completionNote: "Synthetic completion",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS_TRANSITION" });
  });

  it("completes containment and locks the event record", async () => {
    const created = await createQualityEvent(createInput);
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(created.qualityEvent) });
    const inContainment = await startOrUpdateContainment({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: created.qualityEvent.id,
      summary: "Segregate synthetic affected material.",
      actorId: "quality-1",
    });

    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(inContainment) });
    const completed = await completeContainment({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: created.qualityEvent.id,
      completionNote: "Synthetic material was segregated and identified.",
      actorId: "quality-1",
    });

    expect(completed.status).toBe("CONTAINED");
    expect(completed.containment?.completedAt).toBeTruthy();
    expect(completed.containment?.completionNote).toContain("segregated");

    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(completed) });
    await expect(
      updateQualityEvent({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: completed.id,
        title: "Changed after containment",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "EVENT_LOCKED" });
  });

  it("filters event IDs through exact tenant/site scope before returning results", async () => {
    const created = await createQualityEvent(createInput);
    mocks.auditFindMany.mockResolvedValue([{ entityId: created.qualityEvent.id }]);
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(created.qualityEvent) });

    const ownSite = await queryQualityEvents({ organizationId: "org-a", siteId: "site-a" });
    const otherSite = await queryQualityEvents({ organizationId: "org-a", siteId: "site-b" });

    expect(ownSite).toHaveLength(1);
    expect(otherSite).toHaveLength(0);
  });
});
