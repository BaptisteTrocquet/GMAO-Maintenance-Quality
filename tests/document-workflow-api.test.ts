import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  submitRevisionForReview: vi.fn(),
  requestRevisionApproval: vi.fn(),
  decideRevisionApproval: vi.fn(),
  scheduleRevisionEffective: vi.fn(),
  resolveEffectiveRevision: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/documents/workflow", () => ({
  submitRevisionForReview: mocks.submitRevisionForReview,
  requestRevisionApproval: mocks.requestRevisionApproval,
  decideRevisionApproval: mocks.decideRevisionApproval,
  scheduleRevisionEffective: mocks.scheduleRevisionEffective,
  resolveEffectiveRevision: mocks.resolveEffectiveRevision,
  DocumentWorkflowError: class DocumentWorkflowError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { POST as submitReview } from "@/app/api/documents/[documentId]/revisions/[revisionId]/review/route";
import { POST as decideApproval } from "@/app/api/documents/[documentId]/revisions/[revisionId]/approval/route";
import { POST as scheduleEffective } from "@/app/api/documents/[documentId]/revisions/[revisionId]/effective/route";
import { GET as getEffective } from "@/app/api/documents/[documentId]/effective/route";

function auth(role: "QUALITY_MANAGER" | "TECHNICIAN" | "VIEWER") {
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

const revisionContext = {
  params: Promise.resolve({ documentId: "doc-1", revisionId: "rev-b" }),
};

function jsonRequest(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("document workflow API permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.submitRevisionForReview.mockResolvedValue({ id: "rev-b", status: "IN_REVIEW" });
    mocks.decideRevisionApproval.mockResolvedValue({ id: "rev-b", status: "APPROVED" });
    mocks.scheduleRevisionEffective.mockResolvedValue({ id: "rev-b", status: "APPROVED" });
    mocks.resolveEffectiveRevision.mockResolvedValue({ id: "rev-b", status: "EFFECTIVE" });
  });

  it("allows document managers to submit a revision for review", async () => {
    const response = await submitReview(
      jsonRequest("/api/documents/doc-1/revisions/rev-b/review", { organizationId: "org-a" }),
      revisionContext,
    );

    await expectStatus(response, 200);
    expect(mocks.submitRevisionForReview).toHaveBeenCalledWith({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-b",
      actorId: "quality-1",
    });
  });

  it("blocks users without document:approve from recording approval decisions", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await decideApproval(
      jsonRequest("/api/documents/doc-1/revisions/rev-b/approval", {
        organizationId: "org-a",
        decision: "APPROVED",
      }),
      revisionContext,
    );

    await expectStatus(response, 403);
    expect(mocks.decideRevisionApproval).not.toHaveBeenCalled();
  });

  it("allows an authorized approver to decide an assigned revision", async () => {
    const response = await decideApproval(
      jsonRequest("/api/documents/doc-1/revisions/rev-b/approval", {
        organizationId: "org-a",
        decision: "APPROVED",
        comment: "Ready for release",
      }),
      revisionContext,
    );

    await expectStatus(response, 200);
    expect(mocks.decideRevisionApproval).toHaveBeenCalledWith({
      organizationId: "org-a",
      documentId: "doc-1",
      revisionId: "rev-b",
      actorId: "quality-1",
      decision: "APPROVED",
      comment: "Ready for release",
    });
  });

  it("requires document approval permission to schedule an effective date", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await scheduleEffective(
      jsonRequest("/api/documents/doc-1/revisions/rev-b/effective", {
        organizationId: "org-a",
        effectiveAt: "2026-09-01T00:00:00.000Z",
      }),
      revisionContext,
    );

    await expectStatus(response, 403);
    expect(mocks.scheduleRevisionEffective).not.toHaveBeenCalled();
  });

  it("allows read-only document users to resolve the effective revision", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const request = new Request(
      "http://localhost/api/documents/doc-1/effective?organizationId=org-a&asOf=2026-09-15T00:00:00.000Z",
    );

    const response = await getEffective(request, { params: Promise.resolve({ documentId: "doc-1" }) });

    await expectStatus(response, 200);
    expect(mocks.resolveEffectiveRevision).toHaveBeenCalledWith({
      organizationId: "org-a",
      documentId: "doc-1",
      asOf: new Date("2026-09-15T00:00:00.000Z"),
    });
  });
});
