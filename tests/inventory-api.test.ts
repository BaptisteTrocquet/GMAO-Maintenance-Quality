import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  listParts: vi.fn(),
  createPart: vi.fn(),
  listWarehouses: vi.fn(),
  createWarehouse: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/inventory/parts", () => ({
  listParts: mocks.listParts,
  createPart: mocks.createPart,
  PartMasterError: class PartMasterError extends Error {},
}));
vi.mock("@/lib/inventory/warehouses", () => ({
  listWarehouses: mocks.listWarehouses,
  createWarehouse: mocks.createWarehouse,
  InventoryLocationError: class InventoryLocationError extends Error {},
}));

import { GET as getParts, POST as createPartRoute } from "@/app/api/inventory/parts/route";
import {
  GET as getWarehouses,
  POST as createWarehouseRoute,
} from "@/app/api/inventory/warehouses/route";

function authenticated(role: "TECHNICIAN" | "MAINTENANCE_MANAGER", siteIds: string[] = []) {
  return {
    session: { user: { id: "user-1" } },
    tenant: {
      scope: {
        active: true,
        role,
        allSites: false,
        siteIds,
      },
    },
  };
}

describe("inventory API permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listParts.mockResolvedValue([]);
    mocks.listWarehouses.mockResolvedValue([]);
    mocks.createPart.mockResolvedValue({ id: "part-1" });
    mocks.createWarehouse.mockResolvedValue({ id: "wh-1" });
  });

  it("allows technicians to read part master data", async () => {
    mocks.authenticateRequest.mockResolvedValue(authenticated("TECHNICIAN"));

    const response = await getParts(
      new Request("http://localhost/api/inventory/parts?organizationId=org-a"),
    );

    expect(response.status).toBe(200);
    expect(mocks.listParts).toHaveBeenCalledWith({
      organizationId: "org-a",
      includeInactive: false,
    });
  });

  it("denies part creation without inventory:manage", async () => {
    mocks.authenticateRequest.mockResolvedValue(authenticated("TECHNICIAN"));

    const response = await createPartRoute(
      new Request("http://localhost/api/inventory/parts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          sku: "SP-100",
          name: "Bearing",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.createPart).not.toHaveBeenCalled();
  });

  it("denies warehouse reads outside the manager site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(
      authenticated("MAINTENANCE_MANAGER", ["site-a"]),
    );

    const response = await getWarehouses(
      new Request(
        "http://localhost/api/inventory/warehouses?organizationId=org-a&siteId=site-b",
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.listWarehouses).not.toHaveBeenCalled();
  });

  it("allows inventory managers to create a warehouse in an assigned site", async () => {
    mocks.authenticateRequest.mockResolvedValue(
      authenticated("MAINTENANCE_MANAGER", ["site-a"]),
    );

    const response = await createWarehouseRoute(
      new Request("http://localhost/api/inventory/warehouses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          code: "MAIN",
          name: "Main warehouse",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.createWarehouse).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        actorId: "user-1",
      }),
    );
  });
});
