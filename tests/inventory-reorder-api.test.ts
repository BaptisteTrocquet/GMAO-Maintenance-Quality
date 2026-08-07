import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ReorderPolicyError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    listPolicies: vi.fn(),
    setPolicy: vi.fn(),
    disablePolicy: vi.fn(),
    getAlerts: vi.fn(),
    ReorderPolicyError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/inventory/reorder", () => ({
  listReorderPolicies: mocks.listPolicies,
  setReorderPolicy: mocks.setPolicy,
  disableReorderPolicy: mocks.disablePolicy,
  getReorderAlerts: mocks.getAlerts,
  ReorderPolicyError: mocks.ReorderPolicyError,
}));

import { GET as getAlerts } from "@/app/api/inventory/reorder-alerts/route";
import { POST as setPolicy } from "@/app/api/inventory/reorder-policies/route";

function auth(role: "TECHNICIAN" | "MAINTENANCE_MANAGER") {
  return {
    session: { user: { id: role === "TECHNICIAN" ? "tech-1" : "manager-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role,
        allSites: true,
        siteIds: [],
        active: true,
      },
    },
  };
}

function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  expect(response.status).toBe(status);
}

describe("inventory reorder APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPolicies.mockResolvedValue([]);
    mocks.getAlerts.mockResolvedValue([]);
    mocks.setPolicy.mockResolvedValue({ id: "policy-1", active: true });
    mocks.disablePolicy.mockResolvedValue({ id: "policy-1", active: false });
  });

  it("lets technicians read reorder alerts", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await getAlerts(
      new Request(
        "http://localhost/api/inventory/reorder-alerts?organizationId=org-a&siteId=site-a",
      ),
    );

    expectStatus(response, 200);
    expect(mocks.getAlerts).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      includeOk: false,
    });
  });

  it("prevents technicians from changing reorder policies", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await setPolicy(
      new Request("http://localhost/api/inventory/reorder-policies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          binId: "bin-1",
          partId: "part-1",
          minQuantity: 2,
          maxQuantity: 10,
        }),
      }),
    );

    expectStatus(response, 403);
    expect(mocks.setPolicy).not.toHaveBeenCalled();
  });

  it("lets inventory managers configure bin-level min/max policy", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await setPolicy(
      new Request("http://localhost/api/inventory/reorder-policies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          binId: "bin-1",
          partId: "part-1",
          minQuantity: 2,
          maxQuantity: 10,
        }),
      }),
    );

    expectStatus(response, 201);
    expect(mocks.setPolicy).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      binId: "bin-1",
      partId: "part-1",
      minQuantity: 2,
      maxQuantity: 10,
      actorId: "manager-1",
    });
  });
});
