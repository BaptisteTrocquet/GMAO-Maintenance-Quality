import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CapaError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    getCapaWorkspace: vi.fn(),
    listCapaTimeline: vi.fn(),
    saveCapaWorkspace: vi.fn(),
    activateCapa: vi.fn(),
    transitionCapaAction: vi.fn(),
    submitEffectivenessReview: vi.fn(),
    verifyCapaEffectiveness: vi.fn(),
    CapaError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/capa", () => ({
  getCapaWorkspace: mocks.getCapaWorkspace,
  listCapaTimeline: mocks.listCapaTimeline,
  saveCapaWorkspace: mocks.saveCapaWorkspace,
  activateCapa: mocks.activateCapa,
  transitionCapaAction: mocks.transitionCapaAction,
  submitEffectivenessReview: mocks.submitEffectivenessReview,
  verifyCapaEffectiveness: mocks.verifyCapaEffectiveness,
  CapaError: mocks.CapaError,
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
      rootCauseConfirmed: true,
      capa: null,
    });
    mocks.listCapaTimeline.mockResolvedValue([]);
    mocks.saveCapaWorkspace.mockResolvedValue({ eventId: "event-1", status: "DRAFT" });
    mocks.activateCapa.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
    mocks.transitionCapaAction.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
    mocks.submitEffectivenessReview.mockResolvedValue({
      eventId: "event-1",
      status: "EFFECTIVENESS_REVIEW",
    });
    mocks.verifyCapaEffectiveness.mockResolvedValue({ eventId: "event-1", status: "CLOSED" });
  });

  it("lets viewers read the CAPA workspace inside their site scope", async () => {
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

  it("prevents viewers and technicians from editing CAPA", async () => {
    for (const role of ["VIEWER", "TECHNICIAN"] as const) {
      mocks.authenticateRequest.mockResolvedValue(auth(role));
      const response = await PATCH(
        new Request("http://localhost/api/quality/events/event-1/capa", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "ACTIVATE" }),
        }),
        context,
      );
      expectStatus(response, 403);
    }
    expect(mocks.activateCapa).not.toHaveBeenCalled();
  });

  it("lets quality managers save corrective and preventive action ownership", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SAVE",
          objective: "Remove synthetic cause and prevent recurrence.",
          actions: [
            {
              id: "corrective-1",
              type: "CORRECTIVE",
              title: "Correct synthetic cause",
              ownerId: "quality-2",
              dueAt: "2026-08-20T00:00:00.000Z",
            },
          ],
        }),
      }),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.saveCapaWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      objective: "Remove synthetic cause and prevent recurrence.",
      actions: [
        {
          id: "corrective-1",
          type: "CORRECTIVE",
          title: "Correct synthetic cause",
          description: null,
          ownerId: "quality-2",
          dueAt: new Date("2026-08-20T00:00:00.000Z"),
        },
      ],
      actorId: "quality-1",
    });
  });

  it("routes action completion and effectiveness through explicit audited transitions", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const complete = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "TRANSITION_ACTION",
          actionId: "corrective-1",
          status: "COMPLETED",
          evidence: "Synthetic completion evidence.",
        }),
      }),
      context,
    );
    expectStatus(complete, 200);
    expect(mocks.transitionCapaAction).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actionId: "corrective-1",
      status: "COMPLETED",
      evidence: "Synthetic completion evidence.",
      actorId: "quality-1",
    });

    const review = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SUBMIT_EFFECTIVENESS",
          method: "Verify synthetic recurrence does not reappear.",
          ownerId: "quality-4",
          dueAt: "2026-09-01T00:00:00.000Z",
        }),
      }),
      context,
    );
    expectStatus(review, 200);
    expect(mocks.submitEffectivenessReview).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      method: "Verify synthetic recurrence does not reappear.",
      ownerId: "quality-4",
      dueAt: new Date("2026-09-01T00:00:00.000Z"),
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
          evidence: "Synthetic effectiveness criteria satisfied.",
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
      evidence: "Synthetic effectiveness criteria satisfied.",
      actorId: "quality-1",
    });
  });

  it("maps workflow conflicts without leaking another tenant", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.activateCapa.mockRejectedValue(
      new mocks.CapaError("ROOT_CAUSE_CONFIRMATION_REQUIRED", "Confirm root-cause analysis before activating CAPA"),
    );
    const conflict = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "ACTIVATE" }),
      }),
      context,
    );
    expectStatus(conflict, 409);

    mocks.activateCapa.mockRejectedValue(
      new mocks.CapaError("QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope"),
    );
    const missing = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "ACTIVATE" }),
      }),
      context,
    );
    expectStatus(missing, 404);
  });
});
