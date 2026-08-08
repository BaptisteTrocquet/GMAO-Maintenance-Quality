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
  MAX_QUALITY_EVIDENCE_BYTES: 20 * 1024 * 1024,
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

function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  expect(response.status).toBe(status);
}

const context = { params: Promise.resolve({ eventId: "event-1" }) };
const fileBytes = new Uint8Array([1, 2, 3, 4]);

function postRequest() {
  const formData = new FormData();
  formData.set("organizationId", "org-a");
  formData.set("siteId", "site-a");
  formData.set("phase", "CAPA");
  formData.set("kind", "DOCUMENT");
  formData.set("description", "Synthetic implementation evidence");
  formData.set(
    "file",
    new File([fileBytes], "synthetic-evidence.pdf", { type: "application/pdf" }),
  );
  return new Request("http://localhost/api/quality/events/event-1/evidence", {
    method: "POST",
    body: formData,
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
      storageKey: "quality-evidence/org-a/event-1/evidence-1/checksum",
      mimeType: "application/pdf",
      sizeBytes: fileBytes.byteLength,
      checksum: "synthetic-checksum",
      description: "Synthetic implementation evidence",
      createdById: "quality-1",
      createdAt: "2026-08-08T00:00:00.000Z",
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

    expectStatus(response, 200);
    expect(mocks.listQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      phase: "CAPA",
    });
  });

  it("blocks viewers from uploading evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await POST(postRequest(), context);

    expectStatus(response, 403);
    expect(mocks.addQualityEvidence).not.toHaveBeenCalled();
  });

  it("allows quality managers to upload evidence bytes through managed storage", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await POST(postRequest(), context);

    expectStatus(response, 201);
    expect(mocks.addQualityEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        phase: "CAPA",
        kind: "DOCUMENT",
        fileName: "synthetic-evidence.pdf",
        mimeType: "application/pdf",
        description: "Synthetic implementation evidence",
        actorId: "quality-1",
        data: expect.any(Uint8Array),
      }),
    );
    const payload = mocks.addQualityEvidence.mock.calls[0]?.[0];
    expect(Array.from(payload.data as Uint8Array)).toEqual(Array.from(fileBytes));
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

    expectStatus(response, 404);
  });

  it("maps closed-event upload attempts to conflict", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.addQualityEvidence.mockRejectedValue(
      new mocks.QualityEvidenceError("EVENT_CLOSED", "Evidence cannot be added after closure"),
    );

    const response = await POST(postRequest(), context);

    expectStatus(response, 409);
  });

  it("rejects non-multipart payloads before authentication", async () => {
    const response = await POST(
      new Request("http://localhost/api/quality/events/event-1/evidence", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not multipart",
      }),
      context,
    );

    expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
