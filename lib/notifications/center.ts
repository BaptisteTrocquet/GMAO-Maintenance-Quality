import type { MembershipRole } from "@prisma/client";
import { db } from "@/lib/db";
import { getReorderAlerts } from "@/lib/inventory/reorder";
import { listActiveMaintenanceReminders } from "@/lib/maintenance/reminders";
import { can } from "@/lib/permissions";
import { listQualityEvents } from "@/lib/quality/events";

export const NOTIFICATION_CENTER_LIMIT = 80;
const WORK_ORDER_LIMIT = 30;

export type NotificationCenterKind =
  | "MAINTENANCE_REMINDER"
  | "OVERDUE_WORK_ORDER"
  | "REORDER_ALERT"
  | "QUALITY_ALERT";

export type NotificationCenterSeverity = "CRITICAL" | "HIGH" | "NORMAL";

export type NotificationCenterItem = {
  id: string;
  kind: NotificationCenterKind;
  severity: NotificationCenterSeverity;
  title: string;
  detail: string;
  href: string;
  occurredAt: string;
  dismissible: boolean;
  sourceId: string;
};

function severityRank(value: NotificationCenterSeverity) {
  return value === "CRITICAL" ? 0 : value === "HIGH" ? 1 : 2;
}

export async function buildNotificationCenter(input: {
  organizationId: string;
  siteId: string;
  role: MembershipRole;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const [reminders, overdueWorkOrders, reorderAlerts, qualityEvents] = await Promise.all([
    can(input.role, "maintenance:read")
      ? listActiveMaintenanceReminders({
          organizationId: input.organizationId,
          siteId: input.siteId,
        })
      : Promise.resolve([]),
    can(input.role, "work:read")
      ? db.workOrder.findMany({
          where: {
            siteId: input.siteId,
            site: { organizationId: input.organizationId, active: true },
            status: { notIn: ["COMPLETED", "CANCELLED"] },
            dueAt: { lt: now },
          },
          select: {
            id: true,
            number: true,
            title: true,
            priority: true,
            dueAt: true,
            assignee: { select: { displayName: true } },
            team: { select: { name: true } },
          },
          orderBy: [{ dueAt: "asc" }, { priority: "desc" }],
          take: WORK_ORDER_LIMIT,
        })
      : Promise.resolve([]),
    can(input.role, "inventory:read")
      ? getReorderAlerts({ organizationId: input.organizationId, siteId: input.siteId })
      : Promise.resolve([]),
    can(input.role, "quality:read")
      ? listQualityEvents({ organizationId: input.organizationId, siteId: input.siteId })
      : Promise.resolve([]),
  ]);

  const items: NotificationCenterItem[] = [];

  for (const reminder of reminders ?? []) {
    items.push({
      id: `maintenance:${reminder.id}`,
      kind: "MAINTENANCE_REMINDER",
      severity: "NORMAL",
      title: reminder.title,
      detail: `${reminder.assetCode ? `${reminder.assetCode} · ` : ""}Preventive work due ${reminder.dueAt.toISOString()}`,
      href: `/maintenance/${reminder.workOrderId}`,
      occurredAt: reminder.remindAt.toISOString(),
      dismissible: true,
      sourceId: reminder.id,
    });
  }

  for (const workOrder of overdueWorkOrders) {
    if (!workOrder.dueAt) continue;
    const owner = workOrder.assignee?.displayName ?? workOrder.team?.name ?? "Unassigned";
    items.push({
      id: `overdue:${workOrder.id}`,
      kind: "OVERDUE_WORK_ORDER",
      severity: workOrder.priority === "URGENT" ? "CRITICAL" : workOrder.priority === "HIGH" ? "HIGH" : "NORMAL",
      title: `${workOrder.number} · ${workOrder.title}`,
      detail: `Overdue since ${workOrder.dueAt.toISOString()} · ${owner}`,
      href: `/maintenance/${workOrder.id}`,
      occurredAt: workOrder.dueAt.toISOString(),
      dismissible: false,
      sourceId: workOrder.id,
    });
  }

  for (const alert of reorderAlerts) {
    items.push({
      id: `reorder:${alert.policy.id}`,
      kind: "REORDER_ALERT",
      severity: alert.status === "OUT_OF_STOCK" ? "CRITICAL" : "HIGH",
      title: `${alert.part.sku} · ${alert.part.name}`,
      detail: `${alert.status === "OUT_OF_STOCK" ? "Out of stock" : "Reorder required"} at ${alert.bin.warehouse.code}/${alert.bin.code} · ${alert.available} ${alert.part.unit} available · suggested ${alert.suggestedOrderQuantity} ${alert.part.unit}`,
      href: "/inventory",
      occurredAt: now.toISOString(),
      dismissible: false,
      sourceId: alert.policy.id,
    });
  }

  for (const event of qualityEvents) {
    if (event.status === "CLOSED" || (event.severity !== "HIGH" && event.severity !== "CRITICAL")) {
      continue;
    }
    items.push({
      id: `quality:${event.id}`,
      kind: "QUALITY_ALERT",
      severity: event.severity,
      title: `${event.eventNumber} · ${event.title}`,
      detail: `${event.type.replaceAll("_", " ")} · ${event.status.replaceAll("_", " ")}`,
      href: `/quality/${event.id}`,
      occurredAt: event.updatedAt,
      dismissible: false,
      sourceId: event.id,
    });
  }

  items.sort((left, right) => {
    const severity = severityRank(left.severity) - severityRank(right.severity);
    if (severity) return severity;
    return right.occurredAt.localeCompare(left.occurredAt);
  });

  const limited = items.slice(0, NOTIFICATION_CENTER_LIMIT);
  return {
    items: limited,
    truncated: items.length > limited.length,
    counts: {
      total: limited.length,
      critical: limited.filter((item) => item.severity === "CRITICAL").length,
      high: limited.filter((item) => item.severity === "HIGH").length,
      normal: limited.filter((item) => item.severity === "NORMAL").length,
    },
  };
}
