import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class QualityEventError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    getCapaWorkspace: vi.fn(),
    getQualityEvent: vi.fn(),
    listQualityEventTimeline: vi.fn(),
    setImmediateContainment: vi.fn(),
    transitionQualityEvent: vi.fn(),
    QualityEventError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/capa", () => ({ getCapaWorkspace: mocks.getCapaWorkspace }));
vi.mock("@/lib/quality/events", () => ({
  getQualityEvent: mocks.getQualityEvent,
  listQualityEventTimeline: mocks.listQualityEventTimeline,
  setImmediateContainment: mocks.setImmediateContainment,
  transitionQualityEvent: mocks.transitionQualityEvent,
  QualityEventError: mocks.QualityEventError,
}));

import { PATCH } from "@/app/api/quality/events/[eventId]/route";

const context = { params: Promise.resolve({ eventId: "event-1" }) };

function auth() {
  return {
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
}

function expectResponse(response: Response | undefined) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  return response;
}

function closeRequest() {
  return new Request("http://localhost/api/quality/events/event-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      action: "CLOSE",
      resolutionSummary: "Synthetic issue resolved.",
    }),
  });
}

describe("quality event CAPA closure gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.transitionQualityEvent.mockResolvedValue({ id: "event-1", status: "CLOSED" });
  });

  it("blocks quality-event closure while CAPA is still active", async () => {
    mocks.getCapaWorkspace.mockResolvedValue({
      event: { organizationId: "org-a", siteId: "site-a" },
      rootCause: { status: "CONFIRMED" },
      capa: { status: "ACTIVE" },
    });

    const response = expectResponse(await PATCH(closeRequest(), context));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CAPA_INCOMPLETE" },
    });
    expect(mocks.transitionQualityEvent).not.toHaveBeenCalled();
  });

  it("allows closure after CAPA effectiveness is confirmed", async () => {
    mocks.getCapaWorkspace.mockResolvedValue({
      event: { organizationId: "org-a", siteId: "site-a" },
      rootCause: { status: "CONFIRMED" },
      capa: { status: "CLOSED" },
    });

    const response = expectResponse(await PATCH(closeRequest(), context));

    expect(response.status).toBe(200);
    expect(mocks.transitionQualityEvent).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      action: "CLOSE",
      resolutionSummary: "Synthetic issue resolved.",
      actorId: "quality-1",
    });
  });

  it("preserves existing closure behavior when no CAPA exists", async () => {
    mocks.getCapaWorkspace.mockResolvedValue({
      event: { organizationId: "org-a", siteId: "site-a" },
      rootCause: null,
      capa: null,
    });

    const response = expectResponse(await PATCH(closeRequest(), context));

    expect(response.status).toBe(200);
    expect(mocks.transitionQualityEvent).toHaveBeenCalledTimes(1);
  });
});
