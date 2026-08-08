import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  siteFindFirst: vi.fn(),
  getDashboardKpiConfig: vi.fn(),
  saveDashboardKpiConfig: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({ db: { site: { findFirst: mocks.siteFindFirst } } }));
vi.mock("@/lib/dashboard/kpi-cards", () => ({
  DASHBOARD_KPI_KEYS: [
    "OPEN_WORK",
    "BLOCKED_WORK",
    "OVERDUE_WORK",
    "DUE_SOON_WORK",
    "URGENT_WORK",
    "PENDING_APPROVALS",
  ],
  DashboardKpiConfigError: class DashboardKpiConfigError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  getDashboardKpiConfig: mocks.getDashboardKpiConfig,
  saveDashboardKpiConfig: mocks.saveDashboardKpiConfig,
}));

import { GET, PATCH } from "@/app/api/dashboard/kpi-cards/route";

function auth(overrides: Record<string, unknown> = {}) {
  return {
    session: { user: { id: "user-a" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "VIEWER" as const,
        allSites: false,
        siteIds: ["site-a"],
        active: true,
        ...overrides,
      },
    },
  };
}

function getRequest(siteId = "site-a") {
  return new Request(`http://localhost/api/dashboard/kpi-cards?organizationId=org-a&siteId=${siteId}`);
}

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/dashboard/kpi-cards", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("dashboard KPI cards API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a" });
    mocks.getDashboardKpiConfig.mockResolvedValue({ cards: ["OPEN_WORK"] });
    mocks.saveDashboardKpiConfig.mockResolvedValue({ cards: ["URGENT_WORK", "OPEN_WORK"] });
  });

  it("loads only the authenticated user's site-scoped configuration", async () => {
    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(mocks.getDashboardKpiConfig).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
    });
  });

  it("rejects a site outside explicit membership before reading configuration", async () => {
    const response = await GET(getRequest("site-b"));

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.getDashboardKpiConfig).not.toHaveBeenCalled();
  });

  it("saves an ordered subset for the authenticated user and ignores any client user identity", async () => {
    const response = await PATCH(
      patchRequest({
        organizationId: "org-a",
        siteId: "site-a",
        userId: "attacker-user",
        cards: ["URGENT_WORK", "OPEN_WORK"],
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.saveDashboardKpiConfig).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      userId: "user-a",
      cards: ["URGENT_WORK", "OPEN_WORK"],
    });
  });

  it("allows any authenticated site member to configure their own cards without elevated write permissions", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth({ role: "VIEWER" }));

    const response = await PATCH(
      patchRequest({ organizationId: "org-a", siteId: "site-a", cards: ["OPEN_WORK"] }),
    );

    expect(response.status).toBe(200);
    expect(mocks.saveDashboardKpiConfig).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed JSON and unsupported card keys", async () => {
    const malformed = new Request("http://localhost/api/dashboard/kpi-cards", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect((await PATCH(malformed)).status).toBe(400);

    const unsupported = await PATCH(
      patchRequest({ organizationId: "org-a", siteId: "site-a", cards: ["NOT_A_CARD"] }),
    );
    expect(unsupported.status).toBe(400);
    expect(mocks.saveDashboardKpiConfig).not.toHaveBeenCalled();
  });
});
