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
  markCapaReadyForEffectiveness,
  saveCapaDraft,
  transitionCapaAction,
} from "@/lib/quality/capa";

const event = { organizationId: "org-a", siteId: "site-a", status: "INVESTIGATING" };
const confirmedRootCause = { organizationId: "org-a", siteId: "site-a", status: "CONFIRMED" };

const draftInput = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  objective: "Remove the confirmed cause and prevent recurrence.",
  actions: [
    {
      actionKey: "corrective-1",
      type: "CORRECTIVE" as const,
      title: "Replace the synthetic worn clamp",
      description: "Synthetic corrective action.",
      ownerId: "quality-2",
      dueAt: new Date("2026-08-20T00:00:00.000Z"),
    },
    {
      actionKey: "preventive-1",
      type: "PREVENTIVE" as const,
      title: "Add clamp verification to setup standard",
      ownerId: "quality-3",
      dueAt: new Date("2026-08-25T00:00:00.000Z"),
    },
  ],
  actorId: "quality-1",
};

function mockJson(value: unknown) {
  mocks.auditFindFirst.mockResolvedValueOnce({ afterJson: JSON.stringify(value) });
}

function mockNoRecord() {
  mocks.auditFindFirst.mockResolvedValueOnce(null);
}

describe("quality CAPA workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.membershipFindMany.mockResolvedValue([
      { userId: "quality-2" },
      { userId: "quality-3" },
    ]);
  });

  it("creates a draft with corrective/preventive actions, owners and due dates", async () => {
    mockJson(event);
    mockNoRecord();

    const draft = await saveCapaDraft(draftInput);

    expect(draft.status).toBe("DRAFT");
    expect(draft.actions).toHaveLength(2);
    expect(draft.actions[0]).toMatchObject({
      actionKey: "corrective-1",
      type: "CORRECTIVE",
      ownerId: "quality-2",
      dueAt: "2026-08-20T00:00:00.000Z",
      status: "PLANNED",
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ entityType: "QualityCapa", action: "CAPA_DRAFT_CREATED" }),
    });
  });

  it("rejects duplicate action keys", async () => {
    mockJson(event);
    mockNoRecord();

    await expect(
      saveCapaDraft({
        ...draftInput,
        actions: [draftInput.actions[0], { ...draftInput.actions[1], actionKey: "corrective-1" }],
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_ACTION_KEY" });
  });

  it("rejects action owners outside active organization membership", async () => {
    mockJson(event);
    mockNoRecord();
    mocks.membershipFindMany.mockResolvedValue([{ userId: "quality-2" }]);

    await expect(saveCapaDraft(draftInput)).rejects.toMatchObject({
      code: "ACTION_OWNER_NOT_FOUND",
    });
  });

  it("requires confirmed RCA before CAPA activation", async () => {
    mockJson(event);
    mockNoRecord();
    const draft = await saveCapaDraft(draftInput);

    mockJson(event);
    mockJson({ ...confirmedRootCause, status: "DRAFT" });

    await expect(
      activateCapa({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "ROOT_CAUSE_CONFIRMATION_REQUIRED" });

    expect(draft.status).toBe("DRAFT");
  });

  it("activates CAPA after confirmed RCA", async () => {
    mockJson(event);
    mockNoRecord();
    const draft = await saveCapaDraft(draftInput);

    mockJson(event);
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

  it("requires a completion note when completing an action", async () => {
    const active = {
      ...latestCapabase(),
      status: "ACTIVE" as const,
    };
    mockJson(event);
    mockJson(active);

    await expect(
      transitionCapaAction({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actionId: active.actions[0].id,
        transition: "COMPLETE",
        completionNote: " ",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "ACTION_COMPLETION_NOTE_REQUIRED" });
  });

  it("moves action execution from planned to in-progress to completed", async () => {
    const active = { ...latestCapabase(), status: "ACTIVE" as const };
    mockJson(event);
    mockJson(active);
    const started = await transitionCapaAction({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actionId: active.actions[0].id,
      transition: "START",
      actorId: "quality-1",
    });
    expect(started.actions[0].status).toBe("IN_PROGRESS");

    mockJson(event);
    mockJson(started);
    const completed = await transitionCapaAction({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actionId: active.actions[0].id,
      transition: "COMPLETE",
      completionNote: "Synthetic action completed and evidence recorded.",
      actorId: "quality-1",
    });
    expect(completed.actions[0]).toMatchObject({
      status: "COMPLETED",
      completionNote: "Synthetic action completed and evidence recorded.",
    });
  });

  it("blocks effectiveness readiness while open actions remain", async () => {
    const active = { ...latestCapabase(), status: "ACTIVE" as const };
    mockJson(event);
    mockJson(active);

    await expect(
      markCapaReadyForEffectiveness({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "OPEN_ACTIONS_REMAIN" });
  });

  it("moves CAPA to effectiveness only after every action is dispositioned", async () => {
    const active = {
      ...latestCapabase(),
      status: "ACTIVE" as const,
      actions: latestCapabase().actions.map((action, index) => ({
        ...action,
        status: index === 0 ? ("COMPLETED" as const) : ("CANCELLED" as const),
        completedAt: index === 0 ? "2026-08-18T00:00:00.000Z" : null,
        completionNote: "Synthetic disposition",
      })),
    };
    mockJson(event);
    mockJson(active);

    const ready = await markCapaReadyForEffectiveness({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
    expect(ready.status).toBe("READY_FOR_EFFECTIVENESS");
    expect(ready.readyForEffectivenessAt).toBeTruthy();
  });
});

function latestCapabase() {
  return {
    eventId: "event-1",
    organizationId: "org-a",
    siteId: "site-a",
    status: "DRAFT" as const,
    objective: "Remove confirmed cause",
    actions: [
      {
        id: "action-1",
        actionKey: "corrective-1",
        type: "CORRECTIVE" as const,
        title: "Correct synthetic cause",
        description: null,
        ownerId: "quality-2",
        dueAt: "2026-08-20T00:00:00.000Z",
        status: "PLANNED" as const,
        completionNote: null,
        completedAt: null,
      },
      {
        id: "action-2",
        actionKey: "preventive-1",
        type: "PREVENTIVE" as const,
        title: "Prevent synthetic recurrence",
        description: null,
        ownerId: "quality-3",
        dueAt: "2026-08-25T00:00:00.000Z",
        status: "PLANNED" as const,
        completionNote: null,
        completedAt: null,
      },
    ],
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    activatedAt: null,
    readyForEffectivenessAt: null,
  };
}
