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
    removeQualityEvidence: vi.fn(),
    QualityEvidenceError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/evidence", () => ({
  readQualityEvidence: mocks.readQualityEvidence,
  removeQualityEvidence: mocks.removeQualityEvidence,
  QualityEvidenceError: mocks.QualityEvidenceError,
}));

import {
  DELETE,
  GET,
} from "@/app/api/quality/events/[eventId]/evidence/[evidenceId]/file/route";

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

function request(method = "GET") {
  return new Request(
    "http://localhost/api/quality/events/event-1/evidence/evidence-1/file?organizationId=org-a&siteId=site-a",
    { method },
  );
}

const context = {
  params: Promise.resolve({ eventId: "event-1", evidenceId: "evidence-1" }),
};

describe("quality evidence file API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readQualityEvidence.mockResolvedValue({
      id: "evidence-1",
      fileName: "synthetic-evidence.pdf",
      mimeType: "application/pdf",
      checksum: "a".repeat(64),
      data: new Uint8Array([1, 2, 3]),
    });
    mocks.removeQualityEvidence.mockResolvedValue({
      evidence: { id: "evidence-1", removedAt: "2026-08-08T01:00:00.000Z" },
      storageDeleted: true,
    });
  });

  it("lets viewers download tenant-scoped evidence with integrity headers", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("synthetic-evidence.pdf");
    expect(response.headers.get("x-content-sha256")).toBe("a".repeat(64));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(mocks.readQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      evidenceId: "evidence-1",
    });
  });

  it("prevents viewers from removing evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await DELETE(request("DELETE"), context);

    expect(response.status).toBe(403);
    expect(mocks.removeQualityEvidence).not.toHaveBeenCalled();
  });

  it("lets quality managers remove evidence through the audited service", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await DELETE(request("DELETE"), context);

    expect(response.status).toBe(200);
    expect(mocks.removeQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      evidenceId: "evidence-1",
      actorId: "quality-1",
    });
  });

  it("returns opaque 404 when evidence is outside tenant/site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    mocks.readQualityEvidence.mockRejectedValue(
      new mocks.QualityEvidenceError("EVIDENCE_NOT_FOUND", "Quality evidence not found in site scope"),
    );

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
  });

  it("returns conflict when checksum validation fails", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    mocks.readQualityEvidence.mockRejectedValue(
      new mocks.QualityEvidenceError(
        "FILE_INTEGRITY_FAILED",
        "Stored quality evidence does not match its recorded SHA-256 checksum",
      ),
    );

    const response = await GET(request(), context);

    expect(response.status).toBe(409);
  });
});
