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

import { GET, PATCH, PUT } from "@/app/api/quality/events/[eventId]/8d/route";

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

describe("quality 8D API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEightDWorkspace.mockResolvedValue({
      event: { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" },
      eightD: null,
    });
    mocks.listEightDTimeline.mockResolvedValue([]);
    mocks.saveEightDWorkspace.mockResolvedValue({ eventId: "event-1", currentDiscipline: "D1" });
    mocks.advanceEightD.mockResolvedValue({ eventId: "event-1", currentDiscipline: "D2" });
  });

  it("lets quality readers view an 8D workspace", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    const response = await GET(
      new Request("http://localhost/api/quality/events/event-1/8d?organizationId=org-a&siteId=site-a"),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.getEightDWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
  });

  it("prevents viewers and technicians from mutating 8D", async () => {
    for (const role of ["VIEWER", "TECHNICIAN"] as const) {
      mocks.authenticateRequest.mockResolvedValue(auth(role));
      const response = await PUT(
        new Request("http://localhost/api/quality/events/event-1/8d", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-a",
            siteId: "site-a",
            problemStatement: "Synthetic problem",
          }),
        }),
        context,
      );
      expectStatus(response, 403);
    }
    expect(mocks.saveEightDWorkspace).not.toHaveBeenCalled();
  });

  it("lets quality managers save D1/D2/D7/D8 editable evidence", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PUT(
      new Request("http://localhost/api/quality/events/event-1/8d", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          team: [{ userId: "quality-1", responsibility: "Lead 8D" }],
          problemStatement: "Leakage recurred after startup",
          preventionSummary: "Standardize point-of-use instructions",
          systemicChanges: ["Add document check to maintenance release"],
          recognitionNote: "Recognize the cross-functional team",
        }),
      }),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.saveEightDWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      team: [{ userId: "quality-1", responsibility: "Lead 8D" }],
      problemStatement: "Leakage recurred after startup",
      preventionSummary: "Standardize point-of-use instructions",
      systemicChanges: ["Add document check to maintenance release"],
      recognitionNote: "Recognize the cross-functional team",
      actorId: "quality-1",
    });
  });

  it("advances only through the explicit ADVANCE transition", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/8d", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "ADVANCE" }),
      }),
      context,
    );
    expectStatus(response, 200);
    expect(mocks.advanceEightD).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
  });

  it("maps discipline prerequisites to workflow conflicts", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.advanceEightD.mockRejectedValue(
      new mocks.EightDError("CAPA_ACTIONS_INCOMPLETE", "D6 requires implementation evidence"),
    );
    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/8d", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "ADVANCE" }),
      }),
      context,
    );
    expectStatus(response, 409);
  });

  it("returns 404 for an event outside the requested site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));
    mocks.getEightDWorkspace.mockResolvedValue(null);
    const response = await GET(
      new Request("http://localhost/api/quality/events/event-1/8d?organizationId=org-a&siteId=site-a"),
      context,
    );
    expectStatus(response, 404);
  });
});
