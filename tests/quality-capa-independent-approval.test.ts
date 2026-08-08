import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  membershipFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    organizationMembership: { findFirst: mocks.membershipFindFirst },
    auditLog: { findMany: mocks.auditFindMany },
  },
}));

import { assertIndependentCapaApprover } from "@/lib/quality/capa-approval";

const input = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  approverId: "approver-1",
};

describe("independent CAPA approval guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.membershipFindFirst.mockResolvedValue({ id: "membership-1" });
    mocks.auditFindMany.mockResolvedValue([
      { actorId: "draft-author-1" },
      { actorId: "draft-editor-2" },
    ]);
  });

  it("requires an active privileged approver with site access", async () => {
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(assertIndependentCapaApprover(input)).rejects.toMatchObject({
      code: "CAPA_APPROVER_NOT_ALLOWED",
    });
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
  });

  it("rejects approval by anyone who authored or edited the CAPA draft", async () => {
    mocks.auditFindMany.mockResolvedValue([
      { actorId: "draft-author-1" },
      { actorId: "approver-1" },
    ]);

    await expect(assertIndependentCapaApprover(input)).rejects.toMatchObject({
      code: "CAPA_SELF_APPROVAL_NOT_ALLOWED",
    });
  });

  it("allows a separate privileged approver and scopes draft history to the CAPA event", async () => {
    await expect(assertIndependentCapaApprover(input)).resolves.toBeUndefined();

    expect(mocks.membershipFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        userId: "approver-1",
        active: true,
        role: { in: ["OWNER", "ADMIN", "QUALITY_MANAGER"] },
        user: { active: true },
        OR: [
          { allSites: true },
          { siteMemberships: { some: { siteId: "site-a" } } },
        ],
      },
      select: { id: true },
    });
    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "QualityCapa",
        entityId: "event-1",
        action: { in: ["CREATED", "PLAN_UPDATED"] },
      },
      select: { actorId: true },
    });
  });
});
