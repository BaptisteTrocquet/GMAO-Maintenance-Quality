import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { advanceCalendarDue, type CalendarFrequencyUnit } from "@/lib/maintenance/calendar";

const MAX_OCCURRENCES_PER_PLAN = 100;

export class MaintenanceSchedulerError extends Error {
  constructor(
    public readonly code: "PLAN_MOVED" | "SCHEDULER_LIMIT",
    message: string,
  ) {
    super(message);
    this.name = "MaintenanceSchedulerError";
  }
}

export function preventiveWorkOrderNumber(planId: string, dueAt: Date) {
  const digest = createHash("sha256")
    .update(`${planId}:${dueAt.toISOString()}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  const date = dueAt.toISOString().slice(0, 10).replaceAll("-", "");
  return `PM-${date}-${digest}`;
}

type CalendarPlan = {
  id: string;
  assetId: string;
  name: string;
  description: string | null;
  frequencyValue: number;
  frequencyUnit: CalendarFrequencyUnit;
  nextDueAt: Date;
  estimatedMinutes: number | null;
  asset: { siteId: string };
  checklistItems: Array<{ sequence: number; label: string; mandatory: boolean }>;
};

async function advancePlanDue(input: {
  planId: string;
  dueAt: Date;
  nextDueAt: Date;
}) {
  return db.maintenancePlan.updateMany({
    where: { id: input.planId, active: true, nextDueAt: input.dueAt },
    data: { nextDueAt: input.nextDueAt },
  });
}

async function generateOccurrence(input: {
  plan: CalendarPlan;
  dueAt: Date;
  nextDueAt: Date;
  timeZone: string;
  actorId?: string | null;
}) {
  const number = preventiveWorkOrderNumber(input.plan.id, input.dueAt);
  const existing = await db.workOrder.findUnique({ where: { number } });
  if (existing) {
    await advancePlanDue({ planId: input.plan.id, dueAt: input.dueAt, nextDueAt: input.nextDueAt });
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
          requestedAt: new Date(),
          dueAt: input.dueAt,
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
        where: { id: input.plan.id, active: true, nextDueAt: input.dueAt },
        data: { nextDueAt: input.nextDueAt },
      });
      if (moved.count !== 1) {
        throw new MaintenanceSchedulerError(
          "PLAN_MOVED",
          "Maintenance plan due date changed while generating work order",
        );
      }

      await tx.auditLog.create({
        data: {
          actorId: input.actorId ?? null,
          entityType: "WorkOrder",
          entityId: workOrder.id,
          action: "PREVENTIVE_GENERATED",
          afterJson: JSON.stringify({
            maintenancePlanId: input.plan.id,
            maintenanceDueAt: input.dueAt,
            nextDueAt: input.nextDueAt,
            timeZone: input.timeZone,
            planSnapshot: {
              name: input.plan.name,
              description: input.plan.description,
              frequencyValue: input.plan.frequencyValue,
              frequencyUnit: input.plan.frequencyUnit,
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
          action: "DUE_ADVANCED",
          beforeJson: JSON.stringify({ nextDueAt: input.dueAt }),
          afterJson: JSON.stringify({ nextDueAt: input.nextDueAt, generatedWorkOrderId: workOrder.id }),
        },
      });

      return { workOrder, created: true };
    });
  } catch (error) {
    if (error instanceof MaintenanceSchedulerError) throw error;

    const raced = await db.workOrder.findUnique({ where: { number } });
    if (raced) {
      await advancePlanDue({ planId: input.plan.id, dueAt: input.dueAt, nextDueAt: input.nextDueAt });
      return { workOrder: raced, created: false };
    }
    throw error;
  }
}

export async function generateCalendarMaintenanceWorkOrders(input: {
  organizationId: string;
  siteId: string;
  throughDate: Date;
  actorId?: string | null;
}) {
  const site = await db.site.findFirst({
    where: {
      id: input.siteId,
      organizationId: input.organizationId,
      active: true,
      organization: { active: true },
    },
    select: { id: true, organization: { select: { timezone: true } } },
  });
  if (!site) return { siteFound: false as const, generated: [], existing: [] };

  const plans = await db.maintenancePlan.findMany({
    where: {
      active: true,
      nextDueAt: { lte: input.throughDate },
      frequencyUnit: { in: ["DAY", "WEEK", "MONTH", "YEAR"] },
      asset: { siteId: input.siteId, archivedAt: null },
    },
    include: {
      asset: { select: { siteId: true } },
      checklistItems: { orderBy: { sequence: "asc" } },
    },
    orderBy: { nextDueAt: "asc" },
  });

  const generated: Array<{ id: string; number: string }> = [];
  const existing: Array<{ id: string; number: string }> = [];

  for (const plan of plans) {
    if (!plan.nextDueAt || plan.frequencyUnit === "METER") continue;
    let dueAt = plan.nextDueAt;
    let occurrenceCount = 0;

    while (dueAt <= input.throughDate) {
      occurrenceCount += 1;
      if (occurrenceCount > MAX_OCCURRENCES_PER_PLAN) {
        throw new MaintenanceSchedulerError(
          "SCHEDULER_LIMIT",
          `Plan ${plan.id} exceeded ${MAX_OCCURRENCES_PER_PLAN} occurrences in one scheduler run`,
        );
      }

      const nextDueAt = advanceCalendarDue({
        currentDueAt: dueAt,
        frequencyValue: plan.frequencyValue,
        frequencyUnit: plan.frequencyUnit as CalendarFrequencyUnit,
        timeZone: site.organization.timezone,
      });

      const result = await generateOccurrence({
        plan: {
          ...plan,
          frequencyUnit: plan.frequencyUnit as CalendarFrequencyUnit,
          nextDueAt: dueAt,
        },
        dueAt,
        nextDueAt,
        timeZone: site.organization.timezone,
        actorId: input.actorId,
      });

      const summary = { id: result.workOrder.id, number: result.workOrder.number };
      if (result.created) generated.push(summary);
      else existing.push(summary);
      dueAt = nextDueAt;
    }
  }

  return { siteFound: true as const, generated, existing };
}
