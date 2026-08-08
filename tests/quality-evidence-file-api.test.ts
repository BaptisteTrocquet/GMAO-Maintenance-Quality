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

import { GET } from "@/app/api/quality/events/[eventId]/evidence/[evidenceId]/file/route";

const context = {
  params: Promise.resolve({ eventId: "event-1", evidenceId: "evidence-1" }),
};

function auth(role: "VIEWER" | "TECHNICIAN") {
  return {
    session: { user: { id: `${role.toLowerCase()}-1` } },
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

function requireResponse(response: Response | undefined) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  return response;
}

function request() {
  return new Request(
    "http://localhost/api/quality/events/event-1/evidence/evidence-1/file?organizationId=org-a&siteId=site-a",
  );
}

describe("quality evidence file API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    mocks.readQualityEvidence.mockResolvedValue({
      id: "evidence-1",
      fileName: "synthetic evidence.txt",
      mimeType: "text/plain",
      checksum: "b".repeat(64),
      data: new TextEncoder().encode("verified evidence"),
    });
  });

  it("downloads verified evidence with private integrity headers", async () => {
    const response = requireResponse(await GET(request(), context));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-sha256")).toBe("b".repeat(64));
    expect(response.headers.get("content-disposition")).toContain("synthetic%20evidence.txt");
    expect(await response.text()).toBe("verified evidence");
    expect(mocks.readQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      evidenceId: "evidence-1",
    });
  });

  it("blocks roles without quality read permission before reading storage", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));
    const response = requireResponse(await GET(request(), context));
    expect(response.status).toBe(403);
    expect(mocks.readQualityEvidence).not.toHaveBeenCalled();
  });

  it("maps tampered evidence to a conflict instead of returning bytes", async () => {
    mocks.readQualityEvidence.mockRejectedValue(
      new mocks.QualityEvidenceError("FILE_INTEGRITY_FAILED", "Checksum mismatch"),
    );
    const response = requireResponse(await GET(request(), context));
    expect(response.status).toBe(409);
  });

  it("does not reveal evidence outside the event scope", async () => {
    mocks.readQualityEvidence.mockRejectedValue(
      new mocks.QualityEvidenceError("EVIDENCE_NOT_FOUND", "Not found"),
    );
    const response = requireResponse(await GET(request(), context));
    expect(response.status).toBe(404);
  });
});
