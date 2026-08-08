import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class PurchaseRequestError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    listPurchaseRequests: vi.fn(),
    createPurchaseRequest: vi.fn(),
    getPurchaseRequest: vi.fn(),
    updatePurchaseRequestDraft: vi.fn(),
    transitionPurchaseRequest: vi.fn(),
    PurchaseRequestError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/inventory/purchase-requests", () => ({
  listPurchaseRequests: mocks.listPurchaseRequests,
  createPurchaseRequest: mocks.createPurchaseRequest,
  getPurchaseRequest: mocks.getPurchaseRequest,
  updatePurchaseRequestDraft: mocks.updatePurchaseRequestDraft,
  transitionPurchaseRequest: mocks.transitionPurchaseRequest,
  PurchaseRequestError: mocks.PurchaseRequestError,
}));

import {
  GET as listPurchaseRequests,
  POST as createPurchaseRequest,
} from "@/app/api/inventory/purchase-requests/route";
import { PATCH as patchPurchaseRequest } from "@/app/api/inventory/purchase-requests/[requestId]/route";

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

describe("purchase request APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPurchaseRequests.mockResolvedValue([]);
    mocks.createPurchaseRequest.mockResolvedValue({
      idempotent: false,
      purchaseRequest: { id: "request-1", status: "DRAFT" },
    });
    mocks.transitionPurchaseRequest.mockResolvedValue({ id: "request-1", status: "SUBMITTED" });
    mocks.updatePurchaseRequestDraft.mockResolvedValue({ id: "request-1", status: "DRAFT" });
  });

  it("lets technicians read site purchase requests", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await listPurchaseRequests(
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

    const response = await createPurchaseRequest(
      new Request("http://localhost/api/inventory/purchase-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          requestKey: "pr-001",
          lines: [{ partId: "part-1", quantity: 2 }],
        }),
      }),
    );

    expectStatus(response, 403);
    expect(mocks.createPurchaseRequest).not.toHaveBeenCalled();
  });

  it("lets inventory managers create idempotent drafts", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await createPurchaseRequest(
      new Request("http://localhost/api/inventory/purchase-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          requestKey: "pr-001",
          reason: "Reorder",
          neededBy: "2026-08-20T00:00:00.000Z",
          lines: [{ partId: "part-1", quantity: 2 }],
        }),
      }),
    );

    expectStatus(response, 201);
    expect(mocks.createPurchaseRequest).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      requestKey: "pr-001",
      reason: "Reorder",
      neededBy: new Date("2026-08-20T00:00:00.000Z"),
      lines: [{ partId: "part-1", quantity: 2 }],
      actorId: "manager-1",
    });
  });

  it("lets inventory managers submit a draft without modifying lines", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await patchPurchaseRequest(
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
    expect(mocks.updatePurchaseRequestDraft).not.toHaveBeenCalled();
  });

  it("rejects payloads that mix a transition with line edits", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await patchPurchaseRequest(
      new Request("http://localhost/api/inventory/purchase-requests/request-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SUBMIT",
          lines: [{ partId: "part-1", quantity: 3 }],
        }),
      }),
      requestContext,
    );

    expectStatus(response, 400);
    expect(mocks.transitionPurchaseRequest).not.toHaveBeenCalled();
  });
});
