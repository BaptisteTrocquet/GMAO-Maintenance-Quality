import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workOrderFindMany: vi.fn(),
  assetFindMany: vi.fn(),
  documentFindMany: vi.fn(),
  partFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findMany: mocks.workOrderFindMany },
    asset: { findMany: mocks.assetFindMany },
    document: { findMany: mocks.documentFindMany },
    part: { findMany: mocks.partFindMany },
  },
}));

import { searchGlobal } from "@/lib/search/global-search";

describe("global search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workOrderFindMany.mockResolvedValue([
      { id: "wo-1", number: "WO-0001", title: "Pump inspection", status: "PLANNED", asset: { code: "P-01" } },
    ]);
    mocks.assetFindMany.mockResolvedValue([
      { id: "asset-1", code: "P-01", name: "Utility pump", status: "ACTIVE", category: "PUMP" },
    ]);
    mocks.documentFindMany.mockResolvedValue([
      { id: "doc-1", code: "WI-001", title: "Pump inspection", type: "WORK_INSTRUCTION", owner: "Maintenance" },
    ]);
    mocks.partFindMany.mockResolvedValue([
      { id: "part-1", sku: "SP-001", name: "Seal kit", unit: "EA", quantityOnHand: 4 },
    ]);
  });

  it("pushes organization/site scope and per-kind limits into database queries", async () => {
    const result = await searchGlobal({
      organizationId: "org-a",
      siteId: "site-a",
      role: "MAINTENANCE_MANAGER",
      query: "pump",
    });

    expect(result.results).toHaveLength(4);
    expect(mocks.workOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
        }),
        take: 8,
      }),
    );
    expect(mocks.assetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ siteId: "site-a" }),
        take: 8,
      }),
    );
    expect(mocks.documentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-a" }),
        take: 8,
      }),
    );
    expect(mocks.partFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-a", active: true }),
        take: 8,
      }),
    );
  });

  it("does not query inventory when the role lacks inventory:read", async () => {
    const result = await searchGlobal({
      organizationId: "org-a",
      siteId: "site-a",
      role: "VIEWER",
      query: "pump",
    });

    expect(mocks.partFindMany).not.toHaveBeenCalled();
    expect(result.results.some((item) => item.kind === "PART")).toBe(false);
    expect(result.counts.parts).toBe(0);
  });

  it("normalizes whitespace and rejects too-short searches before querying", async () => {
    const result = await searchGlobal({
      organizationId: "org-a",
      siteId: "site-a",
      role: "VIEWER",
      query: "  pump   inspection  ",
    });
    expect(result.query).toBe("pump inspection");

    await expect(
      searchGlobal({ organizationId: "org-a", siteId: "site-a", role: "VIEWER", query: " x " }),
    ).rejects.toThrow("2 to 100");
  });

  it("returns only relative application links", async () => {
    const result = await searchGlobal({
      organizationId: "org-a",
      siteId: "site-a",
      role: "MAINTENANCE_MANAGER",
      query: "pump",
    });
    expect(result.results.every((item) => item.href.startsWith("/"))).toBe(true);
  });
});
