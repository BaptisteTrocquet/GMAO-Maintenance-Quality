import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ membershipFindMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: {
    organizationMembership: { findMany: mocks.membershipFindMany },
  },
}));

import { assertCapaOwnersInSite } from "@/lib/quality/capa-owner-scope";

describe("CAPA owner site scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries only active users with organization and selected-site access", async () => {
    mocks.membershipFindMany.mockResolvedValue([{ userId: "owner-1" }, { userId: "owner-2" }]);

    await expect(
      assertCapaOwnersInSite({
        organizationId: "org-a",
        siteId: "site-a",
        ownerIds: ["owner-1", "owner-2", "owner-1"],
      }),
    ).resolves.toBeUndefined();

    expect(mocks.membershipFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        userId: { in: ["owner-1", "owner-2"] },
        active: true,
        user: { active: true },
        OR: [
          { allSites: true },
          { siteMemberships: { some: { siteId: "site-a" } } },
        ],
      },
      select: { userId: true },
    });
  });

  it("rejects when any requested owner is outside the selected site", async () => {
    mocks.membershipFindMany.mockResolvedValue([{ userId: "owner-1" }]);

    await expect(
      assertCapaOwnersInSite({
        organizationId: "org-a",
        siteId: "site-a",
        ownerIds: ["owner-1", "owner-outside-site"],
      }),
    ).rejects.toMatchObject({ name: "CapaOwnerScopeError" });
  });
});
