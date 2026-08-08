import type { MembershipRole } from "@prisma/client";
import { db } from "@/lib/db";
import { getReorderAlerts } from "@/lib/inventory/reorder";
import { can } from "@/lib/permissions";

export const NOTIFICATION_CENTER_LIMIT = 50;
export const NOTIFICATION_WORK_QUERY_LIMIT = 40;
export const NOTIFICATION_REORDER_LIMIT = 20;

export type NotificationSeverity = "CRITICAL" | "WARNING" | "INFO";
export type NotificationKind = "WORK_OVERDUE" | "WORK_DUE_SOON" | "MAINTENANCE_REMINDER" | "REORDER";

export type NotificationCenterItem = {
  key: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  description: string;
  href: string;
  occurredAt: Date;
  dueAt: Date | null;
};

function severityRank(value: NotificationSeverity) {
  return value === "CRITICAL" ? 0 : value === "WARNING" ? 1 : 2;
}

function compareItems(left: NotificationCenterItem, right: NotificationCenterItem) {
  const severity = severityRank(left.severity) - severityRank(right.severity);
  if (severity !== 0) return severity;
  const leftDue = left.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightDue = right.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (leftDue !== rightDue) return leftDue - rightDue;
  return right.occurredAt.getTime() - left.occurredAt.getTime();
}

export async function buildNotificationCenter(input: {
  organizationId: string;
  siteId: string;
  role: MembershipRole;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const through = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const items: NotificationCenterItem[] = [];

  if (can(input.role, "work:read")) {
    const [workOrders, reminders] = await Promise.all([
      db.workOrder.findMany({
        where: {
          siteId: input.siteId,
          site: { organizationId: input.organizationId, active: true },
          status: { notIn: ["COMPLETED", "CANCELLED"] },
          dueAt: { lte: through },
        },
        select: {
          id: true,
          number: true,
          title: true,
          status: true,
          priority: true,
          dueAt: true,
          updatedAt: true,
          asset: { select: { code: true } },
        },
        orderBy: { dueAt: "asc" },
        take: NOTIFICATION_WORK_QUERY_LIMIT,
      }),
      db.maintenanceReminder.findMany({
        where: {
          siteId: input.siteId,
          site: { organizationId: input.organizationId, active: true },
          status: "ACTIVE",
          remindAt: { lte: now },
          workOrder: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
        },
        select: {
          id: true,
          title: true,
          assetCode: true,
          dueAt: true,
          remindAt: true,
          workOrderId: true,
        },
        orderBy: { dueAt: "asc" },
        take: NOTIFICATION_WORK_QUERY_LIMIT,
      }),
    ]);

    for (const workOrder of workOrders) {
      if (!workOrder.dueAt) continue;
      const overdue = workOrder.dueAt.getTime() < now.getTime();
      items.push({
        key: `work:${workOrder.id}:${overdue ? "overdue" : "due"}`,
        kind: overdue ? "WORK_OVERDUE" : "WORK_DUE_SOON",
        severity: overdue || workOrder.priority === "URGENT" ? "CRITICAL" : "WARNING",
        title: `${workOrder.number} · ${workOrder.title}`,
        description: `${overdue ? "Overdue" : "Due within 7 days"}${workOrder.asset?.code ? ` · ${workOrder.asset.code}` : ""} · ${workOrder.status}`,
        href: `/maintenance/${workOrder.id}`,
        occurredAt: workOrder.updatedAt,
        dueAt: workOrder.dueAt,
      });
    }

    const workKeys = new Set(workOrders.map((workOrder) => workOrder.id));
    for (const reminder of reminders) {
      if (workKeys.has(reminder.workOrderId)) continue;
      items.push({
        key: `reminder:${reminder.id}`,
        kind: "MAINTENANCE_REMINDER",
        severity: "INFO",
        title: reminder.title,
        description: `Preventive maintenance reminder${reminder.assetCode ? ` · ${reminder.assetCode}` : ""}`,
        href: `/maintenance/${reminder.workOrderId}`,
        occurredAt: reminder.remindAt,
        dueAt: reminder.dueAt,
      });
    }
  }

  if (can(input.role, "inventory:read")) {
    const reorderAlerts = await getReorderAlerts({
      organizationId: input.organizationId,
      siteId: input.siteId,
    });
    for (const alert of reorderAlerts.slice(0, NOTIFICATION_REORDER_LIMIT)) {
      items.push({
        key: `reorder:${alert.policy.id}`,
        kind: "REORDER",
        severity: alert.status === "OUT_OF_STOCK" ? "CRITICAL" : "WARNING",
        title: `${alert.part.sku} · ${alert.part.name}`,
        description: `${alert.status === "OUT_OF_STOCK" ? "Out of stock" : "Below reorder threshold"} · ${alert.available} ${alert.part.unit} available · ${alert.bin.warehouse.code}/${alert.bin.code}`,
        href: "/inventory",
        occurredAt: now,
        dueAt: null,
      });
    }
  }

  return items.sort(compareItems).slice(0, NOTIFICATION_CENTER_LIMIT);
}
