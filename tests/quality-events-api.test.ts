import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class QualityEventError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    queryQualityEvents: vi.fn(),
    createQualityEvent: vi.fn(),
    getQualityEvent: vi.fn(),
    listQualityEventTimeline: vi.fn(),
    updateQualityEvent: vi.fn(),
    startOrUpdateContainment: vi.fn(),
    completeContainment: vi.fn(),
    QualityEventError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/queries", () => ({ queryQualityEvents: mocks.queryQualityEvents }));
vi.mock("@/lib/quality/events", () => ({
  createQualityEvent: mocks.createQualityEvent,
  getQualityEvent: mocks.getQualityEvent,
  listQualityEventTimeline: mocks.listQualityEventTimeline,
  updateQualityEvent: mocks.updateQualityEvent,
  startOrUpdateContainment: mocks.startOrUpdateContainment,
  completeContainment: mocks.completeContainment,
  QualityEventError: mocks.QualityEventError,
}));

import { GET as listEvents, POST as createEvent } from "@/app/api/quality/events/route";
import { GET as getEvent, PATCH as patchEvent } from "@/app/api/quality/events/[eventId]/route";

function auth(role: "VIEWER" | "QUALITY_MANAGER", allSites = true) {
  return {
    session: { user: { id: role === "VIEWER" ? "viewer-1" : "quality-1" } },
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

const eventContext = { params: Promise.resolve({ eventId: "event-1" }) };

describe("quality event APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryQualityEvents.mockResolvedValue([]);
    mocks.createQualityEvent.mockResolvedValue({
      idempotent: false,
      qualityEvent: { id: "event-1", status: "OPEN" },
    });
    mocks.getQualityEvent.mockResolvedValue({ id: "event-1", status: "OPEN" });
    mocks.listQualityEventTimeline.mockResolvedValue([]);
    mocks.updateQualityEvent.mockResolvedValue({ id: "event-1", status: "OPEN" });
    mocks.startOrUpdateContainment.mockResolvedValue({ id: "event-1", status: "CONTAINMENT" });
    mocks.completeContainment.mockResolvedValue({ id: "event-1", status: "CONTAINED" });
  });

  it("lets viewers read quality events in their site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await listEvents(
      new Request("http://localhost/api/quality/events?organizationId=org-a&siteId=site-a"),
    );

    expectStatus(response, 200);
    expect(mocks.queryQualityEvents).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      status: undefined,
      type: undefined,
      severity: undefined,
    });
  });

  it("prevents viewers from creating quality events", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await createEvent(
      new Request("http://localhost/api/quality/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          eventKey: "qe-001",
          type: "NONCONFORMITY",
          severity: "HIGH",
          title: "Synthetic event",
        }),
      }),
    );

    expectStatus(response, 403);
    expect(mocks.createQualityEvent).not.toHaveBeenCalled();
  });

  it("lets quality managers create idempotent quality events", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await createEvent(
      new Request("http://localhost/api/quality/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          eventKey: "qe-001",
          type: "NONCONFORMITY",
          severity: "HIGH",
          title: "Synthetic event",
          description: "Synthetic quality event.",
          occurredAt: "2026-08-08T00:00:00.000Z",
        }),
      }),
    );

    expectStatus(response, 201);
    expect(mocks.createQualityEvent).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventKey: "qe-001",
      type: "NONCONFORMITY",
      severity: "HIGH",
      title: "Synthetic event",
      description: "Synthetic quality event.",
      occurredAt: new Date("2026-08-08T00:00:00.000Z"),
      actorId: "quality-1",
    });
  });

  it("lets quality managers start containment with a tenant owner", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await patchEvent(
      new Request("http://localhost/api/quality/events/event-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "START_CONTAINMENT",
          summary: "Segregate synthetic affected material.",
          ownerId: "quality-2",
          dueAt: "2026-08-09T12:00:00.000Z",
        }),
      }),
      eventContext,
    );

    expectStatus(response, 200);
    expect(mocks.startOrUpdateContainment).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      summary: "Segregate synthetic affected material.",
      ownerId: "quality-2",
      dueAt: new Date("2026-08-09T12:00:00.000Z"),
      actorId: "quality-1",
    });
  });

  it("rejects no-op event updates", async () => {
    const response = await patchEvent(
      new Request("http://localhost/api/quality/events/event-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "UPDATE",
        }),
      }),
      eventContext,
    );

    expectStatus(response, 400);
    expect(mocks.updateQualityEvent).not.toHaveBeenCalled();
  });

  it("returns event detail with its audit timeline to readers", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await getEvent(
      new Request(
        "http://localhost/api/quality/events/event-1?organizationId=org-a&siteId=site-a",
      ),
      eventContext,
    );

    expectStatus(response, 200);
    expect(mocks.getQualityEvent).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
    expect(mocks.listQualityEventTimeline).toHaveBeenCalled();
  });
});
