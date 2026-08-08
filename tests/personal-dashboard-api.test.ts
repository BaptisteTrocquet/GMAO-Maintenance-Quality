import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  buildDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/maintenance/personal-dashboard", () => ({
  buildPersonalMaintenanceDashboard: mocks.buildDashboard,
}));

import { GET } from "@/app/api/me/dashboard/route";

function auth(siteIds: string[] = ["site-a"]) {
  return {
    session: { user: { id: "session-user" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "TECHNICIAN",
        allSites: false,
        siteIds,
        active: true,
      },
    },
  };
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("personal dashboard API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.buildDashboard.mockResolvedValue({ workOrders: [], reminders: [], counts: {} });
  });

  it("uses the authenticated user identity, never a caller-supplied user id", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/me/dashboard?organizationId=org-a&siteId=site-a&userId=spoofed",
      ),
    );

    await expectStatus(response, 200);
    expect(mocks.buildDashboard).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "session-user",
      role: "TECHNICIAN",
    });
  });

  it("rejects a selected site outside membership before reading personal work", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth(["site-b"]));

    const response = await GET(
      new Request("http://localhost/api/me/dashboard?organizationId=org-a&siteId=site-a"),
    );

    await expectStatus(response, 403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.buildDashboard).not.toHaveBeenCalled();
  });

  it("returns opaque not-found for a foreign or inactive site", async () => {
    mocks.siteFindFirst.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/me/dashboard?organizationId=org-a&siteId=site-a"),
    );

    await expectStatus(response, 404);
    expect(mocks.buildDashboard).not.toHaveBeenCalled();
  });

  it("rejects missing scope before authentication", async () => {
    const response = await GET(new Request("http://localhost/api/me/dashboard"));

    await expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
