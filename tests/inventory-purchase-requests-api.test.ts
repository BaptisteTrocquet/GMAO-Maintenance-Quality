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
import {
  GET as getRequest,
  PATCH as patchRequest,
} from "@/app/api/inventory/purchase-requests/[requestId]/route";

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

const requestContext = { params: Promise.resolve({ requestId: "request-1" }) };

describe("inventory purchase request APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPurchaseRequests.mockResolvedValue([]);
    mocks.createPurchaseRequest.mockResolvedValue({
      purchaseRequest: { id: "request-1", status: "DRAFT" },
      idempotent: false,
    });
    mocks.getPurchaseRequest.mockResolvedValue({ id: "request-1", status: "DRAFT" });
    mocks.updatePurchaseRequestDraft.mockResolvedValue({ id: "request-1", status: "DRAFT" });
    mocks.transitionPurchaseRequest.mockResolvedValue({ id: "request-1", status: "SUBMITTED" });
  });

  it("lets technicians read purchase requests in their site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await listRequests(
      new Request(
        "http://localhost/api/inventory/purchase-requests?organizationId=org-a&siteId=site-a",
      ),
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
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          requestKey: "reorder-bin-a-part-1",
          lines: [{ partId: "part-1", quantity: 3 }],
        }),
      }),
    );

    expectStatus(response, 403);
    expect(mocks.createPurchaseRequest).not.toHaveBeenCalled();
  });

  it("lets inventory managers create idempotent purchase request drafts", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await createRequest(
      new Request("http://localhost/api/inventory/purchase-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          requestKey: "reorder-bin-a-part-1",
          reason: "Low stock",
          neededBy: "2026-08-20T00:00:00.000Z",
          lines: [{ partId: "part-1", supplierId: "supplier-1", quantity: 3 }],
        }),
      }),
    );

    expectStatus(response, 201);
    expect(mocks.createPurchaseRequest).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      requestKey: "reorder-bin-a-part-1",
      reason: "Low stock",
      neededBy: new Date("2026-08-20T00:00:00.000Z"),
      lines: [{ partId: "part-1", supplierId: "supplier-1", quantity: 3 }],
      actorId: "manager-1",
    });
  });

  it("supports partial draft edits without forcing lines to be resent", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await patchRequest(
      new Request("http://localhost/api/inventory/purchase-requests/request-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          reason: "Production-critical shortage",
        }),
      }),
      requestContext,
    );

    expectStatus(response, 200);
    expect(mocks.updatePurchaseRequestDraft).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      requestId: "request-1",
      reason: "Production-critical shortage",
      neededBy: undefined,
      lines: undefined,
      actorId: "manager-1",
    });
  });

  it("rejects a payload that mixes a status transition with draft edits", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await patchRequest(
      new Request("http://localhost/api/inventory/purchase-requests/request-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SUBMIT",
          reason: "Do not mix this",
        }),
      }),
      requestContext,
    );

    expectStatus(response, 400);
    expect(mocks.transitionPurchaseRequest).not.toHaveBeenCalled();
  });

  it("lets inventory managers submit a draft through the transition contract", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await patchRequest(
      new Request("http://localhost/api/inventory/purchase-requests/request-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SUBMIT",
        }),
      }),
      requestContext,
    );

    expectStatus(response, 200);
    expect(mocks.transitionPurchaseRequest).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      requestId: "request-1",
      action: "SUBMIT",
      note: undefined,
      actorId: "manager-1",
    });
  });

  it("returns 404 for a purchase request outside the requested site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));
    mocks.getPurchaseRequest.mockResolvedValue(null);

    const response = await getRequest(
      new Request(
        "http://localhost/api/inventory/purchase-requests/request-1?organizationId=org-a&siteId=site-a",
      ),
      requestContext,
    );

    expectStatus(response, 404);
  });
});
