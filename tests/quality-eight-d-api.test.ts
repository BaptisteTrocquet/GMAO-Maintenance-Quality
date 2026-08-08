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
    resetEightDAfterIneffectiveCapa: vi.fn(),
    EightDError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/eight-d", () => ({
  getEightDWorkspace: mocks.getEightDWorkspace,
  listEightDTimeline: mocks.listEightDTimeline,
  saveEightDWorkspace: mocks.saveEightDWorkspace,
  advanceEightD: mocks.advanceEightD,
  resetEightDAfterIneffectiveCapa: mocks.resetEightDAfterIneffectiveCapa,
  EightDError: mocks.EightDError,
}));

import { GET, PATCH, PUT } from "@/app/api/quality/events/[eventId]/eight-d/route";

const context = { params: Promise.resolve({ eventId: "event-1" }) };

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

function expectResponse(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  expect(response.status).toBe(status);
  return response;
}

describe("quality 8D API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEightDWorkspace.mockResolvedValue({ event: { status: "INVESTIGATING" }, eightD: null, capa: null });
    mocks.listEightDTimeline.mockResolvedValue([]);
    mocks.saveEightDWorkspace.mockResolvedValue({ eventId: "event-1", currentDiscipline: "D1" });
    mocks.advanceEightD.mockResolvedValue({ eventId: "event-1", currentDiscipline: "D2" });
    mocks.resetEightDAfterIneffectiveCapa.mockResolvedValue({ eventId: "event-1", currentDiscipline: "D5" });
  });

  it("lets viewers read the 8D workspace", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const response = await GET(
      new Request("http://localhost/api/quality/events/event-1/eight-d?organizationId=org-a&siteId=site-a"),
      context,
    );
    expectResponse(response, 200);
  });

  it("rejects 8D mutations without quality:manage", async () => {
    for (const role of ["VIEWER", "TECHNICIAN"] as const) {
      mocks.authenticateRequest.mockResolvedValue(auth(role));
      const response = await PUT(
        new Request("http://localhost/api/quality/events/event-1/eight-d", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", problemStatement: "Synthetic issue" }),
        }),
        context,
      );
      expectResponse(response, 403);
    }
    expect(mocks.saveEightDWorkspace).not.toHaveBeenCalled();
  });

  it("saves only D1 fields while a new 8D is on D1", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PUT(
      new Request("http://localhost/api/quality/events/event-1/eight-d", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          team: [{ userId: "user-1", responsibility: "8D lead" }],
          problemStatement: "Must not pre-edit D2.",
          escapePoint: "Must not pre-edit D4.",
        }),
      }),
      context,
    );
    expectResponse(response, 200);
    expect(mocks.saveEightDWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      team: [{ userId: "user-1", responsibility: "8D lead" }],
      actorId: "quality-1",
    });
  });

  it("does not let a later discipline rewrite frozen historical fields", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.getEightDWorkspace.mockResolvedValue({
      event: { status: "INVESTIGATING" },
      eightD: { currentDiscipline: "D6", status: "IN_PROGRESS" },
      capa: { status: "ACTIVE" },
    });
    mocks.saveEightDWorkspace.mockResolvedValue({ eventId: "event-1", currentDiscipline: "D6" });

    const response = await PUT(
      new Request("http://localhost/api/quality/events/event-1/eight-d", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          team: [{ userId: "attacker", responsibility: "Rewrite D1" }],
          problemStatement: "Rewrite D2",
          escapePoint: "Rewrite D4",
          validationNote: "Three objective verification runs passed.",
          preventionSummary: "Pre-edit D7",
          recognitionNote: "Pre-edit D8",
        }),
      }),
      context,
    );

    expectResponse(response, 200);
    expect(mocks.saveEightDWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      validationNote: "Three objective verification runs passed.",
      actorId: "quality-1",
    });
  });

  it("routes ADVANCE and ineffective-CAPA reset explicitly", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const advance = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/eight-d", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "ADVANCE" }),
      }),
      context,
    );
    expectResponse(advance, 200);
    expect(mocks.advanceEightD).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    const reset = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/eight-d", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "RESET_AFTER_INEFFECTIVE_CAPA",
        }),
      }),
      context,
    );
    expectResponse(reset, 200);
    expect(mocks.resetEightDAfterIneffectiveCapa).toHaveBeenCalledTimes(1);
  });

  it("maps sequential workflow conflicts to 409", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.advanceEightD.mockRejectedValue(new mocks.EightDError("ROOT_CAUSE_REQUIRED", "Confirm RCA first"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/eight-d", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "ADVANCE" }),
      }),
      context,
    );
    expectResponse(response, 409);
  });
});
