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

import {
  advanceEightD,
  getEightDWorkspace,
  saveEightDWorkspace,
  type EightDSnapshot,
} from "@/lib/quality/eight-d";

const event = {
  organizationId: "org-a",
  siteId: "site-a",
  eventNumber: "QE-000001",
  title: "Synthetic quality issue",
  status: "INVESTIGATING",
  containment: {
    summary: "Segregate affected material",
    completedAt: "2026-08-08T00:30:00.000Z",
  },
};

const rootCause = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "CONFIRMED",
  rootCauseSummary: "Controlled instruction was not available at the task point.",
  confirmedAt: "2026-08-08T01:00:00.000Z",
};

const capa = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "ACTIVE",
  actions: [
    {
      id: "action-1",
      type: "CORRECTIVE",
      title: "Publish controlled instruction",
      ownerId: "owner-1",
      dueAt: "2026-08-20T00:00:00.000Z",
      status: "OPEN",
      completionNote: null,
      completedAt: null,
    },
  ],
  effectivenessChecks: [],
};

function eightD(
  discipline: EightDSnapshot["currentDiscipline"],
  overrides: Partial<EightDSnapshot> = {},
): EightDSnapshot {
  return {
    eventId: "event-1",
    organizationId: "org-a",
    siteId: "site-a",
    eventNumber: "QE-000001",
    eventTitle: "Synthetic quality issue",
    version: 1,
    status: discipline === "D1" ? "DRAFT" : "IN_PROGRESS",
    currentDiscipline: discipline,
    d1Team: [
      { userId: "quality-1", displayName: "Demo Quality Lead", responsibility: "Lead 8D" },
    ],
    d2ProblemStatement: "Leakage recurred after startup.",
    d3Containment: null,
    d4RootCause: null,
    d5Actions: [],
    d6Implementation: null,
    d7PreventionSummary: "Standardize point-of-use controlled instructions.",
    d7SystemicChanges: ["Add document availability to maintenance release checklist"],
    d8RecognitionNote: "Team reviewed results and closed the 8D.",
    d8Effectiveness: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

function routeSnapshots(options: {
  currentEightD?: EightDSnapshot | null;
  currentEvent?: Record<string, unknown>;
  currentRootCause?: Record<string, unknown> | null;
  currentCapa?: Record<string, unknown> | null;
} = {}) {
  mocks.auditFindFirst.mockImplementation(async ({ where }: { where: { entityType: string } }) => {
    if (where.entityType === "QualityEvent") {
      return { afterJson: JSON.stringify(options.currentEvent ?? event) };
    }
    if (where.entityType === "QualityRootCause") {
      return options.currentRootCause === null
        ? null
        : { afterJson: JSON.stringify(options.currentRootCause ?? rootCause) };
    }
    if (where.entityType === "QualityCapa") {
      return options.currentCapa === null
        ? null
        : { afterJson: JSON.stringify(options.currentCapa ?? capa) };
    }
    if (where.entityType === "QualityEightD") {
      return options.currentEightD
        ? { afterJson: JSON.stringify(options.currentEightD) }
        : null;
    }
    return null;
  });
}

describe("quality 8D workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.membershipFindFirst.mockResolvedValue({
      user: { id: "quality-1", displayName: "Demo Quality Lead" },
    });
    mocks.userFindMany.mockResolvedValue([
      { id: "owner-1", displayName: "Demo Action Owner" },
    ]);
    routeSnapshots();
  });

  it("creates D1 with only active site-authorized team members and frozen names", async () => {
    const result = await saveEightDWorkspace({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      team: [{ userId: "quality-1", responsibility: "Lead 8D" }],
      actorId: "quality-1",
    });

    expect(result.currentDiscipline).toBe("D1");
    expect(result.version).toBe(1);
    expect(result.d1Team).toEqual([
      { userId: "quality-1", displayName: "Demo Quality Lead", responsibility: "Lead 8D" },
    ]);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "quality-8d:event-1:v1",
        entityType: "QualityEightD",
        action: "EIGHT_D_CREATED",
      }),
    });
  });

  it("requires D1 team before advancing", async () => {
    routeSnapshots({ currentEightD: eightD("D1", { d1Team: [] }) });
    await expect(
      advanceEightD({ organizationId: "org-a", siteId: "site-a", eventId: "event-1", actorId: "quality-1" }),
    ).rejects.toMatchObject({ code: "TEAM_REQUIRED" });
  });

  it("requires D2 problem statement before advancing", async () => {
    routeSnapshots({ currentEightD: eightD("D2", { d2ProblemStatement: "" }) });
    await expect(
      advanceEightD({ organizationId: "org-a", siteId: "site-a", eventId: "event-1", actorId: "quality-1" }),
    ).rejects.toMatchObject({ code: "PROBLEM_STATEMENT_REQUIRED" });
  });

  it("freezes completed containment evidence at D3", async () => {
    routeSnapshots({ currentEightD: eightD("D3") });
    const result = await advanceEightD({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
    expect(result.currentDiscipline).toBe("D4");
    expect(result.d3Containment).toEqual(event.containment);
  });

  it("requires confirmed root cause and freezes the D4 conclusion", async () => {
    routeSnapshots({ currentEightD: eightD("D4") });
    const result = await advanceEightD({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
    expect(result.currentDiscipline).toBe("D5");
    expect(result.d4RootCause).toEqual({
      summary: rootCause.rootCauseSummary,
      confirmedAt: rootCause.confirmedAt,
    });
  });

  it("requires an approved CAPA and freezes permanent actions at D5", async () => {
    routeSnapshots({ currentEightD: eightD("D5") });
    const result = await advanceEightD({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
    expect(result.currentDiscipline).toBe("D6");
    expect(result.d5Actions).toEqual([
      expect.objectContaining({
        id: "action-1",
        type: "CORRECTIVE",
        ownerId: "owner-1",
        ownerName: "Demo Action Owner",
      }),
    ]);
  });

  it("requires completion evidence for every CAPA action at D6", async () => {
    routeSnapshots({ currentEightD: eightD("D6") });
    await expect(
      advanceEightD({ organizationId: "org-a", siteId: "site-a", eventId: "event-1", actorId: "quality-1" }),
    ).rejects.toMatchObject({ code: "CAPA_ACTIONS_INCOMPLETE" });

    const completedCapa = {
      ...capa,
      actions: [
        {
          ...capa.actions[0],
          status: "COMPLETED",
          completionNote: "Approved instruction published at point of use",
          completedAt: "2026-08-15T12:00:00.000Z",
        },
      ],
    };
    routeSnapshots({ currentEightD: eightD("D6"), currentCapa: completedCapa });
    const result = await advanceEightD({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });
    expect(result.currentDiscipline).toBe("D7");
    expect(result.d6Implementation?.actions[0]).toMatchObject({
      actionId: "action-1",
      completionNote: "Approved instruction published at point of use",
    });
  });

  it("requires systemic prevention evidence before D8", async () => {
    routeSnapshots({
      currentEightD: eightD("D7", { d7PreventionSummary: "", d7SystemicChanges: [] }),
    });
    await expect(
      advanceEightD({ organizationId: "org-a", siteId: "site-a", eventId: "event-1", actorId: "quality-1" }),
    ).rejects.toMatchObject({ code: "PREVENTION_REQUIRED" });
  });

  it("completes D8 only after CAPA is closed with latest effectiveness EFFECTIVE", async () => {
    const finalEightD = eightD("D8");
    const closedCapa = {
      ...capa,
      status: "CLOSED",
      actions: [
        {
          ...capa.actions[0],
          status: "COMPLETED",
          completionNote: "Instruction deployed",
          completedAt: "2026-08-15T12:00:00.000Z",
        },
      ],
      effectivenessChecks: [
        {
          result: "EFFECTIVE",
          note: "No recurrence during the verified review window",
          verifiedById: "quality-2",
          verifiedAt: "2026-09-20T12:00:00.000Z",
        },
      ],
    };
    routeSnapshots({ currentEightD: finalEightD, currentCapa: closedCapa });

    const result = await advanceEightD({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.currentDiscipline).toBe("D8");
    expect(result.completedAt).toBeTruthy();
    expect(result.d8Effectiveness).toEqual({
      note: "No recurrence during the verified review window",
      verifiedById: "quality-2",
      verifiedAt: "2026-09-20T12:00:00.000Z",
    });
  });

  it("does not expose 8D workspace across tenant scope", async () => {
    routeSnapshots({ currentEightD: eightD("D4") });
    const workspace = await getEightDWorkspace({
      organizationId: "org-b",
      siteId: "site-b",
      eventId: "event-1",
    });
    expect(workspace).toBeNull();
  });
});
