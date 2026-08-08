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
  approveEightD,
  closeEightD,
  getEightDWorkspace,
  recordEightDPrevention,
  saveEightDDraft,
} from "@/lib/quality/eight-d";

const event = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "INVESTIGATING",
  containment: {
    summary: "Segregate affected material and verify the process before release.",
    completedAt: "2026-08-08T00:00:00.000Z",
  },
};
const rootCause = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "CONFIRMED",
  rootCauseSummary: "A synthetic setup control was missing.",
};
const closedCapa = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "CLOSED",
  actions: [{ status: "COMPLETED" }],
  effectivenessChecks: [{ result: "EFFECTIVE" }],
};

const draftInput = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  leaderId: "leader-1",
  teamMemberIds: ["leader-1", "member-2"],
  problemStatement: "A synthetic process output failed its acceptance criterion during routine verification.",
  actorId: "quality-1",
};

function mockContext(input?: {
  event?: unknown;
  rootCause?: unknown | null;
  capa?: unknown | null;
  eightD?: unknown | null;
}) {
  mocks.auditFindFirst
    .mockResolvedValueOnce({ afterJson: JSON.stringify(input?.event ?? event) })
    .mockResolvedValueOnce(
      input?.rootCause === null
        ? null
        : { afterJson: JSON.stringify(input?.rootCause ?? rootCause) },
    )
    .mockResolvedValueOnce(
      input?.capa === null ? null : { afterJson: JSON.stringify(input?.capa ?? closedCapa) },
    )
    .mockResolvedValueOnce(
      input?.eightD ? { afterJson: JSON.stringify(input.eightD) } : null,
    );
}

describe("quality 8D workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.membershipFindFirst.mockResolvedValue({ id: "membership-1" });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
  });

  it("creates a draft with a site-valid leader, team and D2 problem statement", async () => {
    mockContext({ rootCause: null, capa: null });

    const result = await saveEightDDraft(draftInput);

    expect(result).toMatchObject({
      status: "DRAFT",
      leaderId: "leader-1",
      teamMemberIds: ["leader-1", "member-2"],
      problemStatement: draftInput.problemStatement,
    });
    expect(mocks.membershipFindFirst).toHaveBeenCalledTimes(2);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "Quality8D",
        entityId: "event-1",
        action: "CREATED",
      }),
    });
  });

  it("rejects a team member without active access to the site", async () => {
    mockContext({ rootCause: null, capa: null });
    mocks.membershipFindFirst.mockResolvedValueOnce({ id: "membership-1" }).mockResolvedValueOnce(null);

    await expect(saveEightDDraft(draftInput)).rejects.toMatchObject({
      code: "TEAM_MEMBER_NOT_FOUND",
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("requires completed D3 containment before approving D1/D2", async () => {
    const eventWithoutCompletedContainment = {
      ...event,
      containment: { ...event.containment, completedAt: null },
    };
    mockContext({ event: eventWithoutCompletedContainment, rootCause: null, capa: null });
    const draft = await saveEightDDraft(draftInput);

    mockContext({
      event: eventWithoutCompletedContainment,
      rootCause: null,
      capa: null,
      eightD: draft,
    });
    await expect(
      approveEightD({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-2",
      }),
    ).rejects.toMatchObject({ code: "CONTAINMENT_REQUIRED" });
  });

  it("requires a leader plus at least one additional team member for approval", async () => {
    mockContext({ rootCause: null, capa: null });
    const draft = await saveEightDDraft({
      ...draftInput,
      teamMemberIds: ["leader-1"],
    });

    mockContext({ rootCause: null, capa: null, eightD: draft });
    await expect(
      approveEightD({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-2",
      }),
    ).rejects.toMatchObject({ code: "TEAM_REQUIRED" });
  });

  it("records D7 and closes D8 only after confirmed RCA and effective CAPA", async () => {
    mockContext({ rootCause: null, capa: null });
    const draft = await saveEightDDraft(draftInput);

    mockContext({ rootCause: null, capa: null, eightD: draft });
    const active = await approveEightD({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-2",
    });

    mockContext({ eightD: active });
    const withPrevention = await recordEightDPrevention({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      preventionSummary: "Standardize the setup control and verify it in periodic audits.",
      actorId: "quality-3",
    });

    mockContext({ eightD: withPrevention });
    const closed = await closeEightD({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      recognitionNote: "Team review completed; lessons learned shared with the affected functions.",
      actorId: "quality-4",
    });

    expect(closed).toMatchObject({
      status: "CLOSED",
      closedById: "quality-4",
      preventionSummary: "Standardize the setup control and verify it in periodic audits.",
    });
    expect(closed.closedAt).toBeTruthy();
  });

  it("blocks D7 while CAPA is not effectively closed", async () => {
    const active = {
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      status: "ACTIVE",
      leaderId: "leader-1",
      teamMemberIds: ["leader-1", "member-2"],
      problemStatement: draftInput.problemStatement,
      preventionSummary: null,
      recognitionNote: null,
      approvedById: "quality-2",
      approvedAt: "2026-08-08T01:00:00.000Z",
      closedById: null,
      closedAt: null,
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T01:00:00.000Z",
    } as const;
    mockContext({
      capa: { ...closedCapa, status: "ACTIVE" },
      eightD: active,
    });

    await expect(
      recordEightDPrevention({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        preventionSummary: "Prevent recurrence.",
        actorId: "quality-3",
      }),
    ).rejects.toMatchObject({ code: "CAPA_REQUIRED" });
  });

  it("computes D3-D6 from containment, RCA and CAPA rather than duplicating them", async () => {
    mockContext({
      eightD: {
        eventId: "event-1",
        organizationId: "org-a",
        siteId: "site-a",
        status: "ACTIVE",
        leaderId: "leader-1",
        teamMemberIds: ["leader-1", "member-2"],
        problemStatement: draftInput.problemStatement,
        preventionSummary: null,
        recognitionNote: null,
        approvedById: "quality-2",
        approvedAt: "2026-08-08T01:00:00.000Z",
        closedById: null,
        closedAt: null,
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T01:00:00.000Z",
      },
    });

    const workspace = await getEightDWorkspace({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });

    expect(workspace?.disciplines.filter((discipline) => ["D3", "D4", "D5", "D6"].includes(discipline.key)))
      .toEqual([
        expect.objectContaining({ key: "D3", complete: true, source: "Quality event" }),
        expect.objectContaining({ key: "D4", complete: true, source: "Root cause" }),
        expect.objectContaining({ key: "D5", complete: true, source: "CAPA" }),
        expect.objectContaining({ key: "D6", complete: true, source: "CAPA" }),
      ]);
  });
});
