import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { WorkOrderDueFilter } from "@/lib/maintenance/board";

const ENTITY_TYPE = "SavedKanbanView";
const DUE_FILTERS = new Set<WorkOrderDueFilter>([
  "ALL",
  "OVERDUE",
  "DUE_7_DAYS",
  "NO_DUE_DATE",
]);

export type SavedKanbanView = {
  id: string;
  userId: string;
  organizationId: string;
  siteId: string;
  name: string;
  dueFilter: WorkOrderDueFilter;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export class SavedKanbanViewError extends Error {
  constructor(
    public readonly code:
      | "INVALID_NAME"
      | "INVALID_FILTER"
      | "NAME_CONFLICT"
      | "VIEW_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SavedKanbanViewError";
  }
}

function normalizeName(value: string) {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80) {
    throw new SavedKanbanViewError("INVALID_NAME", "Saved view name must contain 1 to 80 characters");
  }
  return name;
}

function normalizeDueFilter(value: string): WorkOrderDueFilter {
  if (!DUE_FILTERS.has(value as WorkOrderDueFilter)) {
    throw new SavedKanbanViewError("INVALID_FILTER", "Unsupported Kanban due filter");
  }
  return value as WorkOrderDueFilter;
}

function parseSnapshot(value: string | null): SavedKanbanView | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SavedKanbanView>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.dueFilter !== "string" ||
      typeof parsed.active !== "boolean" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return {
      ...(parsed as SavedKanbanView),
      name: normalizeName(parsed.name),
      dueFilter: normalizeDueFilter(parsed.dueFilter),
    };
  } catch {
    return null;
  }
}

function scopeMarkers(input: { userId: string; organizationId: string; siteId: string }) {
  return [
    `"userId":"${input.userId}"`,
    `"organizationId":"${input.organizationId}"`,
    `"siteId":"${input.siteId}"`,
  ];
}

async function scopedViews(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  includeInactive?: boolean;
}) {
  const logs = await db.auditLog.findMany({
    where: {
      entityType: ENTITY_TYPE,
      AND: scopeMarkers(input).map((marker) => ({ afterJson: { contains: marker } })),
    },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });

  const latest = new Map<string, SavedKanbanView>();
  for (const log of logs) {
    const snapshot = parseSnapshot(log.afterJson);
    if (snapshot) latest.set(log.entityId, snapshot);
  }
  return [...latest.values()]
    .filter((view) => input.includeInactive || view.active)
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function latestView(viewId: string) {
  const log = await db.auditLog.findFirst({
    where: { entityType: ENTITY_TYPE, entityId: viewId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseSnapshot(log?.afterJson ?? null);
}

export async function listSavedKanbanViews(input: {
  userId: string;
  organizationId: string;
  siteId: string;
}) {
  return scopedViews(input);
}

export async function createSavedKanbanView(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  name: string;
  dueFilter: string;
}) {
  const name = normalizeName(input.name);
  const dueFilter = normalizeDueFilter(input.dueFilter);
  const existing = await scopedViews(input);
  const nameKey = name.toLocaleLowerCase("en-US");
  if (existing.some((view) => view.name.toLocaleLowerCase("en-US") === nameKey)) {
    throw new SavedKanbanViewError("NAME_CONFLICT", "A saved view with this name already exists");
  }

  const now = new Date().toISOString();
  const snapshot: SavedKanbanView = {
    id: randomUUID(),
    userId: input.userId,
    organizationId: input.organizationId,
    siteId: input.siteId,
    name,
    dueFilter,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await db.auditLog.create({
    data: {
      actorId: input.userId,
      entityType: ENTITY_TYPE,
      entityId: snapshot.id,
      action: "CREATED",
      afterJson: JSON.stringify(snapshot),
    },
  });
  return snapshot;
}

export async function deleteSavedKanbanView(input: {
  viewId: string;
  userId: string;
  organizationId: string;
  siteId: string;
}) {
  const previous = await latestView(input.viewId);
  if (
    !previous ||
    !previous.active ||
    previous.userId !== input.userId ||
    previous.organizationId !== input.organizationId ||
    previous.siteId !== input.siteId
  ) {
    throw new SavedKanbanViewError("VIEW_NOT_FOUND", "Saved view not found in user scope");
  }

  const snapshot: SavedKanbanView = {
    ...previous,
    active: false,
    updatedAt: new Date().toISOString(),
  };
  await db.auditLog.create({
    data: {
      actorId: input.userId,
      entityType: ENTITY_TYPE,
      entityId: snapshot.id,
      action: "DELETED",
      beforeJson: JSON.stringify(previous),
      afterJson: JSON.stringify(snapshot),
    },
  });
  return snapshot;
}
