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

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
  },
}));

import { completeCapaAction, verifyCapaEffectiveness } from "@/lib/quality/capa";

const event = { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" };
const rootCause = { organizationId: "org-a", siteId: "site-a", status: "CONFIRMED" };

function snapshot(actionStatus: "OPEN" | "COMPLETED") {
  return {
    eventId: "event-1",
    organizationId: "org-a",
    siteId: "site-a",
    status: "ACTIVE",
    planSummary: "Synthetic CAPA plan",
    actions: [
      {
        id: "action-1",
        type: "CORRECTIVE",
        title: "Synthetic corrective action",
        description: null,
        ownerId: "owner-1",
        dueAt: "2026-08-20T00:00:00.000Z",
        status: actionStatus,
        completionNote: actionStatus === "COMPLETED" ? "Implemented with evidence." : null,
        completedById: actionStatus === "COMPLETED" ? "quality-2" : null,
        completedAt: actionStatus === "COMPLETED" ? "2026-08-15T00:00:00.000Z" : null,
      },
    ],
    approvedById: "quality-approver",
    approvedAt: "2026-08-10T00:00:00.000Z",
    effectivenessChecks: [],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    closedAt: null,
  };
}

function installContext(capa: ReturnType<typeof snapshot>) {
  mocks.auditFindFirst
    .mockResolvedValueOnce({ afterJson: JSON.stringify(event) })
    .mockResolvedValueOnce({ afterJson: JSON.stringify(rootCause) })
    .mockResolvedValueOnce({ afterJson: JSON.stringify(capa) });
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
    installContext(snapshot("OPEN"));

    await expect(
      completeCapaAction({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actionId: "action-1",
        completionNote: "   ",
        actorId: "quality-2",
      }),
    ).rejects.toMatchObject({ code: "ACTION_COMPLETION_NOTE_REQUIRED" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects effectiveness verification without an evidence-based note", async () => {
    installContext(snapshot("COMPLETED"));

    await expect(
      verifyCapaEffectiveness({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        result: "EFFECTIVE",
        note: "   ",
        actorId: "quality-verifier",
      }),
    ).rejects.toMatchObject({ code: "EFFECTIVENESS_NOTE_REQUIRED" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
