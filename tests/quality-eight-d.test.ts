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

import { advanceEightD, saveEightDWorkspace } from "@/lib/quality/eight-d";

function event(options?: { contained?: boolean }) {
  return {
    organizationId: "org-a",
    siteId: "site-a",
    eventNumber: "QE-0001",
    title: "Synthetic quality event",
    status: "INVESTIGATING" as const,
    containment: options?.contained === false
      ? { summary: "Temporary synthetic containment", completedAt: null }
      : { summary: "Completed synthetic containment", completedAt: "2026-08-08T08:00:00.000Z" },
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

function capa(options?: {
  status?: "DRAFT" | "ACTIVE" | "VERIFYING" | "EFFECTIVE" | "INEFFECTIVE";
  completed?: boolean;
  verificationStarted?: boolean;
}) {
  const completed = options?.completed ?? false;
  const status = options?.status ?? "ACTIVE";
  return {
    organizationId: "org-a",
    siteId: "site-a",
    status,
    actions: [
      {
        id: "action-1",
        type: "CORRECTIVE" as const,
        title: "Correct synthetic cause",
        ownerId: "owner-1",
        ownerName: "Synthetic Owner",
        dueAt: "2026-08-15T10:00:00.000Z",
        status: completed ? ("COMPLETED" as const) : ("OPEN" as const),
      },
    ],
    verificationPlan: {
      method: "Review synthetic recurrence data",
      acceptanceCriteria: "No recurrence",
    },
    verificationStartedAt: options?.verificationStarted
      ? "2026-08-16T10:00:00.000Z"
      : null,
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
    d6Implementation: null,
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
  });

  it("creates D1 with frozen team labels from active site memberships", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce(null);

    const result = await saveEightDWorkspace({
      ...common,
      team: [{ userId: "quality-1", responsibility: "Lead 8D" }],
      problemStatement: "Synthetic problem statement",
      actorId: "quality-1",
    });

    expect(result.currentDiscipline).toBe("D1");
    expect(result.d1Team).toEqual([
      {
        userId: "quality-1",
        displayName: "Synthetic Quality Manager",
        responsibility: "Lead 8D",
      },
    ]);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ entityType: "QualityEightD", action: "EIGHT_D_CREATED" }),
    });
  });

  it("requires completed immediate containment to pass D3", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event({ contained: false })) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D3")) });

    await expect(advanceEightD(common)).rejects.toMatchObject({ code: "CONTAINMENT_REQUIRED" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("freezes completed containment when D3 advances", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D3")) });

    const result = await advanceEightD(common);
    expect(result.currentDiscipline).toBe("D4");
    expect(result.d3Containment).toEqual({
      summary: "Completed synthetic containment",
      completedAt: "2026-08-08T08:00:00.000Z",
    });
  });

  it("requires confirmed RCA to pass D4 and freezes the root-cause summary", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D4")) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(rootCause(false)) });
    await expect(advanceEightD(common)).rejects.toMatchObject({ code: "ROOT_CAUSE_REQUIRED" });

    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D4")) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(rootCause(true)) });
    const result = await advanceEightD(common);
    expect(result.currentDiscipline).toBe("D5");
    expect(result.d4RootCause).toEqual({
      summary: "Synthetic confirmed root cause",
      confirmedAt: "2026-08-09T08:00:00.000Z",
    });
  });

  it("requires an activated CAPA to select permanent actions at D5", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D5")) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(capa({ status: "DRAFT" })) });
    await expect(advanceEightD(common)).rejects.toMatchObject({ code: "CAPA_REQUIRED" });

    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D5")) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(capa({ status: "ACTIVE" })) });
    const result = await advanceEightD(common);
    expect(result.currentDiscipline).toBe("D6");
    expect(result.d5Actions).toEqual([
      expect.objectContaining({ id: "action-1", type: "CORRECTIVE", ownerName: "Synthetic Owner" }),
    ]);
  });

  it("blocks D6 until every CAPA action is complete and verification has started", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D6")) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(capa({ status: "ACTIVE", completed: false })) });
    await expect(advanceEightD(common)).rejects.toMatchObject({ code: "CAPA_ACTIONS_INCOMPLETE" });

    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D6")) })
      .mockResolvedValueOnce({
        afterJson: JSON.stringify(
          capa({ status: "VERIFYING", completed: true, verificationStarted: true }),
        ),
      });
    const result = await advanceEightD(common);
    expect(result.currentDiscipline).toBe("D7");
    expect(result.d6Implementation).toMatchObject({
      completedActionIds: ["action-1"],
      verificationMethod: "Review synthetic recurrence data",
    });
  });

  it("requires systemic prevention at D7", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({
        afterJson: JSON.stringify(
          eightD("D7", { d7PreventionSummary: "", d7SystemicChanges: [] }),
        ),
      });
    await expect(advanceEightD(common)).rejects.toMatchObject({ code: "PREVENTION_REQUIRED" });
  });

  it("completes D8 only after effective CAPA and a recognition note", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D8")) })
      .mockResolvedValueOnce({
        afterJson: JSON.stringify(
          capa({ status: "INEFFECTIVE", completed: true, verificationStarted: true }),
        ),
      });
    await expect(advanceEightD(common)).rejects.toMatchObject({ code: "EFFECTIVE_CAPA_REQUIRED" });

    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event()) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(eightD("D8")) })
      .mockResolvedValueOnce({
        afterJson: JSON.stringify(
          capa({ status: "EFFECTIVE", completed: true, verificationStarted: true }),
        ),
      });
    const result = await advanceEightD(common);
    expect(result.status).toBe("COMPLETED");
    expect(result.completedAt).toBeTruthy();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "EIGHT_D_COMPLETED" }),
    });
  });
});
