import { createHash } from "node:crypto";
import { db } from "@/lib/db";

const ENTITY_TYPE = "DashboardKpiCardConfig";

export const DASHBOARD_KPI_KEYS = [
  "OPEN_WORK",
  "BLOCKED_WORK",
  "OVERDUE_WORK",
  "DUE_SOON_WORK",
  "URGENT_WORK",
  "PENDING_APPROVALS",
] as const;

export type DashboardKpiKey = (typeof DASHBOARD_KPI_KEYS)[number];

export type DashboardKpiConfig = {
  organizationId: string;
  siteId: string;
  userId: string;
  cards: DashboardKpiKey[];
  updatedAt: string;
};

export class DashboardKpiConfigError extends Error {
  constructor(
    public readonly code: "INVALID_CARDS",
    message: string,
  ) {
    super(message);
    this.name = "DashboardKpiConfigError";
  }
}

function configId(input: { organizationId: string; siteId: string; userId: string }) {
  return createHash("sha256")
    .update(`${input.organizationId}:${input.siteId}:${input.userId}`)
    .digest("hex");
}

function defaultConfig(input: { organizationId: string; siteId: string; userId: string }): DashboardKpiConfig {
  return {
    ...input,
    cards: [...DASHBOARD_KPI_KEYS],
    updatedAt: new Date(0).toISOString(),
  };
}

function parseConfig(value: string | null): DashboardKpiConfig | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DashboardKpiConfig>;
    if (
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !Array.isArray(parsed.cards)
    ) {
      return null;
    }
    const cards = parsed.cards.filter(
      (key): key is DashboardKpiKey =>
        typeof key === "string" && (DASHBOARD_KPI_KEYS as readonly string[]).includes(key),
    );
    if (cards.length !== parsed.cards.length || new Set(cards).size !== cards.length) return null;
    return { ...parsed, cards } as DashboardKpiConfig;
  } catch {
    return null;
  }
}

function validateCards(cards: DashboardKpiKey[]) {
  if (cards.length > DASHBOARD_KPI_KEYS.length || new Set(cards).size !== cards.length) {
    throw new DashboardKpiConfigError("INVALID_CARDS", "KPI card selection must contain unique supported keys");
  }
  for (const key of cards) {
    if (!(DASHBOARD_KPI_KEYS as readonly string[]).includes(key)) {
      throw new DashboardKpiConfigError("INVALID_CARDS", `Unsupported KPI card: ${key}`);
    }
  }
}

export async function getDashboardKpiConfig(input: {
  organizationId: string;
  siteId: string;
  userId: string;
}) {
  const log = await db.auditLog.findFirst({
    where: { entityType: ENTITY_TYPE, entityId: configId(input) },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  const parsed = parseConfig(log?.afterJson ?? null);
  if (
    parsed &&
    parsed.organizationId === input.organizationId &&
    parsed.siteId === input.siteId &&
    parsed.userId === input.userId
  ) {
    return parsed;
  }
  return defaultConfig(input);
}

export async function saveDashboardKpiConfig(input: {
  organizationId: string;
  siteId: string;
  userId: string;
  cards: DashboardKpiKey[];
}) {
  validateCards(input.cards);
  const previous = await getDashboardKpiConfig(input);
  const snapshot: DashboardKpiConfig = {
    organizationId: input.organizationId,
    siteId: input.siteId,
    userId: input.userId,
    cards: [...input.cards],
    updatedAt: new Date().toISOString(),
  };
  await db.auditLog.create({
    data: {
      actorId: input.userId,
      entityType: ENTITY_TYPE,
      entityId: configId(input),
      action: "UPDATED",
      beforeJson: JSON.stringify(previous),
      afterJson: JSON.stringify(snapshot),
    },
  });
  return snapshot;
}
