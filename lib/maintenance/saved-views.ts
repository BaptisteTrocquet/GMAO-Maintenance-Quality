import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { WorkOrderDueFilter } from "@/lib/maintenance/board";

const ENTITY_TYPE = "MaintenanceSavedView";
export const SAVED_VIEW_LIMIT = 25;

export type SavedMaintenanceSurface = "KANBAN";

export type SavedKanbanConfig = {
  dueFilter: WorkOrderDueFilter;
};

export type SavedMaintenanceViewSnapshot = {
  id: string;
  organizationId: string;
  siteId: string;
  userId: string;
  surface: SavedMaintenanceSurface;
  name: string;
  config: SavedKanbanConfig;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

const DUE_FILTERS: readonly WorkOrderDueFilter[] = [
  "ALL",
  "OVERDUE",
  "DUE_7_DAYS",
  "NO_DUE_DATE",
];

export class SavedMaintenanceViewError extends Error {
  constructor(
    public readonly code:
      | "INVALID_VIEW"
      | "VIEW_LIMIT_REACHED"
      | "DUPLICATE_VIEW_NAME"
      | "VIEW_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SavedMaintenanceViewError";
  }
}

function validDueFilter(value: unknown): value is WorkOrderDueFilter {
  return DUE_FILTERS.includes(value as WorkOrderDueFilter);
}

function parseSnapshot(value: string | null): SavedMaintenanceViewSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SavedMaintenanceViewSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.userId !== "string" ||
      parsed.surface !== "KANBAN" ||
      typeof parsed.name !== "string" ||
      !parsed.config ||
      !validDueFilter(parsed.config.dueFilter) ||
      typeof parsed.active !== "boolean" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return parsed as SavedMaintenanceViewSnapshot;
  } catch {
    return null;
  }
}

function scopeWhere(input: { organizationId: string; siteId: string; userId: string }) {
  return {
    entityType: ENTITY_TYPE,
    AND: [
      { afterJson: { contains: `"organizationId":"${input.organizationId}"` } },
      { afterJson: { contains: `"siteId":"${input.siteId}"` } },
      { afterJson: { contains: `"userId":"${input.userId}"` } },
    ],
  } as const;
}

export async function listSavedMaintenanceViews(input: {
  organizationId: string;
  siteId: string;
  userId: string;
  includeInactive?: boolean;
}) {
  const records = await db.auditLog.findMany({
    where: scopeWhere(input),
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });

  const latest = new Map<string, SavedMaintenanceViewSnapshot>();
  for (const record of records) {
    const snapshot = parseSnapshot(record.afterJson);
    if (
      snapshot &&
      snapshot.organizationId === input.organizationId &&
      snapshot.siteId === input.siteId &&
      snapshot.userId === input.userId
    ) {
      latest.set(record.entityId, snapshot);
    }
  }

  return [...latest.values()]
    .filter((view) => input.includeInactive || view.active)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function createSavedMaintenanceView(input: {
  organizationId: string;
  siteId: string;
  userId: string;
  name: string;
  surface: SavedMaintenanceSurface;
  config: SavedKanbanConfig;
}) {
  const name = input.name.trim();
  if (!name || name.length > 80 || input.surface !== "KANBAN" || !validDueFilter(input.config.dueFilter)) {
    throw new SavedMaintenanceViewError("INVALID_VIEW", "Saved view name and filter configuration are invalid");
  }

  const active = await listSavedMaintenanceViews(input);
  if (active.length >= SAVED_VIEW_LIMIT) {
    throw new SavedMaintenanceViewError(
      "VIEW_LIMIT_REACHED",
      `A user can save at most ${SAVED_VIEW_LIMIT} active views per site`,
    );
  }
  if (active.some((view) => view.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new SavedMaintenanceViewError(
      "DUPLICATE_VIEW_NAME",
      "A saved view with this name already exists for this site",
    );
  }

  const now = new Date().toISOString();
  const snapshot: SavedMaintenanceViewSnapshot = {
    id: randomUUID(),
    organizationId: input.organizationId,
    siteId: input.siteId,
    userId: input.userId,
    surface: input.surface,
    name,
    config: input.config,
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

export async function deleteSavedMaintenanceView(input: {
  organizationId: string;
  siteId: string;
  userId: string;
  viewId: string;
}) {
  const current = (await listSavedMaintenanceViews({ ...input, includeInactive: true })).find(
    (view) => view.id === input.viewId,
  );
  if (!current || !current.active) {
    throw new SavedMaintenanceViewError("VIEW_NOT_FOUND", "Saved view not found in user/site scope");
  }

  const snapshot: SavedMaintenanceViewSnapshot = {
    ...current,
    active: false,
    updatedAt: new Date().toISOString(),
  };
  await db.auditLog.create({
    data: {
      actorId: input.userId,
      entityType: ENTITY_TYPE,
      entityId: current.id,
      action: "DELETED",
      beforeJson: JSON.stringify(current),
      afterJson: JSON.stringify(snapshot),
    },
  });
  return snapshot;
}

export function savedKanbanHref(view: Pick<SavedMaintenanceViewSnapshot, "surface" | "config">) {
  if (view.surface !== "KANBAN") return "/maintenance/kanban";
  return view.config.dueFilter === "ALL"
    ? "/maintenance/kanban"
    : `/maintenance/kanban?due=${encodeURIComponent(view.config.dueFilter)}`;
}
