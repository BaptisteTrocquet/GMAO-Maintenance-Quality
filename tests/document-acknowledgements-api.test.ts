import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  acknowledgeEffectiveRevision: vi.fn(),
  getEffectiveRevisionAcknowledgement: vi.fn(),
  listDocumentReadAcknowledgements: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/documents/acknowledgements", () => ({
  acknowledgeEffectiveRevision: mocks.acknowledgeEffectiveRevision,
  getEffectiveRevisionAcknowledgement: mocks.getEffectiveRevisionAcknowledgement,
  listDocumentReadAcknowledgements: mocks.listDocumentReadAcknowledgements,
  DocumentAcknowledgementError: class DocumentAcknowledgementError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { GET, POST } from "@/app/api/documents/[documentId]/acknowledgements/route";

const checksum = "a".repeat(64);
const context = { params: Promise.resolve({ documentId: "doc-1" }) };

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

function postRequest(body: unknown) {
  return new Request("http://localhost/api/documents/doc-1/acknowledgements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("document acknowledgement API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    mocks.acknowledgeEffectiveRevision.mockResolvedValue({
      created: true,
      auditId: "audit-ack-1",
      snapshot: { revisionId: "rev-b", checksum },
    });
    mocks.getEffectiveRevisionAcknowledgement.mockResolvedValue({
      acknowledged: true,
      revision: { id: "rev-b", revision: "B", checksum },
      acknowledgement: { auditId: "audit-ack-1" },
    });
    mocks.listDocumentReadAcknowledgements.mockResolvedValue({
      document: { id: "doc-1", code: "WI-001" },
      acknowledgements: [],
    });
  });

  it("allows any document reader to acknowledge the effective revision checksum", async () => {
    const response = await POST(
      postRequest({ organizationId: "org-a", checksum }),
      context,
    );

    await expectStatus(response, 201);
    expect(mocks.acknowledgeEffectiveRevision).toHaveBeenCalledWith({
      organizationId: "org-a",
      documentId: "doc-1",
      actorId: "viewer-1",
      checksum,
      asOf: undefined,
    });
  });

  it("returns 200 rather than duplicating an existing acknowledgement", async () => {
    mocks.acknowledgeEffectiveRevision.mockResolvedValue({
      created: false,
      auditId: "audit-existing",
      snapshot: { revisionId: "rev-b", checksum },
    });

    const response = await POST(postRequest({ organizationId: "org-a", checksum }), context);

    await expectStatus(response, 200);
  });

  it("lets a reader query only their own effective-revision acknowledgement by default", async () => {
    const response = await GET(
      new Request("http://localhost/api/documents/doc-1/acknowledgements?organizationId=org-a"),
      context,
    );

    await expectStatus(response, 200);
    expect(mocks.getEffectiveRevisionAcknowledgement).toHaveBeenCalledWith({
      organizationId: "org-a",
      documentId: "doc-1",
      actorId: "viewer-1",
      asOf: undefined,
    });
    expect(mocks.listDocumentReadAcknowledgements).not.toHaveBeenCalled();
  });

  it("blocks ordinary readers from listing other users' acknowledgements", async () => {
    const response = await GET(
      new Request("http://localhost/api/documents/doc-1/acknowledgements?organizationId=org-a&scope=all"),
      context,
    );

    await expectStatus(response, 403);
    expect(mocks.listDocumentReadAcknowledgements).not.toHaveBeenCalled();
  });

  it("allows document managers to list acknowledgement history", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await GET(
      new Request("http://localhost/api/documents/doc-1/acknowledgements?organizationId=org-a&scope=all"),
      context,
    );

    await expectStatus(response, 200);
    expect(mocks.listDocumentReadAcknowledgements).toHaveBeenCalledWith({
      organizationId: "org-a",
      documentId: "doc-1",
    });
  });

  it("rejects a checksum that is not a SHA-256 digest before authentication", async () => {
    const response = await POST(
      postRequest({ organizationId: "org-a", checksum: "not-a-checksum" }),
      context,
    );

    await expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
