import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { WorkOrderDueFilter } from "@/lib/maintenance/board";

const ENTITY_TYPE = "MaintenanceSavedView";
export const SAVED_VIEW_LIMIT = 25;

export type SavedMaintenanceSurface = "KANBAN" | "CALENDAR";
export type SavedKanbanConfig = { dueFilter: WorkOrderDueFilter };
export type SavedCalendarConfig = { month: string | null };
export type SavedMaintenanceConfig = SavedKanbanConfig | SavedCalendarConfig;

export type SavedMaintenanceViewSnapshot = {
  id: string;
  organizationId: string;
  siteId: string;
  userId: string;
  surface: SavedMaintenanceSurface;
  name: string;
  config: SavedMaintenanceConfig;
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

function validMonth(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return false;
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  return year >= 1970 && year <= 9999 && month >= 1 && month <= 12;
}

function validConfig(surface: SavedMaintenanceSurface, config: SavedMaintenanceConfig) {
  if (surface === "KANBAN") {
    return "dueFilter" in config && validDueFilter(config.dueFilter);
  }
  return "month" in config && validMonth(config.month);
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
      (parsed.surface !== "KANBAN" && parsed.surface !== "CALENDAR") ||
      typeof parsed.name !== "string" ||
      !parsed.config ||
      !validConfig(parsed.surface, parsed.config) ||
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

function scopeWhere(input: {
  organizationId: string;
  siteId: string;
  userId: string;
}): Prisma.AuditLogWhereInput {
  return {
    entityType: ENTITY_TYPE,
    actorId: input.userId,
    AND: [
      { afterJson: { contains: `"organizationId":"${input.organizationId}"` } },
      { afterJson: { contains: `"siteId":"${input.siteId}"` } },
      { afterJson: { contains: `"userId":"${input.userId}"` } },
    ],
  };
}

export async function listSavedMaintenanceViews(input: {
  organizationId: string;
  siteId: string;
  userId: string;
  surface?: SavedMaintenanceSurface;
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
    .filter(
      (view) =>
        (input.includeInactive || view.active) &&
        (!input.surface || view.surface === input.surface),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizedName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export async function createSavedMaintenanceView(input: {
  organizationId: string;
  siteId: string;
  userId: string;
  name: string;
  surface: SavedMaintenanceSurface;
  config: SavedMaintenanceConfig;
}) {
  const name = normalizedName(input.name);
  if (!name || name.length > 80 || !validConfig(input.surface, input.config)) {
    throw new SavedMaintenanceViewError(
      "INVALID_VIEW",
      "Saved view name and filter configuration are invalid",
    );
  }

  const active = await listSavedMaintenanceViews(input);
  if (active.length >= SAVED_VIEW_LIMIT) {
    throw new SavedMaintenanceViewError(
      "VIEW_LIMIT_REACHED",
      `A user can save at most ${SAVED_VIEW_LIMIT} active views per site`,
    );
  }
  if (
    active.some(
      (view) =>
        view.surface === input.surface &&
        view.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"),
    )
  ) {
    throw new SavedMaintenanceViewError(
      "DUPLICATE_VIEW_NAME",
      "A saved view with this name already exists for this planning surface",
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
  const current = (
    await listSavedMaintenanceViews({ ...input, includeInactive: true })
  ).find((view) => view.id === input.viewId);
  if (!current || !current.active) {
    throw new SavedMaintenanceViewError(
      "VIEW_NOT_FOUND",
      "Saved view not found in user/site scope",
    );
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

export function savedMaintenanceHref(
  view: Pick<SavedMaintenanceViewSnapshot, "surface" | "config">,
) {
  if (view.surface === "KANBAN") {
    const config = view.config as SavedKanbanConfig;
    return config.dueFilter === "ALL"
      ? "/maintenance/kanban"
      : `/maintenance/kanban?due=${encodeURIComponent(config.dueFilter)}`;
  }
  const config = view.config as SavedCalendarConfig;
  return config.month
    ? `/maintenance/calendar?month=${encodeURIComponent(config.month)}`
    : "/maintenance/calendar";
}
