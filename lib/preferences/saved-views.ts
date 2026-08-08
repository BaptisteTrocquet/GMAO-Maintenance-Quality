import { createHash } from "node:crypto";
import { db } from "@/lib/db";

const ENTITY_TYPE = "SavedPlanningView";

export type SavedViewSurface = "KANBAN" | "CALENDAR" | "WORKLOAD";

export type SavedPlanningView = {
  id: string;
  userId: string;
  organizationId: string;
  siteId: string;
  name: string;
  surface: SavedViewSurface;
  params: Record<string, string>;
  active: boolean;
  updatedAt: string;
};

export class SavedViewError extends Error {
  constructor(
    public readonly code: "INVALID_PARAMS" | "VIEW_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SavedViewError";
  }
}

function viewId(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  surface: SavedViewSurface;
  name: string;
}) {
  return createHash("sha256")
    .update(
      [input.userId, input.organizationId, input.siteId, input.surface, input.name.trim().toLowerCase()].join(":"),
    )
    .digest("hex");
}

function parseSnapshot(value: string | null): SavedPlanningView | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SavedPlanningView>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.name !== "string" ||
      (parsed.surface !== "KANBAN" && parsed.surface !== "CALENDAR" && parsed.surface !== "WORKLOAD") ||
      !parsed.params ||
      typeof parsed.params !== "object" ||
      Array.isArray(parsed.params) ||
      typeof parsed.active !== "boolean" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    for (const value of Object.values(parsed.params)) {
      if (typeof value !== "string") return null;
    }
    return parsed as SavedPlanningView;
  } catch {
    return null;
  }
}

export function normalizeSavedViewParams(
  surface: SavedViewSurface,
  params: Record<string, string>,
): Record<string, string> {
  if (surface === "KANBAN") {
    const due = params.due ?? "ALL";
    if (!["ALL", "OVERDUE", "DUE_7_DAYS", "NO_DUE_DATE"].includes(due)) {
      throw new SavedViewError("INVALID_PARAMS", "Kanban due filter is not supported");
    }
    if (Object.keys(params).some((key) => key !== "due")) {
      throw new SavedViewError("INVALID_PARAMS", "Kanban saved views only support the due filter");
    }
    return due === "ALL" ? {} : { due };
  }

  if (surface === "CALENDAR") {
    if (Object.keys(params).some((key) => key !== "month")) {
      throw new SavedViewError("INVALID_PARAMS", "Calendar saved views only support the month parameter");
    }
    const month = params.month;
    if (!month) return {};
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new SavedViewError("INVALID_PARAMS", "Calendar month must use YYYY-MM");
    }
    return { month };
  }

  if (Object.keys(params).length > 0) {
    throw new SavedViewError("INVALID_PARAMS", "Workload saved views do not support parameters yet");
  }
  return {};
}

export function savedViewHref(view: Pick<SavedPlanningView, "surface" | "params">) {
  const base =
    view.surface === "KANBAN"
      ? "/maintenance/kanban"
      : view.surface === "CALENDAR"
        ? "/maintenance/calendar"
        : "/maintenance/workload";
  const query = new URLSearchParams(view.params).toString();
  return query ? `${base}?${query}` : base;
}

async function latestView(entityId: string) {
  const log = await db.auditLog.findFirst({
    where: { entityType: ENTITY_TYPE, entityId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseSnapshot(log?.afterJson ?? null);
}

export async function listSavedViews(input: {
  userId: string;
  organizationId: string;
  siteId: string;
}) {
  const marker = `\"userId\":\"${input.userId}\",\"organizationId\":\"${input.organizationId}\",\"siteId\":\"${input.siteId}\"`;
  const logs = await db.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, afterJson: { contains: marker } },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });
  const latest = new Map<string, SavedPlanningView>();
  for (const log of logs) {
    const view = parseSnapshot(log.afterJson);
    if (
      view &&
      view.userId === input.userId &&
      view.organizationId === input.organizationId &&
      view.siteId === input.siteId
    ) {
      latest.set(log.entityId, view);
    }
  }
  return [...latest.values()]
    .filter((view) => view.active)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function saveView(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  name: string;
  surface: SavedViewSurface;
  params: Record<string, string>;
}) {
  const name = input.name.trim();
  const params = normalizeSavedViewParams(input.surface, input.params);
  const id = viewId({ ...input, name });
  const previous = await latestView(id);
  const snapshot: SavedPlanningView = {
    id,
    userId: input.userId,
    organizationId: input.organizationId,
    siteId: input.siteId,
    name,
    surface: input.surface,
    params,
    active: true,
    updatedAt: new Date().toISOString(),
  };
  await db.auditLog.create({
    data: {
      actorId: input.userId,
      entityType: ENTITY_TYPE,
      entityId: id,
      action: previous ? "UPDATED" : "CREATED",
      beforeJson: previous ? JSON.stringify(previous) : null,
      afterJson: JSON.stringify(snapshot),
    },
  });
  return snapshot;
}

export async function deleteSavedView(input: {
  userId: string;
  organizationId: string;
  siteId: string;
  name: string;
  surface: SavedViewSurface;
}) {
  const id = viewId({ ...input, name: input.name.trim() });
  const previous = await latestView(id);
  if (
    !previous ||
    !previous.active ||
    previous.userId !== input.userId ||
    previous.organizationId !== input.organizationId ||
    previous.siteId !== input.siteId
  ) {
    throw new SavedViewError("VIEW_NOT_FOUND", "Saved view not found");
  }
  const snapshot: SavedPlanningView = {
    ...previous,
    active: false,
    updatedAt: new Date().toISOString(),
  };
  await db.auditLog.create({
    data: {
      actorId: input.userId,
      entityType: ENTITY_TYPE,
      entityId: id,
      action: "DELETED",
      beforeJson: JSON.stringify(previous),
      afterJson: JSON.stringify(snapshot),
    },
  });
  return snapshot;
}
