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
    auditLog: {
      findFirst: mocks.auditFindFirst,
      findMany: mocks.auditFindMany,
    },
  },
}));

import {
  confirmRootCauseWorkspace,
  getRootCauseWorkspace,
  reopenRootCauseWorkspace,
  saveRootCauseWorkspace,
} from "@/lib/quality/root-cause";

const event = {
  organizationId: "org-a",
  siteId: "site-a",
  status: "INVESTIGATING",
};

const fiveWhyInput = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  method: "FIVE_WHYS" as const,
  problemStatement: "Synthetic repeated dimensional drift",
  fiveWhys: [
    { sequence: 1, prompt: "Why did the dimension drift?", answer: "The setting moved." },
    { sequence: 2, prompt: "Why did the setting move?", answer: "The clamp loosened." },
  ],
  ishikawa: [],
  rootCauseSummary: "Clamp retention was insufficient.",
  actorId: "quality-1",
};

function mockCurrentEvent(status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED" = "INVESTIGATING") {
  mocks.auditFindFirst.mockResolvedValueOnce({
    afterJson: JSON.stringify({ ...event, status }),
  });
}

function mockNoWorkspace() {
  mocks.auditFindFirst.mockResolvedValueOnce(null);
}

function mockWorkspace(snapshot: unknown) {
  mocks.auditFindFirst.mockResolvedValueOnce({ afterJson: JSON.stringify(snapshot) });
}

describe("quality root-cause analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
  });

  it("records ordered 5 Why analysis as an immutable draft snapshot", async () => {
    mockCurrentEvent();
    mockNoWorkspace();

    const result = await saveRootCauseWorkspace(fiveWhyInput);

    expect(result).toMatchObject({
      status: "DRAFT",
      method: "FIVE_WHYS",
      problemStatement: "Synthetic repeated dimensional drift",
      fiveWhys: [
        { sequence: 1, answer: "The setting moved." },
        { sequence: 2, answer: "The clamp loosened." },
      ],
      rootCauseSummary: "Clamp retention was insufficient.",
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "QualityRootCause",
        entityId: "event-1",
        action: "CREATED",
      }),
    });
  });

  it("requires the quality event to be actively investigating", async () => {
    mockCurrentEvent("CONTAINED");

    await expect(saveRootCauseWorkspace(fiveWhyInput)).rejects.toMatchObject({
      code: "INVESTIGATION_REQUIRED",
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects non-contiguous 5 Why steps", async () => {
    mockCurrentEvent();
    mockNoWorkspace();

    await expect(
      saveRootCauseWorkspace({
        ...fiveWhyInput,
        fiveWhys: [
          { sequence: 1, prompt: "Why one?", answer: "Answer one" },
          { sequence: 3, prompt: "Why three?", answer: "Answer three" },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_FIVE_WHYS" });
  });

  it("stores Ishikawa causes with structured categories and optional evidence", async () => {
    mockCurrentEvent();
    mockNoWorkspace();

    const result = await saveRootCauseWorkspace({
      ...fiveWhyInput,
      method: "ISHIKAWA",
      fiveWhys: [],
      ishikawa: [
        {
          category: "MACHINE",
          cause: "  Synthetic clamp wear  ",
          evidence: " Inspection photo reference ",
        },
        { category: "METHOD", cause: "Setup verification omitted", evidence: null },
      ],
    });

    expect(result.ishikawa).toEqual([
      {
        category: "MACHINE",
        cause: "Synthetic clamp wear",
        evidence: "Inspection photo reference",
      },
      { category: "METHOD", cause: "Setup verification omitted", evidence: null },
    ]);
  });

  it("confirms only a complete draft and makes it immutable until reopened", async () => {
    mockCurrentEvent();
    mockNoWorkspace();
    const draft = await saveRootCauseWorkspace(fiveWhyInput);

    mocks.auditCreate.mockClear();
    mockCurrentEvent();
    mockWorkspace(draft);
    const confirmed = await confirmRootCauseWorkspace({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-2",
    });

    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.confirmedAt).toBeTruthy();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "CONFIRMED", actorId: "quality-2" }),
    });

    mockCurrentEvent();
    mockWorkspace(confirmed);
    await expect(saveRootCauseWorkspace(fiveWhyInput)).rejects.toMatchObject({
      code: "ROOT_CAUSE_CONFIRMED",
    });
  });

  it("requires a root-cause summary before confirmation", async () => {
    mockCurrentEvent();
    mockNoWorkspace();
    const draft = await saveRootCauseWorkspace({ ...fiveWhyInput, rootCauseSummary: null });

    mockCurrentEvent();
    mockWorkspace(draft);
    await expect(
      confirmRootCauseWorkspace({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "ROOT_CAUSE_SUMMARY_REQUIRED" });
  });

  it("reopens confirmed analysis before further edits", async () => {
    const confirmed = {
      eventId: "event-1",
      organizationId: "org-a",
      siteId: "site-a",
      status: "CONFIRMED" as const,
      method: "FIVE_WHYS" as const,
      problemStatement: "Synthetic problem",
      fiveWhys: [{ sequence: 1, prompt: "Why?", answer: "Synthetic cause" }],
      ishikawa: [],
      rootCauseSummary: "Synthetic root cause",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:10:00.000Z",
      confirmedAt: "2026-08-08T00:10:00.000Z",
    };
    mockCurrentEvent();
    mockWorkspace(confirmed);

    const reopened = await reopenRootCauseWorkspace({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    expect(reopened.status).toBe("DRAFT");
    expect(reopened.confirmedAt).toBeNull();
  });

  it("does not expose root-cause data through a mismatched tenant scope", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event) })
      .mockResolvedValueOnce({
        afterJson: JSON.stringify({
          eventId: "event-1",
          organizationId: "org-other",
          siteId: "site-a",
          status: "DRAFT",
          method: "FIVE_WHYS",
          problemStatement: "Other tenant",
          fiveWhys: [{ sequence: 1, prompt: "Why?", answer: "Other" }],
          ishikawa: [],
          rootCauseSummary: null,
          createdAt: "2026-08-08T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z",
          confirmedAt: null,
        }),
      });

    const workspace = await getRootCauseWorkspace({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
    });
    expect(workspace).toBeNull();
  });
});
