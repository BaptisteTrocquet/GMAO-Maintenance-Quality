import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CapaError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  class CapaApprovalError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    getCapaWorkspace: vi.fn(),
    listCapaTimeline: vi.fn(),
    saveCapaDraft: vi.fn(),
    approveCapaGoverned: vi.fn(),
    completeCapaAction: vi.fn(),
    verifyCapaEffectiveness: vi.fn(),
    reopenCapa: vi.fn(),
    CapaError,
    CapaApprovalError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/capa", () => ({
  getCapaWorkspace: mocks.getCapaWorkspace,
  listCapaTimeline: mocks.listCapaTimeline,
  saveCapaDraft: mocks.saveCapaDraft,
  completeCapaAction: mocks.completeCapaAction,
  verifyCapaEffectiveness: mocks.verifyCapaEffectiveness,
  reopenCapa: mocks.reopenCapa,
  CapaError: mocks.CapaError,
}));
vi.mock("@/lib/quality/capa-approval", () => ({
  approveCapaGoverned: mocks.approveCapaGoverned,
  CapaApprovalError: mocks.CapaApprovalError,
}));

import { GET, PATCH } from "@/app/api/quality/events/[eventId]/capa/route";

function auth(role: "VIEWER" | "QUALITY_MANAGER" | "TECHNICIAN", allSites = true) {
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
        allSites,
        siteIds: allSites ? [] : ["site-a"],
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

describe("quality CAPA API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCapaWorkspace.mockResolvedValue({
      event: { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" },
      rootCause: { organizationId: "org-a", siteId: "site-a", status: "CONFIRMED" },
      capa: null,
    });
    mocks.listCapaTimeline.mockResolvedValue([]);
    mocks.saveCapaDraft.mockResolvedValue({ eventId: "event-1", status: "DRAFT" });
    mocks.approveCapaGoverned.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
    mocks.completeCapaAction.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
    mocks.verifyCapaEffectiveness.mockResolvedValue({ eventId: "event-1", status: "CLOSED" });
    mocks.reopenCapa.mockResolvedValue({ eventId: "event-1", status: "DRAFT" });
  });

  it("lets viewers read CAPA inside their site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const response = await GET(
      new Request("http://localhost/api/quality/events/event-1/capa?organizationId=org-a&siteId=site-a"),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.getCapaWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
  });

  it("prevents viewers and technicians from mutating CAPA", async () => {
    for (const role of ["VIEWER", "TECHNICIAN"] as const) {
      mocks.authenticateRequest.mockResolvedValue(auth(role));
      const response = await PATCH(
        new Request("http://localhost/api/quality/events/event-1/capa", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "APPROVE" }),
        }),
        context,
      );
      expectStatus(response, 403);
    }
    expect(mocks.approveCapaGoverned).not.toHaveBeenCalled();
  });

  it("lets quality managers save action ownership and due dates", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SAVE",
          planSummary: "Synthetic CAPA plan",
          actions: [
            {
              type: "CORRECTIVE",
              title: "Replace synthetic fixture",
              ownerId: "owner-1",
              dueAt: "2026-08-20T10:00:00.000Z",
            },
          ],
        }),
      }),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.saveCapaDraft).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      planSummary: "Synthetic CAPA plan",
      actions: [
        {
          type: "CORRECTIVE",
          title: "Replace synthetic fixture",
          ownerId: "owner-1",
          dueAt: new Date("2026-08-20T10:00:00.000Z"),
        },
      ],
      actorId: "quality-1",
    });
  });

  it("routes approval through the independent governance gate", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "APPROVE" }),
      }),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.approveCapaGoverned).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      approverId: "quality-1",
    });
  });

  it("routes action completion and effectiveness with required evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const complete = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "COMPLETE_ACTION",
          actionId: "dd1f1863-0c8d-48a4-a4f8-3a25771626ea",
          completionNote: "Implementation verified.",
        }),
      }),
      context,
    );
    expectStatus(complete, 200);
    expect(mocks.completeCapaAction).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actionId: "dd1f1863-0c8d-48a4-a4f8-3a25771626ea",
      completionNote: "Implementation verified.",
      actorId: "quality-1",
    });

    const verify = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "VERIFY_EFFECTIVENESS",
          result: "EFFECTIVE",
          note: "No recurrence during follow-up checks.",
        }),
      }),
      context,
    );
    expectStatus(verify, 200);
    expect(mocks.verifyCapaEffectiveness).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      result: "EFFECTIVE",
      note: "No recurrence during follow-up checks.",
      actorId: "quality-1",
    });
  });

  it("rejects malformed action due dates before reaching the service", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SAVE",
          planSummary: "Synthetic plan",
          actions: [{ type: "CORRECTIVE", title: "Action", ownerId: "owner-1", dueAt: "not-a-date" }],
        }),
      }),
      context,
    );
    expectStatus(response, 400);
    expect(mocks.saveCapaDraft).not.toHaveBeenCalled();
  });

  it("maps governed approval failures without leaking tenant data", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.approveCapaGoverned.mockRejectedValue(
      new mocks.CapaApprovalError("CAPA_SELF_APPROVAL_NOT_ALLOWED", "Independent approval required"),
    );
    const conflict = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "APPROVE" }),
      }),
      context,
    );
    expectStatus(conflict, 409);

    mocks.approveCapaGoverned.mockRejectedValue(
      new mocks.CapaApprovalError("CAPA_APPROVER_NOT_ALLOWED", "Approver is not allowed"),
    );
    const forbidden = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "APPROVE" }),
      }),
      context,
    );
    expectStatus(forbidden, 403);

    mocks.approveCapaGoverned.mockRejectedValue(
      new mocks.CapaApprovalError("QUALITY_EVENT_NOT_FOUND", "Quality event not found"),
    );
    const missing = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "APPROVE" }),
      }),
      context,
    );
    expectStatus(missing, 404);
  });
});
