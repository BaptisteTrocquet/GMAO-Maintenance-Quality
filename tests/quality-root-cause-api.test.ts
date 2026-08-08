import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RootCauseError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    getRootCauseWorkspace: vi.fn(),
    listRootCauseTimeline: vi.fn(),
    saveRootCauseWorkspace: vi.fn(),
    confirmRootCauseWorkspace: vi.fn(),
    reopenRootCauseWorkspace: vi.fn(),
    RootCauseError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/root-cause", () => ({
  getRootCauseWorkspace: mocks.getRootCauseWorkspace,
  listRootCauseTimeline: mocks.listRootCauseTimeline,
  saveRootCauseWorkspace: mocks.saveRootCauseWorkspace,
  confirmRootCauseWorkspace: mocks.confirmRootCauseWorkspace,
  reopenRootCauseWorkspace: mocks.reopenRootCauseWorkspace,
  RootCauseError: mocks.RootCauseError,
}));

import { GET, PATCH } from "@/app/api/quality/events/[eventId]/root-cause/route";

function auth(role: "VIEWER" | "QUALITY_MANAGER" | "TECHNICIAN", allSites = true) {
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
        allSites,
        siteIds: allSites ? [] : ["site-a"],
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

describe("quality root-cause API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRootCauseWorkspace.mockResolvedValue({
      event: { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" },
      rootCause: null,
    });
    mocks.listRootCauseTimeline.mockResolvedValue([]);
    mocks.saveRootCauseWorkspace.mockResolvedValue({ eventId: "event-1", status: "DRAFT" });
    mocks.confirmRootCauseWorkspace.mockResolvedValue({ eventId: "event-1", status: "CONFIRMED" });
    mocks.reopenRootCauseWorkspace.mockResolvedValue({ eventId: "event-1", status: "DRAFT" });
  });

  it("lets viewers read the RCA workspace inside their site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await GET(
      new Request(
        "http://localhost/api/quality/events/event-1/root-cause?organizationId=org-a&siteId=site-a",
      ),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.getRootCauseWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
  });

  it("prevents viewers and technicians from editing root-cause analysis", async () => {
    for (const role of ["VIEWER", "TECHNICIAN"] as const) {
      mocks.authenticateRequest.mockResolvedValue(auth(role));
      const response = await PATCH(
        new Request("http://localhost/api/quality/events/event-1/root-cause", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-a",
            siteId: "site-a",
            action: "CONFIRM",
          }),
        }),
        context,
      );
      expectStatus(response, 403);
    }
    expect(mocks.confirmRootCauseWorkspace).not.toHaveBeenCalled();
  });

  it("lets quality managers save combined 5 Why and Ishikawa data", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/root-cause", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SAVE",
          method: "COMBINED",
          problemStatement: "Synthetic recurring defect",
          fiveWhys: [{ sequence: 1, prompt: "Why?", answer: "Synthetic answer" }],
          ishikawa: [{ category: "METHOD", cause: "Synthetic method cause" }],
          rootCauseSummary: "Synthetic root cause",
        }),
      }),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.saveRootCauseWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      method: "COMBINED",
      problemStatement: "Synthetic recurring defect",
      fiveWhys: [{ sequence: 1, prompt: "Why?", answer: "Synthetic answer" }],
      ishikawa: [{ category: "METHOD", cause: "Synthetic method cause", evidence: null }],
      rootCauseSummary: "Synthetic root cause",
      actorId: "quality-1",
    });
  });

  it("routes confirmation and reopening through explicit actions", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const confirm = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/root-cause", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "CONFIRM" }),
      }),
      context,
    );
    expectStatus(confirm, 200);
    expect(mocks.confirmRootCauseWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    const reopen = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/root-cause", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "REOPEN" }),
      }),
      context,
    );
    expectStatus(reopen, 200);
    expect(mocks.reopenRootCauseWorkspace).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
  });

  it("rejects unsupported Ishikawa categories before calling the service", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/root-cause", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SAVE",
          method: "ISHIKAWA",
          problemStatement: "Synthetic defect",
          ishikawa: [{ category: "UNCONTROLLED", cause: "Synthetic cause" }],
        }),
      }),
      context,
    );

    expectStatus(response, 400);
    expect(mocks.saveRootCauseWorkspace).not.toHaveBeenCalled();
  });

  it("maps a missing quality event to a tenant-safe 404", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.confirmRootCauseWorkspace.mockRejectedValue(
      new mocks.RootCauseError("QUALITY_EVENT_NOT_FOUND", "Quality event not found in site scope"),
    );

    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/root-cause", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", action: "CONFIRM" }),
      }),
      context,
    );

    expectStatus(response, 404);
  });
});
