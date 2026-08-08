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
    readQualityEvidence: vi.fn(),
    QualityEvidenceError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/evidence", () => ({
  attachQualityEvidence: mocks.attachQualityEvidence,
  listQualityEvidence: mocks.listQualityEvidence,
  readQualityEvidence: mocks.readQualityEvidence,
  MAX_QUALITY_EVIDENCE_BYTES: 20 * 1024 * 1024,
  QualityEvidenceError: mocks.QualityEvidenceError,
}));

import { GET as LIST, POST } from "@/app/api/quality/events/[eventId]/evidence/route";
import { GET as DOWNLOAD } from "@/app/api/quality/events/[eventId]/evidence/[evidenceId]/route";

function auth(role: "VIEWER" | "QUALITY_MANAGER") {
  return {
    session: { user: { id: role === "VIEWER" ? "viewer-1" : "quality-1" } },
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

function expectResponse(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  expect(response.status).toBe(status);
  return response;
}

const eventContext = { params: Promise.resolve({ eventId: "event-1" }) };
const evidenceContext = {
  params: Promise.resolve({ eventId: "event-1", evidenceId: "evidence-1" }),
};

describe("quality evidence API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listQualityEvidence.mockResolvedValue([]);
    mocks.attachQualityEvidence.mockResolvedValue({ id: "evidence-1" });
    mocks.readQualityEvidence.mockResolvedValue({
      id: "evidence-1",
      fileName: "proof.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      checksumSha256: "a".repeat(64),
      data: new TextEncoder().encode("proof"),
    });
  });

  it("lets viewers list and download evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const listResponse = expectResponse(
      await LIST(
        new Request("http://localhost/api/quality/events/event-1/evidence?organizationId=org-a&siteId=site-a"),
        eventContext,
      ),
      200,
    );
    expect(listResponse.status).toBe(200);

    const downloadResponse = expectResponse(
      await DOWNLOAD(
        new Request("http://localhost/api/quality/events/event-1/evidence/evidence-1?organizationId=org-a&siteId=site-a"),
        evidenceContext,
      ),
      200,
    );
    expect(downloadResponse.headers.get("content-type")).toBe("text/plain");
    expect(downloadResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(downloadResponse.headers.get("x-content-sha256")).toBe("a".repeat(64));
  });

  it("prevents viewers from uploading evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const form = new FormData();
    form.set("file", new File(["proof"], "proof.txt", { type: "text/plain" }));

    expectResponse(
      await POST(
        new Request("http://localhost/api/quality/events/event-1/evidence?organizationId=org-a&siteId=site-a", {
          method: "POST",
          body: form,
        }),
        eventContext,
      ),
      403,
    );
    expect(mocks.attachQualityEvidence).not.toHaveBeenCalled();
  });

  it("lets quality managers upload multipart evidence after authorization", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const form = new FormData();
    form.set("file", new File(["proof"], "proof.txt", { type: "text/plain" }));
    form.set("kind", "INSPECTION");
    form.set("description", "Synthetic inspection proof");

    expectResponse(
      await POST(
        new Request("http://localhost/api/quality/events/event-1/evidence?organizationId=org-a&siteId=site-a", {
          method: "POST",
          body: form,
        }),
        eventContext,
      ),
      201,
    );
    expect(mocks.attachQualityEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-1",
        fileName: "proof.txt",
        mimeType: "text/plain",
        kind: "INSPECTION",
        description: "Synthetic inspection proof",
      }),
    );
  });

  it("rejects upload scope before reading multipart data", async () => {
    expectResponse(
      await POST(
        new Request("http://localhost/api/quality/events/event-1/evidence", {
          method: "POST",
          body: "not multipart",
        }),
        eventContext,
      ),
      400,
    );
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.attachQualityEvidence).not.toHaveBeenCalled();
  });
});
