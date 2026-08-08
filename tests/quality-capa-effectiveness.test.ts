import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  membershipFindFirst: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    findMany: mocks.auditFindMany,
    create: mocks.auditCreate,
  },
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
  startCapaEffectivenessReview,
  verifyCapaEffectiveness,
} from "@/lib/quality/effectiveness";

const event = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "INVESTIGATING",
};

const readyCapa = {
  eventId: "event-1",
  organizationId: "org-a",
  siteId: "site-a",
  status: "READY_FOR_EFFECTIVENESS",
  objective: "Prevent synthetic recurrence",
  actions: [
    {
      id: "action-1",
      actionKey: "corrective-1",
      type: "CORRECTIVE",
      title: "Correct synthetic cause",
      description: null,
      ownerId: "quality-2",
      dueAt: "2026-08-20T00:00:00.000Z",
      status: "COMPLETED",
      completionNote: "Synthetic completion evidence",
      completedAt: "2026-08-18T00:00:00.000Z",
    },
  ],
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  activatedAt: "2026-08-09T00:00:00.000Z",
  readyForEffectivenessAt: "2026-08-20T00:00:00.000Z",
};

const pendingEffectiveness = {
  eventId: "event-1",
  organizationId: "org-a",
  siteId: "site-a",
  status: "PENDING",
  criteria: "No repeat failure during the observation window.",
  verifierId: "quality-4",
  verifierName: "Synthetic Verifier",
  dueAt: "2026-09-01T00:00:00.000Z",
  result: null,
  summary: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  verifiedAt: null,
};

function mockJson(value: unknown) {
  mocks.auditFindFirst.mockResolvedValueOnce({ afterJson: JSON.stringify(value) });
}

function mockNoRecord() {
  mocks.auditFindFirst.mockResolvedValueOnce(null);
}

describe("CAPA effectiveness verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.membershipFindFirst.mockResolvedValue({
      user: { displayName: "Synthetic Verifier" },
    });
  });

  it("starts an effectiveness review only after CAPA is ready and freezes verifier identity", async () => {
    mockJson(event);
    mockJson(readyCapa);
    mockNoRecord();

    const result = await startCapaEffectivenessReview({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      criteria: " No repeat failure during the observation window. ",
      verifierId: "quality-4",
      dueAt: new Date("2026-09-01T00:00:00.000Z"),
      actorId: "quality-1",
    });

    expect(result).toMatchObject({
      status: "PENDING",
      criteria: "No repeat failure during the observation window.",
      verifierId: "quality-4",
      verifierName: "Synthetic Verifier",
      result: null,
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "QualityCapaEffectiveness",
        action: "EFFECTIVENESS_REVIEW_STARTED",
      }),
    });
  });

  it("rejects a verifier without active site access", async () => {
    mockJson(event);
    mockJson(readyCapa);
    mockNoRecord();
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(
      startCapaEffectivenessReview({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        criteria: "Synthetic criteria",
        verifierId: "outside-user",
        dueAt: new Date("2026-09-01T00:00:00.000Z"),
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "VERIFIER_NOT_FOUND" });
  });

  it("allows only the assigned verifier to record the effectiveness result", async () => {
    mockJson(event);
    mockJson(readyCapa);
    mockJson(pendingEffectiveness);

    await expect(
      verifyCapaEffectiveness({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        result: "EFFECTIVE",
        summary: "Synthetic result",
        actorId: "quality-other",
      }),
    ).rejects.toMatchObject({ code: "EFFECTIVENESS_VERIFIER_REQUIRED" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("records an effective result without reopening the CAPA plan", async () => {
    mockJson(event);
    mockJson(readyCapa);
    mockJson(pendingEffectiveness);

    const result = await verifyCapaEffectiveness({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      result: "EFFECTIVE",
      summary: "No recurrence observed during the synthetic verification period.",
      actorId: "quality-4",
    });

    expect(result).toMatchObject({ status: "VERIFIED", result: "EFFECTIVE" });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "CAPA_EFFECTIVE" }),
    });
  });

  it("reopens an ineffective CAPA as an empty draft so a new action plan is required", async () => {
    mockJson(event);
    mockJson(readyCapa);
    mockJson(pendingEffectiveness);

    const result = await verifyCapaEffectiveness({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      result: "INEFFECTIVE",
      summary: "Synthetic recurrence was detected.",
      actorId: "quality-4",
    });

    expect(result).toMatchObject({ status: "VERIFIED", result: "INEFFECTIVE" });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    const reopenCall = mocks.auditCreate.mock.calls[1]?.[0];
    expect(reopenCall?.data).toMatchObject({
      entityType: "QualityCapa",
      entityId: "event-1",
      action: "CAPA_REOPENED_INEFFECTIVE",
    });
    const reopened = JSON.parse(reopenCall?.data?.afterJson as string);
    expect(reopened.status).toBe("DRAFT");
    expect(reopened.actions).toEqual([]);
    expect(reopened.activatedAt).toBeNull();
    expect(reopened.readyForEffectivenessAt).toBeNull();
  });
});
