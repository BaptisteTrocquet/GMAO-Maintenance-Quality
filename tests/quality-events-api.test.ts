import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class QualityEventError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  class CapaClosureError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    listQualityEvents: vi.fn(),
    createQualityEvent: vi.fn(),
    getQualityEvent: vi.fn(),
    listQualityEventTimeline: vi.fn(),
    setImmediateContainment: vi.fn(),
    transitionQualityEvent: vi.fn(),
    assertCapaClosedForEvent: vi.fn(),
    QualityEventError,
    CapaClosureError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/events", () => ({
  listQualityEvents: mocks.listQualityEvents,
  createQualityEvent: mocks.createQualityEvent,
  getQualityEvent: mocks.getQualityEvent,
  listQualityEventTimeline: mocks.listQualityEventTimeline,
  setImmediateContainment: mocks.setImmediateContainment,
  transitionQualityEvent: mocks.transitionQualityEvent,
  QualityEventError: mocks.QualityEventError,
}));
vi.mock("@/lib/quality/capa-closure", () => ({
  assertCapaClosedForEvent: mocks.assertCapaClosedForEvent,
  CapaClosureError: mocks.CapaClosureError,
}));

import { GET as listEvents, POST as createEvent } from "@/app/api/quality/events/route";
import { GET as getEvent, PATCH as patchEvent } from "@/app/api/quality/events/[eventId]/route";

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

const eventContext = { params: Promise.resolve({ eventId: "event-1" }) };

describe("quality event APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listQualityEvents.mockResolvedValue([]);
    mocks.createQualityEvent.mockResolvedValue({
      idempotent: false,
      qualityEvent: { id: "event-1", status: "OPEN" },
    });
    mocks.getQualityEvent.mockResolvedValue({ id: "event-1", status: "OPEN" });
    mocks.listQualityEventTimeline.mockResolvedValue([]);
    mocks.setImmediateContainment.mockResolvedValue({ id: "event-1", status: "CONTAINED" });
    mocks.transitionQualityEvent.mockResolvedValue({ id: "event-1", status: "INVESTIGATING" });
    mocks.assertCapaClosedForEvent.mockResolvedValue(undefined);
  });

  it("lets viewers read quality events in their site scope", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await listEvents(
      new Request("http://localhost/api/quality/events?organizationId=org-a&siteId=site-a"),
    );

    expectStatus(response, 200);
    expect(mocks.listQualityEvents).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      status: undefined,
      type: undefined,
      severity: undefined,
    });
  });

  it("prevents viewers and technicians from managing quality events", async () => {
    for (const role of ["VIEWER", "TECHNICIAN"] as const) {
      mocks.authenticateRequest.mockResolvedValue(auth(role));
      const response = await createEvent(
        new Request("http://localhost/api/quality/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-a",
            siteId: "site-a",
            eventKey: `qe-${role}`,
            type: "NONCONFORMITY",
            severity: "HIGH",
            title: "Synthetic event",
          }),
        }),
      );
      expectStatus(response, 403);
    }
    expect(mocks.createQualityEvent).not.toHaveBeenCalled();
  });

  it("lets quality managers create linked idempotent quality events", async () => {
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
          assetId: "asset-1",
          workOrderId: "wo-1",
          documentIds: ["doc-1"],
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
      assetId: "asset-1",
      workOrderId: "wo-1",
      documentIds: ["doc-1"],
      actorId: "quality-1",
    });
  });

  it("lets quality managers record immediate containment", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await patchEvent(
      new Request("http://localhost/api/quality/events/event-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "SET_CONTAINMENT",
          summary: "Segregate synthetic affected material.",
          ownerId: "quality-2",
          dueAt: "2026-08-09T12:00:00.000Z",
        }),
      }),
      eventContext,
    );

    expectStatus(response, 200);
    expect(mocks.setImmediateContainment).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      summary: "Segregate synthetic affected material.",
      ownerId: "quality-2",
      dueAt: new Date("2026-08-09T12:00:00.000Z"),
      completedAt: undefined,
      actorId: "quality-1",
    });
  });

  it("routes investigation and closure through explicit transitions", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const start = await patchEvent(
      new Request("http://localhost/api/quality/events/event-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "START_INVESTIGATION",
        }),
      }),
      eventContext,
    );
    expectStatus(start, 200);
    expect(mocks.transitionQualityEvent).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      action: "START_INVESTIGATION",
      resolutionSummary: undefined,
      actorId: "quality-1",
    });

    mocks.transitionQualityEvent.mockClear();
    const close = await patchEvent(
      new Request("http://localhost/api/quality/events/event-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "CLOSE",
          resolutionSummary: "Synthetic issue resolved.",
        }),
      }),
      eventContext,
    );
    expectStatus(close, 200);
    expect(mocks.assertCapaClosedForEvent).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
    expect(mocks.transitionQualityEvent).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      action: "CLOSE",
      resolutionSummary: "Synthetic issue resolved.",
      actorId: "quality-1",
    });
  });

  it("blocks quality-event closure while CAPA is incomplete", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    mocks.assertCapaClosedForEvent.mockRejectedValue(
      new mocks.CapaClosureError("CAPA_INCOMPLETE", "Quality event cannot close while its CAPA is incomplete"),
    );

    const response = await patchEvent(
      new Request("http://localhost/api/quality/events/event-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "CLOSE",
          resolutionSummary: "Synthetic issue resolved.",
        }),
      }),
      eventContext,
    );

    expectStatus(response, 409);
    expect(mocks.transitionQualityEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed workflow transitions", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));
    const response = await patchEvent(
      new Request("http://localhost/api/quality/events/event-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "CLOSE",
        }),
      }),
      eventContext,
    );
    expectStatus(response, 400);
    expect(mocks.transitionQualityEvent).not.toHaveBeenCalled();
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
    expect(mocks.listQualityEventTimeline).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
  });
});
