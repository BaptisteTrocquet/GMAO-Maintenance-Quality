import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  membershipFindFirst: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    findMany: mocks.auditFindMany,
    create: mocks.auditCreate,
  },
  organizationMembership: { findFirst: mocks.membershipFindFirst },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    auditLog: {
      findFirst: mocks.auditFindFirst,
      findMany: mocks.auditFindMany,
    },
  },
}));

import {
  activateCapa,
  reopenIneffectiveCapa,
  saveCapaPlan,
  setCapaActionStatus,
  startCapaVerification,
  verifyCapaEffectiveness,
} from "@/lib/quality/capa";

function event(status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED" = "INVESTIGATING") {
  return {
    organizationId: "org-a",
    siteId: "site-a",
    eventNumber: "QE-0001",
    title: "Synthetic quality event",
    status,
  };
}

function rootCause(status: "DRAFT" | "CONFIRMED" = "CONFIRMED") {
  return {
    organizationId: "org-a",
    siteId: "site-a",
    status,
    rootCauseSummary: status === "CONFIRMED" ? "Synthetic confirmed root cause" : null,
  };
}

function action(status: "OPEN" | "IN_PROGRESS" | "COMPLETED" = "OPEN") {
  return {
    id: "action-1",
    type: "CORRECTIVE" as const,
    title: "Correct synthetic cause",
    description: "Synthetic action detail",
    ownerId: "owner-1",
    ownerName: "Synthetic Owner",
    dueAt: "2026-08-15T10:00:00.000Z",
    status,
    completedAt: status === "COMPLETED" ? "2026-08-10T10:00:00.000Z" : null,
    completionNote: status === "COMPLETED" ? "Completed with synthetic evidence" : null,
  };
}

function capa(
  status: "DRAFT" | "ACTIVE" | "VERIFYING" | "EFFECTIVE" | "INEFFECTIVE" = "DRAFT",
  actionStatus: "OPEN" | "IN_PROGRESS" | "COMPLETED" = "OPEN",
) {
  return {
    eventId: "event-1",
    organizationId: "org-a",
    siteId: "site-a",
    eventNumber: "QE-0001",
    eventTitle: "Synthetic quality event",
    rootCauseSummary: "Synthetic confirmed root cause",
    status,
    actions: [action(actionStatus)],
    verificationPlan: {
      method: "Review synthetic recurrence data",
      acceptanceCriteria: "No recurrence for the synthetic review window",
    },
    effectiveness:
      status === "INEFFECTIVE"
        ? {
            result: "Synthetic recurrence observed",
            effective: false,
            verifiedById: "quality-1",
            verifiedByName: "Synthetic Quality Manager",
            verifiedAt: "2026-08-20T10:00:00.000Z",
          }
        : null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    activatedAt: status === "DRAFT" ? null : "2026-08-08T01:00:00.000Z",
    verificationStartedAt:
      status === "VERIFYING" || status === "EFFECTIVE" || status === "INEFFECTIVE"
        ? "2026-08-18T10:00:00.000Z"
        : null,
  };
}

const common = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  actorId: "quality-1",
};

describe("quality CAPA workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.membershipFindFirst.mockResolvedValue({
      user: { id: "owner-1", displayName: "Synthetic Owner" },
    });
  });

  it("saves a draft with corrective and preventive action ownership and due dates", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ afterJson: JSON.stringify(rootCause()) });
    mocks.membershipFindFirst
      .mockResolvedValueOnce({ user: { id: "owner-1", displayName: "Synthetic Owner" } })
      .mockResolvedValueOnce({ user: { id: "owner-2", displayName: "Synthetic Owner Two" } });

    const result = await saveCapaPlan({
      ...common,
      actions: [
        {
          type: "CORRECTIVE",
          title: "Correct synthetic cause",
          ownerId: "owner-1",
          dueAt: "2026-08-15T10:00:00.000Z",
        },
        {
          type: "PREVENTIVE",
          title: "Prevent synthetic recurrence",
          ownerId: "owner-2",
          dueAt: "2026-08-20T10:00:00.000Z",
        },
      ],
      verificationPlan: {
        method: "Review recurrence data",
        acceptanceCriteria: "No recurrence",
      },
    });

    expect(result.status).toBe("DRAFT");
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toMatchObject({
      type: "CORRECTIVE",
      ownerId: "owner-1",
      ownerName: "Synthetic Owner",
      status: "OPEN",
    });
    expect(result.actions[1]).toMatchObject({ type: "PREVENTIVE", ownerId: "owner-2" });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ entityType: "QualityCapa", action: "CAPA_CREATED" }),
    });
  });

  it("rejects an action owner without active access to the event site", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ afterJson: JSON.stringify(rootCause()) });
    mocks.membershipFindFirst.mockResolvedValue(null);

    await expect(
      saveCapaPlan({
        ...common,
        actions: [
          {
            type: "CORRECTIVE",
            title: "Correct synthetic cause",
            ownerId: "outside-user",
            dueAt: "2026-08-15T10:00:00.000Z",
          },
        ],
        verificationPlan: { method: "Review", acceptanceCriteria: "No recurrence" },
      }),
    ).rejects.toMatchObject({ code: "CAPA_ACTION_OWNER_NOT_FOUND" });
  });

  it("requires confirmed root cause before CAPA activation", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(rootCause("DRAFT")) });

    await expect(activateCapa(common)).rejects.toMatchObject({ code: "ROOT_CAUSE_REQUIRED" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("activates a draft only with confirmed root cause and freezes its summary", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(rootCause()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(capa("DRAFT")) });

    const result = await activateCapa(common);

    expect(result.status).toBe("ACTIVE");
    expect(result.rootCauseSummary).toBe("Synthetic confirmed root cause");
    expect(result.activatedAt).toBeTruthy();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "CAPA_ACTIVATED" }),
    });
  });

  it("tracks action completion and blocks effectiveness verification until all actions are complete", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(capa("ACTIVE", "IN_PROGRESS")) });

    const completed = await setCapaActionStatus({
      ...common,
      actionId: "action-1",
      status: "COMPLETED",
      completionNote: "Implemented and recorded",
    });
    expect(completed.actions[0]).toMatchObject({
      status: "COMPLETED",
      completionNote: "Implemented and recorded",
    });
    expect(completed.actions[0].completedAt).toBeTruthy();

    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(capa("ACTIVE", "OPEN")) });
    await expect(startCapaVerification(common)).rejects.toMatchObject({ code: "ACTIONS_INCOMPLETE" });
  });

  it("starts verification when all actions are complete and records effective outcome", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(capa("ACTIVE", "COMPLETED")) });
    const verifying = await startCapaVerification(common);
    expect(verifying.status).toBe("VERIFYING");

    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify({ ...capa("VERIFYING", "COMPLETED"), verificationStartedAt: verifying.verificationStartedAt }) });
    mocks.membershipFindFirst.mockResolvedValue({
      user: { id: "quality-1", displayName: "Synthetic Quality Manager" },
    });

    const effective = await verifyCapaEffectiveness({
      ...common,
      effective: true,
      result: "No synthetic recurrence observed",
    });
    expect(effective.status).toBe("EFFECTIVE");
    expect(effective.effectiveness).toMatchObject({
      effective: true,
      verifiedById: "quality-1",
      verifiedByName: "Synthetic Quality Manager",
    });
  });

  it("reopens an ineffective CAPA for further action without erasing the audit trail", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(capa("INEFFECTIVE", "COMPLETED")) });

    const reopened = await reopenIneffectiveCapa(common);
    expect(reopened.status).toBe("ACTIVE");
    expect(reopened.effectiveness).toBeNull();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "CAPA_REOPENED" }),
    });
  });
});
