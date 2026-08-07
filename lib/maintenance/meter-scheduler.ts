import { createHash } from "node:crypto";
import { db } from "@/lib/db";

const MAX_THRESHOLDS_PER_PLAN = 100;

export class MeterMaintenanceSchedulerError extends Error {
  constructor(
    public readonly code: "PLAN_MOVED" | "SCHEDULER_LIMIT" | "ROLLOVER_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "MeterMaintenanceSchedulerError";
  }
}

export function meterPreventiveWorkOrderNumber(planId: string, threshold: number) {
  const canonicalThreshold = threshold.toString();
  const digest = createHash("sha256")
    .update(`${planId}:meter:${canonicalThreshold}`)
    .digest("hex")
    .slice(0, 20)
    .toUpperCase();
  return `PM-M-${digest}`;
}

type MeterPlan = {
  id: string;
  assetId: string;
  meterId: string | null;
  name: string;
  description: string | null;
  frequencyValue: number;
  nextDueMeterValue: number | null;
  estimatedMinutes: number | null;
  asset: { siteId: string };
  meter: { id: string; code: string; name: string; unit: string; allowRollover: boolean } | null;
  checklistItems: Array<{ sequence: number; label: string; mandatory: boolean }>;
};

async function advanceMeterThreshold(input: {
  planId: string;
  meterId: string;
  threshold: number;
  nextThreshold: number;
}) {
  return db.maintenancePlan.updateMany({
    where: {
      id: input.planId,
      active: true,
      frequencyUnit: "METER",
      meterId: input.meterId,
      nextDueMeterValue: input.threshold,
    },
    data: { nextDueMeterValue: input.nextThreshold },
  });
}

async function generateMeterOccurrence(input: {
  plan: MeterPlan;
  threshold: number;
  nextThreshold: number;
  readingValue: number;
  readingAt: Date;
  actorId?: string | null;
}) {
  const meterId = input.plan.meterId;
  const meter = input.plan.meter;
  if (!meterId || !meter) {
    throw new MeterMaintenanceSchedulerError("PLAN_MOVED", "Meter plan is no longer linked to a meter");
  }

  const number = meterPreventiveWorkOrderNumber(input.plan.id, input.threshold);
  const existing = await db.workOrder.findUnique({ where: { number } });
  if (existing) {
    await advanceMeterThreshold({
      planId: input.plan.id,
      meterId,
      threshold: input.threshold,
      nextThreshold: input.nextThreshold,
    });
    return { workOrder: existing, created: false };
  }

  try {
    return await db.$transaction(async (tx) => {
      const workOrder = await tx.workOrder.create({
        data: {
          number,
          siteId: input.plan.asset.siteId,
          assetId: input.plan.assetId,
          requesterId: null,
          title: `PM: ${input.plan.name}`,
          description: input.plan.description,
          type: "PREVENTIVE",
          status: "APPROVED",
          priority: "NORMAL",
          requestedAt: input.readingAt,
          dueAt: input.readingAt,
          laborMinutes: null,
          downtimeMinutes: null,
          completionNote: null,
          checkItems: {
            create: input.plan.checklistItems.map((item) => ({
              label: item.mandatory ? item.label : `[Optional] ${item.label}`,
              completed: false,
            })),
          },
        },
        include: { checkItems: true },
      });

      const moved = await tx.maintenancePlan.updateMany({
        where: {
          id: input.plan.id,
          active: true,
          frequencyUnit: "METER",
          meterId,
          nextDueMeterValue: input.threshold,
        },
        data: { nextDueMeterValue: input.nextThreshold },
      });
      if (moved.count !== 1) {
        throw new MeterMaintenanceSchedulerError(
          "PLAN_MOVED",
          "Maintenance plan meter threshold changed while generating work order",
        );
      }

      await tx.auditLog.create({
        data: {
          actorId: input.actorId ?? null,
          entityType: "WorkOrder",
          entityId: workOrder.id,
          action: "METER_PREVENTIVE_GENERATED",
          afterJson: JSON.stringify({
            maintenancePlanId: input.plan.id,
            meterId: meter.id,
            meterCode: meter.code,
            meterUnit: meter.unit,
            maintenanceDueMeterValue: input.threshold,
            nextDueMeterValue: input.nextThreshold,
            triggeringReadingValue: input.readingValue,
            triggeringReadingAt: input.readingAt,
            planSnapshot: {
              name: input.plan.name,
              description: input.plan.description,
              frequencyValue: input.plan.frequencyValue,
              frequencyUnit: "METER",
              estimatedMinutes: input.plan.estimatedMinutes,
              checklistItems: input.plan.checklistItems,
            },
          }),
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: input.actorId ?? null,
          entityType: "MaintenancePlan",
          entityId: input.plan.id,
          action: "METER_THRESHOLD_ADVANCED",
          beforeJson: JSON.stringify({ nextDueMeterValue: input.threshold }),
          afterJson: JSON.stringify({
            nextDueMeterValue: input.nextThreshold,
            generatedWorkOrderId: workOrder.id,
            triggeringReadingValue: input.readingValue,
          }),
        },
      });

      return { workOrder, created: true };
    });
  } catch (error) {
    if (error instanceof MeterMaintenanceSchedulerError) throw error;

    const raced = await db.workOrder.findUnique({ where: { number } });
    if (raced) {
      await advanceMeterThreshold({
        planId: input.plan.id,
        meterId,
        threshold: input.threshold,
        nextThreshold: input.nextThreshold,
      });
      return { workOrder: raced, created: false };
    }
    throw error;
  }
}

export async function generateMeterMaintenanceWorkOrders(input: {
  siteId: string;
  meterId: string;
  readingValue: number;
  readingAt: Date;
  actorId?: string | null;
}) {
  const meter = await db.meter.findFirst({
    where: {
      id: input.meterId,
      asset: { siteId: input.siteId, archivedAt: null, site: { active: true, organization: { active: true } } },
    },
    select: { id: true, allowRollover: true },
  });
  if (!meter) return { meterFound: false as const, generated: [], existing: [] };

  const plans = await db.maintenancePlan.findMany({
    where: {
      active: true,
      frequencyUnit: "METER",
      meterId: input.meterId,
      nextDueMeterValue: { lte: input.readingValue },
      asset: { siteId: input.siteId, archivedAt: null },
    },
    include: {
      asset: { select: { siteId: true } },
      meter: { select: { id: true, code: true, name: true, unit: true, allowRollover: true } },
      checklistItems: { orderBy: { sequence: "asc" } },
    },
    orderBy: { nextDueMeterValue: "asc" },
  });

  if (meter.allowRollover && plans.length > 0) {
    throw new MeterMaintenanceSchedulerError(
      "ROLLOVER_UNSUPPORTED",
      "Meter recurrence currently requires a monotonic meter without rollover",
    );
  }

  const generated: Array<{ id: string; number: string; threshold: number }> = [];
  const existing: Array<{ id: string; number: string; threshold: number }> = [];

  for (const plan of plans) {
    if (!plan.meterId || !plan.meter || plan.nextDueMeterValue === null) continue;
    let threshold = plan.nextDueMeterValue;
    let occurrenceCount = 0;

    while (threshold <= input.readingValue) {
      occurrenceCount += 1;
      if (occurrenceCount > MAX_THRESHOLDS_PER_PLAN) {
        throw new MeterMaintenanceSchedulerError(
          "SCHEDULER_LIMIT",
          `Plan ${plan.id} exceeded ${MAX_THRESHOLDS_PER_PLAN} meter thresholds in one reading`,
        );
      }

      const nextThreshold = threshold + plan.frequencyValue;
      const result = await generateMeterOccurrence({
        plan,
        threshold,
        nextThreshold,
        readingValue: input.readingValue,
        readingAt: input.readingAt,
        actorId: input.actorId,
      });

      const summary = { id: result.workOrder.id, number: result.workOrder.number, threshold };
      if (result.created) generated.push(summary);
      else existing.push(summary);
      threshold = nextThreshold;
    }
  }

  return { meterFound: true as const, generated, existing };
}
