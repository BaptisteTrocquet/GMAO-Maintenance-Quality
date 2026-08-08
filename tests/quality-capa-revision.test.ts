import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditCreate: vi.fn(),
  membershipFindFirst: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    create: mocks.auditCreate,
  },
  organizationMembership: { findFirst: mocks.membershipFindFirst },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    auditLog: { findFirst: mocks.auditFindFirst },
  },
}));

import { saveCapaDraft, type CapaSnapshot } from "@/lib/quality/capa";

const completedDraft: CapaSnapshot = {
  eventId: "event-1",
  organizationId: "org-a",
  siteId: "site-a",
  status: "DRAFT",
  planSummary: "Revise the ineffective plan.",
  actions: [
    {
      id: "dd1f1863-0c8d-48a4-a4f8-3a25771626ea",
      type: "CORRECTIVE",
      title: "Replace synthetic fixture",
      description: null,
      ownerId: "owner-1",
      dueAt: "2026-08-20T10:00:00.000Z",
      status: "COMPLETED",
      completionNote: "Fixture replaced.",
      completedById: "quality-2",
      completedAt: "2026-08-15T10:00:00.000Z",
    },
  ],
  approvedById: null,
  approvedAt: null,
  effectivenessChecks: [
    {
      result: "INEFFECTIVE",
      note: "Failure recurred.",
      verifiedById: "quality-3",
      verifiedAt: "2026-08-18T10:00:00.000Z",
    },
  ],
  createdAt: "2026-08-09T10:00:00.000Z",
  updatedAt: "2026-08-18T10:00:00.000Z",
  closedAt: null,
};

function mockContextAndDraft() {
  mocks.auditFindFirst
    .mockResolvedValueOnce({
      afterJson: JSON.stringify({
        organizationId: "org-a",
        siteId: "site-a",
        status: "INVESTIGATING",
      }),
    })
    .mockResolvedValueOnce({
      afterJson: JSON.stringify({
        organizationId: "org-a",
        siteId: "site-a",
        status: "CONFIRMED",
      }),
    })
    .mockResolvedValueOnce({ afterJson: JSON.stringify(completedDraft) });
}

describe("CAPA ineffective-plan revision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.membershipFindFirst.mockResolvedValue({ id: "membership-1" });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("reopens completion when a completed action meaning changes", async () => {
    mockContextAndDraft();

    const result = await saveCapaDraft({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      planSummary: "Revise the ineffective plan.",
      actions: [
        {
          id: completedDraft.actions[0].id,
          type: "CORRECTIVE",
          title: "Replace fixture and add locking feature",
          description: null,
          ownerId: "owner-1",
          dueAt: new Date("2026-08-20T10:00:00.000Z"),
        },
      ],
      actorId: "quality-1",
    });

    expect(result.actions[0]).toMatchObject({
      status: "OPEN",
      completionNote: null,
      completedById: null,
      completedAt: null,
    });
    expect(result.effectivenessChecks).toEqual(completedDraft.effectivenessChecks);
  });

  it("preserves completion when an ineffective-plan revision leaves an action unchanged", async () => {
    mockContextAndDraft();

    const result = await saveCapaDraft({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      planSummary: "Add a different follow-up action later.",
      actions: [
        {
          id: completedDraft.actions[0].id,
          type: completedDraft.actions[0].type,
          title: completedDraft.actions[0].title,
          description: completedDraft.actions[0].description,
          ownerId: completedDraft.actions[0].ownerId,
          dueAt: new Date(completedDraft.actions[0].dueAt),
        },
      ],
      actorId: "quality-1",
    });

    expect(result.actions[0]).toMatchObject({
      status: "COMPLETED",
      completionNote: "Fixture replaced.",
      completedById: "quality-2",
      completedAt: "2026-08-15T10:00:00.000Z",
    });
  });
});
