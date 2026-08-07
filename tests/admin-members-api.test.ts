import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  revokeSessions: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({
  db: {
    organizationMembership: {
      findMany: mocks.findMany,
      findFirst: mocks.findFirst,
      update: mocks.update,
    },
    session: { updateMany: mocks.revokeSessions },
  },
}));

import { GET, PATCH } from "@/app/api/admin/members/route";

describe("admin member API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects cross-tenant member reads before database access", async () => {
    mocks.authenticateRequest.mockResolvedValueOnce({
      error: Response.json({ error: { code: "TENANT_ACCESS_DENIED" } }, { status: 403 }),
    });
    const response = await GET(new Request("http://localhost/api/admin/members?organizationId=org-b"));
    expect(response.status).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("revokes active sessions when a membership is disabled", async () => {
    mocks.authenticateRequest.mockResolvedValueOnce({
      session: { user: { id: "admin-1" } },
      tenant: { scope: { role: "ADMIN", organizationId: "org-a", siteIds: [] } },
    });
    mocks.findFirst.mockResolvedValueOnce({ id: "membership-1", userId: "user-2" });
    mocks.update.mockResolvedValueOnce({ id: "membership-1", role: "VIEWER", active: false, allSites: false });

    const response = await PATCH(new Request("http://localhost/api/admin/members", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId: "org-a", membershipId: "membership-1", active: false }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.revokeSessions).toHaveBeenCalledWith({
      where: { userId: "user-2", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
