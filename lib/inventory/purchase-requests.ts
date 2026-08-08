import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const ENTITY_TYPE = "PurchaseRequest";

export type PurchaseRequestStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED";

export type PurchaseRequestLineSnapshot = {
  id: string;
  partId: string;
  sku: string;
  partName: string;
  unit: string;
  quantity: number;
  supplierId: string | null;
  supplierCode: string | null;
  supplierName: string | null;
  supplierPartNumber: string | null;
  unitCost: number | null;
  currency: string;
};

export type PurchaseRequestSnapshot = {
  id: string;
  requestNumber: string;
  requestKey: string;
  requestHash: string;
  organizationId: string;
  siteId: string;
  requestedById: string;
  status: PurchaseRequestStatus;
  reason: string | null;
  neededBy: string | null;
  decisionNote: string | null;
  lines: PurchaseRequestLineSnapshot[];
  createdAt: string;
  updatedAt: string;
};

export class PurchaseRequestError extends Error {
  constructor(
    public readonly code:
      | "SITE_NOT_FOUND"
      | "PART_NOT_FOUND"
      | "SUPPLIER_REFERENCE_NOT_FOUND"
      | "PURCHASE_REQUEST_NOT_FOUND"
      | "INVALID_STATUS_TRANSITION"
      | "DRAFT_REQUIRED"
      | "IDEMPOTENCY_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "PurchaseRequestError";
  }
}

function stableRequestId(organizationId: string, siteId: string, requestKey: string) {
  return createHash("sha256").update(`${organizationId}:${siteId}:${requestKey}`).digest("hex");
}

function lineId(partId: string, supplierId: string | null, index: number) {
  return createHash("sha256")
    .update(`${partId}:${supplierId ?? "unassigned"}:${index}`)
    .digest("hex")
    .slice(0, 24);
}

function createRequestHash(input: {
  organizationId: string;
  siteId: string;
  requestKey: string;
  reason?: string | null;
  neededBy?: Date | null;
  lines: Array<{ partId: string; supplierId?: string | null; quantity: number }>;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        organizationId: input.organizationId,
        siteId: input.siteId,
        requestKey: input.requestKey,
        reason: input.reason ?? null,
        neededBy: input.neededBy?.toISOString() ?? null,
        lines: input.lines.map((line) => ({
          partId: line.partId,
          supplierId: line.supplierId ?? null,
          quantity: line.quantity,
        })),
      }),
    )
    .digest("hex");
}

function parseSnapshot(value: string | null): PurchaseRequestSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PurchaseRequestSnapshot>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.requestNumber !== "string" ||
      typeof parsed.requestKey !== "string" ||
      typeof parsed.requestHash !== "string" ||
      typeof parsed.organizationId !== "string" ||
      typeof parsed.siteId !== "string" ||
      typeof parsed.requestedById !== "string" ||
      !Array.isArray(parsed.lines) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      (parsed.status !== "DRAFT" &&
        parsed.status !== "SUBMITTED" &&
        parsed.status !== "APPROVED" &&
        parsed.status !== "REJECTED" &&
        parsed.status !== "CANCELLED")
    ) {
      return null;
    }
    return parsed as PurchaseRequestSnapshot;
  } catch {
    return null;
  }
}

async function latestPurchaseRequest(
  client: Pick<Prisma.TransactionClient, "auditLog">,
  requestId: string,
) {
  const event = await client.auditLog.findFirst({
    where: { entityType: ENTITY_TYPE, entityId: requestId },
    orderBy: { createdAt: "desc" },
    select: { afterJson: true },
  });
  return parseSnapshot(event?.afterJson ?? null);
}

async function appendSnapshot(
  tx: Prisma.TransactionClient,
  snapshot: PurchaseRequestSnapshot,
  input: {
    actorId: string;
    action: string;
    previous?: PurchaseRequestSnapshot | null;
  },
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

async function validateSite(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; siteId: string },
) {
  const site = await tx.site.findFirst({
    where: { id: input.siteId, organizationId: input.organizationId, active: true },
    select: { id: true },
  });
  if (!site) {
    throw new PurchaseRequestError("SITE_NOT_FOUND", "Active site not found in organization scope");
  }
}

async function resolveLines(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    lines: Array<{ partId: string; supplierId?: string | null; quantity: number }>;
  },
) {
  const resolved: PurchaseRequestLineSnapshot[] = [];

  for (const [index, line] of input.lines.entries()) {
    const part = await tx.part.findFirst({
      where: { id: line.partId, organizationId: input.organizationId, active: true },
      select: { id: true, sku: true, name: true, unit: true, unitCost: true },
    });
    if (!part) {
      throw new PurchaseRequestError("PART_NOT_FOUND", "Active part not found in organization scope");
    }

    const supplierReference = line.supplierId
      ? await tx.partSupplier.findFirst({
          where: {
            partId: part.id,
            supplierId: line.supplierId,
            active: true,
            supplier: { organizationId: input.organizationId, active: true },
          },
          include: { supplier: true },
        })
      : await tx.partSupplier.findFirst({
          where: {
            partId: part.id,
            preferred: true,
            active: true,
            supplier: { organizationId: input.organizationId, active: true },
          },
          include: { supplier: true },
        });

    if (line.supplierId && !supplierReference) {
      throw new PurchaseRequestError(
        "SUPPLIER_REFERENCE_NOT_FOUND",
        "Active supplier reference not found for this part in organization scope",
      );
    }

    resolved.push({
      id: lineId(part.id, supplierReference?.supplierId ?? null, index),
      partId: part.id,
      sku: part.sku,
      partName: part.name,
      unit: part.unit,
      quantity: line.quantity,
      supplierId: supplierReference?.supplierId ?? null,
      supplierCode: supplierReference?.supplier.code ?? null,
      supplierName: supplierReference?.supplier.name ?? null,
      supplierPartNumber: supplierReference?.supplierPartNumber ?? null,
      unitCost: supplierReference?.unitCost
        ? Number(supplierReference.unitCost)
        : part.unitCost
          ? Number(part.unitCost)
          : null,
      currency: supplierReference?.currency ?? "EUR",
    });
  }

  return resolved;
}

export async function createPurchaseRequest(input: {
  organizationId: string;
  siteId: string;
  requestKey: string;
  reason?: string | null;
  neededBy?: Date | null;
  lines: Array<{ partId: string; supplierId?: string | null; quantity: number }>;
  actorId: string;
}) {
  const id = stableRequestId(input.organizationId, input.siteId, input.requestKey);
  const requestHash = createRequestHash(input);

  return db.$transaction(async (tx) => {
    const existing = await latestPurchaseRequest(tx, id);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new PurchaseRequestError(
          "IDEMPOTENCY_CONFLICT",
          "requestKey was already used for a different purchase request payload",
        );
      }
      return { purchaseRequest: existing, idempotent: true } as const;
    }

    await validateSite(tx, input);
    const lines = await resolveLines(tx, input);
    const timestamp = new Date().toISOString();
    const snapshot: PurchaseRequestSnapshot = {
      id,
      requestNumber: `PR-${id.slice(0, 8).toUpperCase()}`,
      requestKey: input.requestKey,
      requestHash,
      organizationId: input.organizationId,
      siteId: input.siteId,
      requestedById: input.actorId,
      status: "DRAFT",
      reason: input.reason ?? null,
      neededBy: input.neededBy?.toISOString() ?? null,
      decisionNote: null,
      lines,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await appendSnapshot(tx, snapshot, { actorId: input.actorId, action: "CREATED" });
    return { purchaseRequest: snapshot, idempotent: false } as const;
  });
}

export async function updatePurchaseRequestDraft(input: {
  organizationId: string;
  siteId: string;
  requestId: string;
  reason?: string | null;
  neededBy?: Date | null;
  lines: Array<{ partId: string; supplierId?: string | null; quantity: number }>;
  actorId: string;
}) {
  return db.$transaction(async (tx) => {
    const previous = await latestPurchaseRequest(tx, input.requestId);
    if (
      !previous ||
      previous.organizationId !== input.organizationId ||
      previous.siteId !== input.siteId
    ) {
      throw new PurchaseRequestError("PURCHASE_REQUEST_NOT_FOUND", "Purchase request not found in site scope");
    }
    if (previous.status !== "DRAFT") {
      throw new PurchaseRequestError("DRAFT_REQUIRED", "Only draft purchase requests can be edited");
    }

    await validateSite(tx, input);
    const lines = await resolveLines(tx, input);
    const snapshot: PurchaseRequestSnapshot = {
      ...previous,
      reason: input.reason ?? null,
      neededBy: input.neededBy?.toISOString() ?? null,
      lines,
      updatedAt: new Date().toISOString(),
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: "DRAFT_UPDATED",
      previous,
    });
    return snapshot;
  });
}

function nextStatus(
  current: PurchaseRequestStatus,
  action: "SUBMIT" | "APPROVE" | "REJECT" | "CANCEL",
): PurchaseRequestStatus {
  if (action === "SUBMIT" && current === "DRAFT") return "SUBMITTED";
  if (action === "APPROVE" && current === "SUBMITTED") return "APPROVED";
  if (action === "REJECT" && current === "SUBMITTED") return "REJECTED";
  if (action === "CANCEL" && (current === "DRAFT" || current === "SUBMITTED")) return "CANCELLED";
  throw new PurchaseRequestError(
    "INVALID_STATUS_TRANSITION",
    `Cannot ${action.toLowerCase()} purchase request from ${current}`,
  );
}

export async function transitionPurchaseRequest(input: {
  organizationId: string;
  siteId: string;
  requestId: string;
  action: "SUBMIT" | "APPROVE" | "REJECT" | "CANCEL";
  note?: string | null;
  actorId: string;
}) {
  return db.$transaction(async (tx) => {
    const previous = await latestPurchaseRequest(tx, input.requestId);
    if (
      !previous ||
      previous.organizationId !== input.organizationId ||
      previous.siteId !== input.siteId
    ) {
      throw new PurchaseRequestError("PURCHASE_REQUEST_NOT_FOUND", "Purchase request not found in site scope");
    }
    const status = nextStatus(previous.status, input.action);
    const snapshot: PurchaseRequestSnapshot = {
      ...previous,
      status,
      decisionNote:
        input.action === "APPROVE" || input.action === "REJECT" || input.action === "CANCEL"
          ? input.note ?? null
          : previous.decisionNote,
      updatedAt: new Date().toISOString(),
    };
    await appendSnapshot(tx, snapshot, {
      actorId: input.actorId,
      action: input.action === "SUBMIT" ? "SUBMITTED" : status,
      previous,
    });
    return snapshot;
  });
}

export async function getPurchaseRequest(input: {
  organizationId: string;
  siteId: string;
  requestId: string;
}) {
  const snapshot = await latestPurchaseRequest(
    db as unknown as Pick<Prisma.TransactionClient, "auditLog">,
    input.requestId,
  );
  if (
    !snapshot ||
    snapshot.organizationId !== input.organizationId ||
    snapshot.siteId !== input.siteId
  ) {
    return null;
  }
  return snapshot;
}

export async function listPurchaseRequests(input: {
  organizationId: string;
  siteId: string;
  status?: PurchaseRequestStatus;
}) {
  const marker = `"organizationId":"${input.organizationId}","siteId":"${input.siteId}"`;
  const logs = await db.auditLog.findMany({
    where: { entityType: ENTITY_TYPE, afterJson: { contains: marker } },
    orderBy: { createdAt: "asc" },
    select: { entityId: true, afterJson: true },
  });

  const latest = new Map<string, PurchaseRequestSnapshot>();
  for (const log of logs) {
    const snapshot = parseSnapshot(log.afterJson);
    if (snapshot) latest.set(log.entityId, snapshot);
  }

  return [...latest.values()]
    .filter((snapshot) => !input.status || snapshot.status === input.status)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
