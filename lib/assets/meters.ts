import { db } from "@/lib/db";
import { generateMeterMaintenanceWorkOrders } from "@/lib/maintenance/meter-scheduler";

export async function createMeter(input: {
  siteId: string;
  assetId: string;
  name: string;
  unit: string;
  code?: string | null;
  allowRollover?: boolean;
  actorId?: string | null;
}) {
  const asset = await db.asset.findFirst({
    where: { id: input.assetId, siteId: input.siteId, archivedAt: null },
    select: { id: true },
  });
  if (!asset) return null;

  const meter = await db.meter.create({
    data: {
      assetId: input.assetId,
      name: input.name,
      unit: input.unit,
      code: input.code ?? input.name,
      allowRollover: input.allowRollover ?? false,
    },
  });

  await db.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      entityType: "Meter",
      entityId: meter.id,
      action: "CREATED",
      afterJson: JSON.stringify(meter),
    },
  });

  return meter;
}

export async function addMeterReading(input: {
  siteId: string;
  meterId: string;
  value: number;
  note?: string | null;
  readingAt?: Date;
  actorId?: string | null;
}) {
  const meter = await db.meter.findFirst({
    where: { id: input.meterId, asset: { siteId: input.siteId, archivedAt: null } },
    include: { readings: { orderBy: { readingAt: "desc" }, take: 1 } },
  });
  if (!meter) return null;

  const previous = meter.readings[0];
  const isRollover = meter.allowRollover && previous && input.value < previous.value;
  if (previous && input.value < previous.value && !isRollover) {
    throw new MeterReadingError(
      "METER_READING_DECREASE",
      "Meter reading cannot decrease unless rollover is configured",
    );
  }

  const readingAt = input.readingAt ?? new Date();
  const reading = await db.meterReading.create({
    data: {
      meterId: input.meterId,
      value: input.value,
      note: input.note ?? null,
      readingAt,
    },
  });

  await db.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      entityType: "MeterReading",
      entityId: reading.id,
      action: "CREATED",
      afterJson: JSON.stringify(reading),
    },
  });

  await generateMeterMaintenanceWorkOrders({
    siteId: input.siteId,
    meterId: input.meterId,
    readingValue: input.value,
    readingAt,
    actorId: input.actorId,
  });

  return reading;
}

export class MeterReadingError extends Error {
  constructor(
    public readonly code: "METER_READING_DECREASE",
    message: string,
  ) {
    super(message);
    this.name = "MeterReadingError";
  }
}
