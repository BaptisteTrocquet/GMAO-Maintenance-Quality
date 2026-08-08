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

let rootCauseStatus: "DRAFT" | "CONFIRMED";
let lastDraftEditorId: string | null;

function installApprovalReads() {
  mocks.auditFindFirst.mockImplementation(
    async ({ where }: { where: { entityType: string; action?: unknown } }) => {
      if (where.entityType === "QualityEvent") {
        return { afterJson: JSON.stringify(event) };
      }
      if (where.entityType === "QualityRootCause") {
        return { afterJson: JSON.stringify({ ...rootCause, status: rootCauseStatus }) };
      }
      if (where.entityType === "QualityCapa" && where.action) {
        return lastDraftEditorId ? { actorId: lastDraftEditorId } : null;
      }
      if (where.entityType === "QualityCapa") {
        return { afterJson: JSON.stringify(draft) };
      }
      return null;
    },
  );
}

describe("CAPA approval separation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditFindFirst.mockReset();
    mocks.auditCreate.mockReset();
    mocks.membershipFindFirst.mockReset();
    mocks.membershipFindMany.mockReset();
    mocks.transaction.mockReset();

    rootCauseStatus = "CONFIRMED";
    lastDraftEditorId = "quality-author";
    installApprovalReads();

    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.membershipFindFirst.mockResolvedValue({ id: "approver-membership", role: "QUALITY_MANAGER" });
    mocks.membershipFindMany.mockResolvedValue([{ userId: "quality-2" }]);
  });

  it("approves a draft only after confirmed RCA and records approver audit", async () => {
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
    expect(mocks.auditFindFirst).toHaveBeenCalledWith({
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
    lastDraftEditorId = "quality-approver";

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
    rootCauseStatus = "DRAFT";

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
