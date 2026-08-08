import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type MtbfCounts = {
  failureEvents: number;
  validIntervals: number;
  excludedIntervals: number;
  contributingAssets: number;
  totalIntervalMinutes: number;
};

export type MtbfResult = MtbfCounts & {
  mtbfMinutes: number | null;
  mtbfHours: number | null;
  empty: boolean;
  from: string;
  to: string;
  generatedAt: string;
  definition: string;
};

type AggregateRow = {
  failureEvents: bigint | number;
  validIntervals: bigint | number;
  excludedIntervals: bigint | number;
  contributingAssets: bigint | number;
  totalIntervalMinutes: number | string | null;
};

function asNumber(value: bigint | number | string | null | undefined) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return value ?? 0;
}

export function calculateMtbf(
  counts: MtbfCounts,
  input: { from: Date; to: Date; generatedAt: Date },
): MtbfResult {
  const mtbfMinutes =
    counts.validIntervals === 0 ? null : counts.totalIntervalMinutes / counts.validIntervals;

  return {
    ...counts,
    mtbfMinutes,
    mtbfHours: mtbfMinutes === null ? null : mtbfMinutes / 60,
    empty: counts.validIntervals === 0,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    generatedAt: input.generatedAt.toISOString(),
    definition:
      "Event-interval MTBF proxy: average elapsed time between successive non-cancelled CORRECTIVE requestedAt events on the same asset. The later failure must fall inside the reporting window; its preceding failure may predate the window. This is a proxy until explicit failure events and operating-hours telemetry exist.",
  };
}

export class MtbfError extends Error {
  constructor(
    public readonly code: "INVALID_DATE_RANGE" | "ASSET_SCOPE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "MtbfError";
  }
}

export async function buildMtbf(input: {
  organizationId: string;
  siteId: string;
  from: Date;
  to: Date;
  assetId?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (
    !Number.isFinite(input.from.getTime()) ||
    !Number.isFinite(input.to.getTime()) ||
    input.to <= input.from
  ) {
    throw new MtbfError("INVALID_DATE_RANGE", "to must be later than from");
  }

  const effectiveTo = input.to < now ? input.to : now;
  if (effectiveTo <= input.from) {
    return calculateMtbf(
      {
        failureEvents: 0,
        validIntervals: 0,
        excludedIntervals: 0,
        contributingAssets: 0,
        totalIntervalMinutes: 0,
      },
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
      throw new MtbfError(
        "ASSET_SCOPE_MISMATCH",
        "Asset not found in the requested active organization and site",
      );
    }
  }

  const assetFilter = input.assetId
    ? Prisma.sql`AND wo."assetId" = ${input.assetId}`
    : Prisma.empty;

  const rows = await db.$queryRaw<AggregateRow[]>(Prisma.sql`
    WITH failures AS (
      SELECT
        wo."id",
        wo."assetId",
        wo."requestedAt",
        LAG(wo."requestedAt") OVER (
          PARTITION BY wo."assetId"
          ORDER BY wo."requestedAt", wo."id"
        ) AS "previousRequestedAt"
      FROM "WorkOrder" wo
      INNER JOIN "Site" s ON s."id" = wo."siteId"
      WHERE wo."siteId" = ${input.siteId}
        AND s."organizationId" = ${input.organizationId}
        AND s."active" = true
        AND wo."type" = 'CORRECTIVE'
        AND wo."status" <> 'CANCELLED'
        AND wo."assetId" IS NOT NULL
        AND wo."requestedAt" < ${effectiveTo}
        ${assetFilter}
    ), windowed AS (
      SELECT *
      FROM failures
      WHERE "requestedAt" >= ${input.from}
        AND "requestedAt" < ${effectiveTo}
    )
    SELECT
      COUNT(*)::bigint AS "failureEvents",
      COUNT(*) FILTER (
        WHERE "previousRequestedAt" IS NOT NULL
          AND "requestedAt" > "previousRequestedAt"
      )::bigint AS "validIntervals",
      COUNT(*) FILTER (
        WHERE "previousRequestedAt" IS NULL
          OR "requestedAt" <= "previousRequestedAt"
      )::bigint AS "excludedIntervals",
      COUNT(DISTINCT "assetId") FILTER (
        WHERE "previousRequestedAt" IS NOT NULL
          AND "requestedAt" > "previousRequestedAt"
      )::bigint AS "contributingAssets",
      COALESCE(
        SUM(
          EXTRACT(EPOCH FROM ("requestedAt" - "previousRequestedAt")) / 60.0
        ) FILTER (
          WHERE "previousRequestedAt" IS NOT NULL
            AND "requestedAt" > "previousRequestedAt"
        ),
        0
      ) AS "totalIntervalMinutes"
    FROM windowed
  `);

  const row = rows[0];
  return calculateMtbf(
    {
      failureEvents: asNumber(row?.failureEvents),
      validIntervals: asNumber(row?.validIntervals),
      excludedIntervals: asNumber(row?.excludedIntervals),
      contributingAssets: asNumber(row?.contributingAssets),
      totalIntervalMinutes: asNumber(row?.totalIntervalMinutes),
    },
    { from: input.from, to: effectiveTo, generatedAt: now },
  );
}
