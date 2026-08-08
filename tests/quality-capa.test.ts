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
  approveCapa,
  completeCapaAction,
  getCapaWorkspace,
  saveCapaDraft,
  verifyCapaEffectiveness,
} from "@/lib/quality/capa";

const event = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "INVESTIGATING",
};

const rootCause = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "CONFIRMED",
};

const baseInput = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  planSummary: "Remove the confirmed failure mechanism and prevent recurrence.",
  actions: [
    {
      type: "CORRECTIVE" as const,
      title: "Replace synthetic worn fixture",
      description: "Restore the equipment to the validated condition.",
      ownerId: "owner-1",
      dueAt: new Date("2026-08-20T10:00:00.000Z"),
    },
    {
      type: "PREVENTIVE" as const,
      title: "Add periodic retention check",
      ownerId: "owner-2",
      dueAt: new Date("2026-08-25T10:00:00.000Z"),
    },
  ],
  actorId: "quality-1",
};

function mockContext(rootStatus: "DRAFT" | "CONFIRMED" = "CONFIRMED") {
  mocks.auditFindFirst
    .mockResolvedValueOnce({ afterJson: JSON.stringify(event) })
    .mockResolvedValueOnce({ afterJson: JSON.stringify({ ...rootCause, status: rootStatus }) });
}

function mockCapa(snapshot: unknown | null) {
  mocks.auditFindFirst.mockResolvedValueOnce(
    snapshot ? { afterJson: JSON.stringify(snapshot) } : null,
  );
}

describe("quality CAPA workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.membershipFindFirst.mockResolvedValue({ id: "membership-1" });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
  });

  it("creates a draft with corrective and preventive actions, owners and due dates", async () => {
    mockContext();
    mockCapa(null);

    const result = await saveCapaDraft(baseInput);

    expect(result.status).toBe("DRAFT");
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toMatchObject({
      type: "CORRECTIVE",
      ownerId: "owner-1",
      status: "OPEN",
      dueAt: "2026-08-20T10:00:00.000Z",
    });
    expect(result.actions[1]).toMatchObject({ type: "PREVENTIVE", ownerId: "owner-2" });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "QualityCapa",
        entityId: "event-1",
        action: "CREATED",
      }),
    });
  });

  it("requires confirmed root-cause analysis before CAPA planning", async () => {
    mockContext("DRAFT");

    await expect(saveCapaDraft(baseInput)).rejects.toMatchObject({
      code: "ROOT_CAUSE_REQUIRED",
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects action owners without active site access", async () => {
    mockContext();
    mockCapa(null);
    mocks.membershipFindFirst.mockResolvedValueOnce(null);

    await expect(saveCapaDraft(baseInput)).rejects.toMatchObject({
      code: "ACTION_OWNER_NOT_FOUND",
    });
  });

  it("approves a complete draft and freezes plan edits", async () => {
    mockContext();
    mockCapa(null);
    const draft = await saveCapaDraft(baseInput);

    mockContext();
    mockCapa(draft);
    const approved = await approveCapa({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-2",
    });

    expect(approved).toMatchObject({
      status: "ACTIVE",
      approvedById: "quality-2",
    });
    expect(approved.approvedAt).toBeTruthy();

    mockContext();
    mockCapa(approved);
    await expect(saveCapaDraft(baseInput)).rejects.toMatchObject({ code: "CAPA_LOCKED" });
  });

  it("requires at least one action before approval", async () => {
    mockContext();
    mockCapa(null);
    const draft = await saveCapaDraft({ ...baseInput, actions: [] });

    mockContext();
    mockCapa(draft);
    await expect(
      approveCapa({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "ACTION_REQUIRED" });
  });

  it("completes an approved action with an immutable completion record", async () => {
    mockContext();
    mockCapa(null);
    const draft = await saveCapaDraft({ ...baseInput, actions: [baseInput.actions[0]] });
    mockContext();
    mockCapa(draft);
    const approved = await approveCapa({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    mockContext();
    mockCapa(approved);
    const completed = await completeCapaAction({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actionId: approved.actions[0].id,
      completionNote: "Fixture replaced and setup verification passed.",
      actorId: "quality-2",
    });

    expect(completed.actions[0]).toMatchObject({
      status: "COMPLETED",
      completedById: "quality-2",
      completionNote: "Fixture replaced and setup verification passed.",
    });
    expect(completed.actions[0].completedAt).toBeTruthy();
  });

  it("blocks effectiveness verification until every action is complete", async () => {
    mockContext();
    mockCapa(null);
    const draft = await saveCapaDraft(baseInput);
    mockContext();
    mockCapa(draft);
    const approved = await approveCapa({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    mockContext();
    mockCapa(approved);
    await expect(
      verifyCapaEffectiveness({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        result: "EFFECTIVE",
        note: "No recurrence detected.",
        actorId: "quality-3",
      }),
    ).rejects.toMatchObject({ code: "ACTIONS_INCOMPLETE" });
  });

  it("closes CAPA only after an effective verification", async () => {
    mockContext();
    mockCapa(null);
    const draft = await saveCapaDraft({ ...baseInput, actions: [baseInput.actions[0]] });
    mockContext();
    mockCapa(draft);
    const approved = await approveCapa({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
    mockContext();
    mockCapa(approved);
    const completed = await completeCapaAction({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actionId: approved.actions[0].id,
      completionNote: "Action implemented.",
      actorId: "quality-2",
    });

    mockContext();
    mockCapa(completed);
    const verified = await verifyCapaEffectiveness({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      result: "EFFECTIVE",
      note: "Three follow-up checks remained within acceptance criteria.",
      actorId: "quality-3",
    });

    expect(verified.status).toBe("CLOSED");
    expect(verified.closedAt).toBeTruthy();
    expect(verified.effectivenessChecks.at(-1)).toMatchObject({
      result: "EFFECTIVE",
      verifiedById: "quality-3",
    });
  });

  it("returns ineffective CAPA to draft while preserving verification history", async () => {
    const completed = {
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      status: "ACTIVE" as const,
      planSummary: "Synthetic CAPA",
      actions: [
        {
          id: "dd1f1863-0c8d-48a4-a4f8-3a25771626ea",
          type: "CORRECTIVE" as const,
          title: "Synthetic action",
          description: null,
          ownerId: "owner-1",
          dueAt: "2026-08-20T10:00:00.000Z",
          status: "COMPLETED" as const,
          completionNote: "Done",
          completedById: "quality-2",
          completedAt: "2026-08-15T10:00:00.000Z",
        },
      ],
      approvedById: "quality-1",
      approvedAt: "2026-08-10T10:00:00.000Z",
      effectivenessChecks: [],
      createdAt: "2026-08-09T10:00:00.000Z",
      updatedAt: "2026-08-15T10:00:00.000Z",
      closedAt: null,
    };
    mockContext();
    mockCapa(completed);

    const result = await verifyCapaEffectiveness({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      result: "INEFFECTIVE",
      note: "The failure recurred during follow-up inspection.",
      actorId: "quality-3",
    });

    expect(result.status).toBe("DRAFT");
    expect(result.approvedAt).toBeNull();
    expect(result.effectivenessChecks).toHaveLength(1);
    expect(result.effectivenessChecks[0].result).toBe("INEFFECTIVE");
  });

  it("does not expose CAPA data through mismatched tenant scope", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(rootCause) })
      .mockResolvedValueOnce({
        afterJson: JSON.stringify({
          eventId: "event-1",
          organizationId: "org-other",
          siteId: "site-a",
          status: "DRAFT",
          planSummary: "Other tenant",
          actions: [],
          approvedById: null,
          approvedAt: null,
          effectivenessChecks: [],
          createdAt: "2026-08-08T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z",
          closedAt: null,
        }),
      });

    const workspace = await getCapaWorkspace({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
    expect(workspace).toBeNull();
  });
});
