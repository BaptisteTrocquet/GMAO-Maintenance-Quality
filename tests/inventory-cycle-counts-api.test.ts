import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CycleCountError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly details?: unknown,
    ) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    createCycleCount: vi.fn(),
    listCycleCounts: vi.fn(),
    getCycleCount: vi.fn(),
    recordCycleCountItem: vi.fn(),
    cancelCycleCount: vi.fn(),
    completeCycleCount: vi.fn(),
    CycleCountError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/inventory/cycle-counts", () => ({
  createCycleCount: mocks.createCycleCount,
  listCycleCounts: mocks.listCycleCounts,
  getCycleCount: mocks.getCycleCount,
  recordCycleCountItem: mocks.recordCycleCountItem,
  cancelCycleCount: mocks.cancelCycleCount,
  completeCycleCount: mocks.completeCycleCount,
  CycleCountError: mocks.CycleCountError,
}));

import { GET as listCounts, POST as createCount } from "@/app/api/inventory/cycle-counts/route";
import { PATCH as recordCount } from "@/app/api/inventory/cycle-counts/[countId]/route";
import { POST as completeCount } from "@/app/api/inventory/cycle-counts/[countId]/complete/route";

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

const context = { params: Promise.resolve({ countId: "count-1" }) };

describe("inventory cycle count APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCycleCounts.mockResolvedValue([]);
    mocks.createCycleCount.mockResolvedValue({ id: "count-1", status: "OPEN" });
    mocks.recordCycleCountItem.mockResolvedValue({ id: "count-1", status: "OPEN" });
    mocks.completeCycleCount.mockResolvedValue({ id: "count-1", status: "COMPLETED" });
  });

  it("lets technicians read cycle counts", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await listCounts(
      new Request(
        "http://localhost/api/inventory/cycle-counts?organizationId=org-a&siteId=site-a",
      ),
    );

    expectStatus(response, 200);
    expect(mocks.listCycleCounts).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      includeClosed: false,
    });
  });

  it("prevents technicians from opening cycle counts", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await createCount(
      new Request("http://localhost/api/inventory/cycle-counts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          binId: "bin-1",
        }),
      }),
    );

    expectStatus(response, 403);
    expect(mocks.createCycleCount).not.toHaveBeenCalled();
  });

  it("lets inventory managers open a bin cycle count", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await createCount(
      new Request("http://localhost/api/inventory/cycle-counts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          binId: "bin-1",
        }),
      }),
    );

    expectStatus(response, 201);
    expect(mocks.createCycleCount).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      binId: "bin-1",
      actorId: "manager-1",
    });
  });

  it("records count entries without exposing a stock movement API", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await recordCount(
      new Request("http://localhost/api/inventory/cycle-counts/count-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          partId: "part-1",
          countedQuantity: 4,
        }),
      }),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.recordCycleCountItem).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      countId: "count-1",
      partId: "part-1",
      countedQuantity: 4,
      actorId: "manager-1",
    });
  });

  it("returns a stale completion as conflict with details", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.completeCycleCount.mockRejectedValue(
      new mocks.CycleCountError("COUNT_STALE", "Stock changed", {
        stale: [{ partId: "part-1", expectedQuantity: 5, currentQuantity: 6 }],
      }),
    );

    const response = await completeCount(
      new Request("http://localhost/api/inventory/cycle-counts/count-1/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a" }),
      }),
      context,
    );

    expectStatus(response, 409);
  });
});
