import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditCreate: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    create: mocks.auditCreate,
  },
};

vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));

import { transitionCapaAction } from "@/lib/quality/capa";
import { verifyCapaEffectiveness } from "@/lib/quality/effectiveness";

const event = { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" };

function activeCapa() {
  return {
    eventId: "event-1",
    organizationId: "org-a",
    siteId: "site-a",
    status: "ACTIVE",
    objective: "Remove confirmed synthetic cause",
    actions: [
      {
        id: "action-1",
        actionKey: "corrective-1",
        type: "CORRECTIVE",
        title: "Synthetic corrective action",
        description: null,
        ownerId: "quality-owner",
        dueAt: "2026-08-20T00:00:00.000Z",
        status: "PLANNED",
        completionNote: null,
        completedAt: null,
      },
    ],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    activatedAt: "2026-08-10T00:00:00.000Z",
    readyForEffectivenessAt: null,
  };
}

function readyCapa() {
  return {
    ...activeCapa(),
    status: "READY_FOR_EFFECTIVENESS",
    actions: [
      {
        ...activeCapa().actions[0],
        status: "COMPLETED",
        completionNote: "Implemented with synthetic evidence.",
        completedAt: "2026-08-15T00:00:00.000Z",
      },
    ],
    readyForEffectivenessAt: "2026-08-16T00:00:00.000Z",
  };
}

function pendingEffectiveness() {
  return {
    eventId: "event-1",
    organizationId: "org-a",
    siteId: "site-a",
    status: "PENDING",
    criteria: "No recurrence during the synthetic observation window.",
    verifierId: "quality-verifier",
    verifierName: "Synthetic Verifier",
    dueAt: "2026-09-01T00:00:00.000Z",
    result: null,
    summary: null,
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    verifiedAt: null,
  };
}

describe("CAPA required evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("rejects action completion without a non-empty completion note", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(activeCapa()) });

    await expect(
      transitionCapaAction({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actionId: "action-1",
        transition: "COMPLETE",
        completionNote: "   ",
        actorId: "quality-owner",
      }),
    ).rejects.toMatchObject({ code: "ACTION_COMPLETION_NOTE_REQUIRED" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects effectiveness verification without an evidence summary", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(readyCapa()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(pendingEffectiveness()) });

    await expect(
      verifyCapaEffectiveness({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        result: "EFFECTIVE",
        summary: "   ",
        actorId: "quality-verifier",
      }),
    ).rejects.toMatchObject({ code: "INVALID_EFFECTIVENESS_DATA" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
