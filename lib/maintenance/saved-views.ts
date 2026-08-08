import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type {
  WorkOrderAssignmentFilter,
  WorkOrderDueFilter,
  WorkOrderPriorityFilter,
} from "@/lib/maintenance/board";

const ENTITY_TYPE = "WorkOrderSavedView";

export type SavedWorkOrderViewSnapshot = {
  id: string;
  userId: string;
  organizationId: string;
  siteId: string;
  name: string;
  dueFilter: WorkOrderDueFilter;
  priorityFilter: WorkOrderPriorityFilter;
  assignmentFilter: WorkOrderAssignmentFilter;
  active: boolean;
  updatedAt: string;
};

export class SavedWorkOrderViewError extends Error {
  constructor(
    public readonly code: "INVALID_NAME" | "VIEW_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SavedWorkOrderViewError";
  }
}

function normalizedName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

function savedViewId(userId: string, siteId: string, name: string) {
  return createHash("sha256")
    .update(`${userId}:${siteId}:${normalizedName(name).toLocaleLowerCase("en")}`)
    .digest("hex");
}

function parseSnapshot(value: string | null): SavedWorkOrderViewSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SavedWorkOrderViewSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.name !== "string" ||
      !["ALL", "OVERDUE", "DUE_7_DAYS", "NO_DUE_DATE"].includes(parsed.dueFilter ?? "") ||
      !["ALL", "URGENT", "HIGH", "NORMAL", "LOW"].includes(parsed.priorityFilter ?? "") ||
      !["ALL", "UNASSIGNED", "MY_WORK"].includes(parsed.assignmentFilter ?? "") ||
      typeof parsed.active !== "boolean" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return parsed as SavedWorkOrderViewSnapshot;
  } catch {
    return null;
  }
}

async function latestView(viewId: string) {
  const log = await db.auditLog.findFirst({
    where: { entityType: ENTITY_TYPE, entityId: viewId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseSnapshot(log?.afterJson ?? null);
}

export async function listSavedWorkOrderViews(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  includeInactive?: boolean;
}) {
  const marker = `\"userId\":\"${input.userId}\",\"organizationId\":\"${input.organizationId}\",\"siteId\":\"${input.siteId}\"`;
  const logs = await db.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, afterJson: { contains: marker } },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });

  const latest = new Map<string, SavedWorkOrderViewSnapshot>();
  for (const log of logs) {
    const snapshot = parseSnapshot(log.afterJson);
    if (snapshot) latest.set(log.entityId, snapshot);
  }

  return [...latest.values()]
    .filter((view) => input.includeInactive || view.active)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function saveWorkOrderView(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  name: string;
  dueFilter: WorkOrderDueFilter;
  priorityFilter: WorkOrderPriorityFilter;
  assignmentFilter: WorkOrderAssignmentFilter;
}) {
  const name = normalizedName(input.name);
  if (!name || name.length > 80) {
    throw new SavedWorkOrderViewError("INVALID_NAME", "Saved view name must be between 1 and 80 characters");
  }

  const id = savedViewId(input.userId, input.siteId, name);
  const previous = await latestView(id);
  const snapshot: SavedWorkOrderViewSnapshot = {
    id,
    userId: input.userId,
    organizationId: input.organizationId,
    siteId: input.siteId,
    name,
    dueFilter: input.dueFilter,
    priorityFilter: input.priorityFilter,
    assignmentFilter: input.assignmentFilter,
    active: true,
    updatedAt: new Date().toISOString(),
  };

  await db.auditLog.create({
    data: {
      actorId: input.userId,
      entityType: ENTITY_TYPE,
      entityId: id,
      action: previous?.active ? "UPDATED" : previous ? "RESTORED" : "CREATED",
      beforeJson: previous ? JSON.stringify(previous) : null,
      afterJson: JSON.stringify(snapshot),
    },
  });

  return snapshot;
}

export async function deleteSavedWorkOrderView(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  viewId: string;
}) {
  const previous = await latestView(input.viewId);
  if (
    !previous ||
    !previous.active ||
    previous.userId !== input.userId ||
    previous.organizationId !== input.organizationId ||
    previous.siteId !== input.siteId
  ) {
    throw new SavedWorkOrderViewError("VIEW_NOT_FOUND", "Active saved view not found in user scope");
  }

  const snapshot: SavedWorkOrderViewSnapshot = {
    ...previous,
    active: false,
    updatedAt: new Date().toISOString(),
  };
  await db.auditLog.create({
    data: {
      actorId: input.userId,
      entityType: ENTITY_TYPE,
      entityId: input.viewId,
      action: "DELETED",
      beforeJson: JSON.stringify(previous),
      afterJson: JSON.stringify(snapshot),
    },
  });
  return snapshot;
}
