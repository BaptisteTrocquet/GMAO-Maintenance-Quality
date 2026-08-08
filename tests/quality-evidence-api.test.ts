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
    readQualityEvidence: vi.fn(),
    removeQualityEvidence: vi.fn(),
    QualityEvidenceError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/evidence", () => ({
  addQualityEvidence: mocks.addQualityEvidence,
  listQualityEvidence: mocks.listQualityEvidence,
  readQualityEvidence: mocks.readQualityEvidence,
  removeQualityEvidence: mocks.removeQualityEvidence,
  MAX_QUALITY_EVIDENCE_BYTES: 20 * 1024 * 1024,
  QualityEvidenceError: mocks.QualityEvidenceError,
}));

import { GET as listEvidence, POST as uploadEvidence } from "@/app/api/quality/events/[eventId]/evidence/route";
import { GET as downloadEvidence, DELETE as deleteEvidence } from "@/app/api/quality/events/[eventId]/evidence/[evidenceId]/file/route";

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

const eventContext = { params: Promise.resolve({ eventId: "event-1" }) };
const fileContext = { params: Promise.resolve({ eventId: "event-1", evidenceId: "evidence-1" }) };

function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  expect(response.status).toBe(status);
}

describe("quality evidence API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listQualityEvidence.mockResolvedValue([]);
    mocks.addQualityEvidence.mockResolvedValue({ id: "evidence-1", checksum: "a".repeat(64) });
    mocks.readQualityEvidence.mockResolvedValue({
      id: "evidence-1",
      fileName: "synthetic.txt",
      mimeType: "text/plain",
      sizeBytes: 9,
      checksum: "a".repeat(64),
      data: new TextEncoder().encode("synthetic"),
    });
    mocks.removeQualityEvidence.mockResolvedValue({
      evidence: { id: "evidence-1", removedAt: "2026-08-08T00:00:00.000Z" },
      storageDeleted: true,
    });
  });

  it("lets viewers list quality evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const response = await listEvidence(
      new Request("http://localhost/api/quality/events/event-1/evidence?organizationId=org-a&siteId=site-a"),
      eventContext,
    );
    expectStatus(response, 200);
    expect(mocks.listQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      phase: undefined,
    });
  });

  it("prevents viewers from uploading evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const form = new FormData();
    form.set("organizationId", "org-a");
    form.set("siteId", "site-a");
    form.set("phase", "EVENT");
    form.set("kind", "DOCUMENT");
    form.set("file", new File(["synthetic"], "synthetic.txt", { type: "text/plain" }));
    const response = await uploadEvidence(
      new Request("http://localhost/api/quality/events/event-1/evidence", { method: "POST", body: form }),
      eventContext,
    );
    expectStatus(response, 403);
    expect(mocks.addQualityEvidence).not.toHaveBeenCalled();
  });

  it("lets quality managers upload multipart evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const form = new FormData();
    form.set("organizationId", "org-a");
    form.set("siteId", "site-a");
    form.set("phase", "ROOT_CAUSE");
    form.set("kind", "DOCUMENT");
    form.set("description", "Synthetic analysis record");
    form.set("file", new File(["synthetic"], "analysis.txt", { type: "text/plain" }));
    const response = await uploadEvidence(
      new Request("http://localhost/api/quality/events/event-1/evidence", { method: "POST", body: form }),
      eventContext,
    );
    expectStatus(response, 201);
    expect(mocks.addQualityEvidence).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      phase: "ROOT_CAUSE",
      kind: "DOCUMENT",
      fileName: "analysis.txt",
      mimeType: "text/plain",
      description: "Synthetic analysis record",
      actorId: "quality-1",
    }));
  });

  it("serves a verified file with checksum and no-store headers", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const response = await downloadEvidence(
      new Request("http://localhost/api/quality/events/event-1/evidence/evidence-1/file?organizationId=org-a&siteId=site-a"),
      fileContext,
    );
    expectStatus(response, 200);
    expect(response.headers.get("x-content-sha256")).toBe("a".repeat(64));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.readQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      evidenceId: "evidence-1",
    });
  });

  it("maps checksum mismatch to 409", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    mocks.readQualityEvidence.mockRejectedValue(
      new mocks.QualityEvidenceError("FILE_INTEGRITY_FAILED", "checksum mismatch"),
    );
    const response = await downloadEvidence(
      new Request("http://localhost/api/quality/events/event-1/evidence/evidence-1/file?organizationId=org-a&siteId=site-a"),
      fileContext,
    );
    expectStatus(response, 409);
  });

  it("prevents viewers from removing evidence and lets managers remove it", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const denied = await deleteEvidence(
      new Request("http://localhost/api/quality/events/event-1/evidence/evidence-1/file?organizationId=org-a&siteId=site-a", { method: "DELETE" }),
      fileContext,
    );
    expectStatus(denied, 403);
    expect(mocks.removeQualityEvidence).not.toHaveBeenCalled();

    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const allowed = await deleteEvidence(
      new Request("http://localhost/api/quality/events/event-1/evidence/evidence-1/file?organizationId=org-a&siteId=site-a", { method: "DELETE" }),
      fileContext,
    );
    expectStatus(allowed, 200);
    expect(mocks.removeQualityEvidence).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      evidenceId: "evidence-1",
      actorId: "quality-1",
    });
  });
});
