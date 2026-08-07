import { createHash } from "node:crypto";
import { db } from "@/lib/db";

export function maintenanceReminderOccurrenceKey(input: {
  workOrderId: string;
  dueAt: Date;
  leadDays: number;
}) {
  return createHash("sha256")
    .update(`${input.workOrderId}:${input.dueAt.toISOString()}:${input.leadDays}`)
    .digest("hex");
}

export async function generatePreventiveMaintenanceReminders(input: {
  organizationId: string;
  siteId: string;
  leadDays?: number;
  now?: Date;
  actorId?: string | null;
}) {
  const leadDays = input.leadDays ?? 7;
  const now = input.now ?? new Date();
  const throughDate = new Date(now.getTime() + leadDays * 24 * 60 * 60 * 1000);

  const site = await db.site.findFirst({
    where: {
      id: input.siteId,
      organizationId: input.organizationId,
      active: true,
      organization: { active: true },
    },
    select: { id: true },
  });
  if (!site) return { siteFound: false as const, created: [], existing: [], expired: 0 };

  const expired = await db.maintenanceReminder.updateMany({
    where: {
      siteId: input.siteId,
      status: "ACTIVE",
      OR: [
        { dueAt: { lt: now } },
        { workOrder: { status: { in: ["COMPLETED", "CANCELLED"] } } },
      ],
    },
    data: { status: "EXPIRED" },
  });

  const workOrders = await db.workOrder.findMany({
    where: {
      siteId: input.siteId,
      type: "PREVENTIVE",
      status: { notIn: ["COMPLETED", "CANCELLED"] },
      dueAt: { gte: now, lte: throughDate },
    },
    select: {
      id: true,
      number: true,
      title: true,
      dueAt: true,
      asset: { select: { code: true } },
    },
    orderBy: { dueAt: "asc" },
  });

  const created: Array<{ id: string; workOrderId: string; dueAt: Date }> = [];
  const existing: Array<{ id: string; workOrderId: string; dueAt: Date }> = [];

  for (const workOrder of workOrders) {
    if (!workOrder.dueAt) continue;
    const occurrenceKey = maintenanceReminderOccurrenceKey({
      workOrderId: workOrder.id,
      dueAt: workOrder.dueAt,
      leadDays,
    });
    const remindAt = new Date(workOrder.dueAt.getTime() - leadDays * 24 * 60 * 60 * 1000);

    const already = await db.maintenanceReminder.findUnique({ where: { occurrenceKey } });
    if (already) {
      existing.push({ id: already.id, workOrderId: already.workOrderId, dueAt: already.dueAt });
      continue;
    }

    await db.maintenanceReminder.updateMany({
      where: {
        siteId: input.siteId,
        workOrderId: workOrder.id,
        status: "ACTIVE",
        occurrenceKey: { not: occurrenceKey },
      },
      data: { status: "EXPIRED" },
    });

    try {
      const reminder = await db.maintenanceReminder.create({
        data: {
          siteId: input.siteId,
          workOrderId: workOrder.id,
          occurrenceKey,
          title: `${workOrder.number} · ${workOrder.title}`,
          assetCode: workOrder.asset?.code ?? null,
          dueAt: workOrder.dueAt,
          remindAt,
          leadDays,
          status: "ACTIVE",
        },
      });

      await db.auditLog.create({
        data: {
          actorId: input.actorId ?? null,
          entityType: "MaintenanceReminder",
          entityId: reminder.id,
          action: "CREATED",
          afterJson: JSON.stringify({
            workOrderId: workOrder.id,
            occurrenceKey,
            dueAt: workOrder.dueAt,
            remindAt,
            leadDays,
          }),
        },
      });
      created.push({ id: reminder.id, workOrderId: reminder.workOrderId, dueAt: reminder.dueAt });
    } catch (error) {
      const raced = await db.maintenanceReminder.findUnique({ where: { occurrenceKey } });
      if (raced) {
        existing.push({ id: raced.id, workOrderId: raced.workOrderId, dueAt: raced.dueAt });
        continue;
      }
      throw error;
    }
  }

  return { siteFound: true as const, created, existing, expired: expired.count };
}

export async function listActiveMaintenanceReminders(input: {
  organizationId: string;
  siteId: string;
}) {
  const site = await db.site.findFirst({
    where: {
      id: input.siteId,
      organizationId: input.organizationId,
      active: true,
      organization: { active: true },
    },
    select: { id: true },
  });
  if (!site) return null;

  return db.maintenanceReminder.findMany({
    where: { siteId: input.siteId, status: "ACTIVE" },
    include: {
      workOrder: {
        select: { id: true, number: true, title: true, status: true, dueAt: true },
      },
    },
    orderBy: { dueAt: "asc" },
  });
}

export async function dismissMaintenanceReminder(input: {
  organizationId: string;
  siteId: string;
  reminderId: string;
  actorId: string;
}) {
  const reminder = await db.maintenanceReminder.findFirst({
    where: {
      id: input.reminderId,
      siteId: input.siteId,
      site: { organizationId: input.organizationId },
      status: "ACTIVE",
    },
  });
  if (!reminder) return null;

  const dismissedAt = new Date();
  const updated = await db.maintenanceReminder.update({
    where: { id: reminder.id },
    data: { status: "DISMISSED", dismissedAt },
  });

  await db.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: "MaintenanceReminder",
      entityId: reminder.id,
      action: "DISMISSED",
      beforeJson: JSON.stringify(reminder),
      afterJson: JSON.stringify(updated),
    },
  });
  return updated;
}
