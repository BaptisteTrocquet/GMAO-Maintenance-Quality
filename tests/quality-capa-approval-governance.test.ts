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

import { approveCapaGoverned } from "@/lib/quality/capa-approval";

const event = { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" };
const rootCause = { organizationId: "org-a", siteId: "site-a", status: "CONFIRMED" };
const draft = {
  eventId: "event-1",
  organizationId: "org-a",
  siteId: "site-a",
  status: "DRAFT",
  planSummary: "Remove a synthetic confirmed cause",
  actions: [
    {
      id: "67f99d5d-30bd-4c68-a824-25819781f366",
      type: "CORRECTIVE",
      title: "Correct synthetic cause",
      description: null,
      ownerId: "owner-1",
      dueAt: "2026-08-20T10:00:00.000Z",
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
  mocks.auditFindMany.mockImplementation(async () =>
    draftAuthorIds.map((actorId) => ({ actorId })),
  );
}

describe("CAPA approval governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockReset();
    mocks.auditFindFirst.mockReset();
    mocks.auditFindMany.mockReset();
    mocks.auditCreate.mockReset();
    mocks.membershipFindFirst.mockReset();
    mocks.membershipFindMany.mockReset();

    rootCauseStatus = "CONFIRMED";
    draftAuthorIds = ["draft-author"];
    installAuditReads();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.membershipFindFirst.mockResolvedValue({ role: "QUALITY_MANAGER" });
    mocks.membershipFindMany.mockResolvedValue([{ userId: "owner-1" }]);
  });

  it("approves with an independent site-scoped quality approver and records the decision", async () => {
    const approved = await approveCapaGoverned({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      approverId: "approver-1",
    });

    expect(approved.status).toBe("ACTIVE");
    expect(approved.approvedById).toBe("approver-1");
    expect(mocks.membershipFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        userId: "approver-1",
        active: true,
        role: { in: ["OWNER", "ADMIN", "QUALITY_MANAGER"] },
        user: { active: true },
        OR: [{ allSites: true }, { siteMemberships: { some: { siteId: "site-a" } } }],
      },
      select: { role: true },
    });
    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "QualityCapa",
        entityId: "event-1",
        action: { in: ["CREATED", "PLAN_UPDATED"] },
      },
      select: { actorId: true },
    });
    expect(mocks.auditCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: "QualityCapaApproval",
          action: "CAPA_APPROVED",
          actorId: "approver-1",
        }),
      }),
    );
    expect(mocks.auditCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: "QualityCapa",
          action: "APPROVED",
          actorId: "approver-1",
        }),
      }),
    );
  });

  it("blocks approval by any user who authored or edited the CAPA draft", async () => {
    draftAuthorIds = ["draft-author", "approver-1", "later-editor"];

    await expect(
      approveCapaGoverned({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "approver-1",
      }),
    ).rejects.toMatchObject({ code: "CAPA_SELF_APPROVAL_NOT_ALLOWED" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("blocks the original author even after a different user edited later", async () => {
    draftAuthorIds = ["original-author", "later-editor"];

    await expect(
      approveCapaGoverned({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "original-author",
      }),
    ).rejects.toMatchObject({ code: "CAPA_SELF_APPROVAL_NOT_ALLOWED" });
  });

  it("blocks users without an allowed approval role or site access", async () => {
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(
      approveCapaGoverned({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "technician-or-other-site-user",
      }),
    ).rejects.toMatchObject({ code: "CAPA_APPROVER_NOT_ALLOWED" });
  });

  it("revalidates every action owner at approval time", async () => {
    mocks.membershipFindMany.mockResolvedValue([]);

    await expect(
      approveCapaGoverned({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "approver-1",
      }),
    ).rejects.toMatchObject({ code: "ACTION_OWNER_NOT_FOUND" });
  });

  it("requires confirmed root cause before approval", async () => {
    rootCauseStatus = "DRAFT";

    await expect(
      approveCapaGoverned({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        approverId: "approver-1",
      }),
    ).rejects.toMatchObject({ code: "ROOT_CAUSE_REQUIRED" });
  });
});
