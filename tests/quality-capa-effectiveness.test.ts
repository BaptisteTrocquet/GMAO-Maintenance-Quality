import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  membershipFindMany: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    findMany: mocks.auditFindMany,
    create: mocks.auditCreate,
  },
  organizationMembership: { findMany: mocks.membershipFindMany },
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
  assertCapaClosureReady,
  saveCapaWorkspace,
  submitEffectivenessReview,
  transitionCapaAction,
  verifyCapaEffectiveness,
} from "@/lib/quality/capa";

const investigatingEvent = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "INVESTIGATING",
};
const confirmedRootCause = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "CONFIRMED",
};

const actionDefinitions = [
  {
    id: "corrective-1",
    type: "CORRECTIVE" as const,
    title: "Correct synthetic cause",
    description: "Synthetic corrective action.",
    ownerId: "quality-2",
    dueAt: new Date("2026-08-20T00:00:00.000Z"),
  },
  {
    id: "preventive-1",
    type: "PREVENTIVE" as const,
    title: "Prevent synthetic recurrence",
    ownerId: "quality-3",
    dueAt: new Date("2026-08-25T00:00:00.000Z"),
  },
];

function mockJson(value: unknown) {
  mocks.auditFindFirst.mockResolvedValueOnce({ afterJson: JSON.stringify(value) });
}

function mockNone() {
  mocks.auditFindFirst.mockResolvedValueOnce(null);
}

function baseDraft() {
  return {
    eventId: "event-1",
    organizationId: "org-a",
    siteId: "site-a",
    status: "DRAFT" as const,
    objective: "Remove the confirmed cause and prevent recurrence.",
    actions: [
      {
        id: "corrective-1",
        type: "CORRECTIVE" as const,
        title: "Correct synthetic cause",
        description: "Synthetic corrective action.",
        ownerId: "quality-2",
        ownerName: "Synthetic Owner Two",
        dueAt: "2026-08-20T00:00:00.000Z",
        status: "OPEN" as const,
        completionEvidence: null,
        completedAt: null,
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
      },
      {
        id: "preventive-1",
        type: "PREVENTIVE" as const,
        title: "Prevent synthetic recurrence",
        description: null,
        ownerId: "quality-3",
        ownerName: "Synthetic Owner Three",
        dueAt: "2026-08-25T00:00:00.000Z",
        status: "OPEN" as const,
        completionEvidence: null,
        completedAt: null,
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
      },
    ],
    effectiveness: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    activatedAt: null,
    closedAt: null,
  };
}

function completedActive() {
  const draft = baseDraft();
  return {
    ...draft,
    status: "ACTIVE" as const,
    activatedAt: "2026-08-08T01:00:00.000Z",
    actions: draft.actions.map((action) => ({
      ...action,
      status: "COMPLETED" as const,
      completionEvidence: "Synthetic completion evidence.",
      completedAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    })),
  };
}

describe("quality CAPA actions and effectiveness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.membershipFindMany.mockImplementation(async ({ where }: { where: { userId: { in: string[] } } }) =>
      where.userId.in.map((userId) => ({
        userId,
        user: { displayName: `Synthetic ${userId}` },
      })),
    );
  });

  it("saves corrective and preventive actions with frozen owner names and due dates", async () => {
    mockJson(investigatingEvent);
    mockNone();

    const capa = await saveCapaWorkspace({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      objective: "Remove the confirmed cause and prevent recurrence.",
      actions: actionDefinitions,
      actorId: "quality-1",
    });

    expect(capa.status).toBe("DRAFT");
    expect(capa.actions).toHaveLength(2);
    expect(capa.actions[0]).toMatchObject({
      id: "corrective-1",
      type: "CORRECTIVE",
      ownerId: "quality-2",
      ownerName: "Synthetic quality-2",
      dueAt: "2026-08-20T00:00:00.000Z",
      status: "OPEN",
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ entityType: "QualityCapa", action: "CREATED" }),
    });
  });

  it("requires confirmed root cause before activation", async () => {
    const draft = baseDraft();
    mockJson(investigatingEvent);
    mockJson({ ...confirmedRootCause, status: "DRAFT" });

    await expect(
      activateCapa({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "ROOT_CAUSE_CONFIRMATION_REQUIRED" });

    mocks.auditFindFirst.mockReset();
    mockJson(investigatingEvent);
    mockJson(confirmedRootCause);
    mockJson(draft);
    const active = await activateCapa({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
    expect(active.status).toBe("ACTIVE");
    expect(active.activatedAt).toBeTruthy();
  });

  it("requires evidence when completing or cancelling an action", async () => {
    const active = { ...baseDraft(), status: "ACTIVE" as const };
    mockJson(investigatingEvent);
    mockJson(active);

    await expect(
      transitionCapaAction({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actionId: "corrective-1",
        status: "COMPLETED",
        evidence: " ",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "ACTION_EVIDENCE_REQUIRED" });
  });

  it("starts effectiveness review only after every action is dispositioned", async () => {
    const active = { ...baseDraft(), status: "ACTIVE" as const };
    mockJson(investigatingEvent);
    mockJson(active);

    await expect(
      submitEffectivenessReview({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        method: "Verify three consecutive synthetic runs.",
        ownerId: "quality-4",
        dueAt: new Date("2026-09-01T00:00:00.000Z"),
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "ACTIONS_INCOMPLETE" });

    mocks.auditFindFirst.mockReset();
    mockJson(investigatingEvent);
    mockJson(completedActive());
    const review = await submitEffectivenessReview({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      method: "Verify three consecutive synthetic runs.",
      ownerId: "quality-4",
      dueAt: new Date("2026-09-01T00:00:00.000Z"),
      actorId: "quality-1",
    });
    expect(review.status).toBe("EFFECTIVENESS_REVIEW");
    expect(review.effectiveness).toMatchObject({
      result: "PENDING",
      ownerId: "quality-4",
      dueAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("closes only on effective verification and reopens actions after ineffective verification", async () => {
    const review = {
      ...completedActive(),
      status: "EFFECTIVENESS_REVIEW" as const,
      effectiveness: {
        method: "Synthetic verification",
        ownerId: "quality-4",
        ownerName: "Synthetic quality-4",
        dueAt: "2026-09-01T00:00:00.000Z",
        result: "PENDING" as const,
        evidence: null,
        verifiedAt: null,
        verifiedById: null,
      },
    };

    mockJson(investigatingEvent);
    mockJson(review);
    const ineffective = await verifyCapaEffectiveness({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      result: "INEFFECTIVE",
      evidence: "Synthetic recurrence observed during verification.",
      actorId: "quality-1",
    });
    expect(ineffective.status).toBe("ACTIVE");
    expect(ineffective.closedAt).toBeNull();
    expect(ineffective.effectiveness?.result).toBe("INEFFECTIVE");

    mocks.auditFindFirst.mockReset();
    mockJson(investigatingEvent);
    mockJson(review);
    const effective = await verifyCapaEffectiveness({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      result: "EFFECTIVE",
      evidence: "Synthetic verification criteria satisfied.",
      actorId: "quality-1",
    });
    expect(effective.status).toBe("CLOSED");
    expect(effective.closedAt).toBeTruthy();
    expect(effective.effectiveness?.result).toBe("EFFECTIVE");
  });

  it("blocks quality-event closure while a CAPA exists but is not closed", async () => {
    mockJson({ ...baseDraft(), status: "ACTIVE" });
    await expect(
      assertCapaClosureReady(tx as never, {
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
      }),
    ).rejects.toMatchObject({ code: "ACTIONS_INCOMPLETE" });

    mocks.auditFindFirst.mockReset();
    mockJson({ ...completedActive(), status: "CLOSED", closedAt: "2026-09-02T00:00:00.000Z" });
    await expect(
      assertCapaClosureReady(tx as never, {
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
      }),
    ).resolves.toBeUndefined();
  });
});
