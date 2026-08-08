import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CapaEffectivenessError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    getCapa: vi.fn(),
    getCapaEffectiveness: vi.fn(),
    listCapaEffectivenessTimeline: vi.fn(),
    startCapaEffectivenessReview: vi.fn(),
    verifyCapaEffectiveness: vi.fn(),
    CapaEffectivenessError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/capa", () => ({ getCapa: mocks.getCapa }));
vi.mock("@/lib/quality/effectiveness", () => ({
  getCapaEffectiveness: mocks.getCapaEffectiveness,
  listCapaEffectivenessTimeline: mocks.listCapaEffectivenessTimeline,
  startCapaEffectivenessReview: mocks.startCapaEffectivenessReview,
  verifyCapaEffectiveness: mocks.verifyCapaEffectiveness,
  CapaEffectivenessError: mocks.CapaEffectivenessError,
}));

import { GET, PATCH } from "@/app/api/quality/events/[eventId]/capa/effectiveness/route";

function auth(role: "VIEWER" | "QUALITY_MANAGER" | "TECHNICIAN") {
  return {
    session: {
      user: { id: role === "QUALITY_MANAGER" ? "quality-4" : role === "VIEWER" ? "viewer-1" : "tech-1" },
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

function readyCapa(actionStatus: "COMPLETED" | "CANCELLED" = "COMPLETED") {
  return {
    event: { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" },
    capa: {
      eventId: "event-1",
      status: "READY_FOR_EFFECTIVENESS",
      actions: [{ id: "action-1", status: actionStatus }],
    },
  };
}

describe("CAPA effectiveness API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCapa.mockResolvedValue(readyCapa());
    mocks.getCapaEffectiveness.mockResolvedValue(null);
    mocks.listCapaEffectivenessTimeline.mockResolvedValue([]);
    mocks.startCapaEffectivenessReview.mockResolvedValue({
      eventId: "event-1",
      status: "PENDING",
      verifierId: "quality-4",
    });
    mocks.verifyCapaEffectiveness.mockResolvedValue({
      eventId: "event-1",
      status: "VERIFIED",
      result: "EFFECTIVE",
    });
  });

  it("lets viewers read a valid CAPA with no effectiveness review started", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const response = await GET(
      new Request("http://localhost/api/quality/events/event-1/capa/effectiveness?organizationId=org-a&siteId=site-a"),
      context,
    );
    expectStatus(response, 200);
    const body = await response!.json();
    expect(body.data.effectiveness).toBeNull();
  });

  it("prevents viewers and technicians from managing effectiveness", async () => {
    for (const role of ["VIEWER", "TECHNICIAN"] as const) {
      mocks.authenticateRequest.mockResolvedValue(auth(role));
      const response = await PATCH(
        new Request("http://localhost/api/quality/events/event-1/capa/effectiveness", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-a",
            siteId: "site-a",
            action: "VERIFY",
            result: "EFFECTIVE",
            summary: "Synthetic verification",
          }),
        }),
        context,
      );
      expectStatus(response, 403);
    }
    expect(mocks.verifyCapaEffectiveness).not.toHaveBeenCalled();
  });

  it("lets quality managers start a controlled effectiveness review", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa/effectiveness", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "START",
          criteria: "No synthetic recurrence during observation.",
          verifierId: "quality-4",
          dueAt: "2026-09-01T00:00:00.000Z",
        }),
      }),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.startCapaEffectivenessReview).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      criteria: "No synthetic recurrence during observation.",
      verifierId: "quality-4",
      dueAt: new Date("2026-09-01T00:00:00.000Z"),
      actorId: "quality-4",
    });
  });

  it("blocks effectiveness when every CAPA action was cancelled", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.getCapa.mockResolvedValue(readyCapa("CANCELLED"));

    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa/effectiveness", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "START",
          criteria: "No recurrence during observation.",
          verifierId: "quality-4",
          dueAt: "2026-09-01T00:00:00.000Z",
        }),
      }),
      context,
    );

    expectStatus(response, 409);
    const body = await response!.json();
    expect(body.error.code).toBe("COMPLETED_ACTION_REQUIRED");
    expect(mocks.startCapaEffectivenessReview).not.toHaveBeenCalled();
  });

  it("routes effectiveness results with an explicit summary", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa/effectiveness", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "VERIFY",
          result: "INEFFECTIVE",
          summary: "Synthetic recurrence observed.",
        }),
      }),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.verifyCapaEffectiveness).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      result: "INEFFECTIVE",
      summary: "Synthetic recurrence observed.",
      actorId: "quality-4",
    });
  });

  it("rejects malformed JSON before authentication", async () => {
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa/effectiveness", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{invalid-json",
      }),
      context,
    );
    expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
