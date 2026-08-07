import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  createRevision: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/db", () => ({
  db: {
    document: { findFirst: vi.fn() },
    documentRevision: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/documents/control", () => ({
  createDocumentRevision: mocks.createRevision,
  DocumentControlError: class DocumentControlError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { POST } from "@/app/api/documents/[documentId]/revisions/route";

function auth(role: "QUALITY_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "QUALITY_MANAGER" ? "quality-1" : "tech-1" } },
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

function request() {
  return new Request("http://localhost/api/documents/doc-1/revisions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      revision: "B",
      changeSummary: "Clarify inspection sequence",
    }),
  });
}

const context = { params: Promise.resolve({ documentId: "doc-1" }) };

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("document revision API permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.createRevision.mockResolvedValue({
      id: "rev-1",
      documentId: "doc-1",
      revision: "B",
      status: "DRAFT",
      changeSummary: "Clarify inspection sequence",
    });
  });

  it("allows a quality manager to create a draft revision", async () => {
    const response = await POST(request(), context);

    await expectStatus(response, 201);
    expect(mocks.createRevision).toHaveBeenCalledWith({
      organizationId: "org-a",
      documentId: "doc-1",
      revision: "B",
      changeSummary: "Clarify inspection sequence",
      actorId: "quality-1",
    });
  });

  it("blocks a technician from creating document revisions", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await POST(request(), context);

    await expectStatus(response, 403);
    expect(mocks.createRevision).not.toHaveBeenCalled();
  });

  it("propagates tenant authentication failures before document access", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      error: Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }),
    });

    const response = await POST(request(), context);

    await expectStatus(response, 401);
    expect(mocks.createRevision).not.toHaveBeenCalled();
  });
});
