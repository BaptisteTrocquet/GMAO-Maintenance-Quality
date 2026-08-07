import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  list: vi.fn(),
  generate: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/maintenance/reminders", () => ({
  listActiveMaintenanceReminders: mocks.list,
  generatePreventiveMaintenanceReminders: mocks.generate,
  dismissMaintenanceReminder: mocks.dismiss,
}));

import { GET, POST } from "@/app/api/maintenance-reminders/route";
import { PATCH } from "@/app/api/maintenance-reminders/[reminderId]/route";

function auth(role: "MAINTENANCE_MANAGER" | "TECHNICIAN", siteIds = ["site-a"]) {
  return {
    session: { user: { id: role === "TECHNICIAN" ? "tech-1" : "manager-1" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role,
        allSites: false,
        siteIds,
        active: true,
      },
    },
  };
}

function getRequest(siteId = "site-a") {
  return new Request(
    `http://localhost/api/maintenance-reminders?organizationId=org-a&siteId=${siteId}`,
  );
}

function postRequest(leadDays = 7) {
  return new Request("http://localhost/api/maintenance-reminders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: "org-a", siteId: "site-a", leadDays }),
  });
}

function patchRequest() {
  return new Request("http://localhost/api/maintenance-reminders/reminder-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId: "org-a", siteId: "site-a" }),
  });
}

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

describe("maintenance reminder API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth("TECHNICIAN"));
    mocks.list.mockResolvedValue([]);
    mocks.generate.mockResolvedValue({ siteFound: true, created: [], existing: [], expired: 0 });
    mocks.dismiss.mockResolvedValue({ id: "reminder-1", status: "DISMISSED" });
  });

  it("allows a technician to read active reminders in an assigned site", async () => {
    const response = await GET(getRequest());

    await expectStatus(response, 200);
    expect(mocks.list).toHaveBeenCalledWith({ organizationId: "org-a", siteId: "site-a" });
  });

  it("blocks reminder reads outside tenant site scope", async () => {
    const response = await GET(getRequest("site-b"));

    await expectStatus(response, 403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("requires maintenance management permission to run reminder generation", async () => {
    const response = await POST(postRequest());

    await expectStatus(response, 403);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("lets a maintenance manager run reminder generation", async () => {
    mocks.authenticateRequest.mockResolvedValue(auth("MAINTENANCE_MANAGER"));

    const response = await POST(postRequest(10));

    await expectStatus(response, 200);
    expect(mocks.generate).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      leadDays: 10,
      actorId: "manager-1",
    });
  });

  it("lets a maintenance reader dismiss an active reminder in scope", async () => {
    const response = await PATCH(patchRequest(), {
      params: Promise.resolve({ reminderId: "reminder-1" }),
    });

    await expectStatus(response, 200);
    expect(mocks.dismiss).toHaveBeenCalledWith({
      organizationId: "org-a",
      siteId: "site-a",
      reminderId: "reminder-1",
      actorId: "tech-1",
    });
  });
});
