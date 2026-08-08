import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  membershipFindFirst: vi.fn(),
  membershipFindMany: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    findMany: mocks.auditFindMany,
    create: mocks.auditCreate,
  },
  organizationMembership: {
    findFirst: mocks.membershipFindFirst,
    findMany: mocks.membershipFindMany,
  },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
  },
}));

import { approveCapaWithGovernance } from "@/lib/quality/capa-approval";

const event = { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" };
const rootCause = { organizationId: "org-a", siteId: "site-a", status: "CONFIRMED" };
const draft = {
  eventId: "event-1",
  organizationId: "org-a",
  siteId: "site-a",
  status: "DRAFT",
  planSummary: "Remove the confirmed synthetic failure mechanism.",
  actions: [
    {
      id: "action-1",
      type: "CORRECTIVE",
      title: "Correct synthetic cause",
      description: null,
      ownerId: "quality-owner",
      dueAt: "2026-08-20T00:00:00.000Z",
      status: "OPEN",
      completionNote: null,
      completedById: null,
      completedAt: null,
    },
  ],
  approvedById: null,
  approvedAt: null,
  effectivenessChecks: [],
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:30:00.000Z",
  closedAt: null,
};

let rootCauseStatus: "DRAFT" | "CONFIRMED";
let draftHistory: Array<{ action: string; actorId: string | null }>;

function installReads() {
  mocks.auditFindFirst.mockImplementation(
    async ({ where }: { where: { entityType: string } }) => {
      if (where.entityType === "QualityEvent") return { afterJson: JSON.stringify(event) };
      if (where.entityType === "QualityRootCause") {
        return { afterJson: JSON.stringify({ ...rootCause, status: rootCauseStatus }) };
      }
      if (where.entityType === "QualityCapa") return { afterJson: JSON.stringify(draft) };
      return null;
    },
  );
  mocks.auditFindMany.mockImplementation(async () => draftHistory);
}

describe("CAPA approval governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rootCauseStatus = "CONFIRMED";
    draftHistory = [{ action: "CREATED", actorId: "quality-author" }];
    installReads();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.membershipFindFirst.mockResolvedValue({ id: "membership-1", role: "QUALITY_MANAGER" });
    mocks.membershipFindMany.mockResolvedValue([{ userId: "quality-owner" }]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("approves a draft with an independent quality approver and records the approval", async () => {
    const approved = await approveCapaWithGovernance({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      approverId: "quality-approver",
      approvalNote: "Independent review completed.",
    });

    expect(approved.status).toBe("ACTIVE");
    expect(approved.approvedById).toBe("quality-approver");
    expect(mocks.membershipFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        userId: "quality-approver",
        active: true,
        role: { in: ["OWNER", "ADMIN", "QUALITY_MANAGER"] },
        user: { active: true },
        OR: [{ allSites: true }, { siteMemberships: { some: { siteId: "site-a" } } }],
      },
      select: { id: true, role: true },
    });
    expect(mocks.auditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: "QualityCapaApproval",
          action: "CAPA_APPROVED",
          actorId: "quality-approver",
          afterJson: expect.stringContaining('"approvedDraftUpdatedAt":"2026-08-08T00:30:00.000Z"'),
        }),
      }),
    );
    expect(mocks.auditCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: "QualityCapa",
          action: "APPROVED",
          actorId: "quality-approver",
        }),
      }),
    );
  });

  it("rejects self-approval by any author or editor of the current draft cycle", async () => {
    draftHistory = [
      { action: "CREATED", actorId: "quality-author" },
      { action: "PLAN_UPDATED", actorId: "quality-approver" },
    ];

    await expect(
      approveCapaWithGovernance({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "quality-approver",
      }),
    ).rejects.toMatchObject({ code: "CAPA_SELF_APPROVAL_NOT_ALLOWED" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("allows a previous-cycle author to approve after a new draft cycle was authored independently", async () => {
    draftHistory = [
      { action: "CREATED", actorId: "quality-previous-author" },
      { action: "EFFECTIVENESS_FAILED", actorId: "quality-verifier" },
      { action: "PLAN_UPDATED", actorId: "quality-new-author" },
    ];

    const approved = await approveCapaWithGovernance({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      approverId: "quality-previous-author",
    });

    expect(approved.approvedById).toBe("quality-previous-author");
  });

  it("rejects approvers without the required role or active site access", async () => {
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(
      approveCapaWithGovernance({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "technician-1",
      }),
    ).rejects.toMatchObject({ code: "CAPA_APPROVER_NOT_ALLOWED" });
  });

  it("revalidates action owners at approval time", async () => {
    mocks.membershipFindMany.mockResolvedValue([]);

    await expect(
      approveCapaWithGovernance({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "quality-approver",
      }),
    ).rejects.toMatchObject({ code: "ACTION_OWNER_NOT_FOUND" });
  });

  it("rejects approval until root cause is confirmed", async () => {
    rootCauseStatus = "DRAFT";

    await expect(
      approveCapaWithGovernance({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "quality-approver",
      }),
    ).rejects.toMatchObject({ code: "ROOT_CAUSE_CONFIRMATION_REQUIRED" });
  });
});
