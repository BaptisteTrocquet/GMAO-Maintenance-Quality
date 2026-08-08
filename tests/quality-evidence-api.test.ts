import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class QualityEvidenceError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    attachQualityEvidence: vi.fn(),
    listQualityEvidence: vi.fn(),
    QualityEvidenceError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/evidence", () => ({
  attachQualityEvidence: mocks.attachQualityEvidence,
  listQualityEvidence: mocks.listQualityEvidence,
  MAX_QUALITY_EVIDENCE_BYTES: 20 * 1024 * 1024,
  QualityEvidenceError: mocks.QualityEvidenceError,
}));

import { GET, POST } from "@/app/api/quality/events/[eventId]/evidence/route";

function auth(role: "VIEWER" | "QUALITY_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "QUALITY_MANAGER" ? "quality-1" : `${role.toLowerCase()}-1` } },
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

const context = { params: Promise.resolve({ eventId: "event-1" }) };

function scopedUrl() {
  return "http://localhost/api/quality/events/event-1/evidence?organizationId=org-a&siteId=site-a";
}

function uploadRequest() {
  const form = new FormData();
  form.set("file", new File(["synthetic evidence"], "evidence.txt", { type: "text/plain" }));
  form.set("kind", "INSPECTION");
  form.set("description", "Synthetic inspection evidence");
  return new Request(scopedUrl(), { method: "POST", body: form });
}

describe("quality evidence collection API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listQualityEvidence.mockResolvedValue([]);
    mocks.attachQualityEvidence.mockResolvedValue({
      id: "evidence-1",
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      fileName: "evidence.txt",
      checksum: "a".repeat(64),
    });
  });

  it("lets quality readers list evidence in site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const response = requireResponse(await GET(new Request(scopedUrl()), context));

    expect(response.status).toBe(200);
    expect(mocks.listQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
  });

  it("blocks non-managers from uploading evidence", async () => {
    for (const role of ["VIEWER", "TECHNICIAN"] as const) {
      mocks.authenticateRequest.mockResolvedValue(auth(role));
      const response = requireResponse(await POST(uploadRequest(), context));
      expect(response.status).toBe(403);
    }
    expect(mocks.attachQualityEvidence).not.toHaveBeenCalled();
  });

  it("rejects an oversized multipart request before parsing its body", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const request = new Request(scopedUrl(), {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=synthetic",
        "content-length": String(22 * 1024 * 1024),
      },
      body: "not parsed because content-length is already too large",
    });
    const formDataSpy = vi.spyOn(request, "formData");

    const response = requireResponse(await POST(request, context));

    expect(response.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(mocks.attachQualityEvidence).not.toHaveBeenCalled();
  });

  it("uploads multipart evidence for a quality manager", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = requireResponse(await POST(uploadRequest(), context));

    expect(response.status).toBe(201);
    expect(mocks.attachQualityEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-1",
        fileName: "evidence.txt",
        mimeType: "text/plain",
        kind: "INSPECTION",
        description: "Synthetic inspection evidence",
      }),
    );
    const call = mocks.attachQualityEvidence.mock.calls[0]?.[0];
    expect(new TextDecoder().decode(call.data)).toBe("synthetic evidence");
  });

  it("maps closed-event uploads to a conflict", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.attachQualityEvidence.mockRejectedValue(
      new mocks.QualityEvidenceError("EVENT_CLOSED", "Closed event"),
    );

    const response = requireResponse(await POST(uploadRequest(), context));
    expect(response.status).toBe(409);
  });

  it("requires explicit organization and site scope", async () => {
    const response = requireResponse(
      await GET(
        new Request("http://localhost/api/quality/events/event-1/evidence?organizationId=org-a"),
        context,
      ),
    );
    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
