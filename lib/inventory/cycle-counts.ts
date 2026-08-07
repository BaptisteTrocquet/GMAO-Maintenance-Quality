import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { applyStockMovement, StockMovementError } from "@/lib/inventory/stock";

const ENTITY_TYPE = "StockCycleCount";
const MAX_TRANSACTION_ATTEMPTS = 4;

export type CycleCountStatus = "OPEN" | "COMPLETED" | "CANCELLED";

export type CycleCountItem = {
  partId: string;
  sku: string;
  name: string;
  unit: string;
  expectedQuantity: number;
  countedQuantity: number | null;
  countedById: string | null;
  countedAt: string | null;
};

export type CycleCountSnapshot = {
  id: string;
  organizationId: string;
  siteId: string;
  binId: string;
  warehouseCode: string;
  binCode: string;
  status: CycleCountStatus;
  items: CycleCountItem[];
  createdById: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
};

export class CycleCountError extends Error {
  constructor(
    public readonly code:
      | "BIN_NOT_FOUND"
      | "EMPTY_BIN"
      | "COUNT_NOT_FOUND"
      | "COUNT_NOT_OPEN"
      | "PART_NOT_IN_COUNT"
      | "COUNT_INCOMPLETE"
      | "COUNT_STALE"
      | "COUNT_ADJUSTMENT_BLOCKED",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CycleCountError";
  }
}

function parseSnapshot(value: string | null): CycleCountSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CycleCountSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.binId !== "string" ||
      typeof parsed.warehouseCode !== "string" ||
      typeof parsed.binCode !== "string" ||
      (parsed.status !== "OPEN" && parsed.status !== "COMPLETED" && parsed.status !== "CANCELLED") ||
      !Array.isArray(parsed.items) ||
      typeof parsed.createdById !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !(parsed.completedAt === null || typeof parsed.completedAt === "string") ||
      !(parsed.cancelledAt === null || typeof parsed.cancelledAt === "string")
    ) {
      return null;
    }

    for (const item of parsed.items) {
      if (
        typeof item !== "object" ||
        item === null ||
        typeof item.partId !== "string" ||
        typeof item.sku !== "string" ||
        typeof item.name !== "string" ||
        typeof item.unit !== "string" ||
        typeof item.expectedQuantity !== "number" ||
        !(item.countedQuantity === null || typeof item.countedQuantity === "number") ||
        !(item.countedById === null || typeof item.countedById === "string") ||
        !(item.countedAt === null || typeof item.countedAt === "string")
      ) {
        return null;
      }
    }
    return parsed as CycleCountSnapshot;
  } catch {
    return null;
  }
}

async function latestCount(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  countId: string,
) {
  const log = await client.auditLog.findFirst({
    where: { entityType: ENTITY_TYPE, entityId: countId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseSnapshot(log?.afterJson ?? null);
}

async function appendSnapshot(
  tx: Prisma.TransactionClient,
  snapshot: CycleCountSnapshot,
  input: { actorId: string; action: string; previous?: CycleCountSnapshot | null },
) {
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      entityType: ENTITY_TYPE,
      entityId: snapshot.id,
      action: input.action,
      beforeJson: input.previous ? JSON.stringify(input.previous) : null,
      afterJson: JSON.stringify(snapshot),
    },
  });
}

function retryable(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export async function createCycleCount(input: {
  organizationId: string;
  siteId: string;
  binId: string;
  actorId: string;
}) {
  return db.$transaction(
    async (tx) => {
      const bin = await tx.stockBin.findFirst({
        where: {
          id: input.binId,
          active: true,
          warehouse: {
            active: true,
            siteId: input.siteId,
            site: { organizationId: input.organizationId, active: true },
          },
        },
        select: {
          id: true,
          code: true,
          warehouse: { select: { code: true } },
        },
      });
      if (!bin) throw new CycleCountError("BIN_NOT_FOUND", "Active stock bin not found in site scope");

      const balances = await tx.stockBalance.findMany({
        where: {
          binId: bin.id,
          part: { organizationId: input.organizationId, active: true },
        },
        include: {
          part: { select: { id: true, sku: true, name: true, unit: true } },
        },
        orderBy: { part: { sku: "asc" } },
      });
      if (balances.length === 0) {
        throw new CycleCountError("EMPTY_BIN", "No active part balances exist in this bin");
      }

      const now = new Date().toISOString();
      const snapshot: CycleCountSnapshot = {
        id: randomUUID(),
        organizationId: input.organizationId,
        siteId: input.siteId,
        binId: bin.id,
        warehouseCode: bin.warehouse.code,
        binCode: bin.code,
        status: "OPEN",
        items: balances.map((balance) => ({
          partId: balance.part.id,
          sku: balance.part.sku,
          name: balance.part.name,
          unit: balance.part.unit,
          expectedQuantity: balance.quantity,
          countedQuantity: null,
          countedById: null,
          countedAt: null,
        })),
        createdById: input.actorId,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        cancelledAt: null,
      };
      await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "CREATED" });
      return snapshot;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function recordCycleCountItem(input: {
  organizationId: string;
  siteId: string;
  countId: string;
  partId: string;
  countedQuantity: number;
  actorId: string;
}) {
  if (!Number.isFinite(input.countedQuantity) || input.countedQuantity < 0) {
    throw new CycleCountError("PART_NOT_IN_COUNT", "Counted quantity must be non-negative");
  }

  return db.$transaction(
    async (tx) => {
      const previous = await latestCount(tx, input.countId);
      if (
        !previous ||
        previous.organizationId !== input.organizationId ||
        previous.siteId !== input.siteId
      ) {
        throw new CycleCountError("COUNT_NOT_FOUND", "Cycle count not found in site scope");
      }
      if (previous.status !== "OPEN") {
        throw new CycleCountError("COUNT_NOT_OPEN", "Only an open cycle count can be updated");
      }

      const itemIndex = previous.items.findIndex((item) => item.partId === input.partId);
      if (itemIndex < 0) {
        throw new CycleCountError("PART_NOT_IN_COUNT", "Part is not included in this cycle count");
      }

      const now = new Date().toISOString();
      const items = previous.items.map((item, index) =>
        index === itemIndex
          ? {
              ...item,
              countedQuantity: input.countedQuantity,
              countedById: input.actorId,
              countedAt: now,
            }
          : item,
      );
      const snapshot: CycleCountSnapshot = { ...previous, items, updatedAt: now };
      await appendSnapshot(tx, snapshot, {
        actorId: input.actorId,
        action: "COUNT_RECORDED",
        previous,
      });
      return snapshot;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function completeCycleCount(input: {
  organizationId: string;
  siteId: string;
  countId: string;
  actorId: string;
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const previous = await latestCount(tx, input.countId);
          if (
            !previous ||
            previous.organizationId !== input.organizationId ||
            previous.siteId !== input.siteId
          ) {
            throw new CycleCountError("COUNT_NOT_FOUND", "Cycle count not found in site scope");
          }
          if (previous.status === "COMPLETED") return previous;
          if (previous.status !== "OPEN") {
            throw new CycleCountError("COUNT_NOT_OPEN", "Only an open cycle count can be completed");
          }
          const missing = previous.items.filter((item) => item.countedQuantity === null);
          if (missing.length > 0) {
            throw new CycleCountError(
              "COUNT_INCOMPLETE",
              "Every cycle-count item must be counted before completion",
              { partIds: missing.map((item) => item.partId) },
            );
          }

          const currentBalances = await tx.stockBalance.findMany({
            where: {
              binId: previous.binId,
              partId: { in: previous.items.map((item) => item.partId) },
            },
            select: { partId: true, quantity: true },
          });
          const currentByPart = new Map(currentBalances.map((balance) => [balance.partId, balance.quantity]));
          const stale = previous.items
            .map((item) => ({
              partId: item.partId,
              expectedQuantity: item.expectedQuantity,
              currentQuantity: currentByPart.get(item.partId) ?? 0,
            }))
            .filter((item) => item.currentQuantity !== item.expectedQuantity);
          if (stale.length > 0) {
            throw new CycleCountError(
              "COUNT_STALE",
              "Stock changed after the count snapshot; review or restart the cycle count",
              { stale },
            );
          }

          const movementIds: string[] = [];
          for (const item of previous.items) {
            const countedQuantity = item.countedQuantity as number;
            if (countedQuantity === item.expectedQuantity) continue;
            try {
              const result = await applyStockMovement(tx, {
                organizationId: previous.organizationId,
                siteId: previous.siteId,
                binId: previous.binId,
                partId: item.partId,
                type: "ADJUSTMENT",
                targetQuantity: countedQuantity,
                idempotencyKey: `cycle:${previous.id}:${item.partId}`,
                actorId: input.actorId,
                referenceType: "CycleCount",
                referenceId: previous.id,
                note: `Cycle count ${previous.id}: expected ${item.expectedQuantity}, counted ${countedQuantity}`,
              });
              movementIds.push(result.movement.id);
            } catch (error) {
              if (error instanceof StockMovementError) {
                throw new CycleCountError(
                  "COUNT_ADJUSTMENT_BLOCKED",
                  error.message,
                  { partId: item.partId, stockError: error.code },
                );
              }
              throw error;
            }
          }

          const now = new Date().toISOString();
          const snapshot: CycleCountSnapshot = {
            ...previous,
            status: "COMPLETED",
            updatedAt: now,
            completedAt: now,
          };
          await appendSnapshot(tx, snapshot, {
            actorId: input.actorId,
            action: "COMPLETED",
            previous,
          });
          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              entityType: "StockCycleCount",
              entityId: previous.id,
              action: "ADJUSTMENTS_APPLIED",
              afterJson: JSON.stringify({ movementIds }),
            },
          });
          return snapshot;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
    }
  }
  throw lastError;
}

export async function cancelCycleCount(input: {
  organizationId: string;
  siteId: string;
  countId: string;
  actorId: string;
}) {
  return db.$transaction(async (tx) => {
    const previous = await latestCount(tx, input.countId);
    if (
      !previous ||
      previous.organizationId !== input.organizationId ||
      previous.siteId !== input.siteId
    ) {
      throw new CycleCountError("COUNT_NOT_FOUND", "Cycle count not found in site scope");
    }
    if (previous.status !== "OPEN") {
      throw new CycleCountError("COUNT_NOT_OPEN", "Only an open cycle count can be cancelled");
    }
    const now = new Date().toISOString();
    const snapshot: CycleCountSnapshot = {
      ...previous,
      status: "CANCELLED",
      updatedAt: now,
      cancelledAt: now,
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: "CANCELLED",
      previous,
    });
    return snapshot;
  });
}

export async function getCycleCount(input: {
  organizationId: string;
  siteId: string;
  countId: string;
}) {
  const snapshot = await latestCount(
    db as unknown as Pick<Prisma.TransactionClient, "auditLog">,
    input.countId,
  );
  if (!snapshot || snapshot.organizationId !== input.organizationId || snapshot.siteId !== input.siteId) {
    throw new CycleCountError("COUNT_NOT_FOUND", "Cycle count not found in site scope");
  }
  return snapshot;
}

export async function listCycleCounts(input: {
  organizationId: string;
  siteId: string;
  includeClosed?: boolean;
}) {
  const marker = `"organizationId":"${input.organizationId}","siteId":"${input.siteId}"`;
  const logs = await db.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, afterJson: { contains: marker } },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });
  const latest = new Map<string, CycleCountSnapshot>();
  for (const log of logs) {
    const snapshot = parseSnapshot(log.afterJson);
    if (snapshot) latest.set(log.entityId, snapshot);
  }
  return [...latest.values()]
    .filter((snapshot) => input.includeClosed || snapshot.status === "OPEN")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
