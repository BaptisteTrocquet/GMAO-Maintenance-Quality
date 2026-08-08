import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapaSnapshot } from "@/lib/quality/capa";
import type { EightDSnapshot } from "@/lib/quality/eight-d";

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
  resetEightDAfterIneffectiveCapa,
  saveEightDWorkspace,
} from "@/lib/quality/eight-d";

const event = {
  organizationId: "org-a",
  siteId: "site-a",
  eventNumber: "QE-0001",
  title: "Synthetic dimensional nonconformity",
  status: "INVESTIGATING" as const,
  containment: {
    summary: "Segregate synthetic affected material.",
    completedAt: "2026-08-08T08:00:00.000Z",
  },
};

const rootCause = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "CONFIRMED" as const,
  rootCauseSummary: "Fixture retention was not controlled.",
  confirmedAt: "2026-08-09T08:00:00.000Z",
};

function baseEightD(discipline: EightDSnapshot["currentDiscipline"]): EightDSnapshot {
  return {
    eventId: "event-1",
    organizationId: "org-a",
    siteId: "site-a",
    eventNumber: "QE-0001",
    eventTitle: event.title,
    status: discipline === "D1" ? "DRAFT" : "IN_PROGRESS",
    currentDiscipline: discipline,
    d1Team: [
      { userId: "user-1", displayName: "Synthetic Quality Lead", responsibility: "8D lead" },
    ],
    d2ProblemStatement: "Synthetic part exceeds the defined dimensional limit.",
    d2ImpactScope: "One synthetic lot on one site.",
    d3Containment: {
      summary: event.containment.summary,
      completedAt: event.containment.completedAt,
    },
    d4RootCause: {
      summary: rootCause.rootCauseSummary,
      confirmedAt: rootCause.confirmedAt,
      escapePoint: "Final inspection did not verify fixture retention.",
    },
    d4EscapePointDraft: "Final inspection did not verify fixture retention.",
    d5Actions: [],
    d6Implementation: null,
    d6ValidationNoteDraft: "Three verification runs met acceptance criteria.",
    d7PreventionSummary: "Standardize retention checks across similar fixtures.",
    d7SystemicChanges: ["Add retention verification to preventive checklist"],
    d8RecognitionNote: "Recognize the cross-functional response team.",
    d8LessonsLearned: "Detection controls must cover fixture integrity as well as product output.",
    createdAt: "2026-08-08T07:00:00.000Z",
    updatedAt: "2026-08-09T09:00:00.000Z",
    completedAt: null,
  };
}

function capa(status: CapaSnapshot["status"] = "ACTIVE"): CapaSnapshot {
  return {
    eventId: "event-1",
    organizationId: "org-a",
    siteId: "site-a",
    status,
    planSummary: "Synthetic permanent corrective and preventive plan.",
    actions: [
      {
        id: "ca-1",
        type: "CORRECTIVE",
        title: "Replace the fixture retention mechanism",
        description: null,
        ownerId: "user-1",
        dueAt: "2026-08-15T08:00:00.000Z",
        status: "COMPLETED",
        completionNote: "Replacement and verification completed.",
        completedById: "quality-1",
        completedAt: "2026-08-14T08:00:00.000Z",
      },
      {
        id: "pa-1",
        type: "PREVENTIVE",
        title: "Add retention verification to periodic checks",
        description: null,
        ownerId: "user-2",
        dueAt: "2026-08-16T08:00:00.000Z",
        status: "COMPLETED",
        completionNote: "Checklist updated and briefed.",
        completedById: "quality-1",
        completedAt: "2026-08-15T08:00:00.000Z",
      },
    ],
    approvedById: "quality-1",
    approvedAt: "2026-08-10T08:00:00.000Z",
    effectivenessChecks:
      status === "CLOSED"
        ? [
            {
              result: "EFFECTIVE",
              note: "No recurrence during the follow-up window.",
              verifiedById: "quality-2",
              verifiedAt: "2026-08-20T08:00:00.000Z",
            },
          ]
        : [],
    createdAt: "2026-08-10T07:00:00.000Z",
    updatedAt: "2026-08-20T08:00:00.000Z",
    closedAt: status === "CLOSED" ? "2026-08-20T08:00:00.000Z" : null,
  };
}

function audit(value: unknown) {
  return { afterJson: JSON.stringify(value) };
}

function mockEventAndEightD(snapshot: EightDSnapshot) {
  mocks.auditFindFirst
    .mockResolvedValueOnce(audit(event))
    .mockResolvedValueOnce(audit(snapshot));
}

describe("integrated quality 8D workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.membershipFindFirst.mockResolvedValue({
      user: { id: "user-1", displayName: "Synthetic Quality Lead" },
    });
    mocks.userFindMany.mockResolvedValue([
      { id: "user-1", displayName: "Synthetic Quality Lead" },
      { id: "user-2", displayName: "Synthetic Maintenance Lead" },
    ]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("freezes D1 team names and responsibilities from site-authorized members", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce(audit(event))
      .mockResolvedValueOnce(null);

    const result = await saveEightDWorkspace({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      team: [{ userId: "user-1", responsibility: "8D lead" }],
      actorId: "quality-1",
    });

    expect(result.d1Team).toEqual([
      { userId: "user-1", displayName: "Synthetic Quality Lead", responsibility: "8D lead" },
    ]);
  });

  it("requires completed containment before D3 can advance", async () => {
    const d3 = baseEightD("D3");
    mocks.auditFindFirst
      .mockResolvedValueOnce(audit({ ...event, containment: { summary: event.containment.summary, completedAt: null } }))
      .mockResolvedValueOnce(audit(d3));

    await expect(
      advanceEightD({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "CONTAINMENT_REQUIRED" });
  });

  it("freezes confirmed root cause plus escape point at D4", async () => {
    const d4 = baseEightD("D4");
    mockEventAndEightD(d4);
    mocks.auditFindFirst.mockResolvedValueOnce(audit(rootCause));

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
      escapePoint: "Final inspection did not verify fixture retention.",
    });
  });

  it("requires an approved CAPA with corrective actions at D5 and freezes owner names", async () => {
    const d5 = baseEightD("D5");
    mockEventAndEightD(d5);
    mocks.auditFindFirst.mockResolvedValueOnce(audit(capa("ACTIVE")));

    const result = await advanceEightD({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    expect(result.currentDiscipline).toBe("D6");
    expect(result.d5Actions).toEqual([
      expect.objectContaining({ id: "ca-1", type: "CORRECTIVE", ownerName: "Synthetic Quality Lead" }),
      expect.objectContaining({ id: "pa-1", type: "PREVENTIVE", ownerName: "Synthetic Maintenance Lead" }),
    ]);
  });

  it("requires selected corrective actions complete and validation evidence at D6", async () => {
    const d6 = {
      ...baseEightD("D6"),
      d5Actions: [
        {
          id: "ca-1",
          type: "CORRECTIVE" as const,
          title: "Replace the fixture retention mechanism",
          ownerId: "user-1",
          ownerName: "Synthetic Quality Lead",
          dueAt: "2026-08-15T08:00:00.000Z",
        },
      ],
    };
    mockEventAndEightD(d6);
    mocks.auditFindFirst.mockResolvedValueOnce(audit(capa("ACTIVE")));

    const result = await advanceEightD({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    expect(result.currentDiscipline).toBe("D7");
    expect(result.d6Implementation).toMatchObject({
      completedActionIds: ["ca-1"],
      validationNote: "Three verification runs met acceptance criteria.",
    });
  });

  it("requires completed preventive action and systemic prevention at D7", async () => {
    const d7 = baseEightD("D7");
    mockEventAndEightD(d7);
    const incomplete = capa("ACTIVE");
    incomplete.actions[1] = { ...incomplete.actions[1], status: "OPEN", completionNote: null, completedById: null, completedAt: null };
    mocks.auditFindFirst.mockResolvedValueOnce(audit(incomplete));

    await expect(
      advanceEightD({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "PREVENTION_REQUIRED" });
  });

  it("closes D8 only after CAPA effectiveness and closure evidence", async () => {
    const d8 = baseEightD("D8");
    mockEventAndEightD(d8);
    mocks.auditFindFirst.mockResolvedValueOnce(audit(capa("CLOSED")));

    const result = await advanceEightD({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.completedAt).toBeTruthy();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "EIGHT_D_COMPLETED", entityType: "QualityEightD" }),
    });
  });

  it("resets D5-D8 evidence after an ineffective CAPA so revised actions are reselected", async () => {
    const d8 = baseEightD("D8");
    d8.d5Actions = [
      {
        id: "ca-old",
        type: "CORRECTIVE",
        title: "Old action",
        ownerId: "user-1",
        ownerName: "Synthetic Quality Lead",
        dueAt: "2026-08-15T08:00:00.000Z",
      },
    ];
    d8.d6Implementation = {
      completedActionIds: ["ca-old"],
      validationNote: "Old validation",
      validatedAt: "2026-08-16T08:00:00.000Z",
    };
    const ineffective = capa("DRAFT");
    ineffective.approvedById = null;
    ineffective.approvedAt = null;
    ineffective.effectivenessChecks = [
      {
        result: "INEFFECTIVE",
        note: "Failure recurred.",
        verifiedById: "quality-2",
        verifiedAt: "2026-08-20T08:00:00.000Z",
      },
    ];

    mockEventAndEightD(d8);
    mocks.auditFindFirst.mockResolvedValueOnce(audit(ineffective));

    const result = await resetEightDAfterIneffectiveCapa({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    expect(result).toMatchObject({
      currentDiscipline: "D5",
      d5Actions: [],
      d6Implementation: null,
      d7PreventionSummary: "",
      d7SystemicChanges: [],
      d8RecognitionNote: "",
      d8LessonsLearned: "",
    });
  });
});
