import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AccessDeniedError extends Error {}
  return {
    AccessDeniedError,
    authenticateRequest: vi.fn(),
    assertSitePermission: vi.fn(),
    siteFindFirst: vi.fn(),
    assetFindMany: vi.fn(),
    locationFindMany: vi.fn(),
    transaction: vi.fn(),
    txAssetFindUnique: vi.fn(),
    txAssetCreate: vi.fn(),
    txAssetUpdate: vi.fn(),
    txStatusCreate: vi.fn(),
    txAuditCreate: vi.fn(),
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  assertSitePermission: mocks.assertSitePermission,
}));
vi.mock("@/lib/db", () => ({
  db: {
    site: { findFirst: mocks.siteFindFirst },
    asset: { findMany: mocks.assetFindMany },
    location: { findMany: mocks.locationFindMany },
    $transaction: mocks.transaction,
  },
}));

import { GET, POST } from "@/app/api/integrations/csv/assets/route";

function auth() {
  return {
    session: { user: { id: "manager-a", displayName: "Manager A" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "MAINTENANCE_MANAGER",
        allSites: false,
        siteIds: ["site-a"],
        active: true,
      },
    },
  };
}

function endpoint(mode?: "validate" | "upsert") {
  return `http://localhost/api/integrations/csv/assets?organizationId=org-a&siteId=site-a${mode ? `&mode=${mode}` : ""}`;
}

function post(csv: string, mode?: "validate" | "upsert") {
  return POST(new Request(endpoint(mode), { method: "POST", body: csv }));
}

async function requiredResponse(value: Response | undefined | Promise<Response | undefined>) {
  const response = await value;
  if (!response) throw new Error("Expected CSV API response");
  return response;
}

describe("asset CSV integration API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.assertSitePermission.mockImplementation(() => undefined);
    mocks.siteFindFirst.mockResolvedValue({ id: "site-a", code: "PA" });
    mocks.assetFindMany.mockResolvedValue([]);
    mocks.locationFindMany.mockResolvedValue([]);

    const tx = {
      asset: {
        findUnique: mocks.txAssetFindUnique,
        create: mocks.txAssetCreate,
        update: mocks.txAssetUpdate,
      },
      assetStatusHistory: { create: mocks.txStatusCreate },
      auditLog: { create: mocks.txAuditCreate },
    };
    mocks.transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) => callback(tx));
    mocks.txAssetFindUnique.mockResolvedValue(null);
    mocks.txAssetCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: `asset-${String(data.code).toLowerCase()}`,
      siteId: "site-a",
      locationId: data.locationId ?? null,
      parentAssetId: data.parentAssetId ?? null,
      description: null,
      category: null,
      manufacturer: null,
      model: null,
      serialNumber: null,
      status: data.status ?? "ACTIVE",
      criticality: data.criticality ?? "MEDIUM",
      installedAt: null,
      commissionedAt: null,
      decommissionedAt: null,
      archivedAt: null,
      createdAt: new Date("2026-08-08T08:00:00.000Z"),
      updatedAt: new Date("2026-08-08T08:00:00.000Z"),
      ...data,
    }));
    mocks.txAuditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("exports only the selected site after asset read authorization", async () => {
    mocks.assetFindMany.mockResolvedValue([
      {
        code: "A-1",
        name: "Pump",
        description: null,
        category: null,
        manufacturer: null,
        model: null,
        serialNumber: null,
        criticality: "HIGH",
        status: "ACTIVE",
        installedAt: null,
        commissionedAt: null,
        location: { code: "LINE-1" },
        parentAsset: null,
      },
    ]);

    const response = await requiredResponse(GET(new Request(endpoint())));
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-a" }),
      "site-a",
      "asset:read",
    );
    expect(mocks.assetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { siteId: "site-a", archivedAt: null } }),
    );
    expect(csv).toContain("A-1,Pump");
  });

  it("stops before site/data access when asset write permission is denied", async () => {
    mocks.assertSitePermission.mockImplementation(() => {
      throw new mocks.AccessDeniedError("Missing permission");
    });

    const response = await requiredResponse(post("code,name\nA-1,Pump", "validate"));

    expect(response.status).toBe(403);
    expect(mocks.siteFindFirst).not.toHaveBeenCalled();
    expect(mocks.assetFindMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("dry-runs a scoped import without writes", async () => {
    mocks.assetFindMany.mockResolvedValue([
      { id: "asset-existing", code: "A-1", parentAssetId: null },
    ]);
    mocks.locationFindMany.mockResolvedValue([{ id: "location-1", code: "LINE-1" }]);

    const response = await requiredResponse(
      post(
        "code,name,locationCode\nA-1,Updated pump,LINE-1\nA-2,New pump,LINE-1",
        "validate",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ valid: true, rows: 2, creates: 1, updates: 1 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects references outside the selected site", async () => {
    const response = await requiredResponse(
      post(
        "code,name,locationCode,parentAssetCode\nA-2,Child,OTHER-SITE,OTHER-ASSET",
        "validate",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("CSV_REFERENCE_VALIDATION_FAILED");
    expect(body.error.details.errors.map((entry: { code: string }) => entry.code)).toEqual(
      expect.arrayContaining(["LOCATION_NOT_FOUND", "PARENT_ASSET_NOT_FOUND"]),
    );
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("creates batch parents first and audits one atomic upsert", async () => {
    const response = await requiredResponse(
      post(
        "code,name,parentAssetCode,status\nCHILD,Child,PARENT,active\nPARENT,Parent,,active",
        "upsert",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ rows: 2, created: 2, updated: 0 });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.txAssetCreate.mock.calls[0]?.[0].data.code).toBe("PARENT");
    expect(mocks.txAssetCreate.mock.calls[1]?.[0].data).toMatchObject({
      code: "CHILD",
      parentAssetId: "asset-parent",
    });
    expect(mocks.txAuditCreate).toHaveBeenCalledTimes(3);
    expect(mocks.txAuditCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ entityType: "IntegrationImport", action: "ASSET_CSV_IMPORTED" }),
    });
  });
});
