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
    saveEightDWorkspace: vi.fn(),
    advanceEightD: vi.fn(),
    EightDError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/eight-d", () => ({
  getEightDWorkspace: mocks.getEightDWorkspace,
  listEightDTimeline: mocks.listEightDTimeline,
  saveEightDWorkspace: mocks.saveEightDWorkspace,
  advanceEightD: mocks.advanceEightD,
  EightDError: mocks.EightDError,
}));

import { GET, PATCH, PUT } from "@/app/api/quality/events/[eventId]/eight-d/route";

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

function requireResponse(response: Response | undefined) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  return response;
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
  eightD: null,
};

describe("quality 8D API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEightDWorkspace.mockResolvedValue(workspace);
    mocks.listEightDTimeline.mockResolvedValue([]);
    mocks.saveEightDWorkspace.mockResolvedValue({
      eventId: "event-1",
      status: "DRAFT",
      currentDiscipline: "D1",
    });
    mocks.advanceEightD.mockResolvedValue({
      eventId: "event-1",
      status: "IN_PROGRESS",
      currentDiscipline: "D2",
    });
  });

  it("lets viewers read the 8D workspace", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const response = requireResponse(
      await GET(
        new Request("http://localhost/api/quality/events/event-1/eight-d?organizationId=org-a&siteId=site-a"),
        context,
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.getEightDWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
  });

  it("prevents viewers and technicians from editing 8D", async () => {
    for (const role of ["VIEWER", "TECHNICIAN"] as const) {
      mocks.authenticateRequest.mockResolvedValue(auth(role));
      const response = requireResponse(
        await PUT(
          new Request("http://localhost/api/quality/events/event-1/eight-d", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              organizationId: "org-a",
              siteId: "site-a",
              problemStatement: "Synthetic problem",
            }),
          }),
          context,
        ),
      );
      expect(response.status).toBe(403);
    }
    expect(mocks.saveEightDWorkspace).not.toHaveBeenCalled();
  });

  it("lets quality managers save D1/D2/D7/D8 workspace data", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = requireResponse(
      await PUT(
        new Request("http://localhost/api/quality/events/event-1/eight-d", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-a",
            siteId: "site-a",
            team: [{ userId: "quality-1", responsibility: "Lead 8D" }],
            problemStatement: "Synthetic problem",
            preventionSummary: "Prevent recurrence",
            systemicChanges: ["Update generic procedure"],
            recognitionNote: "Recognize the synthetic team",
          }),
        }),
        context,
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.saveEightDWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      team: [{ userId: "quality-1", responsibility: "Lead 8D" }],
      problemStatement: "Synthetic problem",
      preventionSummary: "Prevent recurrence",
      systemicChanges: ["Update generic procedure"],
      recognitionNote: "Recognize the synthetic team",
      actorId: "quality-1",
    });
  });

  it("advances only through the gated service transition", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = requireResponse(
      await PATCH(
        new Request("http://localhost/api/quality/events/event-1/eight-d", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "ADVANCE" }),
        }),
        context,
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.advanceEightD).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
  });

  it("maps discipline gate failures to conflict responses", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.advanceEightD.mockRejectedValue(
      new mocks.EightDError("ROOT_CAUSE_REQUIRED", "D4 requires confirmed root-cause analysis"),
    );
    const response = requireResponse(
      await PATCH(
        new Request("http://localhost/api/quality/events/event-1/eight-d", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "ADVANCE" }),
        }),
        context,
      ),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "ROOT_CAUSE_REQUIRED" },
    });
  });

  it("rejects malformed JSON before authentication", async () => {
    const response = requireResponse(
      await PUT(
        new Request("http://localhost/api/quality/events/event-1/eight-d", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: "{broken-json",
        }),
        context,
      ),
    );
    expect(response.status).toBe(400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
  });
});
