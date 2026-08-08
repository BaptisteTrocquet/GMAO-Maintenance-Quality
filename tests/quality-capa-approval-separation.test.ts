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
  db: { $transaction: mocks.transaction },
}));

import { approveCapaWithSeparation } from "@/lib/quality/capa-approval";

const event = { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" };
const rootCause = { organizationId: "org-a", siteId: "site-a", status: "CONFIRMED" };
const draft = {
  eventId: "event-1",
  organizationId: "org-a",
  siteId: "site-a",
  status: "DRAFT",
  planSummary: "Synthetic CAPA plan",
  actions: [
    {
      id: "action-1",
      type: "CORRECTIVE",
      title: "Correct synthetic cause",
      description: null,
      ownerId: "owner-1",
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
let draftAuthorIds: string[];

function installAuditReads() {
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
  mocks.auditFindMany.mockResolvedValue(draftAuthorIds.map((actorId) => ({ actorId })));
}

describe("independent CAPA approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rootCauseStatus = "CONFIRMED";
    draftAuthorIds = ["draft-author"];
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.membershipFindFirst.mockResolvedValue({ id: "approver-membership", role: "QUALITY_MANAGER" });
    mocks.membershipFindMany.mockResolvedValue([{ userId: "owner-1" }]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    installAuditReads();
  });

  it("approves with an independent quality approver and records the approval decision", async () => {
    const result = await approveCapaWithSeparation({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      approverId: "quality-approver",
      approvalNote: "Reviewed synthetic plan.",
    });

    expect(result.status).toBe("ACTIVE");
    expect(result.approvedById).toBe("quality-approver");
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

  it("rejects an approver without an allowed active role and site access", async () => {
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(
      approveCapaWithSeparation({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "technician-1",
      }),
    ).rejects.toMatchObject({ code: "CAPA_APPROVER_NOT_ALLOWED" });
  });

  it("rejects self approval by any user who authored or edited the current draft", async () => {
    draftAuthorIds = ["draft-author", "quality-approver"];
    installAuditReads();

    await expect(
      approveCapaWithSeparation({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "quality-approver",
      }),
    ).rejects.toMatchObject({ code: "CAPA_SELF_APPROVAL_NOT_ALLOWED" });
  });

  it("revalidates action owners at approval time", async () => {
    mocks.membershipFindMany.mockResolvedValue([]);

    await expect(
      approveCapaWithSeparation({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "quality-approver",
      }),
    ).rejects.toMatchObject({ code: "ACTION_OWNER_NOT_FOUND" });
  });

  it("rejects approval when root cause is no longer confirmed", async () => {
    rootCauseStatus = "DRAFT";
    installAuditReads();

    await expect(
      approveCapaWithSeparation({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "quality-approver",
      }),
    ).rejects.toMatchObject({ code: "ROOT_CAUSE_REQUIRED" });
  });
});
