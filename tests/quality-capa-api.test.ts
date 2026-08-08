import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CapaError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  class CapaOwnerScopeError extends Error {
    constructor(message: string) {
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
    assertCapaOwnersInSite: vi.fn(),
    CapaError,
    CapaOwnerScopeError,
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
vi.mock("@/lib/quality/capa-owner-scope", () => ({
  assertCapaOwnersInSite: mocks.assertCapaOwnersInSite,
  CapaOwnerScopeError: mocks.CapaOwnerScopeError,
}));

import { GET, PATCH } from "@/app/api/quality/events/[eventId]/capa/route";

function auth(role: "VIEWER" | "QUALITY_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "QUALITY_MANAGER" ? "quality-1" : "user-1" } },
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
    mocks.assertCapaOwnersInSite.mockResolvedValue(undefined);
    mocks.getCapaWorkspace.mockResolvedValue({
      event: { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" },
      rootCauseConfirmed: true,
      capa: null,
    });
    mocks.listCapaTimeline.mockResolvedValue([]);
    mocks.saveCapaWorkspace.mockResolvedValue({ eventId: "event-1", status: "DRAFT" });
    mocks.activateCapa.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
    mocks.transitionCapaAction.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
    mocks.submitEffectivenessReview.mockResolvedValue({ eventId: "event-1", status: "EFFECTIVENESS_REVIEW" });
    mocks.verifyCapaEffectiveness.mockResolvedValue({ eventId: "event-1", status: "CLOSED" });
  });

  it("lets viewers read CAPA in their site scope", async () => {
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
          body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "ACTIVATE" }),
        }),
        context,
      );
      expectStatus(response, 403);
    }
    expect(mocks.activateCapa).not.toHaveBeenCalled();
  });

  it("routes CAPA save only after action owners are validated in the selected site", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SAVE",
          objective: "Prevent recurrence",
          actions: [
            {
              id: "action-1",
              type: "CORRECTIVE",
              title: "Replace seal",
              description: null,
              ownerId: "owner-1",
              dueAt: "2026-09-01T12:00:00.000Z",
            },
          ],
        }),
      }),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.assertCapaOwnersInSite).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      ownerIds: ["owner-1"],
    });
    expect(mocks.saveCapaWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      objective: "Prevent recurrence",
      actions: [
        {
          id: "action-1",
          type: "CORRECTIVE",
          title: "Replace seal",
          description: null,
          ownerId: "owner-1",
          dueAt: new Date("2026-09-01T12:00:00.000Z"),
        },
      ],
      actorId: "quality-1",
    });
  });

  it("rejects CAPA owners outside the selected site before the workflow service runs", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.assertCapaOwnersInSite.mockRejectedValue(
      new mocks.CapaOwnerScopeError("Every CAPA owner must be an active member of the selected site"),
    );

    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SAVE",
          objective: "Prevent recurrence",
          actions: [
            {
              id: "action-1",
              type: "CORRECTIVE",
              title: "Replace seal",
              ownerId: "owner-other-site",
              dueAt: "2026-09-01T12:00:00.000Z",
            },
          ],
        }),
      }),
      context,
    );

    expectStatus(response, 404);
    expect(mocks.saveCapaWorkspace).not.toHaveBeenCalled();
  });

  it("routes action completion with required evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "TRANSITION_ACTION",
          actionId: "action-1",
          status: "COMPLETED",
          evidence: "Verified work record",
        }),
      }),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.transitionCapaAction).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actionId: "action-1",
      status: "COMPLETED",
      evidence: "Verified work record",
      actorId: "quality-1",
    });
  });

  it("routes effectiveness planning and verification through explicit actions", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const submit = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SUBMIT_EFFECTIVENESS",
          method: "Review recurrence trend",
          ownerId: "reviewer-1",
          dueAt: "2026-10-01T12:00:00.000Z",
        }),
      }),
      context,
    );
    expectStatus(submit, 200);
    expect(mocks.assertCapaOwnersInSite).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      ownerIds: ["reviewer-1"],
    });
    expect(mocks.submitEffectivenessReview).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      method: "Review recurrence trend",
      ownerId: "reviewer-1",
      dueAt: new Date("2026-10-01T12:00:00.000Z"),
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
          evidence: "No recurrence in verification window",
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
      evidence: "No recurrence in verification window",
      actorId: "quality-1",
    });
  });

  it("maps workflow conflicts to 409 without leaking tenant data", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.activateCapa.mockRejectedValue(
      new mocks.CapaError("ROOT_CAUSE_CONFIRMATION_REQUIRED", "Confirm root-cause analysis before activating CAPA"),
    );
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "ACTIVATE" }),
      }),
      context,
    );
    expectStatus(response, 409);
  });
});
