import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RootCauseAnalysisError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }

  return {
    authenticateRequest: vi.fn(),
    getRootCauseAnalysis: vi.fn(),
    listRootCauseTimeline: vi.fn(),
    saveRootCauseAnalysis: vi.fn(),
    transitionRootCauseAnalysis: vi.fn(),
    RootCauseAnalysisError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/root-cause", () => ({
  getRootCauseAnalysis: mocks.getRootCauseAnalysis,
  listRootCauseTimeline: mocks.listRootCauseTimeline,
  saveRootCauseAnalysis: mocks.saveRootCauseAnalysis,
  transitionRootCauseAnalysis: mocks.transitionRootCauseAnalysis,
  RootCauseAnalysisError: mocks.RootCauseAnalysisError,
}));

import { GET, PATCH, PUT } from "@/app/api/quality/events/[eventId]/root-cause/route";

function auth(role: "VIEWER" | "QUALITY_MANAGER") {
  return {
    session: { user: { id: role === "VIEWER" ? "viewer-1" : "quality-1" } },
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

const context = { params: Promise.resolve({ eventId: "event-1" }) };

function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  expect(response.status).toBe(status);
}

describe("quality root-cause API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRootCauseAnalysis.mockResolvedValue(null);
    mocks.listRootCauseTimeline.mockResolvedValue([]);
    mocks.saveRootCauseAnalysis.mockResolvedValue({ id: "event-1", status: "DRAFT" });
    mocks.transitionRootCauseAnalysis.mockResolvedValue({ id: "event-1", status: "COMPLETED" });
  });

  it("lets quality readers view root-cause analysis", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await GET(
      new Request("http://localhost/api/quality/events/event-1/root-cause?organizationId=org-a&siteId=site-a"),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.getRootCauseAnalysis).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
  });

  it("prevents read-only users from editing root-cause analysis", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await PUT(
      new Request("http://localhost/api/quality/events/event-1/root-cause", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          problemStatement: "Leakage",
          fiveWhys: ["Seal failed"],
        }),
      }),
      context,
    );

    expectStatus(response, 403);
    expect(mocks.saveRootCauseAnalysis).not.toHaveBeenCalled();
  });

  it("lets quality managers save structured 5 Why evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await PUT(
      new Request("http://localhost/api/quality/events/event-1/root-cause", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          problemStatement: "Leakage",
          fiveWhys: ["Seal failed", "Seal was damaged"],
          rootCauseConclusion: null,
        }),
      }),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.saveRootCauseAnalysis).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      problemStatement: "Leakage",
      fiveWhys: ["Seal failed", "Seal was damaged"],
      rootCauseConclusion: null,
      actorId: "quality-1",
    });
  });

  it("rejects more than five Why answers at the HTTP boundary", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await PUT(
      new Request("http://localhost/api/quality/events/event-1/root-cause", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          problemStatement: "Leakage",
          fiveWhys: ["1", "2", "3", "4", "5", "6"],
        }),
      }),
      context,
    );

    expectStatus(response, 400);
    expect(mocks.saveRootCauseAnalysis).not.toHaveBeenCalled();
  });

  it("lets quality managers complete the analysis through an explicit transition", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/root-cause", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "COMPLETE" }),
      }),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.transitionRootCauseAnalysis).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      action: "COMPLETE",
      actorId: "quality-1",
    });
  });

  it("maps incomplete 5 Why evidence to a conflict", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.transitionRootCauseAnalysis.mockRejectedValue(
      new mocks.RootCauseAnalysisError("FIVE_WHYS_INCOMPLETE", "All five Why answers are required"),
    );

    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/root-cause", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "COMPLETE" }),
      }),
      context,
    );

    expectStatus(response, 409);
  });
});
