import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class QualityEvidenceError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    addQualityEvidence: vi.fn(),
    listQualityEvidence: vi.fn(),
    QualityEvidenceError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/evidence", () => ({
  addQualityEvidence: mocks.addQualityEvidence,
  listQualityEvidence: mocks.listQualityEvidence,
  QualityEvidenceError: mocks.QualityEvidenceError,
}));

import { GET, POST } from "@/app/api/quality/events/[eventId]/evidence/route";

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

const context = { params: Promise.resolve({ eventId: "event-1" }) };

function postRequest() {
  return new Request("http://localhost/api/quality/events/event-1/evidence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      phase: "CAPA",
      kind: "DOCUMENT",
      fileName: "synthetic-evidence.pdf",
      storageKey: "quality/event-1/synthetic-evidence.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      description: "Synthetic implementation evidence",
    }),
  });
}

describe("quality evidence API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listQualityEvidence.mockResolvedValue([]);
    mocks.addQualityEvidence.mockResolvedValue({
      id: "evidence-1",
      eventId: "event-1",
      phase: "CAPA",
      kind: "DOCUMENT",
      fileName: "synthetic-evidence.pdf",
    });
  });

  it("allows viewers to read evidence in their site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await GET(
      new Request(
        "http://localhost/api/quality/events/event-1/evidence?organizationId=org-a&siteId=site-a&phase=CAPA",
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.listQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      phase: "CAPA",
    });
  });

  it("blocks viewers from attaching evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await POST(postRequest(), context);

    expect(response.status).toBe(403);
    expect(mocks.addQualityEvidence).not.toHaveBeenCalled();
  });

  it("allows quality managers to attach immutable evidence metadata", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await POST(postRequest(), context);

    expect(response.status).toBe(201);
    expect(mocks.addQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      phase: "CAPA",
      kind: "DOCUMENT",
      fileName: "synthetic-evidence.pdf",
      storageKey: "quality/event-1/synthetic-evidence.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      description: "Synthetic implementation evidence",
      actorId: "quality-1",
    });
  });

  it("returns an opaque 404 when the event is outside tenant/site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    mocks.listQualityEvidence.mockResolvedValue(null);

    const response = await GET(
      new Request(
        "http://localhost/api/quality/events/event-missing/evidence?organizationId=org-a&siteId=site-a",
      ),
      { params: Promise.resolve({ eventId: "event-missing" }) },
    );

    expect(response.status).toBe(404);
  });

  it("maps closed-event evidence attempts to conflict", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.addQualityEvidence.mockRejectedValue(
      new mocks.QualityEvidenceError("EVENT_CLOSED", "Evidence cannot be added after closure"),
    );

    const response = await POST(postRequest(), context);

    expect(response.status).toBe(409);
  });

  it("rejects malformed JSON before authentication", async () => {
    const response = await POST(
      new Request("http://localhost/api/quality/events/event-1/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{invalid-json",
      }),
      context,
    );

    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
