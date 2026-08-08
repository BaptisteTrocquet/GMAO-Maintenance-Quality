import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetFindMany: vi.fn(),
  workOrderFindMany: vi.fn(),
  documentFindMany: vi.fn(),
  partFindMany: vi.fn(),
  auditFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    asset: { findMany: mocks.assetFindMany },
    workOrder: { findMany: mocks.workOrderFindMany },
    document: { findMany: mocks.documentFindMany },
    part: { findMany: mocks.partFindMany },
    auditLog: { findMany: mocks.auditFindMany },
  },
}));

import {
  GLOBAL_SEARCH_CANDIDATE_LIMIT,
  GLOBAL_SEARCH_QUALITY_SCAN_LIMIT,
  normalizeGlobalSearchQuery,
  searchGlobal,
} from "@/lib/search/global-search";

describe("global search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetFindMany.mockResolvedValue([]);
    mocks.workOrderFindMany.mockResolvedValue([]);
    mocks.documentFindMany.mockResolvedValue([]);
    mocks.partFindMany.mockResolvedValue([]);
    mocks.auditFindMany.mockResolvedValue([]);
  });

  it("normalizes whitespace and rejects queries shorter than two characters", () => {
    expect(normalizeGlobalSearchQuery("  pump   12 ")).toBe("pump 12");
    expect(normalizeGlobalSearchQuery(" x ")).toBeNull();
    expect(normalizeGlobalSearchQuery("   ")).toBeNull();
  });

  it("never queries quality for a maintenance manager without quality:read", async () => {
    await searchGlobal({
      organizationId: "org-a",
      siteId: "site-a",
      role: "MAINTENANCE_MANAGER",
      query: "pump",
    });

    expect(mocks.assetFindMany).toHaveBeenCalled();
    expect(mocks.workOrderFindMany).toHaveBeenCalled();
    expect(mocks.documentFindMany).toHaveBeenCalled();
    expect(mocks.partFindMany).toHaveBeenCalled();
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
  });

  it("never queries inventory for a viewer without inventory:read but permits quality search", async () => {
    await searchGlobal({
      organizationId: "org-a",
      siteId: "site-a",
      role: "VIEWER",
      query: "audit",
    });

    expect(mocks.partFindMany).not.toHaveBeenCalled();
    expect(mocks.auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: GLOBAL_SEARCH_QUALITY_SCAN_LIMIT }),
    );
  });

  it("scopes relational candidates before loading and bounds each query", async () => {
    await searchGlobal({
      organizationId: "org-a",
      siteId: "site-a",
      role: "ADMIN",
      query: "seal",
    });

    expect(mocks.assetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteId: "site-a",
          site: { organizationId: "org-a", active: true },
        }),
        take: GLOBAL_SEARCH_CANDIDATE_LIMIT,
      }),
    );
    expect(mocks.documentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-a" }),
        take: GLOBAL_SEARCH_CANDIDATE_LIMIT,
      }),
    );
    expect(mocks.partFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: "org-a", active: true }),
        take: GLOBAL_SEARCH_CANDIDATE_LIMIT,
      }),
    );
  });

  it("uses independent organization and site markers for the bounded quality scan", async () => {
    await searchGlobal({
      organizationId: "org-a",
      siteId: "site-a",
      role: "QUALITY_MANAGER",
      query: "complaint",
    });

    expect(mocks.auditFindMany).toHaveBeenCalledWith({
      where: {
        entityType: "QualityEvent",
        AND: [
          { afterJson: { contains: '\"organizationId\":\"org-a\"' } },
          { afterJson: { contains: '\"siteId\":\"site-a\"' } },
        ],
      },
      orderBy: { createdAt: "desc" },
      select: { entityId: true, afterJson: true },
      take: GLOBAL_SEARCH_QUALITY_SCAN_LIMIT,
    });
  });

  it("ranks exact identifiers before prefix and contains matches", async () => {
    mocks.assetFindMany.mockResolvedValue([
      { id: "contains", code: "ZONE-PUMP-1", name: "Remote", description: null, status: "ACTIVE", criticality: "LOW" },
      { id: "exact", code: "PUMP", name: "Exact", description: null, status: "ACTIVE", criticality: "HIGH" },
      { id: "prefix", code: "PUMP-02", name: "Prefix", description: null, status: "ACTIVE", criticality: "MEDIUM" },
    ]);

    const results = await searchGlobal({
      organizationId: "org-a",
      siteId: "site-a",
      role: "MAINTENANCE_MANAGER",
      query: "pump",
    });

    expect(results.filter((result) => result.kind === "ASSET").map((result) => result.id)).toEqual([
      "exact",
      "prefix",
      "contains",
    ]);
  });

  it("deduplicates quality snapshots and searches only the latest version per event", async () => {
    mocks.auditFindMany.mockResolvedValue([
      {
        entityId: "qe-1",
        afterJson: JSON.stringify({
          id: "qe-1",
          eventNumber: "QE-001",
          organizationId: "org-a",
          siteId: "site-a",
          type: "COMPLAINT",
          severity: "HIGH",
          status: "CLOSED",
          title: "Resolved customer complaint",
          description: null,
          updatedAt: "2026-08-08T10:00:00.000Z",
        }),
      },
      {
        entityId: "qe-1",
        afterJson: JSON.stringify({
          id: "qe-1",
          eventNumber: "QE-001",
          organizationId: "org-a",
          siteId: "site-a",
          type: "COMPLAINT",
          severity: "HIGH",
          status: "OPEN",
          title: "Old wording",
          description: null,
          updatedAt: "2026-08-07T10:00:00.000Z",
        }),
      },
    ]);

    const results = await searchGlobal({
      organizationId: "org-a",
      siteId: "site-a",
      role: "QUALITY_MANAGER",
      query: "resolved",
    });

    expect(results.filter((result) => result.kind === "QUALITY")).toEqual([
      expect.objectContaining({ id: "qe-1", label: "QE-001 · Resolved customer complaint" }),
    ]);
  });
});
