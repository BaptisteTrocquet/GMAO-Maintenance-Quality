import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

const ENTITY_TYPE = "SavedPlanningView";
const MAX_SAVED_VIEWS = 50;
const MAX_AUDIT_ROWS = 500;

export type SavedPlanningView = {
  id: string;
  organizationId: string;
  userId: string;
  name: string;
  path: "/maintenance/kanban" | "/maintenance/calendar" | "/maintenance/workload";
  query: string;
  active: boolean;
  updatedAt: string;
};

export class SavedPlanningViewError extends Error {
  constructor(
    public readonly code:
      | "INVALID_VIEW"
      | "VIEW_LIMIT_REACHED"
      | "VIEW_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "SavedPlanningViewError";
  }
}

function parseSnapshot(value: string | null): SavedPlanningView | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SavedPlanningView>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.name !== "string" ||
      (parsed.path !== "/maintenance/kanban" &&
        parsed.path !== "/maintenance/calendar" &&
        parsed.path !== "/maintenance/workload") ||
      typeof parsed.query !== "string" ||
      typeof parsed.active !== "boolean" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return parsed as SavedPlanningView;
  } catch {
    return null;
  }
}

function normalizeView(input: { path: string; query?: string | null }) {
  const params = new URLSearchParams(input.query ?? "");

  if (input.path === "/maintenance/kanban") {
    const due = params.get("due");
    const allowedDue = new Set(["ALL", "OVERDUE", "DUE_7_DAYS", "NO_DUE_DATE"]);
    if (due && !allowedDue.has(due)) {
      throw new SavedPlanningViewError("INVALID_VIEW", "Unsupported Kanban due filter");
    }
    const normalized = new URLSearchParams();
    if (due && due !== "ALL") normalized.set("due", due);
    return { path: input.path as SavedPlanningView["path"], query: normalized.toString() };
  }

  if (input.path === "/maintenance/calendar") {
    const month = params.get("month");
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new SavedPlanningViewError("INVALID_VIEW", "Calendar month must use YYYY-MM");
    }
    const normalized = new URLSearchParams();
    if (month) normalized.set("month", month);
    return { path: input.path as SavedPlanningView["path"], query: normalized.toString() };
  }

  if (input.path === "/maintenance/workload") {
    return { path: input.path as SavedPlanningView["path"], query: "" };
  }

  throw new SavedPlanningViewError("INVALID_VIEW", "Only maintenance planning views can be saved");
}

async function loadLatestViews(input: { organizationId: string; userId: string }) {
  const rows = await db.auditLog.findMany({
    where: {
      entityType: ENTITY_TYPE,
      actorId: input.userId,
      afterJson: { contains: `\"organizationId\":\"${input.organizationId}\"` },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_AUDIT_ROWS,
    select: { entityId: true, afterJson: true },
  });

  const latest = new Map<string, SavedPlanningView>();
  for (const row of rows) {
    if (latest.has(row.entityId)) continue;
    const snapshot = parseSnapshot(row.afterJson);
    if (
      snapshot &&
      snapshot.organizationId === input.organizationId &&
      snapshot.userId === input.userId
    ) {
      latest.set(row.entityId, snapshot);
    }
  }
  return [...latest.values()];
}

export async function listSavedPlanningViews(input: {
  organizationId: string;
  userId: string;
}) {
  const views = await loadLatestViews(input);
  return views
    .filter((view) => view.active)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function createSavedPlanningView(input: {
  organizationId: string;
  userId: string;
  name: string;
  path: string;
  query?: string | null;
}) {
  const name = input.name.trim();
  if (!name || name.length > 60) {
    throw new SavedPlanningViewError("INVALID_VIEW", "View name must contain 1 to 60 characters");
  }
  const normalized = normalizeView(input);
  const existing = await listSavedPlanningViews({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (existing.length >= MAX_SAVED_VIEWS) {
    throw new SavedPlanningViewError(
      "VIEW_LIMIT_REACHED",
      `A user can save at most ${MAX_SAVED_VIEWS} planning views per organization`,
    );
  }

  const snapshot: SavedPlanningView = {
    id: randomUUID(),
    organizationId: input.organizationId,
    userId: input.userId,
    name,
    path: normalized.path,
    query: normalized.query,
    active: true,
    updatedAt: new Date().toISOString(),
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

export async function deleteSavedPlanningView(input: {
  organizationId: string;
  userId: string;
  viewId: string;
}) {
  const row = await db.auditLog.findFirst({
    where: {
      entityType: ENTITY_TYPE,
      entityId: input.viewId,
      actorId: input.userId,
    },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  const previous = parseSnapshot(row?.afterJson ?? null);
  if (
    !previous ||
    previous.organizationId !== input.organizationId ||
    previous.userId !== input.userId ||
    !previous.active
  ) {
    throw new SavedPlanningViewError("VIEW_NOT_FOUND", "Saved planning view not found");
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
      entityId: previous.id,
      action: "DELETED",
      beforeJson: JSON.stringify(previous),
      afterJson: JSON.stringify(snapshot),
    },
  });
  return snapshot;
}

export function savedPlanningViewHref(view: Pick<SavedPlanningView, "path" | "query">) {
  return view.query ? `${view.path}?${view.query}` : view.path;
}
