import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  recordEvent: vi.fn(),
  markProcessed: vi.fn(),
  assetFindFirst: vi.fn(),
  meterFindFirst: vi.fn(),
  readingCreate: vi.fn(),
  auditFindFirst: vi.fn(),
  auditCreate: vi.fn(),
  scheduler: vi.fn(),
}));

const tx = {
  asset: { findFirst: mocks.assetFindFirst },
  meter: { findFirst: mocks.meterFindFirst },
  meterReading: { create: mocks.readingCreate },
  auditLog: {
    findFirst: mocks.auditFindFirst,
    create: mocks.auditCreate,
  },
};

vi.mock("@/lib/db", () => ({
  db: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/integrations/event-log", () => ({
  recordIntegrationEventInTransaction: mocks.recordEvent,
  markIntegrationEventProcessed: mocks.markProcessed,
}));
vi.mock("@/lib/maintenance/meter-scheduler", () => ({
  generateMeterMaintenanceWorkOrders: mocks.scheduler,
}));

import {
  ExampleIotConnectorError,
  ingestVerifiedExampleIotMeterReading,
} from "@/lib/integrations/examples/iot-meter-readings";

const event = {
  version: 1 as const,
  id: "i".repeat(64),
  organizationId: "org-a",
  siteId: "site-a",
  direction: "INBOUND" as const,
  channel: "iot-example",
  eventType: "meter.reading.received",
  sourceId: "device-event-100",
  correlationId: "PUMP-100:HOURS",
  causationId: null,
  subjectType: "Meter",
  subjectId: "PUMP-100:HOURS",
  occurredAt: "2026-08-08T10:00:00.000Z",
  payloadHash: "f".repeat(64),
  payload: {
    externalEventId: "device-event-100",
    assetCode: "PUMP-100",
    meterCode: "HOURS",
    value: 1250,
    observedAt: "2026-08-08T10:00:00.000Z",
  },
};

const message = {
  externalEventId: "device-event-100",
  assetCode: "PUMP-100",
  meterCode: "HOURS",
  value: 1250,
  observedAt: "2026-08-08T10:00:00.000Z",
};

const now = new Date("2026-08-08T10:01:00.000Z");

function receipt() {
  return JSON.stringify({
    integrationEventId: event.id,
    readingId: "reading-1",
    meterId: "meter-1",
    value: 1250,
    readingAt: "2026-08-08T10:00:00.000Z",
  });
}

describe("IoT meter-reading connector example", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(
      async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    );
    mocks.recordEvent.mockResolvedValue({ event, replayed: false });
    mocks.markProcessed.mockResolvedValue({ processed: true });
    mocks.auditFindFirst.mockResolvedValue(null);
    mocks.assetFindFirst.mockResolvedValue({ id: "asset-1" });
    mocks.meterFindFirst.mockResolvedValue({
      id: "meter-1",
      allowRollover: false,
      readings: [{ value: 1200, readingAt: new Date("2026-08-07T10:00:00.000Z") }],
    });
    mocks.readingCreate.mockResolvedValue({
      id: "reading-1",
      meterId: "meter-1",
      value: 1250,
      readingAt: new Date("2026-08-08T10:00:00.000Z"),
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
    mocks.scheduler.mockResolvedValue({ meterFound: true, generated: [], existing: [] });
  });

  it("applies one verified inbound event using only site-scoped asset and meter codes", async () => {
    const result = await ingestVerifiedExampleIotMeterReading({
      organizationId: "org-a",
      siteId: "site-a",
      verifiedMessage: message,
      now,
    });

    expect(result).toMatchObject({
      eventId: event.id,
      eventReplayed: false,
      applied: true,
      readingId: "reading-1",
      meterId: "meter-1",
    });
    expect(mocks.recordEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: "org-a",
        siteId: "site-a",
        direction: "INBOUND",
        channel: "iot-example",
        eventType: "meter.reading.received",
        sourceId: "device-event-100",
        payload: {
          externalEventId: "device-event-100",
          assetCode: "PUMP-100",
          meterCode: "HOURS",
          value: 1250,
          observedAt: "2026-08-08T10:00:00.000Z",
        },
      }),
    );
    expect(mocks.assetFindFirst).toHaveBeenCalledWith({
      where: { siteId: "site-a", code: "PUMP-100", archivedAt: null },
      select: { id: true },
    });
    expect(mocks.meterFindFirst).toHaveBeenCalledWith({
      where: { assetId: "asset-1", code: "HOURS" },
      include: { readings: { orderBy: { readingAt: "desc" }, take: 1 } },
    });
    expect(mocks.readingCreate).toHaveBeenCalledWith({
      data: {
        meterId: "meter-1",
        value: 1250,
        note: "IoT event device-event-100",
        readingAt: new Date("2026-08-08T10:00:00.000Z"),
      },
      select: { id: true, meterId: true, value: true, readingAt: true },
    });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.auditCreate.mock.calls)).not.toContain("Authorization");
    expect(mocks.scheduler).toHaveBeenCalledWith({
      siteId: "site-a",
      meterId: "meter-1",
      readingValue: 1250,
      readingAt: new Date("2026-08-08T10:00:00.000Z"),
      actorId: null,
    });
    expect(mocks.markProcessed).toHaveBeenCalledWith({ event, processedAt: now });
  });

  it("reuses an inbound receipt without creating a duplicate reading and reruns the idempotent scheduler", async () => {
    mocks.recordEvent.mockResolvedValue({ event, replayed: true });
    mocks.auditFindFirst.mockResolvedValue({ afterJson: receipt() });

    const result = await ingestVerifiedExampleIotMeterReading({
      organizationId: "org-a",
      siteId: "site-a",
      verifiedMessage: message,
      now,
    });

    expect(result).toMatchObject({
      eventReplayed: true,
      applied: false,
      readingId: "reading-1",
    });
    expect(mocks.assetFindFirst).not.toHaveBeenCalled();
    expect(mocks.meterFindFirst).not.toHaveBeenCalled();
    expect(mocks.readingCreate).not.toHaveBeenCalled();
    expect(mocks.scheduler).toHaveBeenCalledTimes(1);
    expect(mocks.markProcessed).toHaveBeenCalledWith({ event, processedAt: now });
  });

  it("rejects a decreasing non-rollover reading before any business mutation", async () => {
    mocks.meterFindFirst.mockResolvedValue({
      id: "meter-1",
      allowRollover: false,
      readings: [{ value: 1300, readingAt: new Date("2026-08-07T10:00:00.000Z") }],
    });

    await expect(
      ingestVerifiedExampleIotMeterReading({
        organizationId: "org-a",
        siteId: "site-a",
        verifiedMessage: message,
        now,
      }),
    ).rejects.toMatchObject({ code: "METER_READING_DECREASE" });
    expect(mocks.readingCreate).not.toHaveBeenCalled();
    expect(mocks.scheduler).not.toHaveBeenCalled();
    expect(mocks.markProcessed).not.toHaveBeenCalled();
  });

  it("fails closed when the meter code is not on the scoped asset", async () => {
    mocks.meterFindFirst.mockResolvedValue(null);

    await expect(
      ingestVerifiedExampleIotMeterReading({
        organizationId: "org-a",
        siteId: "site-a",
        verifiedMessage: message,
        now,
      }),
    ).rejects.toMatchObject({ code: "METER_NOT_FOUND" });
    expect(mocks.readingCreate).not.toHaveBeenCalled();
  });

  it("rejects an implausibly future message before opening a transaction", async () => {
    await expect(
      ingestVerifiedExampleIotMeterReading({
        organizationId: "org-a",
        siteId: "site-a",
        verifiedMessage: {
          ...message,
          observedAt: "2026-08-08T10:10:01.000Z",
        },
        now,
      }),
    ).rejects.toBeInstanceOf(ExampleIotConnectorError);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });
});
