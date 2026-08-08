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

vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));

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
      ownerId: "quality-owner",
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

describe("CAPA independent approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rootCauseStatus = "CONFIRMED";
    draftHistory = [{ action: "CAPA_DRAFT_CREATED", actorId: "quality-author" }];
    installReads();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.membershipFindFirst.mockResolvedValue({ id: "approver-membership", role: "QUALITY_MANAGER" });
    mocks.membershipFindMany.mockResolvedValue([{ userId: "quality-owner" }]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("activates a valid draft through an independent site-scoped approver", async () => {
    const approved = await approveCapa({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      approverId: "quality-approver",
      approvalNote: "Independent review complete.",
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
    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "QualityCapa",
        entityId: "event-1",
        action: {
          in: ["CAPA_DRAFT_CREATED", "CAPA_DRAFT_UPDATED", "CAPA_REOPENED_INEFFECTIVE"],
        },
      },
      orderBy: { createdAt: "asc" },
      select: { action: true, actorId: true },
    });
    expect(mocks.auditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: "QualityCapaApproval",
          action: "CAPA_APPROVED",
          actorId: "quality-approver",
        }),
      }),
    );
  });

  it("blocks every author or editor of the current draft cycle", async () => {
    draftHistory = [
      { action: "CAPA_DRAFT_CREATED", actorId: "quality-author" },
      { action: "CAPA_DRAFT_UPDATED", actorId: "quality-approver" },
    ];

    await expect(
      approveCapa({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "quality-approver",
      }),
    ).rejects.toMatchObject({ code: "CAPA_SELF_APPROVAL_NOT_ALLOWED" });
  });

  it("resets author separation after an ineffective CAPA opens a new draft cycle", async () => {
    draftHistory = [
      { action: "CAPA_DRAFT_CREATED", actorId: "quality-previous-author" },
      { action: "CAPA_DRAFT_UPDATED", actorId: "quality-previous-author" },
      { action: "CAPA_REOPENED_INEFFECTIVE", actorId: "quality-verifier" },
      { action: "CAPA_DRAFT_UPDATED", actorId: "quality-new-author" },
    ];

    const approved = await approveCapa({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      approverId: "quality-previous-author",
    });

    expect(approved.status).toBe("ACTIVE");
  });

  it("still blocks the new-cycle author", async () => {
    draftHistory = [
      { action: "CAPA_DRAFT_CREATED", actorId: "quality-previous-author" },
      { action: "CAPA_REOPENED_INEFFECTIVE", actorId: "quality-verifier" },
      { action: "CAPA_DRAFT_UPDATED", actorId: "quality-new-author" },
    ];

    await expect(
      approveCapa({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "quality-new-author",
      }),
    ).rejects.toMatchObject({ code: "CAPA_SELF_APPROVAL_NOT_ALLOWED" });
  });

  it("rejects approvers without the required role or site access", async () => {
    mocks.membershipFindFirst.mockResolvedValue(null);
    await expect(
      approveCapa({
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
