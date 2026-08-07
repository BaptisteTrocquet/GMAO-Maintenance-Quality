import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditCount: vi.fn(),
  auditCreate: vi.fn(),
  documentFindFirst: vi.fn(),
  issueCopy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    auditLog: { count: mocks.auditCount, create: mocks.auditCreate },
    document: { findFirst: mocks.documentFindFirst },
  },
}));

vi.mock("@/lib/documents/controlled-copy", () => ({
  issueControlledCopy: mocks.issueCopy,
}));

import { issuePublicControlledDocument } from "@/lib/public-documents/viewer";

const token = { id: "token-doc", organizationId: "org-a", siteId: "site-a" };

describe("public controlled document viewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auditCount.mockResolvedValue(0);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.documentFindFirst.mockResolvedValue({ id: "doc-1", code: "SOP-100" });
    mocks.issueCopy.mockResolvedValue({ document: { code: "SOP-100" } });
  });

  it("requires document applicability through an active asset in the token site", async () => {
    const asOf = new Date("2026-08-07T12:00:00.000Z");
    await issuePublicControlledDocument({ token, documentCode: "SOP-100", asOf });

    expect(mocks.documentFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        code: "SOP-100",
        assetDocuments: {
          some: {
            asset: { siteId: "site-a", archivedAt: null },
          },
        },
      },
      select: { id: true, code: true },
    });
    expect(mocks.issueCopy).toHaveBeenCalledWith({
      organizationId: "org-a",
      documentId: "doc-1",
      actorId: null,
      asOf,
    });
  });

  it("audits unavailable document codes before rejecting them", async () => {
    mocks.documentFindFirst.mockResolvedValue(null);

    await expect(
      issuePublicControlledDocument({
        token,
        documentCode: "FOREIGN",
        origin: "https://portal.example.local",
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_AVAILABLE" });

    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "PublicMaintenanceRequestToken",
        entityId: "token-doc",
        action: "PUBLIC_DOCUMENT_LOOKUP",
      }),
    });
    expect(mocks.issueCopy).not.toHaveBeenCalled();
  });

  it("rate limits before document lookup", async () => {
    mocks.auditCount.mockResolvedValue(60);

    await expect(
      issuePublicControlledDocument({ token, documentCode: "SOP-100" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(mocks.documentFindFirst).not.toHaveBeenCalled();
    expect(mocks.issueCopy).not.toHaveBeenCalled();
  });
});
