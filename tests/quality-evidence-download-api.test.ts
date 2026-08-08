import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class QualityEvidenceError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    readQualityEvidence: vi.fn(),
    QualityEvidenceError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/evidence", () => ({
  readQualityEvidence: mocks.readQualityEvidence,
  QualityEvidenceError: mocks.QualityEvidenceError,
}));

import { GET } from "@/app/api/quality/events/[eventId]/evidence/[evidenceId]/route";

function auth(role: "VIEWER" | "QUALITY_MANAGER") {
  return {
    session: { user: { id: role === "QUALITY_MANAGER" ? "quality-1" : "viewer-1" } },
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

const context = {
  params: Promise.resolve({ eventId: "event-1", evidenceId: "evidence-1" }),
};

function request() {
  return new Request(
    "http://localhost/api/quality/events/event-1/evidence/evidence-1?organizationId=org-a&siteId=site-a",
  );
}

describe("quality evidence download API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readQualityEvidence.mockResolvedValue({
      id: "evidence-1",
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      phase: "EIGHT_D",
      kind: "DOCUMENT",
      fileName: "verification record.pdf",
      storageKey: "quality-evidence/org-a/event-1/evidence-1/checksum",
      mimeType: "application/pdf",
      sizeBytes: 4,
      checksum: "a".repeat(64),
      description: null,
      createdById: "quality-1",
      createdAt: "2026-08-08T00:00:00.000Z",
      data: new Uint8Array([1, 2, 3, 4]),
    });
  });

  it("allows scoped readers to download integrity-checked evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await GET(request(), context);

    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("application/pdf");
    expect(response?.headers.get("content-disposition")).toContain("verification%20record.pdf");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.readQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      evidenceId: "evidence-1",
    });
    expect(Array.from(new Uint8Array(await response!.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it("maps integrity failures to conflict without returning stored bytes", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    mocks.readQualityEvidence.mockRejectedValue(
      new mocks.QualityEvidenceError("FILE_INTEGRITY_FAILED", "Checksum mismatch"),
    );

    const response = await GET(request(), context);

    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({
      error: { code: "FILE_INTEGRITY_FAILED" },
    });
  });

  it("blocks users without quality read permission", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      ...auth("VIEWER"),
      tenant: {
        scope: {
          organizationId: "org-a",
          role: "VIEWER",
          allSites: false,
          siteIds: ["site-other"],
          active: true,
        },
      },
    });

    const response = await GET(request(), context);

    expect(response?.status).toBe(403);
    expect(mocks.readQualityEvidence).not.toHaveBeenCalled();
  });
});
