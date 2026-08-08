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
  db: { $transaction: mocks.transaction },
}));

import { completeCapaAction, verifyCapaEffectiveness } from "@/lib/quality/capa";

const event = { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" };
const rootCause = { organizationId: "org-a", siteId: "site-a", status: "CONFIRMED" };

const activeCapa = {
  eventId: "event-1",
  organizationId: "org-a",
  siteId: "site-a",
  status: "ACTIVE",
  planSummary: "Synthetic CAPA plan",
  actions: [
    {
      id: "1d1dd1b3-6d15-43bd-8d61-f137327d7a3a",
      type: "CORRECTIVE",
      title: "Correct synthetic cause",
      description: null,
      ownerId: "owner-1",
      dueAt: "2026-08-20T10:00:00.000Z",
      status: "OPEN",
      completionNote: null,
      completedById: null,
      completedAt: null,
    },
  ],
  approvedById: "quality-approver",
  approvedAt: "2026-08-10T10:00:00.000Z",
  effectivenessChecks: [],
  createdAt: "2026-08-08T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
  closedAt: null,
};

function mockContext(capa: unknown) {
  mocks.auditFindFirst
    .mockResolvedValueOnce({ afterJson: JSON.stringify(event) })
    .mockResolvedValueOnce({ afterJson: JSON.stringify(rootCause) })
    .mockResolvedValueOnce({ afterJson: JSON.stringify(capa) });
}

describe("CAPA required evidence rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("does not complete a CAPA action without implementation evidence", async () => {
    mockContext(activeCapa);

    await expect(
      completeCapaAction({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actionId: activeCapa.actions[0].id,
        completionNote: "   ",
        actorId: "quality-user",
      }),
    ).rejects.toMatchObject({ code: "ACTION_COMPLETION_NOTE_REQUIRED" });

    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("does not verify effectiveness without evidence-based verification notes", async () => {
    const completed = {
      ...activeCapa,
      actions: [
        {
          ...activeCapa.actions[0],
          status: "COMPLETED",
          completionNote: "Implementation evidence recorded.",
          completedById: "quality-user",
          completedAt: "2026-08-15T10:00:00.000Z",
        },
      ],
    };
    mockContext(completed);

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
