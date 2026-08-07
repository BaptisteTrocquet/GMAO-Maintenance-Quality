import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  documentFindMany: vi.fn(),
  documentCreate: vi.fn(),
  organizationFindFirst: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: {
    document: { findMany: mocks.documentFindMany, create: mocks.documentCreate },
    organization: { findFirst: mocks.organizationFindFirst },
    auditLog: { create: mocks.auditCreate },
  },
}));

import { GET, POST } from "@/app/api/documents/route";

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

function postRequest() {
  return new Request("http://localhost/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      code: "WI-001",
      title: "Inspection instruction",
      type: "WORK_INSTRUCTION",
      owner: "Maintenance",
      description: "Synthetic controlled work instruction.",
    }),
  });
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("documents API tenant boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.documentFindMany.mockResolvedValue([]);
    mocks.organizationFindFirst.mockResolvedValue({ id: "org-a" });
    mocks.documentCreate.mockResolvedValue({
      id: "doc-1",
      organizationId: "org-a",
      code: "WI-001",
      title: "Inspection instruction",
      type: "WORK_INSTRUCTION",
      owner: "Maintenance",
      description: "Synthetic controlled work instruction.",
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("requires an explicit organization scope", async () => {
    const response = await GET(new Request("http://localhost/api/documents"));
    await expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });

  it("rejects requests that fail tenant authentication", async () => {
    mocks.authenticateRequest.mockResolvedValueOnce({
      error: Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }),
    });

    const response = await GET(
      new Request("http://localhost/api/documents?organizationId=org-other"),
    );

    await expectStatus(response, 401);
    expect(mocks.authenticateRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "org-other",
    );
  });

  it("applies organization-scoped search, type and owner filters", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/documents?organizationId=org-a&q=inspection&type=WORK_INSTRUCTION&owner=Maintenance",
      ),
    );

    await expectStatus(response, 200);
    expect(mocks.documentFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        type: "WORK_INSTRUCTION",
        owner: "Maintenance",
        OR: [
          { code: { contains: "inspection", mode: "insensitive" } },
          { title: { contains: "inspection", mode: "insensitive" } },
          { description: { contains: "inspection", mode: "insensitive" } },
        ],
      },
      include: {
        revisions: { orderBy: { createdAt: "desc" } },
        assetDocuments: {
          where: { asset: { site: { organizationId: "org-a" } } },
          include: { asset: true },
        },
      },
      orderBy: { code: "asc" },
    });
  });

  it("allows a quality manager to create and audit a document master", async () => {
    const response = await POST(postRequest());

    await expectStatus(response, 201);
    expect(mocks.documentCreate).toHaveBeenCalledWith({
      data: {
        organizationId: "org-a",
        code: "WI-001",
        title: "Inspection instruction",
        type: "WORK_INSTRUCTION",
        owner: "Maintenance",
        description: "Synthetic controlled work instruction.",
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "quality-1",
        entityType: "Document",
        entityId: "doc-1",
        action: "CREATED",
      }),
    });
  });

  it("blocks a technician from creating document masters", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await POST(postRequest());

    await expectStatus(response, 403);
    expect(mocks.documentCreate).not.toHaveBeenCalled();
  });
});
