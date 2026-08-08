import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type PmComplianceCounts = {
  due: number;
  completedOnTime: number;
  completedLate: number;
  openOverdue: number;
};

export type PmComplianceResult = PmComplianceCounts & {
  missed: number;
  complianceRate: number | null;
  empty: boolean;
  from: string;
  to: string;
  generatedAt: string;
};

type AggregateRow = {
  due: bigint | number;
  completedOnTime: bigint | number;
  completedLate: bigint | number;
  openOverdue: bigint | number;
};

function asNumber(value: bigint | number | undefined) {
  return typeof value === "bigint" ? Number(value) : value ?? 0;
}

export function calculatePmCompliance(
  counts: PmComplianceCounts,
  input: { from: Date; to: Date; generatedAt: Date },
): PmComplianceResult {
  const missed = Math.max(counts.due - counts.completedOnTime, 0);
  const complianceRate = counts.due === 0 ? null : (counts.completedOnTime / counts.due) * 100;

  return {
    ...counts,
    missed,
    complianceRate,
    empty: counts.due === 0,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    generatedAt: input.generatedAt.toISOString(),
  };
}

export class PmComplianceError extends Error {
  constructor(
    public readonly code: "INVALID_DATE_RANGE" | "ASSET_SCOPE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "PmComplianceError";
  }
}

export async function buildPmCompliance(input: {
  organizationId: string;
  siteId: string;
  from: Date;
  to: Date;
  assetId?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!Number.isFinite(input.from.getTime()) || !Number.isFinite(input.to.getTime()) || input.to <= input.from) {
    throw new PmComplianceError("INVALID_DATE_RANGE", "to must be later than from");
  }

  // Future due dates are intentionally excluded from PM compliance.
  const effectiveTo = input.to < now ? input.to : now;
  if (effectiveTo <= input.from) {
    return calculatePmCompliance(
      { due: 0, completedOnTime: 0, completedLate: 0, openOverdue: 0 },
      { from: input.from, to: effectiveTo, generatedAt: now },
    );
  }

  if (input.assetId) {
    const asset = await db.asset.findFirst({
      where: {
        id: input.assetId,
        siteId: input.siteId,
        archivedAt: null,
        site: { organizationId: input.organizationId, active: true },
      },
      select: { id: true },
    });
    if (!asset) {
      throw new PmComplianceError(
        "ASSET_SCOPE_MISMATCH",
        "Asset not found in the requested active organization and site",
      );
    }
  }

  const assetFilter = input.assetId
    ? Prisma.sql`AND wo."assetId" = ${input.assetId}`
    : Prisma.empty;

  const rows = await db.$queryRaw<AggregateRow[]>(Prisma.sql`
    SELECT
      COUNT(*)::bigint AS "due",
      COUNT(*) FILTER (
        WHERE wo."status" = 'COMPLETED'
          AND wo."completedAt" IS NOT NULL
          AND wo."completedAt" <= wo."dueAt"
      )::bigint AS "completedOnTime",
      COUNT(*) FILTER (
        WHERE wo."status" = 'COMPLETED'
          AND wo."completedAt" IS NOT NULL
          AND wo."completedAt" > wo."dueAt"
      )::bigint AS "completedLate",
      COUNT(*) FILTER (
        WHERE wo."status" <> 'COMPLETED'
      )::bigint AS "openOverdue"
    FROM "WorkOrder" wo
    INNER JOIN "Site" s ON s."id" = wo."siteId"
    WHERE wo."siteId" = ${input.siteId}
      AND s."organizationId" = ${input.organizationId}
      AND s."active" = true
      AND wo."type" = 'PREVENTIVE'
      AND wo."status" <> 'CANCELLED'
      AND wo."dueAt" IS NOT NULL
      AND wo."dueAt" >= ${input.from}
      AND wo."dueAt" < ${effectiveTo}
      AND EXISTS (
        SELECT 1
        FROM "AuditLog" generated
        WHERE generated."entityType" = 'WorkOrder'
          AND generated."entityId" = wo."id"
          AND generated."action" = 'PREVENTIVE_GENERATED'
      )
      ${assetFilter}
  `);

  const row = rows[0];
  return calculatePmCompliance(
    {
      due: asNumber(row?.due),
      completedOnTime: asNumber(row?.completedOnTime),
      completedLate: asNumber(row?.completedLate),
      openOverdue: asNumber(row?.openOverdue),
    },
    { from: input.from, to: effectiveTo, generatedAt: now },
  );
}
