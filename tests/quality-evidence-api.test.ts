import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class QualityEvidenceError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    listQualityEvidence: vi.fn(),
    addQualityEvidence: vi.fn(),
    revokeQualityEvidence: vi.fn(),
    QualityEvidenceError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/evidence", () => ({
  listQualityEvidence: mocks.listQualityEvidence,
  addQualityEvidence: mocks.addQualityEvidence,
  revokeQualityEvidence: mocks.revokeQualityEvidence,
  QualityEvidenceError: mocks.QualityEvidenceError,
  MAX_QUALITY_EVIDENCE_BYTES: 25 * 1024 * 1024,
  QUALITY_EVIDENCE_MIME_TYPES: [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/plain",
  ],
}));

import { GET, POST } from "@/app/api/quality/events/[eventId]/evidence/route";
import { DELETE } from "@/app/api/quality/events/[eventId]/evidence/[evidenceId]/route";

function auth(role: "VIEWER" | "QUALITY_MANAGER" | "TECHNICIAN") {
  return {
    session: {
      user: {
        id:
          role === "VIEWER"
            ? "viewer-1"
            : role === "QUALITY_MANAGER"
              ? "quality-1"
              : "tech-1",
      },
    },
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

const collectionContext = { params: Promise.resolve({ eventId: "event-1" }) };
const evidenceContext = {
  params: Promise.resolve({ eventId: "event-1", evidenceId: "evidence-1" }),
};

describe("quality evidence API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listQualityEvidence.mockResolvedValue([]);
    mocks.addQualityEvidence.mockResolvedValue({ evidenceId: "evidence-1", active: true });
    mocks.revokeQualityEvidence.mockResolvedValue({ evidenceId: "evidence-1", active: false });
  });

  it("lets viewers read evidence but not mutate it", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const read = await GET(
      new Request("http://localhost/api/quality/events/event-1/evidence?organizationId=org-a&siteId=site-a"),
      collectionContext,
    );
    expectStatus(read, 200);

    const create = await POST(
      new Request("http://localhost/api/quality/events/event-1/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          category: "ROOT_CAUSE",
          fileName: "evidence.pdf",
          storageKey: "quality/event-1/evidence.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1024,
        }),
      }),
      collectionContext,
    );
    expectStatus(create, 403);
    expect(mocks.addQualityEvidence).not.toHaveBeenCalled();
  });

  it("lets quality managers register bounded evidence metadata", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await POST(
      new Request("http://localhost/api/quality/events/event-1/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          category: "CAPA_ACTION",
          relatedActionId: "action-1",
          fileName: "implementation.jpg",
          storageKey: "quality/event-1/implementation.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 2048,
          note: "Implementation evidence.",
        }),
      }),
      collectionContext,
    );

    expectStatus(response, 201);
    expect(mocks.addQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      category: "CAPA_ACTION",
      relatedActionId: "action-1",
      fileName: "implementation.jpg",
      storageKey: "quality/event-1/implementation.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 2048,
      note: "Implementation evidence.",
      actorId: "quality-1",
    });
  });

  it("rejects unsupported MIME types and oversized files at the HTTP boundary", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const unsupported = await POST(
      new Request("http://localhost/api/quality/events/event-1/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          category: "OTHER",
          fileName: "binary.exe",
          storageKey: "quality/event-1/binary.exe",
          mimeType: "application/x-msdownload",
          sizeBytes: 1024,
        }),
      }),
      collectionContext,
    );
    expectStatus(unsupported, 400);

    const oversized = await POST(
      new Request("http://localhost/api/quality/events/event-1/evidence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          category: "OTHER",
          fileName: "large.pdf",
          storageKey: "quality/event-1/large.pdf",
          mimeType: "application/pdf",
          sizeBytes: 25 * 1024 * 1024 + 1,
        }),
      }),
      collectionContext,
    );
    expectStatus(oversized, 400);
    expect(mocks.addQualityEvidence).not.toHaveBeenCalled();
  });

  it("revokes evidence with an explicit reason instead of deleting history", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await DELETE(
      new Request("http://localhost/api/quality/events/event-1/evidence/evidence-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          reason: "Superseded by corrected evidence.",
        }),
      }),
      evidenceContext,
    );

    expectStatus(response, 200);
    expect(mocks.revokeQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      evidenceId: "evidence-1",
      reason: "Superseded by corrected evidence.",
      actorId: "quality-1",
    });
  });

  it("keeps technicians from revoking quality evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));
    const response = await DELETE(
      new Request("http://localhost/api/quality/events/event-1/evidence/evidence-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          reason: "Attempted revocation.",
        }),
      }),
      evidenceContext,
    );
    expectStatus(response, 403);
    expect(mocks.revokeQualityEvidence).not.toHaveBeenCalled();
  });
});
