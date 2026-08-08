import { db } from "@/lib/db";
import {
  markIntegrationEventProcessed,
  recordIntegrationEventInTransaction,
  type IntegrationEventEnvelope,
} from "@/lib/integrations/event-log";
import { generateMeterMaintenanceWorkOrders } from "@/lib/maintenance/meter-scheduler";

const MAX_IDENTIFIER = 200;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export type VerifiedExampleIotMeterReading = {
  externalEventId: string;
  assetCode: string;
  meterCode: string;
  value: number;
  observedAt: string;
};

type AppliedReceipt = {
  integrationEventId: string;
  readingId: string;
  meterId: string;
  value: number;
  readingAt: string;
};

export class ExampleIotConnectorError extends Error {
  constructor(
    public readonly code:
      | "INVALID_MESSAGE"
      | "ASSET_NOT_FOUND"
      | "METER_NOT_FOUND"
      | "METER_READING_DECREASE"
      | "INVALID_RECEIPT",
    message: string,
  ) {
    super(message);
    this.name = "ExampleIotConnectorError";
  }
}

function identifier(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_IDENTIFIER) {
    throw new ExampleIotConnectorError(
      "INVALID_MESSAGE",
      `${name} must contain between 1 and ${MAX_IDENTIFIER} characters`,
    );
  }
  return normalized;
}

function parseObservedAt(value: string, now: Date) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ExampleIotConnectorError("INVALID_MESSAGE", "observedAt must be an ISO-8601 timestamp");
  }
  const observedAt = new Date(timestamp);
  if (observedAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new ExampleIotConnectorError(
      "INVALID_MESSAGE",
      "observedAt cannot be more than five minutes in the future",
    );
  }
  return observedAt;
}

function parseReceipt(value: string | null, eventId: string): AppliedReceipt {
  try {
    if (!value) throw new Error();
    const parsed = JSON.parse(value) as Partial<AppliedReceipt>;
    if (
      parsed.integrationEventId !== eventId ||
      typeof parsed.readingId !== "string" ||
      typeof parsed.meterId !== "string" ||
      typeof parsed.value !== "number" ||
      !Number.isFinite(parsed.value) ||
      typeof parsed.readingAt !== "string"
    ) {
      throw new Error();
    }
    return parsed as AppliedReceipt;
  } catch {
    throw new ExampleIotConnectorError(
      "INVALID_RECEIPT",
      "Stored IoT integration receipt is invalid",
    );
  }
}

/**
 * Provider-neutral IoT ingestion example.
 *
 * `verifiedMessage` is intentionally a narrow post-authentication contract. An MQTT broker,
 * HTTP gateway, device certificate verifier, or vendor adapter must authenticate the device
 * and establish the tenant/site scope before invoking this function. Raw transport headers,
 * bearer tokens and device secrets must never be passed through this message object.
 */
export async function ingestVerifiedExampleIotMeterReading(input: {
  organizationId: string;
  siteId: string;
  verifiedMessage: VerifiedExampleIotMeterReading;
  now?: Date;
}) {
  const organizationId = identifier(input.organizationId, "organizationId");
  const siteId = identifier(input.siteId, "siteId");
  const externalEventId = identifier(input.verifiedMessage.externalEventId, "externalEventId");
  const assetCode = identifier(input.verifiedMessage.assetCode, "assetCode");
  const meterCode = identifier(input.verifiedMessage.meterCode, "meterCode");
  const value = input.verifiedMessage.value;
  if (!Number.isFinite(value) || value < 0) {
    throw new ExampleIotConnectorError(
      "INVALID_MESSAGE",
      "Meter reading value must be a finite non-negative number",
    );
  }
  const now = input.now ?? new Date();
  const observedAt = parseObservedAt(input.verifiedMessage.observedAt, now);

  const applied = await db.$transaction(async (tx) => {
    const recorded = await recordIntegrationEventInTransaction(tx, {
      organizationId,
      siteId,
      direction: "INBOUND",
      channel: "iot-example",
      eventType: "meter.reading.received",
      sourceId: externalEventId,
      correlationId: `${assetCode}:${meterCode}`,
      subjectType: "Meter",
      subjectId: `${assetCode}:${meterCode}`,
      occurredAt: observedAt,
      payload: {
        externalEventId,
        assetCode,
        meterCode,
        value,
        observedAt: observedAt.toISOString(),
      },
    });

    const existingReceipt = await tx.auditLog.findFirst({
      where: {
        entityType: "IntegrationInboundReceipt",
        entityId: recorded.event.id,
        action: "IOT_METER_READING_APPLIED",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (existingReceipt) {
      return {
        event: recorded.event,
        eventReplayed: true,
        receipt: parseReceipt(existingReceipt.afterJson, recorded.event.id),
        applied: false,
      };
    }

    const asset = await tx.asset.findFirst({
      where: {
        siteId,
        code: assetCode,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (!asset) {
      throw new ExampleIotConnectorError(
        "ASSET_NOT_FOUND",
        "IoT asset code was not found in the verified site scope",
      );
    }

    const meter = await tx.meter.findFirst({
      where: {
        assetId: asset.id,
        code: meterCode,
      },
      include: {
        readings: {
          orderBy: { readingAt: "desc" },
          take: 1,
        },
      },
    });
    if (!meter) {
      throw new ExampleIotConnectorError(
        "METER_NOT_FOUND",
        "IoT meter code was not found on the scoped asset",
      );
    }

    const previous = meter.readings[0];
    const rollover = Boolean(meter.allowRollover && previous && value < previous.value);
    if (previous && value < previous.value && !rollover) {
      throw new ExampleIotConnectorError(
        "METER_READING_DECREASE",
        "IoT meter reading cannot decrease unless rollover is configured",
      );
    }

    const reading = await tx.meterReading.create({
      data: {
        meterId: meter.id,
        value,
        note: `IoT event ${externalEventId}`,
        readingAt: observedAt,
      },
      select: {
        id: true,
        meterId: true,
        value: true,
        readingAt: true,
      },
    });
    const receipt: AppliedReceipt = {
      integrationEventId: recorded.event.id,
      readingId: reading.id,
      meterId: reading.meterId,
      value: reading.value,
      readingAt: reading.readingAt.toISOString(),
    };

    await tx.auditLog.create({
      data: {
        actorId: null,
        entityType: "MeterReading",
        entityId: reading.id,
        action: "CREATED_FROM_IOT",
        afterJson: JSON.stringify({
          integrationEventId: recorded.event.id,
          externalEventId,
          siteId,
          assetCode,
          meterCode,
          value: reading.value,
          readingAt: receipt.readingAt,
        }),
        createdAt: now,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: null,
        entityType: "IntegrationInboundReceipt",
        entityId: recorded.event.id,
        action: "IOT_METER_READING_APPLIED",
        afterJson: JSON.stringify(receipt),
        createdAt: now,
      },
    });

    return {
      event: recorded.event,
      eventReplayed: recorded.replayed,
      receipt,
      applied: true,
    };
  });

  // Meter-triggered PM generation is itself idempotent by deterministic plan/threshold WO numbers.
  // Run it for both first delivery and replay so a crash between reading commit and scheduling heals.
  const scheduler = await generateMeterMaintenanceWorkOrders({
    siteId,
    meterId: applied.receipt.meterId,
    readingValue: applied.receipt.value,
    readingAt: new Date(applied.receipt.readingAt),
    actorId: null,
  });
  await markIntegrationEventProcessed({
    event: applied.event as IntegrationEventEnvelope,
    processedAt: now,
  });

  return {
    eventId: applied.event.id,
    eventReplayed: applied.eventReplayed,
    applied: applied.applied,
    readingId: applied.receipt.readingId,
    meterId: applied.receipt.meterId,
    scheduler,
  };
}
