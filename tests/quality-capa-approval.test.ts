import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditCreate: vi.fn(),
  membershipFindFirst: vi.fn(),
  membershipFindMany: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
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

import { approveCapa } from "@/lib/quality/capa-approval";

const event = { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" };
const rootCause = { organizationId: "org-a", siteId: "site-a", status: "CONFIRMED" };
const draft = {
  eventId: "event-1",
  organizationId: "org-a",
  siteId: "site-a",
  status: "DRAFT",
  objective: "Remove confirmed synthetic cause",
  actions: [
    {
      id: "action-1",
      actionKey: "corrective-1",
      type: "CORRECTIVE",
      title: "Correct synthetic cause",
      description: null,
      ownerId: "quality-2",
      dueAt: "2026-08-20T00:00:00.000Z",
      status: "PLANNED",
      completionNote: null,
      completedAt: null,
    },
  ],
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:30:00.000Z",
  activatedAt: null,
  readyForEffectivenessAt: null,
};

function mockApprovalReads(lastDraftEditorId = "quality-author") {
  mocks.auditFindFirst
    .mockResolvedValueOnce({ afterJson: JSON.stringify(event) })
    .mockResolvedValueOnce({ afterJson: JSON.stringify(rootCause) })
    .mockResolvedValueOnce({ afterJson: JSON.stringify(draft) })
    .mockResolvedValueOnce({ actorId: lastDraftEditorId });
}

describe("CAPA approval separation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.membershipFindFirst.mockResolvedValue({ id: "approver-membership", role: "QUALITY_MANAGER" });
    mocks.membershipFindMany.mockResolvedValue([{ userId: "quality-2" }]);
  });

  it("approves a draft only after confirmed RCA and records approver audit", async () => {
    mockApprovalReads();

    const approved = await approveCapa({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      approverId: "quality-approver",
      approvalNote: "Reviewed synthetic CAPA plan.",
    });

    expect(approved.status).toBe("ACTIVE");
    expect(approved.activatedAt).toBeTruthy();
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
    expect(mocks.auditFindFirst).toHaveBeenNthCalledWith(4, {
      where: {
        entityType: "QualityCapa",
        entityId: "event-1",
        action: { in: ["CAPA_DRAFT_CREATED", "CAPA_DRAFT_UPDATED"] },
      },
      orderBy: { createdAt: "desc" },
      select: { actorId: true },
    });
    expect(mocks.membershipFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        userId: { in: ["quality-2"] },
        active: true,
        user: { active: true },
        OR: [{ allSites: true }, { siteMemberships: { some: { siteId: "site-a" } } }],
      },
      select: { userId: true },
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
          action: "CAPA_ACTIVATED",
          actorId: "quality-approver",
        }),
      }),
    );
  });

  it("rejects approval by the user who last authored or edited the CAPA draft", async () => {
    mockApprovalReads("quality-approver");

    await expect(
      approveCapa({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "quality-approver",
      }),
    ).rejects.toMatchObject({ code: "CAPA_SELF_APPROVAL_NOT_ALLOWED" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects approvers without an active quality/admin/owner membership or site access", async () => {
    mockApprovalReads();
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(
      approveCapa({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "tech-or-other-site-user",
      }),
    ).rejects.toMatchObject({ code: "CAPA_APPROVER_NOT_ALLOWED" });
  });

  it("revalidates action owners and their site access at approval time", async () => {
    mockApprovalReads();
    mocks.membershipFindMany.mockResolvedValue([]);

    await expect(
      approveCapa({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "quality-approver",
      }),
    ).rejects.toMatchObject({ code: "ACTION_OWNER_NOT_FOUND" });
  });

  it("rejects approval until root cause is confirmed", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify({ ...rootCause, status: "DRAFT" }) });

    await expect(
      approveCapa({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "quality-approver",
      }),
    ).rejects.toMatchObject({ code: "ROOT_CAUSE_CONFIRMATION_REQUIRED" });
  });
});
