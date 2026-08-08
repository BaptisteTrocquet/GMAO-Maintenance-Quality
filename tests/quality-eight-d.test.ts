import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  membershipFindFirst: vi.fn(),
  userFindMany: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    findMany: mocks.auditFindMany,
    create: mocks.auditCreate,
  },
  organizationMembership: { findFirst: mocks.membershipFindFirst },
  user: { findMany: mocks.userFindMany },
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

import { advanceEightD, saveEightDWorkspace } from "@/lib/quality/eight-d";

function event(contained = true) {
  return {
    organizationId: "org-a",
    siteId: "site-a",
    eventNumber: "QE-0001",
    title: "Synthetic quality event",
    status: "INVESTIGATING" as const,
    containment: {
      summary: "Synthetic immediate containment",
      completedAt: contained ? "2026-08-08T08:00:00.000Z" : null,
    },
  };
}

function rootCause(confirmed = true) {
  return {
    organizationId: "org-a",
    siteId: "site-a",
    status: confirmed ? ("CONFIRMED" as const) : ("DRAFT" as const),
    rootCauseSummary: confirmed ? "Synthetic confirmed root cause" : null,
    confirmedAt: confirmed ? "2026-08-09T08:00:00.000Z" : null,
  };
}

function capa(options?: { approved?: boolean; effective?: boolean; completed?: boolean }) {
  const approved = options?.approved ?? true;
  const effective = options?.effective ?? false;
  const completed = options?.completed ?? false;
  return {
    organizationId: "org-a",
    siteId: "site-a",
    status: effective ? ("CLOSED" as const) : approved ? ("ACTIVE" as const) : ("DRAFT" as const),
    approvedAt: approved ? "2026-08-10T08:00:00.000Z" : null,
    actions: [
      {
        id: "action-1",
        type: "CORRECTIVE" as const,
        title: "Correct synthetic cause",
        ownerId: "owner-1",
        dueAt: "2026-08-15T10:00:00.000Z",
        status: completed ? ("COMPLETED" as const) : ("OPEN" as const),
      },
    ],
    effectivenessChecks: effective
      ? [
          {
            result: "EFFECTIVE" as const,
            note: "No synthetic recurrence observed",
            verifiedById: "quality-2",
            verifiedAt: "2026-08-20T10:00:00.000Z",
          },
        ]
      : [],
  };
}

function eightD(
  currentDiscipline: "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "D8",
  overrides: Record<string, unknown> = {},
) {
  return {
    eventId: "event-1",
    organizationId: "org-a",
    siteId: "site-a",
    eventNumber: "QE-0001",
    eventTitle: "Synthetic quality event",
    status: currentDiscipline === "D1" ? ("DRAFT" as const) : ("IN_PROGRESS" as const),
    currentDiscipline,
    d1Team: [
      {
        userId: "quality-1",
        displayName: "Synthetic Quality Manager",
        responsibility: "Lead 8D",
      },
    ],
    d2ProblemStatement: "Synthetic problem statement",
    d3Containment: null,
    d4RootCause: null,
    d5Actions: [],
    d6Validation: null,
    d7PreventionSummary: "Standardize synthetic preventive controls",
    d7SystemicChanges: ["Update generic work instruction"],
    d8RecognitionNote: "Recognize the synthetic cross-functional team",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

const common = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  actorId: "quality-1",
};

describe("quality 8D workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.membershipFindFirst.mockResolvedValue({
      user: { id: "quality-1", displayName: "Synthetic Quality Manager" },
    });
    mocks.userFindMany.mockResolvedValue([{ id: "owner-1", displayName: "Synthetic Owner" }]);
  });

  it("creates D1 with frozen team labels from active site memberships", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce(null);

    const result = await saveEightDWorkspace({
      ...common,
      team: [{ userId: "quality-1", responsibility: "Lead 8D" }],
      problemStatement: "Synthetic problem statement",
    });

    expect(result.currentDiscipline).toBe("D1");
    expect(result.d1Team[0]).toMatchObject({
      userId: "quality-1",
      displayName: "Synthetic Quality Manager",
      responsibility: "Lead 8D",
    });
  });

  it("requires completed immediate containment to pass D3", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event(false)) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D3")) });

    await expect(advanceEightD(common)).rejects.toMatchObject({ code: "CONTAINMENT_REQUIRED" });
  });

  it("freezes completed containment when D3 advances", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event(true)) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D3")) });

    const result = await advanceEightD(common);
    expect(result.currentDiscipline).toBe("D4");
    expect(result.d3Containment).toEqual({
      summary: "Synthetic immediate containment",
      completedAt: "2026-08-08T08:00:00.000Z",
    });
  });

  it("requires confirmed RCA to pass D4", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D4")) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(rootCause(false)) });

    await expect(advanceEightD(common)).rejects.toMatchObject({ code: "ROOT_CAUSE_REQUIRED" });
  });

  it("requires approved CAPA and freezes permanent actions at D5", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D5")) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(capa({ approved: false })) });
    await expect(advanceEightD(common)).rejects.toMatchObject({ code: "CAPA_APPROVAL_REQUIRED" });

    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D5")) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(capa({ approved: true })) });
    const result = await advanceEightD(common);
    expect(result.currentDiscipline).toBe("D6");
    expect(result.d5Actions).toEqual([
      {
        id: "action-1",
        type: "CORRECTIVE",
        title: "Correct synthetic cause",
        ownerId: "owner-1",
        ownerName: "Synthetic Owner",
        dueAt: "2026-08-15T10:00:00.000Z",
      },
    ]);
  });

  it("requires completed actions and effective validation to pass D6", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D6")) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(capa({ approved: true, completed: true, effective: false })) });
    await expect(advanceEightD(common)).rejects.toMatchObject({ code: "CAPA_VALIDATION_REQUIRED" });

    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D6")) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(capa({ approved: true, completed: true, effective: true })) });
    const result = await advanceEightD(common);
    expect(result.currentDiscipline).toBe("D7");
    expect(result.d6Validation).toEqual({
      completedActionIds: ["action-1"],
      effectivenessNote: "No synthetic recurrence observed",
      verifiedById: "quality-2",
      verifiedAt: "2026-08-20T10:00:00.000Z",
    });
  });

  it("requires systemic prevention at D7", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({
        afterJson: JSON.stringify(eightD("D7", { d7PreventionSummary: "", d7SystemicChanges: [] })),
      });
    await expect(advanceEightD(common)).rejects.toMatchObject({ code: "PREVENTION_REQUIRED" });
  });

  it("completes D8 only after recognition note exists", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D8", { d8RecognitionNote: "" })) });
    await expect(advanceEightD(common)).rejects.toMatchObject({ code: "RECOGNITION_REQUIRED" });

    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D8")) });
    const result = await advanceEightD(common);
    expect(result.status).toBe("COMPLETED");
    expect(result.completedAt).toBeTruthy();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "EIGHT_D_COMPLETED" }),
    });
  });
});
