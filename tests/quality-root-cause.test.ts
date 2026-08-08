import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    findMany: mocks.auditFindMany,
    create: mocks.auditCreate,
  },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: mocks.transaction,
    auditLog: { findMany: mocks.auditFindMany },
  },
}));

import {
  getRootCauseAnalysis,
  saveRootCauseAnalysis,
  transitionRootCauseAnalysis,
  type RootCauseAnalysisSnapshot,
} from "@/lib/quality/root-cause";

function qualityEvent(status = "INVESTIGATING") {
  return {
    afterJson: JSON.stringify({
      id: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      status,
    }),
  };
}

function analysis(overrides: Partial<RootCauseAnalysisSnapshot> = {}): RootCauseAnalysisSnapshot {
  return {
    id: "event-1",
    version: 1,
    organizationId: "org-a",
    siteId: "site-a",
    qualityEventId: "event-1",
    status: "DRAFT",
    problemStatement: "Repeated leakage after startup",
    fiveWhys: [
      { sequence: 1, answer: "Seal failed" },
      { sequence: 2, answer: "Seal was damaged" },
      { sequence: 3, answer: "Installation force was excessive" },
      { sequence: 4, answer: "No installation guide was used" },
      { sequence: 5, answer: "The work instruction was missing from the task" },
    ],
    rootCauseConclusion: "The task lacked the controlled installation instruction.",
    createdById: "quality-1",
    completedById: null,
    completedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("quality root-cause analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditFindFirst.mockResolvedValue(qualityEvent());
    mocks.auditFindMany.mockResolvedValue([]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("creates a versioned 5 Why draft while the event is investigating", async () => {
    const result = await saveRootCauseAnalysis({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      problemStatement: "Repeated leakage after startup",
      fiveWhys: ["Seal failed", "Seal was damaged"],
      actorId: "quality-1",
    });

    expect(result.status).toBe("DRAFT");
    expect(result.version).toBe(1);
    expect(result.fiveWhys).toEqual([
      { sequence: 1, answer: "Seal failed" },
      { sequence: 2, answer: "Seal was damaged" },
    ]);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "quality-root-cause:event-1:v1",
        entityType: "QualityRootCauseAnalysis",
        entityId: "event-1",
        action: "RCA_CREATED",
        actorId: "quality-1",
      }),
    });
  });

  it("rejects a blank problem statement at the domain boundary", async () => {
    await expect(
      saveRootCauseAnalysis({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        problemStatement: "   ",
        fiveWhys: [],
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "PROBLEM_STATEMENT_REQUIRED" });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects invalid 5 Why evidence at the domain boundary", async () => {
    await expect(
      saveRootCauseAnalysis({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        problemStatement: "Leakage",
        fiveWhys: ["First cause", "   "],
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "FIVE_WHYS_INVALID" });

    await expect(
      saveRootCauseAnalysis({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        problemStatement: "Leakage",
        fiveWhys: ["1", "2", "3", "4", "5", "6"],
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "FIVE_WHYS_INVALID" });
  });

  it("blocks root-cause editing before investigation starts", async () => {
    mocks.auditFindFirst.mockResolvedValue(qualityEvent("CONTAINED"));

    await expect(
      saveRootCauseAnalysis({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        problemStatement: "Leakage",
        fiveWhys: [],
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "INVESTIGATION_REQUIRED" });

    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("requires all five Why answers before completion", async () => {
    const draft = analysis({
      fiveWhys: [
        { sequence: 1, answer: "Seal failed" },
        { sequence: 2, answer: "Seal was damaged" },
      ],
    });
    mocks.auditFindMany.mockResolvedValue([{ afterJson: JSON.stringify(draft) }]);

    await expect(
      transitionRootCauseAnalysis({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        action: "COMPLETE",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "FIVE_WHYS_INCOMPLETE" });
  });

  it("requires a root-cause conclusion before completion", async () => {
    const draft = analysis({ rootCauseConclusion: null });
    mocks.auditFindMany.mockResolvedValue([{ afterJson: JSON.stringify(draft) }]);

    await expect(
      transitionRootCauseAnalysis({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        action: "COMPLETE",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "ROOT_CAUSE_CONCLUSION_REQUIRED" });
  });

  it("completes a full 5 Why analysis with an immutable audit revision", async () => {
    const draft = analysis();
    mocks.auditFindMany.mockResolvedValue([{ afterJson: JSON.stringify(draft) }]);

    const result = await transitionRootCauseAnalysis({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      action: "COMPLETE",
      actorId: "quality-2",
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.version).toBe(2);
    expect(result.completedById).toBe("quality-2");
    expect(result.completedAt).toBeTruthy();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "quality-root-cause:event-1:v2",
        action: "RCA_COMPLETED",
      }),
    });
  });

  it("requires reopening before a completed analysis can be edited", async () => {
    const completed = analysis({
      status: "COMPLETED",
      completedById: "quality-1",
      completedAt: "2026-08-08T01:00:00.000Z",
    });
    mocks.auditFindMany.mockResolvedValue([{ afterJson: JSON.stringify(completed) }]);

    await expect(
      saveRootCauseAnalysis({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        problemStatement: "Changed",
        fiveWhys: ["Changed"],
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "ANALYSIS_COMPLETED" });
  });

  it("reopens completed analysis as a new audited draft version", async () => {
    const completed = analysis({
      status: "COMPLETED",
      completedById: "quality-1",
      completedAt: "2026-08-08T01:00:00.000Z",
    });
    mocks.auditFindMany.mockResolvedValue([{ afterJson: JSON.stringify(completed) }]);

    const result = await transitionRootCauseAnalysis({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      action: "REOPEN",
      actorId: "quality-2",
    });

    expect(result.status).toBe("DRAFT");
    expect(result.version).toBe(2);
    expect(result.completedAt).toBeNull();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "RCA_REOPENED" }),
    });
  });

  it("does not expose a root-cause snapshot across tenant scope", async () => {
    const draft = analysis();
    mocks.auditFindMany.mockResolvedValue([{ afterJson: JSON.stringify(draft) }]);

    const result = await getRootCauseAnalysis({
      organizationId: "org-b",
      siteId: "site-b",
      eventId: "event-1",
    });

    expect(result).toBeNull();
  });
});
