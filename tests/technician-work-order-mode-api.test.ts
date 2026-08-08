import { beforeEach, describe, expect, it, vi } from "vitest";
import { offlineReadPartitionFromAuthorization } from "@/lib/pwa/offline-read-cache";

const mocks = vi.hoisted(() => {
  class AccessDeniedError extends Error {}
  return {
    AccessDeniedError,
    authenticateRequest: vi.fn(),
    assertSitePermission: vi.fn(),
    teamMemberFindMany: vi.fn(),
    workOrderFindMany: vi.fn(),
    workOrderFindFirst: vi.fn(),
    auditFindFirst: vi.fn(),
    canExecuteWorkOrder: vi.fn(),
  };
});

vi.mock("@/lib/auth/request-auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@/lib/access-control", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  assertSitePermission: mocks.assertSitePermission,
}));
vi.mock("@/lib/work-orders/authorization", () => ({
  canExecuteWorkOrder: mocks.canExecuteWorkOrder,
}));
vi.mock("@/lib/db", () => ({
  db: {
    maintenanceTeamMember: { findMany: mocks.teamMemberFindMany },
    workOrder: {
      findMany: mocks.workOrderFindMany,
      findFirst: mocks.workOrderFindFirst,
    },
    auditLog: { findFirst: mocks.auditFindFirst },
  },
}));

import { GET as GET_QUEUE } from "@/app/api/work-orders/technician/route";
import { GET as GET_DETAIL } from "@/app/api/work-orders/technician/[workOrderId]/route";

const authorization = "Bearer technician-cache-test-session";
const expectedPartition = offlineReadPartitionFromAuthorization(authorization);

function auth() {
  return {
    session: { user: { id: "tech-1", displayName: "Demo Technician" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "TECHNICIAN",
        allSites: false,
        siteIds: ["site-a"],
        active: true,
      },
    },
  };
}

const detailParams = { params: Promise.resolve({ workOrderId: "wo-1" }) };

function queueRequest() {
  return new Request(
    "http://localhost/api/work-orders/technician?organizationId=org-a&siteId=site-a",
    { headers: { authorization } },
  );
}

function detailRequest() {
  return new Request(
    "http://localhost/api/work-orders/technician/wo-1?organizationId=org-a&siteId=site-a",
    { headers: { authorization } },
  );
}

async function responseStatus(response: Response | undefined) {
  expect(response).toBeDefined();
  return response?.status;
}

describe("technician work-order mode API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.assertSitePermission.mockImplementation(() => undefined);
    mocks.teamMemberFindMany.mockResolvedValue([{ teamId: "team-a" }]);
    mocks.workOrderFindMany.mockResolvedValue([]);
    mocks.workOrderFindFirst.mockResolvedValue({
      id: "wo-1",
      number: "WO-000001",
      title: "Inspect pump",
      description: null,
      status: "IN_PROGRESS",
      priority: "NORMAL",
      type: "CORRECTIVE",
      plannedStart: null,
      dueAt: null,
      startedAt: null,
      laborMinutes: 0,
      downtimeMinutes: 0,
      completionNote: null,
      assigneeId: "tech-1",
      teamId: null,
      asset: null,
      assignee: { id: "tech-1", displayName: "Demo Technician" },
      team: null,
      checkItems: [],
    });
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.canExecuteWorkOrder.mockResolvedValue(true);
  });

  it("lists only open work assigned directly or through the technician teams", async () => {
    const response = await GET_QUEUE(queueRequest());

    expect(await responseStatus(response)).toBe(200);
    expect(response?.headers.get("x-opengmao-offline-partition")).toBe(expectedPartition);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.assertSitePermission).toHaveBeenCalledWith(expect.anything(), "site-a", "work:read");
    expect(mocks.teamMemberFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: "tech-1", team: { siteId: "site-a", active: true } }),
    }));
    expect(mocks.workOrderFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        siteId: "site-a",
        site: { organizationId: "org-a", active: true },
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        OR: [{ assigneeId: "tech-1" }, { teamId: { in: ["team-a"] } }],
      }),
    }));
  });

  it("does not query assigned work when site read permission is denied", async () => {
    mocks.assertSitePermission.mockImplementation(() => {
      throw new mocks.AccessDeniedError("denied");
    });

    const response = await GET_QUEUE(queueRequest());

    expect(await responseStatus(response)).toBe(403);
    expect(response?.headers.get("x-opengmao-offline-partition")).toBeNull();
    expect(mocks.workOrderFindMany).not.toHaveBeenCalled();
  });

  it("loads a focused work order only after tenant and site scoping and returns signer identity", async () => {
    const response = await GET_DETAIL(detailRequest(), detailParams);

    expect(await responseStatus(response)).toBe(200);
    expect(response?.headers.get("x-opengmao-offline-partition")).toBe(expectedPartition);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.workOrderFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "wo-1",
        siteId: "site-a",
        site: { organizationId: "org-a", active: true },
      },
    }));
    expect(mocks.canExecuteWorkOrder).toHaveBeenCalledWith({
      role: "TECHNICIAN",
      userId: "tech-1",
      siteId: "site-a",
      assigneeId: "tech-1",
      teamId: null,
    });
    const body = await response?.json() as {
      data?: { signer?: { id?: string; displayName?: string }; completionSignature?: unknown };
    };
    expect(body.data?.signer).toEqual({ id: "tech-1", displayName: "Demo Technician" });
    expect(body.data?.completionSignature).toBeNull();
  });

  it("returns a persisted typed completion signature from the immutable completion audit", async () => {
    mocks.workOrderFindFirst.mockResolvedValue({
      id: "wo-1",
      number: "WO-000001",
      title: "Inspect pump",
      description: null,
      status: "COMPLETED",
      priority: "NORMAL",
      type: "CORRECTIVE",
      plannedStart: null,
      dueAt: null,
      startedAt: null,
      laborMinutes: 30,
      downtimeMinutes: 2,
      completionNote: "Done",
      assigneeId: "tech-1",
      teamId: null,
      asset: null,
      assignee: { id: "tech-1", displayName: "Demo Technician" },
      team: null,
      checkItems: [],
    });
    mocks.auditFindFirst.mockResolvedValue({
      afterJson: JSON.stringify({
        signature: {
          method: "TYPED_NAME",
          signedById: "tech-1",
          signedByName: "Demo Technician",
          capturedName: "Demo Technician",
          signedAt: "2026-08-08T07:40:00.000Z",
          attestationVersion: "work-completion-v1",
        },
      }),
    });

    const response = await GET_DETAIL(detailRequest(), detailParams);

    expect(await responseStatus(response)).toBe(200);
    expect(mocks.auditFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { entityType: "WorkOrder", entityId: "wo-1", action: "COMPLETED_SIGNED" },
    }));
    const body = await response?.json() as { data?: { completionSignature?: unknown } };
    expect(body.data?.completionSignature).toEqual(expect.objectContaining({
      method: "TYPED_NAME",
      signedById: "tech-1",
      signedByName: "Demo Technician",
      capturedName: "Demo Technician",
    }));
  });

  it("rejects deep links to work orders not assigned to the technician or their team", async () => {
    mocks.canExecuteWorkOrder.mockResolvedValue(false);

    const response = await GET_DETAIL(detailRequest(), detailParams);

    expect(await responseStatus(response)).toBe(403);
    expect(response?.headers.get("x-opengmao-offline-partition")).toBeNull();
  });

  it("returns 404 before assignment checks for work outside the selected tenant scope", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(null);

    const response = await GET_DETAIL(detailRequest(), detailParams);

    expect(await responseStatus(response)).toBe(404);
    expect(response?.headers.get("x-opengmao-offline-partition")).toBeNull();
    expect(mocks.canExecuteWorkOrder).not.toHaveBeenCalled();
  });
});