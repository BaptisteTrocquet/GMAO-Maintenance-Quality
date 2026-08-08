import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type MttrCounts = {
  completedCorrective: number;
  validRepairs: number;
  incompleteRepairs: number;
  totalRepairMinutes: number;
};

export type MttrResult = MttrCounts & {
  mttrMinutes: number | null;
  mttrHours: number | null;
  empty: boolean;
  insufficientData: boolean;
  from: string;
  to: string;
  generatedAt: string;
};

type AggregateRow = {
  completedCorrective: bigint | number;
  validRepairs: bigint | number;
  incompleteRepairs: bigint | number;
  totalRepairMinutes: number | string | null;
};

function asNumber(value: bigint | number | string | null | undefined) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return value ?? 0;
}

export function calculateMttr(
  counts: MttrCounts,
  input: { from: Date; to: Date; generatedAt: Date },
): MttrResult {
  const mttrMinutes = counts.validRepairs === 0 ? null : counts.totalRepairMinutes / counts.validRepairs;
  return {
    ...counts,
    mttrMinutes,
    mttrHours: mttrMinutes === null ? null : mttrMinutes / 60,
    empty: counts.completedCorrective === 0,
    insufficientData: counts.completedCorrective > 0 && counts.validRepairs === 0,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    generatedAt: input.generatedAt.toISOString(),
  };
}

export class MttrError extends Error {
  constructor(
    public readonly code: "INVALID_DATE_RANGE" | "ASSET_SCOPE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "MttrError";
  }
}

export async function buildMttr(input: {
  organizationId: string;
  siteId: string;
  from: Date;
  to: Date;
  assetId?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!Number.isFinite(input.from.getTime()) || !Number.isFinite(input.to.getTime()) || input.to <= input.from) {
    throw new MttrError("INVALID_DATE_RANGE", "to must be later than from");
  }

  const effectiveTo = input.to < now ? input.to : now;
  if (effectiveTo <= input.from) {
    return calculateMttr(
      { completedCorrective: 0, validRepairs: 0, incompleteRepairs: 0, totalRepairMinutes: 0 },
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
      throw new MttrError(
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
      COUNT(*)::bigint AS "completedCorrective",
      COUNT(*) FILTER (
        WHERE wo."startedAt" IS NOT NULL
          AND wo."completedAt" >= wo."startedAt"
      )::bigint AS "validRepairs",
      COUNT(*) FILTER (
        WHERE wo."startedAt" IS NULL
          OR wo."completedAt" < wo."startedAt"
      )::bigint AS "incompleteRepairs",
      COALESCE(
        SUM(
          EXTRACT(EPOCH FROM (wo."completedAt" - wo."startedAt")) / 60.0
        ) FILTER (
          WHERE wo."startedAt" IS NOT NULL
            AND wo."completedAt" >= wo."startedAt"
        ),
        0
      ) AS "totalRepairMinutes"
    FROM "WorkOrder" wo
    INNER JOIN "Site" s ON s."id" = wo."siteId"
    WHERE wo."siteId" = ${input.siteId}
      AND s."organizationId" = ${input.organizationId}
      AND s."active" = true
      AND wo."type" = 'CORRECTIVE'
      AND wo."status" = 'COMPLETED'
      AND wo."completedAt" IS NOT NULL
      AND wo."completedAt" >= ${input.from}
      AND wo."completedAt" < ${effectiveTo}
      ${assetFilter}
  `);

  const row = rows[0];
  return calculateMttr(
    {
      completedCorrective: asNumber(row?.completedCorrective),
      validRepairs: asNumber(row?.validRepairs),
      incompleteRepairs: asNumber(row?.incompleteRepairs),
      totalRepairMinutes: asNumber(row?.totalRepairMinutes),
    },
    { from: input.from, to: effectiveTo, generatedAt: now },
  );
}
