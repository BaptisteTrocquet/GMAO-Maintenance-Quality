import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class QualityCapaError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    getCapaWorkspace: vi.fn(),
    listCapaTimeline: vi.fn(),
    saveCapaPlan: vi.fn(),
    activateCapa: vi.fn(),
    setCapaActionStatus: vi.fn(),
    startCapaVerification: vi.fn(),
    verifyCapaEffectiveness: vi.fn(),
    reopenIneffectiveCapa: vi.fn(),
    QualityCapaError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/capa", () => ({
  getCapaWorkspace: mocks.getCapaWorkspace,
  listCapaTimeline: mocks.listCapaTimeline,
  saveCapaPlan: mocks.saveCapaPlan,
  activateCapa: mocks.activateCapa,
  setCapaActionStatus: mocks.setCapaActionStatus,
  startCapaVerification: mocks.startCapaVerification,
  verifyCapaEffectiveness: mocks.verifyCapaEffectiveness,
  reopenIneffectiveCapa: mocks.reopenIneffectiveCapa,
  QualityCapaError: mocks.QualityCapaError,
}));

import { GET, PATCH, PUT } from "@/app/api/quality/events/[eventId]/capa/route";

function auth(role: "VIEWER" | "QUALITY_MANAGER" | "TECHNICIAN") {
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
const workspace = {
  event: {
    organizationId: "org-a",
    siteId: "site-a",
    eventNumber: "QE-0001",
    title: "Synthetic quality event",
    status: "INVESTIGATING",
  },
  capa: null,
};

describe("quality CAPA API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCapaWorkspace.mockResolvedValue(workspace);
    mocks.listCapaTimeline.mockResolvedValue([]);
    mocks.saveCapaPlan.mockResolvedValue({ eventId: "event-1", status: "DRAFT" });
    mocks.activateCapa.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
    mocks.setCapaActionStatus.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
    mocks.startCapaVerification.mockResolvedValue({ eventId: "event-1", status: "VERIFYING" });
    mocks.verifyCapaEffectiveness.mockResolvedValue({ eventId: "event-1", status: "EFFECTIVE" });
    mocks.reopenIneffectiveCapa.mockResolvedValue({ eventId: "event-1", status: "ACTIVE" });
  });

  it("lets viewers read the CAPA workspace", async () => {
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

  it("returns 404 when the quality event is outside scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    mocks.getCapaWorkspace.mockResolvedValue(null);
    const response = await GET(
      new Request("http://localhost/api/quality/events/event-1/capa?organizationId=org-a&siteId=site-a"),
      context,
    );
    expectStatus(response, 404);
    expect(mocks.listCapaTimeline).not.toHaveBeenCalled();
  });

  it("prevents technicians and viewers from saving CAPA", async () => {
    for (const role of ["TECHNICIAN", "VIEWER"] as const) {
      mocks.authenticateRequest.mockResolvedValue(auth(role));
      const response = await PUT(
        new Request("http://localhost/api/quality/events/event-1/capa", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-a",
            siteId: "site-a",
            actions: [],
            verificationPlan: { method: "", acceptanceCriteria: "" },
          }),
        }),
        context,
      );
      expectStatus(response, 403);
    }
    expect(mocks.saveCapaPlan).not.toHaveBeenCalled();
  });

  it("lets quality managers save corrective and preventive actions", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PUT(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          actions: [
            {
              type: "CORRECTIVE",
              title: "Correct synthetic cause",
              ownerId: "owner-1",
              dueAt: "2026-08-15T10:00:00.000Z",
            },
            {
              type: "PREVENTIVE",
              title: "Prevent synthetic recurrence",
              ownerId: "owner-2",
              dueAt: "2026-08-20T10:00:00.000Z",
            },
          ],
          verificationPlan: {
            method: "Review recurrence data",
            acceptanceCriteria: "No recurrence",
          },
        }),
      }),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.saveCapaPlan).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actions: [
        {
          type: "CORRECTIVE",
          title: "Correct synthetic cause",
          ownerId: "owner-1",
          dueAt: "2026-08-15T10:00:00.000Z",
        },
        {
          type: "PREVENTIVE",
          title: "Prevent synthetic recurrence",
          ownerId: "owner-2",
          dueAt: "2026-08-20T10:00:00.000Z",
        },
      ],
      verificationPlan: {
        method: "Review recurrence data",
        acceptanceCriteria: "No recurrence",
      },
      actorId: "quality-1",
    });
  });

  it("dispatches explicit CAPA transitions", async () => {
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
    expect(mocks.activateCapa).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    const complete = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SET_ACTION_STATUS",
          actionId: "action-1",
          status: "COMPLETED",
          completionNote: "Implemented",
        }),
      }),
      context,
    );
    expectStatus(complete, 200);
    expect(mocks.setCapaActionStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "action-1",
        status: "COMPLETED",
        completionNote: "Implemented",
      }),
    );

    const verify = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "VERIFY_EFFECTIVENESS",
          effective: true,
          result: "No recurrence",
        }),
      }),
      context,
    );
    expectStatus(verify, 200);
    expect(mocks.verifyCapaEffectiveness).toHaveBeenCalledWith(
      expect.objectContaining({ effective: true, result: "No recurrence" }),
    );
  });

  it("rejects malformed JSON before authentication", async () => {
    const response = await PUT(
      new Request("http://localhost/api/quality/events/event-1/capa", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{broken-json",
      }),
      context,
    );
    expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.saveCapaPlan).not.toHaveBeenCalled();
  });
});
