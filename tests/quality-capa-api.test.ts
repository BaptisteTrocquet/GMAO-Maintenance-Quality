import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CapaError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    getCapa: vi.fn(),
    listCapaTimeline: vi.fn(),
    saveCapaDraft: vi.fn(),
    activateCapa: vi.fn(),
    transitionCapaAction: vi.fn(),
    markCapaReadyForEffectiveness: vi.fn(),
    CapaError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/capa", () => ({
  getCapa: mocks.getCapa,
  listCapaTimeline: mocks.listCapaTimeline,
  saveCapaDraft: mocks.saveCapaDraft,
  activateCapa: mocks.activateCapa,
  transitionCapaAction: mocks.transitionCapaAction,
  markCapaReadyForEffectiveness: mocks.markCapaReadyForEffectiveness,
  CapaError: mocks.CapaError,
}));

import { GET, PATCH } from "@/app/api/quality/events/[eventId]/capa/route";

function auth(role: "VIEWER" | "QUALITY_MANAGER" | "TECHNICIAN") {
  return {
    session: {
      user: { id: role === "QUALITY_MANAGER" ? "quality-1" : role === "VIEWER" ? "viewer-1" : "tech-1" },
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

const context = { params: Promise.resolve({ eventId: "event-1" }) };

describe("quality CAPA API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCapa.mockResolvedValue({
      event: { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" },
      capa: null,
    });
    mocks.listCapaTimeline.mockResolvedValue([]);
    mocks.saveCapaDraft.mockResolvedValue({ eventId: "event-1", status: "DRAFT" });
    mocks.activateCapa.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
    mocks.transitionCapaAction.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
    mocks.markCapaReadyForEffectiveness.mockResolvedValue({
      eventId: "event-1",
      status: "READY_FOR_EFFECTIVENESS",
    });
  });

  it("lets viewers read CAPA in site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const response = await GET(
      new Request("http://localhost/api/quality/events/event-1/capa?organizationId=org-a&siteId=site-a"),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.getCapa).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
  });

  it("prevents viewers and technicians from managing CAPA", async () => {
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

  it("lets quality managers save CAPA actions with owners and due dates", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SAVE",
          objective: "Prevent synthetic recurrence",
          actions: [
            {
              actionKey: "corrective-1",
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
    expect(mocks.saveCapaDraft).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      objective: "Prevent synthetic recurrence",
      actions: [
        {
          actionKey: "corrective-1",
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

  it("routes activation and action completion explicitly", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const activate = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "ACTIVATE" }),
      }),
      context,
    );
    expectStatus(activate, 200);
    expect(mocks.activateCapa).toHaveBeenCalled();

    const complete = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "TRANSITION_ACTION",
          actionId: "action-1",
          transition: "COMPLETE",
          completionNote: "Synthetic completion evidence",
        }),
      }),
      context,
    );
    expectStatus(complete, 200);
    expect(mocks.transitionCapaAction).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actionId: "action-1",
      transition: "COMPLETE",
      completionNote: "Synthetic completion evidence",
      actorId: "quality-1",
    });
  });

  it("routes readiness for effectiveness as an explicit workflow step", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "READY_FOR_EFFECTIVENESS",
        }),
      }),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.markCapaReadyForEffectiveness).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
  });

  it("rejects malformed action data before calling the service", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SAVE",
          objective: "Synthetic objective",
          actions: [{ actionKey: "a", type: "CORRECTIVE", title: "x" }],
        }),
      }),
      context,
    );
    expectStatus(response, 400);
    expect(mocks.saveCapaDraft).not.toHaveBeenCalled();
  });
});
