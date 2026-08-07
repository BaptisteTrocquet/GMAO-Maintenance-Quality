import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const MAX_TRANSACTION_ATTEMPTS = 4;
const ENTITY_TYPE = "StockReservation";

export type StockReservationStatus = "ACTIVE" | "RELEASED" | "CONSUMED";

export type StockReservationSnapshot = {
  id: string;
  organizationId: string;
  siteId: string;
  workOrderId: string;
  binId: string;
  partId: string;
  quantity: number;
  consumedQuantity: number;
  status: StockReservationStatus;
  updatedAt: string;
};

export class StockReservationError extends Error {
  constructor(
    public readonly code:
      | "WORK_ORDER_NOT_FOUND"
      | "WORK_ORDER_NOT_RESERVABLE"
      | "BIN_NOT_FOUND"
      | "PART_NOT_FOUND"
      | "INSUFFICIENT_AVAILABLE_STOCK"
      | "RESERVATION_NOT_FOUND"
      | "RESERVATION_QUANTITY_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "StockReservationError";
  }
}

function reservationId(workOrderId: string, binId: string, partId: string) {
  return createHash("sha256").update(`${workOrderId}:${binId}:${partId}`).digest("hex");
}

function parseSnapshot(value: string | null): StockReservationSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StockReservationSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.workOrderId !== "string" ||
      typeof parsed.binId !== "string" ||
      typeof parsed.partId !== "string" ||
      typeof parsed.quantity !== "number" ||
      typeof parsed.consumedQuantity !== "number" ||
      (parsed.status !== "ACTIVE" && parsed.status !== "RELEASED" && parsed.status !== "CONSUMED") ||
      typeof parsed.updatedAt !== "string"
    ) {
      return null;
    }
    return parsed as StockReservationSnapshot;
  } catch {
    return null;
  }
}

function remaining(snapshot: StockReservationSnapshot) {
  return snapshot.status === "ACTIVE"
    ? Math.max(snapshot.quantity - snapshot.consumedQuantity, 0)
    : 0;
}

async function latestReservation(
  tx: Prisma.TransactionClient,
  input: { workOrderId: string; binId: string; partId: string },
) {
  const id = reservationId(input.workOrderId, input.binId, input.partId);
  const log = await tx.auditLog.findFirst({
    where: { entityType: ENTITY_TYPE, entityId: id },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseSnapshot(log?.afterJson ?? null);
}

export async function currentReservationsForBinPart(
  tx: Prisma.TransactionClient,
  input: { binId: string; partId: string },
) {
  const marker = `\"binId\":\"${input.binId}\",\"partId\":\"${input.partId}\"`;
  const logs = await tx.auditLog.findMany({
    where: {
      entityType: ENTITY_TYPE,
      afterJson: { contains: marker },
    },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });

  const latest = new Map<string, StockReservationSnapshot>();
  for (const log of logs) {
    const snapshot = parseSnapshot(log.afterJson);
    if (snapshot) latest.set(log.entityId, snapshot);
  }
  return [...latest.values()];
}

export async function reservedQuantityForOthers(
  tx: Prisma.TransactionClient,
  input: { binId: string; partId: string; workOrderId?: string | null },
) {
  const reservations = await currentReservationsForBinPart(tx, input);
  return reservations.reduce((sum, reservation) => {
    if (input.workOrderId && reservation.workOrderId === input.workOrderId) return sum;
    return sum + remaining(reservation);
  }, 0);
}

async function appendReservationSnapshot(
  tx: Prisma.TransactionClient,
  snapshot: StockReservationSnapshot,
  input: { actorId: string | null; action: string; previous?: StockReservationSnapshot | null },
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

async function validateReservationScope(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string; workOrderId: string; binId: string; partId: string },
) {
  const [workOrder, bin, part, balance] = await Promise.all([
    tx.workOrder.findFirst({
      where: {
        id: input.workOrderId,
        siteId: input.siteId,
        site: { organizationId: input.organizationId, active: true },
      },
      select: { id: true, status: true },
    }),
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
    tx.stockBalance.findUnique({
      where: { binId_partId: { binId: input.binId, partId: input.partId } },
      select: { id: true, quantity: true },
    }),
  ]);

  if (!workOrder) {
    throw new StockReservationError("WORK_ORDER_NOT_FOUND", "Work order not found in site scope");
  }
  if (
    workOrder.status === "REQUESTED" ||
    workOrder.status === "COMPLETED" ||
    workOrder.status === "CANCELLED"
  ) {
    throw new StockReservationError(
      "WORK_ORDER_NOT_RESERVABLE",
      "Stock can only be reserved for approved, planned or active work",
    );
  }
  if (!bin) throw new StockReservationError("BIN_NOT_FOUND", "Active stock bin not found in site scope");
  if (!part) throw new StockReservationError("PART_NOT_FOUND", "Active part not found in organization scope");
  return { workOrder, balance };
}

function retryable(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

export async function reserveWorkOrderStock(input: {
  organizationId: string;
  siteId: string;
  workOrderId: string;
  binId: string;
  partId: string;
  quantity: number;
  actorId: string;
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const { balance } = await validateReservationScope(tx, input);
          if (!balance || balance.quantity <= 0) {
            throw new StockReservationError(
              "INSUFFICIENT_AVAILABLE_STOCK",
              "No stock is available in this bin",
            );
          }

          // A zero-delta write makes concurrent reservations contend on the same balance row.
          await tx.stockBalance.update({
            where: { id: balance.id },
            data: { quantity: { increment: 0 } },
          });

          const previous = await latestReservation(tx, input);
          if (previous && input.quantity < previous.consumedQuantity) {
            throw new StockReservationError(
              "RESERVATION_QUANTITY_CONFLICT",
              "Reserved quantity cannot be lower than quantity already consumed",
            );
          }

          const reservedByOthers = await reservedQuantityForOthers(tx, {
            binId: input.binId,
            partId: input.partId,
            workOrderId: input.workOrderId,
          });
          const requestedRemaining = input.quantity - (previous?.consumedQuantity ?? 0);
          const available = balance.quantity - reservedByOthers;
          if (requestedRemaining > available) {
            throw new StockReservationError(
              "INSUFFICIENT_AVAILABLE_STOCK",
              "Requested reservation exceeds stock available after other work-order reservations",
            );
          }

          const snapshot: StockReservationSnapshot = {
            id: reservationId(input.workOrderId, input.binId, input.partId),
            organizationId: input.organizationId,
            siteId: input.siteId,
            workOrderId: input.workOrderId,
            binId: input.binId,
            partId: input.partId,
            quantity: input.quantity,
            consumedQuantity: previous?.consumedQuantity ?? 0,
            status: requestedRemaining > 0 ? "ACTIVE" : "CONSUMED",
            updatedAt: new Date().toISOString(),
          };
          await appendReservationSnapshot(tx, snapshot, {
            actorId: input.actorId,
            action: previous ? "UPDATED" : "RESERVED",
            previous,
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

export async function releaseWorkOrderStock(input: {
  organizationId: string;
  siteId: string;
  workOrderId: string;
  binId: string;
  partId: string;
  actorId: string;
}) {
  return db.$transaction(
    async (tx) => {
      const previous = await latestReservation(tx, input);
      if (
        !previous ||
        previous.organizationId !== input.organizationId ||
        previous.siteId !== input.siteId ||
        previous.status !== "ACTIVE"
      ) {
        throw new StockReservationError("RESERVATION_NOT_FOUND", "Active reservation not found");
      }
      const snapshot: StockReservationSnapshot = {
        ...previous,
        status: "RELEASED",
        updatedAt: new Date().toISOString(),
      };
      await appendReservationSnapshot(tx, snapshot, {
        actorId: input.actorId,
        action: "RELEASED",
        previous,
      });
      return snapshot;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function consumeWorkOrderReservation(
  tx: Prisma.TransactionClient,
  input: { workOrderId: string; binId: string; partId: string; quantity: number; actorId: string },
) {
  const previous = await latestReservation(tx, input);
  if (!previous || previous.status !== "ACTIVE") return null;
  const reservedRemaining = remaining(previous);
  const consumedFromReservation = Math.min(input.quantity, reservedRemaining);
  if (consumedFromReservation <= 0) return previous;

  const consumedQuantity = previous.consumedQuantity + consumedFromReservation;
  const snapshot: StockReservationSnapshot = {
    ...previous,
    consumedQuantity,
    status: consumedQuantity >= previous.quantity ? "CONSUMED" : "ACTIVE",
    updatedAt: new Date().toISOString(),
  };
  await appendReservationSnapshot(tx, snapshot, {
    actorId: input.actorId,
    action: snapshot.status === "CONSUMED" ? "CONSUMED" : "PARTIALLY_CONSUMED",
    previous,
  });
  return snapshot;
}

export async function listWorkOrderReservations(input: {
  organizationId: string;
  siteId: string;
  workOrderId: string;
}) {
  const marker = `\"organizationId\":\"${input.organizationId}\",\"siteId\":\"${input.siteId}\",\"workOrderId\":\"${input.workOrderId}\"`;
  const logs = await db.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, afterJson: { contains: marker } },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });
  const latest = new Map<string, StockReservationSnapshot>();
  for (const log of logs) {
    const snapshot = parseSnapshot(log.afterJson);
    if (snapshot) latest.set(log.entityId, snapshot);
  }
  return [...latest.values()];
}
