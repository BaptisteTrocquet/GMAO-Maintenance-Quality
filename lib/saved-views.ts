import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

const ENTITY_TYPE = "SavedView";

export const SAVED_VIEW_SURFACES = ["WORK_ORDER_KANBAN"] as const;
export type SavedViewSurface = (typeof SAVED_VIEW_SURFACES)[number];

export type SavedViewSnapshot = {
  id: string;
  userId: string;
  organizationId: string;
  siteId: string;
  surface: SavedViewSurface;
  name: string;
  filters: Record<string, string>;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export class SavedViewError extends Error {
  constructor(
    public readonly code: "VIEW_NOT_FOUND" | "VIEW_NAME_CONFLICT" | "INVALID_VIEW_NAME",
    message: string,
  ) {
    super(message);
    this.name = "SavedViewError";
  }
}

function parseSnapshot(value: string | null): SavedViewSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SavedViewSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      !SAVED_VIEW_SURFACES.includes(parsed.surface as SavedViewSurface) ||
      typeof parsed.name !== "string" ||
      !parsed.filters ||
      typeof parsed.filters !== "object" ||
      Array.isArray(parsed.filters) ||
      typeof parsed.active !== "boolean" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }

    const filters: Record<string, string> = {};
    for (const [key, filterValue] of Object.entries(parsed.filters)) {
      if (typeof filterValue !== "string") return null;
      filters[key] = filterValue;
    }

    return { ...(parsed as SavedViewSnapshot), filters };
  } catch {
    return null;
  }
}

function normalizedName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

function nameKey(name: string) {
  return normalizedName(name).toLocaleLowerCase("en-US");
}

function scopeMarkers(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  surface: SavedViewSurface;
}) {
  return [
    `"userId":"${input.userId}"`,
    `"organizationId":"${input.organizationId}"`,
    `"siteId":"${input.siteId}"`,
    `"surface":"${input.surface}"`,
  ];
}

async function listScopedSnapshots(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  surface: SavedViewSurface;
  includeInactive?: boolean;
}) {
  const markers = scopeMarkers(input);
  const logs = await db.auditLog.findMany({
    where: {
      entityType: ENTITY_TYPE,
      AND: markers.map((marker) => ({ afterJson: { contains: marker } })),
    },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });

  const latest = new Map<string, SavedViewSnapshot>();
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

function assertName(name: string) {
  const normalized = normalizedName(name);
  if (!normalized || normalized.length > 80) {
    throw new SavedViewError("INVALID_VIEW_NAME", "Saved view name must contain 1 to 80 characters");
  }
  return normalized;
}

async function assertUniqueName(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  surface: SavedViewSurface;
  name: string;
  excludeId?: string;
}) {
  const views = await listScopedSnapshots(input);
  const target = nameKey(input.name);
  if (views.some((view) => view.id !== input.excludeId && nameKey(view.name) === target)) {
    throw new SavedViewError("VIEW_NAME_CONFLICT", "A saved view with this name already exists");
  }
}

export async function listSavedViews(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  surface: SavedViewSurface;
}) {
  return listScopedSnapshots(input);
}

export async function createSavedView(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  surface: SavedViewSurface;
  name: string;
  filters: Record<string, string>;
}) {
  const name = assertName(input.name);
  await assertUniqueName({ ...input, name });
  const now = new Date().toISOString();
  const snapshot: SavedViewSnapshot = {
    id: randomUUID(),
    userId: input.userId,
    organizationId: input.organizationId,
    siteId: input.siteId,
    surface: input.surface,
    name,
    filters: input.filters,
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

export async function updateSavedView(input: {
  viewId: string;
  userId: string;
  organizationId: string;
  siteId: string;
  surface: SavedViewSurface;
  name?: string;
  filters?: Record<string, string>;
}) {
  const previous = await latestView(input.viewId);
  if (
    !previous ||
    !previous.active ||
    previous.userId !== input.userId ||
    previous.organizationId !== input.organizationId ||
    previous.siteId !== input.siteId ||
    previous.surface !== input.surface
  ) {
    throw new SavedViewError("VIEW_NOT_FOUND", "Saved view not found in user scope");
  }

  const name = input.name === undefined ? previous.name : assertName(input.name);
  await assertUniqueName({ ...input, name, excludeId: previous.id });
  const snapshot: SavedViewSnapshot = {
    ...previous,
    name,
    filters: input.filters ?? previous.filters,
    updatedAt: new Date().toISOString(),
  };

  await db.auditLog.create({
    data: {
      actorId: input.userId,
      entityType: ENTITY_TYPE,
      entityId: snapshot.id,
      action: "UPDATED",
      beforeJson: JSON.stringify(previous),
      afterJson: JSON.stringify(snapshot),
    },
  });
  return snapshot;
}

export async function deleteSavedView(input: {
  viewId: string;
  userId: string;
  organizationId: string;
  siteId: string;
  surface: SavedViewSurface;
}) {
  const previous = await latestView(input.viewId);
  if (
    !previous ||
    !previous.active ||
    previous.userId !== input.userId ||
    previous.organizationId !== input.organizationId ||
    previous.siteId !== input.siteId ||
    previous.surface !== input.surface
  ) {
    throw new SavedViewError("VIEW_NOT_FOUND", "Saved view not found in user scope");
  }

  const snapshot: SavedViewSnapshot = {
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
