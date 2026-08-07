import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  generate: vi.fn(),
  generateReminders: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/maintenance/reminders", () => ({
  generatePreventiveMaintenanceReminders: mocks.generateReminders,
}));
vi.mock("@/lib/maintenance/scheduler", () => ({
  generateCalendarMaintenanceWorkOrders: mocks.generate,
  MaintenanceSchedulerError: class MaintenanceSchedulerError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { POST } from "@/app/api/maintenance-scheduler/route";

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN") {
  return {
    session: { user: { id: role === "TECHNICIAN" ? "tech-1" : "manager-1" } },
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

function request(throughDate?: string, reminderLeadDays?: number) {
  return new Request("http://localhost/api/maintenance-scheduler", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      ...(throughDate ? { throughDate } : {}),
      ...(reminderLeadDays ? { reminderLeadDays } : {}),
    }),
  });
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("maintenance scheduler API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));
    mocks.generate.mockResolvedValue({ siteFound: true, generated: [], existing: [] });
    mocks.generateReminders.mockResolvedValue({
      siteFound: true,
      created: [],
      existing: [],
      expired: 0,
    });
  });

  it("allows a maintenance manager to run work generation and reminder notification together", async () => {
    const response = await POST(request(undefined, 10));

    await expectStatus(response, 200);
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        actorId: "manager-1",
        throughDate: expect.any(Date),
      }),
    );
    expect(mocks.generateReminders).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        leadDays: 10,
        actorId: "manager-1",
        now: expect.any(Date),
      }),
    );
  });

  it("blocks a technician from running the scheduler", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));

    const response = await POST(request());

    await expectStatus(response, 403);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.generateReminders).not.toHaveBeenCalled();
  });

  it("rejects an excessive future generation horizon", async () => {
    const future = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();

    const response = await POST(request(future));

    await expectStatus(response, 400);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.generateReminders).not.toHaveBeenCalled();
  });

  it("rejects a reminder lead time beyond 30 days", async () => {
    const response = await POST(request(undefined, 31));

    await expectStatus(response, 400);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("returns not found when the scheduler site scope is invalid", async () => {
    mocks.generate.mockResolvedValue({ siteFound: false, generated: [], existing: [] });

    const response = await POST(request());

    await expectStatus(response, 404);
    expect(mocks.generateReminders).not.toHaveBeenCalled();
  });
});
