import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  getMaintenanceForecast: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/maintenance/forecast", () => ({ getMaintenanceForecast: mocks.getMaintenanceForecast }));

import { GET } from "@/app/api/maintenance-forecast/route";

const auth = {
  session: { user: { id: "viewer-1" } },
  tenant: {
    scope: {
      organizationId: "org-a",
      role: "VIEWER",
      allSites: false,
      siteIds: ["site-a"],
      active: true,
    },
  },
};

function request(siteId = "site-a", horizonDays = "30") {
  return new Request(
    `http://localhost/api/maintenance-forecast?organizationId=org-a&siteId=${siteId}&horizonDays=${horizonDays}`,
  );
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("maintenance forecast API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.getMaintenanceForecast.mockResolvedValue({
      site: { id: "site-a", code: "S1", name: "Site 1" },
      generatedAt: new Date("2026-08-07T12:00:00.000Z"),
      horizonDays: 30,
      health: { score: 100, status: "HEALTHY" },
      entries: [],
    });
  });

  it("returns a site-scoped forecast to a user with maintenance read access", async () => {
    const response = await GET(request());

    await expectStatus(response, 200);
    expect(mocks.getMaintenanceForecast).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      horizonDays: 30,
    });
  });

  it("rejects a site outside the user's tenant scope", async () => {
    const response = await GET(request("site-b"));

    await expectStatus(response, 403);
    expect(mocks.getMaintenanceForecast).not.toHaveBeenCalled();
  });

  it("rejects an excessive forecast horizon", async () => {
    const response = await GET(request("site-a", "365"));

    await expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
