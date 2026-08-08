import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  buildNotificationCenter: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/notifications/center", () => ({ buildNotificationCenter: mocks.buildNotificationCenter }));

import { GET } from "@/app/api/notifications/route";

function request(siteId = "site-a") {
  const params = new URLSearchParams({ organizationId: "org-a", siteId });
  return new Request(`http://localhost/api/notifications?${params.toString()}`);
}

function auth(scope: Record<string, unknown> = {}) {
  return {
    session: { user: { id: "user-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "VIEWER",
        allSites: false,
        siteIds: ["site-a"],
        active: true,
        ...scope,
      },
    },
  };
}

describe("notification center API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.buildNotificationCenter.mockResolvedValue([]);
  });

  it("rejects a site outside the authenticated membership", async () => {
    const response = await GET(request("site-b"));
    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildNotificationCenter).not.toHaveBeenCalled();
  });

  it("validates that the selected site belongs to the organization", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(mocks.siteFindFirst).toHaveBeenCalledWith({
      where: { id: "site-a", organizationId: "org-a", active: true },
      select: { id: true },
    });
    expect(mocks.buildNotificationCenter).not.toHaveBeenCalled();
  });

  it("passes the authenticated role and selected scope to notification aggregation", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ role: "MAINTENANCE_MANAGER" }));
    mocks.buildNotificationCenter.mockResolvedValue([
      {
        key: "work:wo-1:overdue",
        kind: "WORK_OVERDUE",
        severity: "CRITICAL",
        title: "WO-001 · Synthetic inspection",
        description: "Overdue",
        href: "/maintenance/wo-1",
        occurredAt: new Date("2026-08-08T10:00:00.000Z"),
        dueAt: new Date("2026-08-07T10:00:00.000Z"),
      },
    ]);

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mocks.buildNotificationCenter).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      role: "MAINTENANCE_MANAGER",
    });
    await expect(response.json()).resolves.toEqual({
      data: { items: [expect.objectContaining({ key: "work:wo-1:overdue", severity: "CRITICAL" })] },
    });
  });
});
