import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class EightDError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    getEightDWorkspace: vi.fn(),
    listEightDTimeline: vi.fn(),
    saveEightDDraft: vi.fn(),
    approveEightD: vi.fn(),
    recordEightDPrevention: vi.fn(),
    closeEightD: vi.fn(),
    reopenEightD: vi.fn(),
    EightDError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/eight-d", () => ({
  getEightDWorkspace: mocks.getEightDWorkspace,
  listEightDTimeline: mocks.listEightDTimeline,
  saveEightDDraft: mocks.saveEightDDraft,
  approveEightD: mocks.approveEightD,
  recordEightDPrevention: mocks.recordEightDPrevention,
  closeEightD: mocks.closeEightD,
  reopenEightD: mocks.reopenEightD,
  EightDError: mocks.EightDError,
}));

import { GET, PATCH } from "@/app/api/quality/events/[eventId]/eight-d/route";

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

describe("quality 8D API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEightDWorkspace.mockResolvedValue({
      event: { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" },
      rootCause: null,
      capa: null,
      eightD: null,
      disciplines: [],
    });
    mocks.listEightDTimeline.mockResolvedValue([]);
    mocks.saveEightDDraft.mockResolvedValue({ eventId: "event-1", status: "DRAFT" });
    mocks.approveEightD.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
    mocks.recordEightDPrevention.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
    mocks.closeEightD.mockResolvedValue({ eventId: "event-1", status: "CLOSED" });
    mocks.reopenEightD.mockResolvedValue({ eventId: "event-1", status: "DRAFT" });
  });

  it("lets viewers read 8D inside their site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const response = await GET(
      new Request("http://localhost/api/quality/events/event-1/eight-d?organizationId=org-a&siteId=site-a"),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.getEightDWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
  });

  it("prevents viewers and technicians from mutating 8D", async () => {
    for (const role of ["VIEWER", "TECHNICIAN"] as const) {
      mocks.authenticateRequest.mockResolvedValue(auth(role));
      const response = await PATCH(
        new Request("http://localhost/api/quality/events/event-1/eight-d", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "APPROVE" }),
        }),
        context,
      );
      expectStatus(response, 403);
    }
    expect(mocks.approveEightD).not.toHaveBeenCalled();
  });

  it("lets quality managers save D1/D2 with explicit team ownership", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/eight-d", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SAVE",
          leaderId: "leader-1",
          teamMemberIds: ["leader-1", "member-2"],
          problemStatement: "Synthetic failure observed during routine verification.",
        }),
      }),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.saveEightDDraft).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      leaderId: "leader-1",
      teamMemberIds: ["leader-1", "member-2"],
      problemStatement: "Synthetic failure observed during routine verification.",
      actorId: "quality-1",
    });
  });

  it("routes approval, D7, closure and reopen through explicit workflow actions", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const approve = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/eight-d", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "APPROVE" }),
      }),
      context,
    );
    expectStatus(approve, 200);
    expect(mocks.approveEightD).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    const prevention = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/eight-d", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "RECORD_PREVENTION",
          preventionSummary: "Update the standard and audit the new control.",
        }),
      }),
      context,
    );
    expectStatus(prevention, 200);
    expect(mocks.recordEightDPrevention).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      preventionSummary: "Update the standard and audit the new control.",
      actorId: "quality-1",
    });

    const close = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/eight-d", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "CLOSE",
          recognitionNote: "Recognize the cross-functional team and share lessons learned.",
        }),
      }),
      context,
    );
    expectStatus(close, 200);
    expect(mocks.closeEightD).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      recognitionNote: "Recognize the cross-functional team and share lessons learned.",
      actorId: "quality-1",
    });

    const reopen = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/eight-d", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "REOPEN" }),
      }),
      context,
    );
    expectStatus(reopen, 200);
    expect(mocks.reopenEightD).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
  });

  it("returns workflow conflicts with stable error codes", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.approveEightD.mockRejectedValue(
      new mocks.EightDError("CONTAINMENT_REQUIRED", "Complete containment first"),
    );

    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/eight-d", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "APPROVE" }),
      }),
      context,
    );
    expectStatus(response, 409);
  });
});
