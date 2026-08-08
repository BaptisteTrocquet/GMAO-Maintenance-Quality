import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  workOrderFindFirst: vi.fn(),
  workOrderUpdate: vi.fn(),
  membershipFindFirst: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  authenticateRequest: mocks.authenticateRequest,
}));

vi.mock("@/lib/db", () => ({
  db: {
    workOrder: { findFirst: mocks.workOrderFindFirst, update: mocks.workOrderUpdate },
    organizationMembership: { findFirst: mocks.membershipFindFirst },
    auditLog: { create: mocks.auditCreate },
  },
}));

import { PATCH } from "@/app/api/work-orders/[workOrderId]/route";

function auth() {
  return {
    session: { user: { id: "tech-1", displayName: "Taylor Technician" } },
    tenant: {
      scope: {
        organizationId: "org-a",
        role: "TECHNICIAN",
        allSites: true,
        siteIds: [],
        active: true,
      },
    },
  };
}

function workOrder(input?: { completionNote?: string | null; completed?: boolean }) {
  return {
    id: "wo-1",
    number: "WO-000001",
    siteId: "site-a",
    assetId: null,
    requesterId: "requester-1",
    assigneeId: "tech-1",
    teamId: null,
    title: "Inspect utility area",
    description: null,
    type: "CORRECTIVE",
    status: "IN_PROGRESS",
    priority: "NORMAL",
    requestedAt: new Date("2026-08-07T08:00:00.000Z"),
    plannedStart: new Date("2026-08-07T10:00:00.000Z"),
    dueAt: null,
    startedAt: new Date("2026-08-07T10:00:00.000Z"),
    completedAt: null,
    downtimeMinutes: 10,
    laborMinutes: 30,
    completionNote: input?.completionNote ?? null,
    createdAt: new Date("2026-08-07T08:00:00.000Z"),
    updatedAt: new Date("2026-08-07T10:30:00.000Z"),
    checkItems: [{ id: "item-1", completed: input?.completed ?? true }],
  };
}

function request(completionSignature?: { signerName: string; attested: true }) {
  return new Request("http://localhost/api/work-orders/wo-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      organizationId: "org-a",
      siteId: "site-a",
      status: "COMPLETED",
      ...(completionSignature ? { completionSignature } : {}),
    }),
  });
}

const params = { params: Promise.resolve({ workOrderId: "wo-1" }) };

async function expectStatus(response: Response | undefined, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
}

async function errorCode(response: Response | undefined) {
  expect(response).toBeDefined();
  const body = await response?.json() as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}

describe("signed work order completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue(auth());
    mocks.workOrderUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...workOrder({ completionNote: "Completed safely", completed: true }),
      ...data,
    }));
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("requires a completion note before closing", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(workOrder({ completionNote: null, completed: true }));

    const response = await PATCH(
      request({ signerName: "Taylor Technician", attested: true }),
      params,
    );

    await expectStatus(response, 409);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });

  it("requires every configured checklist item to be complete", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(
      workOrder({ completionNote: "Completed safely", completed: false }),
    );

    const response = await PATCH(
      request({ signerName: "Taylor Technician", attested: true }),
      params,
    );

    await expectStatus(response, 409);
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });

  it("requires explicit signature capture before closing", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(
      workOrder({ completionNote: "Completed safely", completed: true }),
    );

    const response = await PATCH(request(), params);

    await expectStatus(response, 409);
    expect(await errorCode(response)).toBe("SIGNATURE_REQUIRED");
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });

  it("rejects a typed signature that does not match the authenticated identity", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(
      workOrder({ completionNote: "Completed safely", completed: true }),
    );

    const response = await PATCH(
      request({ signerName: "Another Person", attested: true }),
      params,
    );

    await expectStatus(response, 409);
    expect(await errorCode(response)).toBe("SIGNATURE_IDENTITY_MISMATCH");
    expect(mocks.workOrderUpdate).not.toHaveBeenCalled();
  });

  it("closes and signs with typed name, authenticated identity and server timestamp", async () => {
    mocks.workOrderFindFirst.mockResolvedValue(
      workOrder({ completionNote: "Completed safely", completed: true }),
    );

    const response = await PATCH(
      request({ signerName: "  Taylor   Technician ", attested: true }),
      params,
    );

    await expectStatus(response, 200);
    expect(mocks.workOrderUpdate).toHaveBeenCalledWith({
      where: { id: "wo-1" },
      data: expect.objectContaining({ status: "COMPLETED", completedAt: expect.any(Date) }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "tech-1",
        action: "COMPLETED_SIGNED",
      }),
    });

    const auditPayload = mocks.auditCreate.mock.calls[0]?.[0]?.data;
    const after = JSON.parse(auditPayload.afterJson) as {
      signature?: {
        method?: string;
        signedById?: string;
        signedByName?: string;
        capturedName?: string;
        signedAt?: string;
        attestationVersion?: string;
      };
    };
    expect(after.signature).toEqual(expect.objectContaining({
      method: "TYPED_NAME",
      signedById: "tech-1",
      signedByName: "Taylor Technician",
      capturedName: "Taylor Technician",
      attestationVersion: "work-completion-v1",
    }));
    expect(after.signature?.signedAt).toBeTruthy();
  });
});
