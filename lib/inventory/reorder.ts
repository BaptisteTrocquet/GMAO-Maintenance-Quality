import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { reservedQuantityForOthers } from "@/lib/inventory/reservations";

const ENTITY_TYPE = "StockReorderPolicy";

export type ReorderPolicySnapshot = {
  id: string;
  organizationId: string;
  siteId: string;
  binId: string;
  partId: string;
  minQuantity: number;
  maxQuantity: number;
  reorderQuantity: number | null;
  active: boolean;
  updatedAt: string;
};

export class ReorderPolicyError extends Error {
  constructor(
    public readonly code:
      | "BIN_NOT_FOUND"
      | "PART_NOT_FOUND"
      | "INVALID_MIN_MAX"
      | "POLICY_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ReorderPolicyError";
  }
}

function policyId(binId: string, partId: string) {
  return createHash("sha256").update(`${binId}:${partId}`).digest("hex");
}

function parsePolicy(value: string | null): ReorderPolicySnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ReorderPolicySnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.binId !== "string" ||
      typeof parsed.partId !== "string" ||
      typeof parsed.minQuantity !== "number" ||
      typeof parsed.maxQuantity !== "number" ||
      !(parsed.reorderQuantity === null || typeof parsed.reorderQuantity === "number") ||
      typeof parsed.active !== "boolean" ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return parsed as ReorderPolicySnapshot;
  } catch {
    return null;
  }
}

async function latestPolicy(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  input: { binId: string; partId: string },
) {
  const log = await client.auditLog.findFirst({
    where: { entityType: ENTITY_TYPE, entityId: policyId(input.binId, input.partId) },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parsePolicy(log?.afterJson ?? null);
}

async function listPoliciesWithClient(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  input: { organizationId: string; siteId: string; includeInactive?: boolean },
) {
  const marker = `"organizationId":"${input.organizationId}","siteId":"${input.siteId}"`;
  const logs = await client.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, afterJson: { contains: marker } },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });
  const latest = new Map<string, ReorderPolicySnapshot>();
  for (const log of logs) {
    const policy = parsePolicy(log.afterJson);
    if (policy) latest.set(log.entityId, policy);
  }
  return [...latest.values()].filter((policy) => input.includeInactive || policy.active);
}

async function validateScope(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; binId: string; partId: string },
) {
  const [bin, part] = await Promise.all([
    tx.stockBin.findFirst({
      where: {
        id: input.binId,
        active: true,
        warehouse: {
          active: true,
          siteId: input.siteId,
          site: { organizationId: input.organizationId, active: true },
        },
      },
      select: { id: true },
    }),
    tx.part.findFirst({
      where: { id: input.partId, organizationId: input.organizationId, active: true },
      select: { id: true },
    }),
  ]);
  if (!bin) throw new ReorderPolicyError("BIN_NOT_FOUND", "Active stock bin not found in site scope");
  if (!part) throw new ReorderPolicyError("PART_NOT_FOUND", "Active part not found in organization scope");
}

export async function setReorderPolicy(input: {
  organizationId: string;
  siteId: string;
  binId: string;
  partId: string;
  minQuantity: number;
  maxQuantity: number;
  reorderQuantity?: number | null;
  actorId: string;
}) {
  if (input.minQuantity < 0 || input.maxQuantity < input.minQuantity) {
    throw new ReorderPolicyError(
      "INVALID_MIN_MAX",
      "maxQuantity must be greater than or equal to non-negative minQuantity",
    );
  }
  if (input.reorderQuantity !== undefined && input.reorderQuantity !== null && input.reorderQuantity <= 0) {
    throw new ReorderPolicyError("INVALID_MIN_MAX", "reorderQuantity must be positive when supplied");
  }

  return db.$transaction(async (tx) => {
    await validateScope(tx, input);
    const previous = await latestPolicy(tx, input);
    const snapshot: ReorderPolicySnapshot = {
      id: policyId(input.binId, input.partId),
      organizationId: input.organizationId,
      siteId: input.siteId,
      binId: input.binId,
      partId: input.partId,
      minQuantity: input.minQuantity,
      maxQuantity: input.maxQuantity,
      reorderQuantity: input.reorderQuantity ?? null,
      active: true,
      updatedAt: new Date().toISOString(),
    };
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        entityType: ENTITY_TYPE,
        entityId: snapshot.id,
        action: previous ? "UPDATED" : "CREATED",
        beforeJson: previous ? JSON.stringify(previous) : null,
        afterJson: JSON.stringify(snapshot),
      },
    });
    return snapshot;
  });
}

export async function disableReorderPolicy(input: {
  organizationId: string;
  siteId: string;
  binId: string;
  partId: string;
  actorId: string;
}) {
  return db.$transaction(async (tx) => {
    const previous = await latestPolicy(tx, input);
    if (
      !previous ||
      previous.organizationId !== input.organizationId ||
      previous.siteId !== input.siteId ||
      !previous.active
    ) {
      throw new ReorderPolicyError("POLICY_NOT_FOUND", "Active reorder policy not found");
    }
    const snapshot: ReorderPolicySnapshot = {
      ...previous,
      active: false,
      updatedAt: new Date().toISOString(),
    };
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        entityType: ENTITY_TYPE,
        entityId: snapshot.id,
        action: "DISABLED",
        beforeJson: JSON.stringify(previous),
        afterJson: JSON.stringify(snapshot),
      },
    });
    return snapshot;
  });
}

export async function listReorderPolicies(input: {
  organizationId: string;
  siteId: string;
  includeInactive?: boolean;
}) {
  return listPoliciesWithClient(db as unknown as Pick<Prisma.TransactionClient, "auditLog">, input);
}

export async function getReorderAlerts(input: {
  organizationId: string;
  siteId: string;
  includeOk?: boolean;
}) {
  return db.$transaction(async (tx) => {
    const policies = await listPoliciesWithClient(tx, input);
    const alerts = [];

    for (const policy of policies) {
      const [balance, part, bin, reserved] = await Promise.all([
        tx.stockBalance.findUnique({
          where: { binId_partId: { binId: policy.binId, partId: policy.partId } },
          select: { quantity: true },
        }),
        tx.part.findFirst({
          where: {
            id: policy.partId,
            organizationId: input.organizationId,
            active: true,
          },
          select: { id: true, sku: true, name: true, unit: true },
        }),
        tx.stockBin.findFirst({
          where: {
            id: policy.binId,
            active: true,
            warehouse: { active: true, siteId: input.siteId },
          },
          select: {
            id: true,
            code: true,
            name: true,
            warehouse: { select: { id: true, code: true, name: true } },
          },
        }),
        reservedQuantityForOthers(tx, { binId: policy.binId, partId: policy.partId }),
      ]);
      if (!part || !bin) continue;

      const onHand = balance?.quantity ?? 0;
      const available = Math.max(onHand - reserved, 0);
      const status = available <= 0 ? "OUT_OF_STOCK" : available <= policy.minQuantity ? "REORDER" : "OK";
      if (status === "OK" && !input.includeOk) continue;
      const suggestedOrderQuantity =
        status === "OK"
          ? 0
          : policy.reorderQuantity ?? Math.max(policy.maxQuantity - available, 0);

      alerts.push({
        policy,
        part,
        bin,
        onHand,
        reserved,
        available,
        status,
        suggestedOrderQuantity,
      });
    }

    return alerts.sort((left, right) => {
      const severity = { OUT_OF_STOCK: 0, REORDER: 1, OK: 2 } as const;
      const bySeverity = severity[left.status] - severity[right.status];
      return bySeverity || left.part.sku.localeCompare(right.part.sku);
    });
  });
}
