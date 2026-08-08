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

import { PUT } from "@/app/api/quality/events/[eventId]/capa/route";

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

const completedAction = {
  id: "action-1",
  type: "CORRECTIVE" as const,
  title: "Correct synthetic cause",
  description: "Synthetic detail",
  ownerId: "owner-1",
  ownerName: "Synthetic Owner",
  dueAt: "2026-08-15T10:00:00.000Z",
  status: "COMPLETED" as const,
  completedAt: "2026-08-12T10:00:00.000Z",
  completionNote: "Implemented",
};

const activeCapa = {
  eventId: "event-1",
  organizationId: "org-a",
  siteId: "site-a",
  eventNumber: "QE-0001",
  eventTitle: "Synthetic quality event",
  rootCauseSummary: "Synthetic root cause",
  status: "ACTIVE" as const,
  actions: [completedAction],
  verificationPlan: { method: "Review", acceptanceCriteria: "No recurrence" },
  effectiveness: null,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-12T10:00:00.000Z",
  activatedAt: "2026-08-09T10:00:00.000Z",
  verificationStartedAt: null,
};

function request(actions: unknown[]) {
  return new Request("http://localhost/api/quality/events/event-1/capa", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      actions,
      verificationPlan: { method: "Review", acceptanceCriteria: "No recurrence" },
    }),
  });
}

function requireResponse(response: Response | undefined) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  return response;
}

describe("activated CAPA action integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth);
    mocks.getCapaWorkspace.mockResolvedValue({
      event: {
        organizationId: "org-a",
        siteId: "site-a",
        eventNumber: "QE-0001",
        title: "Synthetic quality event",
        status: "INVESTIGATING",
      },
      capa: activeCapa,
    });
    mocks.saveCapaPlan.mockResolvedValue(activeCapa);
  });

  it("rejects silent removal of an action after CAPA activation", async () => {
    const response = requireResponse(await PUT(request([]), context));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "CAPA_ACTION_REMOVAL_FORBIDDEN" },
    });
    expect(mocks.saveCapaPlan).not.toHaveBeenCalled();
  });

  it("rejects rewriting a completed action definition", async () => {
    const response = requireResponse(
      await PUT(
        request([
          {
            id: "action-1",
            type: "CORRECTIVE",
            title: "Rewrite completed action",
            description: "Synthetic detail",
            ownerId: "owner-1",
            dueAt: "2026-08-15T10:00:00.000Z",
          },
        ]),
        context,
      ),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "COMPLETED_CAPA_ACTION_IMMUTABLE" },
    });
    expect(mocks.saveCapaPlan).not.toHaveBeenCalled();
  });

  it("allows the unchanged completed action to remain in an active plan", async () => {
    const response = requireResponse(
      await PUT(
        request([
          {
            id: completedAction.id,
            type: completedAction.type,
            title: completedAction.title,
            description: completedAction.description,
            ownerId: completedAction.ownerId,
            dueAt: completedAction.dueAt,
          },
        ]),
        context,
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.saveCapaPlan).toHaveBeenCalledTimes(1);
  });
});
