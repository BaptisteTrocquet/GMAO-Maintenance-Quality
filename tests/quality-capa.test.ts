import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  auditFindFirst: vi.fn(),
  auditCreate: vi.fn(),
  auditFindMany: vi.fn(),
  membershipFindMany: vi.fn(),
}));

const tx = {
  auditLog: {
    findFirst: mocks.auditFindFirst,
    create: mocks.auditCreate,
    findMany: mocks.auditFindMany,
  },
  organizationMembership: {
    findMany: mocks.membershipFindMany,
  },
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
  saveCapaWorkspace,
  submitEffectivenessReview,
  transitionCapaAction,
  verifyCapaEffectiveness,
} from "@/lib/quality/capa";
import { assertCapaClosedForEvent } from "@/lib/quality/capa-closure";

const event = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "INVESTIGATING",
};

let rootCauseStatus: "DRAFT" | "CONFIRMED";
let currentCapa: Record<string, unknown> | null;

function capaAfterJson() {
  return currentCapa ? JSON.stringify(currentCapa) : null;
}

function installStatefulAuditMocks() {
  mocks.auditFindFirst.mockImplementation(async ({ where }: { where: { entityType: string } }) => {
    if (where.entityType === "QualityEvent") return { afterJson: JSON.stringify(event) };
    if (where.entityType === "QualityRootCause") {
      return {
        afterJson: JSON.stringify({
          organizationId: "org-a",
          siteId: "site-a",
          status: rootCauseStatus,
        }),
      };
    }
    if (where.entityType === "QualityCapa") {
      return currentCapa ? { afterJson: capaAfterJson() } : null;
    }
    return null;
  });
  mocks.auditCreate.mockImplementation(async ({ data }: { data: { entityType: string; afterJson?: string | null } }) => {
    if (data.entityType === "QualityCapa" && data.afterJson) {
      currentCapa = JSON.parse(data.afterJson) as Record<string, unknown>;
    }
    return { id: `audit-${mocks.auditCreate.mock.calls.length}` };
  });
}

const base = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  actorId: "manager-1",
};

const firstAction = {
  id: "action-1",
  type: "CORRECTIVE" as const,
  title: "Replace damaged seal",
  description: "Install revised seal specification",
  ownerId: "owner-1",
  dueAt: new Date("2026-09-01T12:00:00.000Z"),
};

describe("quality CAPA workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentCapa = null;
    rootCauseStatus = "CONFIRMED";
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.membershipFindMany.mockImplementation(async ({ where }: { where: { userId: { in: string[] } } }) =>
      where.userId.in.map((userId) => ({
        userId,
        user: { displayName: userId === "owner-1" ? "Owner One" : "Quality Reviewer" },
      })),
    );
    mocks.auditFindMany.mockResolvedValue([]);
    installStatefulAuditMocks();
  });

  it("creates a draft with frozen owner names and activates only after RCA confirmation", async () => {
    const draft = await saveCapaWorkspace({
      ...base,
      objective: "Eliminate recurrence of the seal failure",
      actions: [firstAction],
    });

    expect(draft.status).toBe("DRAFT");
    expect(draft.actions[0]).toMatchObject({
      id: "action-1",
      ownerId: "owner-1",
      ownerName: "Owner One",
      status: "OPEN",
    });

    const active = await activateCapa(base);
    expect(active.status).toBe("ACTIVE");
    expect(active.activatedAt).toBeTruthy();
  });

  it("rejects activation while root cause remains draft", async () => {
    await saveCapaWorkspace({
      ...base,
      objective: "Prevent recurrence",
      actions: [firstAction],
    });
    rootCauseStatus = "DRAFT";

    await expect(activateCapa(base)).rejects.toMatchObject({
      code: "ROOT_CAUSE_CONFIRMATION_REQUIRED",
    });
  });

  it("requires completion evidence and preserves completed action history", async () => {
    await saveCapaWorkspace({
      ...base,
      objective: "Prevent recurrence",
      actions: [firstAction],
    });
    await activateCapa(base);

    await expect(
      transitionCapaAction({
        ...base,
        actionId: "action-1",
        status: "COMPLETED",
      }),
    ).rejects.toMatchObject({ code: "ACTION_EVIDENCE_REQUIRED" });

    const completed = await transitionCapaAction({
      ...base,
      actionId: "action-1",
      status: "COMPLETED",
      evidence: "Replacement verified against work record WR-001",
    });
    expect(completed.actions[0]).toMatchObject({
      status: "COMPLETED",
      completionEvidence: "Replacement verified against work record WR-001",
    });
  });

  it("moves through effectiveness review and closes only on an effective verdict", async () => {
    await saveCapaWorkspace({
      ...base,
      objective: "Prevent recurrence",
      actions: [firstAction],
    });
    await activateCapa(base);
    await transitionCapaAction({
      ...base,
      actionId: "action-1",
      status: "COMPLETED",
      evidence: "Action evidence",
    });

    const review = await submitEffectivenessReview({
      ...base,
      method: "Review 30 days of repeat failures",
      ownerId: "reviewer-1",
      dueAt: new Date("2026-10-01T12:00:00.000Z"),
    });
    expect(review.status).toBe("EFFECTIVENESS_REVIEW");
    expect(review.effectiveness?.result).toBe("PENDING");

    const closed = await verifyCapaEffectiveness({
      ...base,
      result: "EFFECTIVE",
      evidence: "No recurrence observed during the verification window",
    });
    expect(closed.status).toBe("CLOSED");
    expect(closed.effectiveness?.result).toBe("EFFECTIVE");
    expect(closed.closedAt).toBeTruthy();
  });

  it("requires a follow-up action after an ineffective verification", async () => {
    await saveCapaWorkspace({
      ...base,
      objective: "Prevent recurrence",
      actions: [firstAction],
    });
    await activateCapa(base);
    await transitionCapaAction({
      ...base,
      actionId: "action-1",
      status: "COMPLETED",
      evidence: "Initial action evidence",
    });
    await submitEffectivenessReview({
      ...base,
      method: "Trend repeat events",
      ownerId: "reviewer-1",
      dueAt: new Date("2026-10-01T12:00:00.000Z"),
    });
    const reopened = await verifyCapaEffectiveness({
      ...base,
      result: "INEFFECTIVE",
      evidence: "Repeat failure detected",
    });
    expect(reopened.status).toBe("ACTIVE");

    await expect(
      submitEffectivenessReview({
        ...base,
        method: "Repeat trend review",
        ownerId: "reviewer-1",
        dueAt: new Date("2026-11-01T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "FOLLOW_UP_ACTION_REQUIRED" });
  });

  it("blocks quality-event closure while a CAPA exists but is incomplete", async () => {
    await saveCapaWorkspace({
      ...base,
      objective: "Prevent recurrence",
      actions: [firstAction],
    });

    await expect(
      assertCapaClosedForEvent({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
      }),
    ).rejects.toMatchObject({ code: "CAPA_INCOMPLETE" });
  });
});
