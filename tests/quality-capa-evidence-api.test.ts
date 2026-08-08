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

import { PATCH } from "@/app/api/quality/events/[eventId]/capa/route";

const context = { params: Promise.resolve({ eventId: "event-1" }) };
const auth = {
  session: { user: { id: "quality-1" } },
  tenant: {
    scope: {
      organizationId: "org-a",
      role: "QUALITY_MANAGER" as const,
      allSites: true,
      siteIds: [],
      active: true,
    },
  },
};

function request(completionNote?: string | null) {
  return new Request("http://localhost/api/quality/events/event-1/capa", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      action: "SET_ACTION_STATUS",
      actionId: "action-1",
      status: "COMPLETED",
      completionNote,
    }),
  });
}

describe("CAPA action completion evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.setCapaActionStatus.mockResolvedValue({
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      status: "ACTIVE",
    });
  });

  it("rejects completion without evidence", async () => {
    const response = await PATCH(request(null), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "CAPA_ACTION_EVIDENCE_REQUIRED" },
    });
    expect(mocks.setCapaActionStatus).not.toHaveBeenCalled();
  });

  it("records completion when evidence is supplied", async () => {
    const response = await PATCH(request("Implemented change and attached verification record reference."), context);

    expect(response.status).toBe(200);
    expect(mocks.setCapaActionStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "event-1",
        actionId: "action-1",
        status: "COMPLETED",
        completionNote: "Implemented change and attached verification record reference.",
        actorId: "quality-1",
      }),
    );
  });
});
