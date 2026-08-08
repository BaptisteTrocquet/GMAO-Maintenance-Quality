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

import {
  assertIndependentCapaApprover,
  CapaApprovalGuardError,
} from "@/lib/quality/capa-approval";

const input = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  approverId: "quality-approver",
};

describe("independent CAPA approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.membershipFindFirst.mockResolvedValue({ id: "membership-1" });
    mocks.auditFindMany.mockResolvedValue([]);
  });

  it("requires an eligible quality approver with site access", async () => {
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(assertIndependentCapaApprover(input)).rejects.toMatchObject({
      code: "CAPA_APPROVER_NOT_ALLOWED",
    });
    expect(mocks.membershipFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        userId: "quality-approver",
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
  });

  it("rejects self-approval when the approver authored the current draft", async () => {
    mocks.auditFindMany.mockResolvedValue([
      { action: "CREATED", actorId: "quality-approver" },
      { action: "PLAN_UPDATED", actorId: "editor-2" },
    ]);

    await expect(assertIndependentCapaApprover(input)).rejects.toBeInstanceOf(
      CapaApprovalGuardError,
    );
    await expect(assertIndependentCapaApprover(input)).rejects.toMatchObject({
      code: "CAPA_SELF_APPROVAL_NOT_ALLOWED",
    });
  });

  it("allows an eligible approver who did not edit the current draft", async () => {
    mocks.auditFindMany.mockResolvedValue([
      { action: "CREATED", actorId: "editor-1" },
      { action: "PLAN_UPDATED", actorId: "editor-2" },
    ]);

    await expect(assertIndependentCapaApprover(input)).resolves.toBeUndefined();
  });

  it("resets draft authors after an effectiveness failure", async () => {
    mocks.auditFindMany.mockResolvedValue([
      { action: "CREATED", actorId: "quality-approver" },
      { action: "APPROVED", actorId: "approver-2" },
      { action: "EFFECTIVENESS_FAILED", actorId: "verifier-1" },
      { action: "PLAN_UPDATED", actorId: "editor-2" },
    ]);

    await expect(assertIndependentCapaApprover(input)).resolves.toBeUndefined();
  });

  it("rejects an approver who edited after the latest reopen boundary", async () => {
    mocks.auditFindMany.mockResolvedValue([
      { action: "CREATED", actorId: "editor-1" },
      { action: "APPROVED", actorId: "approver-2" },
      { action: "REOPENED", actorId: "quality-approver" },
      { action: "PLAN_UPDATED", actorId: "quality-approver" },
    ]);

    await expect(assertIndependentCapaApprover(input)).rejects.toMatchObject({
      code: "CAPA_SELF_APPROVAL_NOT_ALLOWED",
    });
  });
});
