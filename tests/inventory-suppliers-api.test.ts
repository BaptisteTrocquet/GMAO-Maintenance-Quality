import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class SupplierReferenceError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    listSuppliers: vi.fn(),
    createSupplier: vi.fn(),
    listPartSuppliers: vi.fn(),
    setPartSupplierReference: vi.fn(),
    SupplierReferenceError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/inventory/suppliers", () => ({
  listSuppliers: mocks.listSuppliers,
  createSupplier: mocks.createSupplier,
  listPartSuppliers: mocks.listPartSuppliers,
  setPartSupplierReference: mocks.setPartSupplierReference,
  SupplierReferenceError: mocks.SupplierReferenceError,
}));

import { GET as getSuppliers, POST as createSupplier } from "@/app/api/inventory/suppliers/route";
import {
  GET as getPartSuppliers,
  POST as setPartSupplier,
} from "@/app/api/inventory/parts/[partId]/suppliers/route";

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

const partContext = { params: Promise.resolve({ partId: "part-1" }) };

describe("inventory supplier APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSuppliers.mockResolvedValue([]);
    mocks.createSupplier.mockResolvedValue({ id: "supplier-1" });
    mocks.listPartSuppliers.mockResolvedValue([]);
    mocks.setPartSupplierReference.mockResolvedValue({
      partId: "part-1",
      supplierId: "supplier-1",
      preferred: true,
    });
  });

  it("lets technicians read organization suppliers", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await getSuppliers(
      new Request("http://localhost/api/inventory/suppliers?organizationId=org-a"),
    );

    expectStatus(response, 200);
    expect(mocks.listSuppliers).toHaveBeenCalledWith({
      organizationId: "org-a",
      includeInactive: false,
    });
  });

  it("prevents technicians from creating suppliers", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await createSupplier(
      new Request("http://localhost/api/inventory/suppliers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          code: "SUP-001",
          name: "Demo Industrial Supply",
        }),
      }),
    );

    expectStatus(response, 403);
    expect(mocks.createSupplier).not.toHaveBeenCalled();
  });

  it("lets technicians read supplier references for a part", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await getPartSuppliers(
      new Request(
        "http://localhost/api/inventory/parts/part-1/suppliers?organizationId=org-a",
      ),
      partContext,
    );

    expectStatus(response, 200);
    expect(mocks.listPartSuppliers).toHaveBeenCalledWith({
      organizationId: "org-a",
      partId: "part-1",
      includeInactive: false,
    });
  });

  it("lets inventory managers create a preferred supplier reference", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await setPartSupplier(
      new Request("http://localhost/api/inventory/parts/part-1/suppliers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          supplierId: "supplier-1",
          supplierPartNumber: "SUP-SP-001",
          preferred: true,
          leadTimeDays: 7,
          minOrderQuantity: 2,
          currency: "eur",
        }),
      }),
      partContext,
    );

    expectStatus(response, 201);
    expect(mocks.setPartSupplierReference).toHaveBeenCalledWith({
      organizationId: "org-a",
      partId: "part-1",
      supplierId: "supplier-1",
      supplierPartNumber: "SUP-SP-001",
      preferred: true,
      leadTimeDays: 7,
      minOrderQuantity: 2,
      unitCost: null,
      currency: "EUR",
      active: true,
      actorId: "manager-1",
    });
  });
});
