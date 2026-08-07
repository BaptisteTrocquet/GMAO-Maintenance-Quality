import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetFindFirst: vi.fn(),
  meterCreate: vi.fn(),
  meterFindFirst: vi.fn(),
  readingCreate: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    asset: { findFirst: mocks.assetFindFirst },
    meter: { create: mocks.meterCreate, findFirst: mocks.meterFindFirst },
    meterReading: { create: mocks.readingCreate },
    auditLog: { create: mocks.auditCreate },
  },
}));

import { addMeterReading, createMeter } from "@/lib/assets/meters";

describe("asset meters", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a meter only for an active asset in the requested site", async () => {
    mocks.assetFindFirst.mockResolvedValueOnce({ id: "asset-1" });
    mocks.meterCreate.mockResolvedValueOnce({
      id: "meter-1",
      assetId: "asset-1",
      name: "Runtime",
      unit: "h",
      code: "RUN",
      rollover: null,
    });
    mocks.auditCreate.mockResolvedValueOnce({ id: "audit-1" });

    await expect(
      createMeter({ siteId: "site-a", assetId: "asset-1", name: "Runtime", unit: "h", code: "RUN" }),
    ).resolves.toMatchObject({ id: "meter-1" });

    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: { id: "asset-1", siteId: "site-a", archivedAt: null },
      select: { id: true },
    });
  });

  it("rejects decreasing readings when no rollover is configured", async () => {
    mocks.meterFindFirst.mockResolvedValueOnce({
      id: "meter-1",
      rollover: null,
      readings: [{ value: 120 }],
    });

    await expect(
      addMeterReading({ siteId: "site-a", meterId: "meter-1", value: 110 }),
    ).rejects.toMatchObject({ code: "METER_READING_DECREASE" });
    expect(mocks.readingCreate).not.toHaveBeenCalled();
  });

  it("accepts a lower reading when rollover is configured", async () => {
    mocks.meterFindFirst.mockResolvedValueOnce({
      id: "meter-1",
      rollover: 9999,
      readings: [{ value: 9998 }],
    });
    mocks.readingCreate.mockResolvedValueOnce({ id: "reading-1", meterId: "meter-1", value: 3 });
    mocks.auditCreate.mockResolvedValueOnce({ id: "audit-2" });

    await expect(
      addMeterReading({ siteId: "site-a", meterId: "meter-1", value: 3 }),
    ).resolves.toMatchObject({ id: "reading-1", value: 3 });
  });
});
