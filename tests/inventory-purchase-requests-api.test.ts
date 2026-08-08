import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PurchaseRequestError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    createPurchaseRequest: vi.fn(),
    listPurchaseRequests: vi.fn(),
    getPurchaseRequest: vi.fn(),
    updatePurchaseRequestDraft: vi.fn(),
    transitionPurchaseRequest: vi.fn(),
    PurchaseRequestError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/inventory/purchase-requests", () => ({
  createPurchaseRequest: mocks.createPurchaseRequest,
  listPurchaseRequests: mocks.listPurchaseRequests,
  getPurchaseRequest: mocks.getPurchaseRequest,
  updatePurchaseRequestDraft: mocks.updatePurchaseRequestDraft,
  transitionPurchaseRequest: mocks.transitionPurchaseRequest,
  PurchaseRequestError: mocks.PurchaseRequestError,
}));

import { GET as listRequests, POST as createRequest } from "@/app/api/inventory/purchase-requests/route";
import { GET as getRequest, PATCH as updateRequest } from "@/app/api/inventory/purchase-requests/[requestId]/route";
import { POST as transitionRequest } from "@/app/api/inventory/purchase-requests/[requestId]/transition/route";

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

const detailContext = { params: Promise.resolve({ requestId: "pr-1" }) };

const draftPayload = {
  organizationId: "org-a",
  siteId: "site-a",
  reason: "Replenish stock",
  neededBy: "2026-08-20T00:00:00.000Z",
  lines: [{ partId: "part-1", quantity: 4 }],
};

describe("inventory purchase request APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPurchaseRequests.mockResolvedValue([]);
    mocks.createPurchaseRequest.mockResolvedValue({
      purchaseRequest: { id: "pr-1", status: "DRAFT" },
      idempotent: false,
    });
    mocks.getPurchaseRequest.mockResolvedValue({ id: "pr-1", status: "DRAFT" });
    mocks.updatePurchaseRequestDraft.mockResolvedValue({ id: "pr-1", status: "DRAFT" });
    mocks.transitionPurchaseRequest.mockResolvedValue({ id: "pr-1", status: "SUBMITTED" });
  });

  it("lets technicians read purchase requests in their site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await listRequests(
      new Request("http://localhost/api/inventory/purchase-requests?organizationId=org-a&siteId=site-a"),
    );

    expectStatus(response, 200);
    expect(mocks.listPurchaseRequests).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      status: undefined,
    });
  });

  it("prevents technicians from creating purchase requests", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await createRequest(
      new Request("http://localhost/api/inventory/purchase-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draftPayload, requestKey: "reorder-1" }),
      }),
    );

    expectStatus(response, 403);
    expect(mocks.createPurchaseRequest).not.toHaveBeenCalled();
  });

  it("creates an idempotent draft for inventory managers", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await createRequest(
      new Request("http://localhost/api/inventory/purchase-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draftPayload, requestKey: "reorder-1" }),
      }),
    );

    expectStatus(response, 201);
    expect(mocks.createPurchaseRequest).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      requestKey: "reorder-1",
      reason: "Replenish stock",
      neededBy: new Date("2026-08-20T00:00:00.000Z"),
      lines: [{ partId: "part-1", quantity: 4 }],
      actorId: "manager-1",
    });
  });

  it("lets technicians read one purchase request", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await getRequest(
      new Request("http://localhost/api/inventory/purchase-requests/pr-1?organizationId=org-a&siteId=site-a"),
      detailContext,
    );

    expectStatus(response, 200);
    expect(mocks.getPurchaseRequest).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      requestId: "pr-1",
    });
  });

  it("prevents technicians from editing or transitioning purchase requests", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const editResponse = await updateRequest(
      new Request("http://localhost/api/inventory/purchase-requests/pr-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draftPayload),
      }),
      detailContext,
    );
    expectStatus(editResponse, 403);

    const transitionResponse = await transitionRequest(
      new Request("http://localhost/api/inventory/purchase-requests/pr-1/transition", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "SUBMIT" }),
      }),
      detailContext,
    );
    expectStatus(transitionResponse, 403);
    expect(mocks.updatePurchaseRequestDraft).not.toHaveBeenCalled();
    expect(mocks.transitionPurchaseRequest).not.toHaveBeenCalled();
  });

  it("lets inventory managers submit purchase requests", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await transitionRequest(
      new Request("http://localhost/api/inventory/purchase-requests/pr-1/transition", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SUBMIT",
          note: "Ready for approval",
        }),
      }),
      detailContext,
    );

    expectStatus(response, 200);
    expect(mocks.transitionPurchaseRequest).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      requestId: "pr-1",
      action: "SUBMIT",
      note: "Ready for approval",
      actorId: "manager-1",
    });
  });
});
