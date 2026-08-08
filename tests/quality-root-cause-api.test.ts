import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class QualityRcaError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  }
  return {
    authenticateRequest: vi.fn(),
    getQualityRca: vi.fn(),
    listQualityRcaTimeline: vi.fn(),
    saveQualityRca: vi.fn(),
    finalizeQualityRca: vi.fn(),
    QualityRcaError,
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/quality/root-cause", () => ({
  getQualityRca: mocks.getQualityRca,
  listQualityRcaTimeline: mocks.listQualityRcaTimeline,
  saveQualityRca: mocks.saveQualityRca,
  finalizeQualityRca: mocks.finalizeQualityRca,
  QualityRcaError: mocks.QualityRcaError,
}));

import { GET, PATCH, PUT } from "@/app/api/quality/events/[eventId]/rca/route";

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

function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  if (!response) throw new Error("expected response");
  expect(response.status).toBe(status);
}

const context = { params: Promise.resolve({ eventId: "event-1" }) };

describe("quality RCA API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getQualityRca.mockResolvedValue(null);
    mocks.listQualityRcaTimeline.mockResolvedValue([]);
    mocks.saveQualityRca.mockResolvedValue({ id: "rca-1", status: "DRAFT" });
    mocks.finalizeQualityRca.mockResolvedValue({ id: "rca-1", status: "FINAL" });
  });

  it("lets viewers read an RCA workspace", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("VIEWER"));

    const response = await GET(
      new Request("http://localhost/api/quality/events/event-1/rca?organizationId=org-a&siteId=site-a"),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.getQualityRca).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
  });

  it("prevents viewers and technicians from saving RCA data", async () => {
    for (const role of ["VIEWER", "TECHNICIAN"] as const) {
      mocks.authenticateRequest.mockResolvedValue(auth(role));
      const response = await PUT(
        new Request("http://localhost/api/quality/events/event-1/rca", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organizationId: "org-a",
            siteId: "site-a",
            problemStatement: "Synthetic problem",
            fiveWhys: [{ sequence: 1, answer: "Synthetic why" }],
            ishikawaCauses: [],
            rootCauses: [],
          }),
        }),
        context,
      );
      expectStatus(response, 403);
    }
    expect(mocks.saveQualityRca).not.toHaveBeenCalled();
  });

  it("lets quality managers save structured 5 Why and Ishikawa analysis", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await PUT(
      new Request("http://localhost/api/quality/events/event-1/rca", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          problemStatement: "Synthetic problem",
          fiveWhys: [
            { sequence: 1, answer: "Synthetic why one" },
            { sequence: 2, answer: "Synthetic why two" },
          ],
          ishikawaCauses: [
            { category: "METHOD", statement: "Synthetic method cause" },
          ],
          rootCauses: [{ source: "FIVE_WHY", refId: "why-2" }],
        }),
      }),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.saveQualityRca).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      problemStatement: "Synthetic problem",
      fiveWhys: [
        { sequence: 1, answer: "Synthetic why one" },
        { sequence: 2, answer: "Synthetic why two" },
      ],
      ishikawaCauses: [{ category: "METHOD", statement: "Synthetic method cause" }],
      rootCauses: [{ source: "FIVE_WHY", refId: "why-2" }],
      actorId: "quality-1",
    });
  });

  it("rejects malformed JSON without invoking authentication or the RCA service", async () => {
    const response = await PUT(
      new Request("http://localhost/api/quality/events/event-1/rca", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{not-valid-json",
      }),
      context,
    );

    expectStatus(response, 400);
    expect(mocks.authenticateRequest).not.toHaveBeenCalled();
    expect(mocks.saveQualityRca).not.toHaveBeenCalled();
  });

  it("lets quality managers finalize RCA explicitly", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await PATCH(
      new Request("http://localhost/api/quality/events/event-1/rca", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          action: "FINALIZE",
        }),
      }),
      context,
    );

    expectStatus(response, 200);
    expect(mocks.finalizeQualityRca).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
  });

  it("rejects invalid Ishikawa categories before reaching the service", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("QUALITY_MANAGER"));

    const response = await PUT(
      new Request("http://localhost/api/quality/events/event-1/rca", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          problemStatement: "Synthetic problem",
          fiveWhys: [],
          ishikawaCauses: [{ category: "INVALID", statement: "Synthetic invalid cause" }],
          rootCauses: [],
        }),
      }),
      context,
    );

    expectStatus(response, 400);
    expect(mocks.saveQualityRca).not.toHaveBeenCalled();
  });
});
