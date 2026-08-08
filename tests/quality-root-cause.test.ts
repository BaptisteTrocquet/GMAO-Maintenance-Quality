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
  finalizeQualityRca,
  getQualityRca,
  saveQualityRca,
} from "@/lib/quality/root-cause";

function event(status: "OPEN" | "CONTAINED" | "INVESTIGATING" | "CLOSED", title = "Synthetic quality event") {
  return {
    id: "event-1",
    organizationId: "org-a",
    siteId: "site-a",
    eventNumber: "QE-0001",
    title,
    status,
  };
}

const saveInput = {
  organizationId: "org-a",
  siteId: "site-a",
  eventId: "event-1",
  problemStatement: "Synthetic defect escapes the expected dimensional limit.",
  fiveWhys: [
    { sequence: 1, answer: "The setting drifted." },
    { sequence: 2, answer: "The verification interval was insufficient." },
  ],
  ishikawaCauses: [
    { category: "MACHINE" as const, statement: "Synthetic fixture wear" },
    { category: "METHOD" as const, statement: "Synthetic verification gap" },
  ],
  rootCauses: [{ source: "FIVE_WHY" as const, refId: "why-2" }],
  actorId: "quality-1",
};

describe("quality root cause analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.auditFindMany.mockResolvedValue([]);
  });

  it("does not allow RCA before immediate containment", async () => {
    mocks.auditFindFirst.mockResolvedValueOnce({ afterJson: JSON.stringify(event("OPEN")) });

    await expect(saveQualityRca(saveInput)).rejects.toMatchObject({ code: "RCA_NOT_ALLOWED" });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("saves structured 5 Why and Ishikawa data for a contained event", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event("CONTAINED")) })
      .mockResolvedValueOnce(null);

    const rca = await saveQualityRca(saveInput);

    expect(rca).toMatchObject({
      eventId: "event-1",
      eventNumber: "QE-0001",
      eventTitle: "Synthetic quality event",
      status: "DRAFT",
      fiveWhys: [
        { id: "why-1", sequence: 1, answer: "The setting drifted." },
        { id: "why-2", sequence: 2, answer: "The verification interval was insufficient." },
      ],
      rootCauses: [{ source: "FIVE_WHY", refId: "why-2" }],
    });
    expect(rca.ishikawaCauses).toHaveLength(2);
    expect(rca.ishikawaCauses[0]).toMatchObject({ category: "MACHINE", statement: "Synthetic fixture wear" });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ entityType: "QualityRca", action: "RCA_CREATED" }),
    });
  });

  it("requires contiguous 5 Why steps starting at one", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event("CONTAINED")) })
      .mockResolvedValueOnce(null);

    await expect(
      saveQualityRca({
        ...saveInput,
        fiveWhys: [{ sequence: 2, answer: "Skipped first why" }],
        rootCauses: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_FIVE_WHY_SEQUENCE" });
  });

  it("rejects root-cause references that do not exist in the current analysis", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event("CONTAINED")) })
      .mockResolvedValueOnce(null);

    await expect(
      saveQualityRca({
        ...saveInput,
        rootCauses: [{ source: "ISHIKAWA", refId: "missing-cause" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ROOT_CAUSE_REFERENCE" });
  });

  it("keeps the original event label frozen when the master event title changes", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event("CONTAINED")) })
      .mockResolvedValueOnce(null);
    const first = await saveQualityRca(saveInput);

    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event("INVESTIGATING", "Renamed event title")) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(first) });
    const updated = await saveQualityRca({
      ...saveInput,
      problemStatement: "Updated synthetic problem statement.",
    });

    expect(updated.eventTitle).toBe("Synthetic quality event");
  });

  it("finalizes only while investigating and with at least one selected root cause", async () => {
    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event("CONTAINED")) })
      .mockResolvedValueOnce(null);
    const draft = await saveQualityRca({ ...saveInput, rootCauses: [] });

    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event("INVESTIGATING")) })
      .mockResolvedValueOnce({ afterJson: JSON.stringify(draft) });
    await expect(
      finalizeQualityRca({
        organizationId: "org-a",
        siteId: "site-a",
        eventId: "event-1",
        actorId: "quality-1",
      }),
    ).rejects.toMatchObject({ code: "ROOT_CAUSE_REQUIRED" });

    mocks.auditFindFirst
      .mockResolvedValueOnce({ afterJson: JSON.stringify(event("INVESTIGATING")) })
      .mockResolvedValueOnce({
        afterJson: JSON.stringify({
          ...draft,
          rootCauses: [{ source: "FIVE_WHY", refId: "why-2" }],
        }),
      });
    const finalized = await finalizeQualityRca({
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      actorId: "quality-1",
    });

    expect(finalized.status).toBe("FINAL");
    expect(finalized.finalizedAt).toBeTruthy();
    expect(mocks.auditCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ action: "RCA_FINALIZED" }),
    });
  });

  it("returns finalized snapshots without consulting mutable event master data", async () => {
    const finalSnapshot = {
      id: "rca-1",
      organizationId: "org-a",
      siteId: "site-a",
      eventId: "event-1",
      eventNumber: "QE-0001",
      eventTitle: "Frozen title",
      status: "FINAL",
      problemStatement: "Synthetic problem",
      fiveWhys: [{ id: "why-1", sequence: 1, answer: "Synthetic cause" }],
      ishikawaCauses: [],
      rootCauses: [{ source: "FIVE_WHY", refId: "why-1" }],
      createdById: "quality-1",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T01:00:00.000Z",
      finalizedAt: "2026-08-08T01:00:00.000Z",
    };
    mocks.auditFindFirst.mockResolvedValue({ afterJson: JSON.stringify(finalSnapshot) });

    const rca = await getQualityRca({ organizationId: "org-a", siteId: "site-a", eventId: "event-1" });
    expect(rca?.eventTitle).toBe("Frozen title");
  });
});
