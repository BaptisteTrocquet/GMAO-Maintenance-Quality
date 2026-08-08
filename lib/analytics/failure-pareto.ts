import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveAnalyticsDateRange } from "@/lib/analytics/date-range";

export const FAILURE_PARETO_LIMIT = 25;
export const FAILURE_PARETO_MAX_RANGE_DAYS = 731;

export type FailureParetoPoint = {
  assetId: string;
  code: string;
  name: string;
  eventCount: number;
  downtimeMinutes: number;
  eventSharePercent: number;
  cumulativePercent: number;
};

type ParetoRow = {
  assetId: string;
  code: string;
  name: string;
  eventCount: number;
  downtimeMinutes: number;
  totalEventCount: number;
};

export class FailureParetoError extends Error {
  constructor(
    public readonly code: "ASSET_NOT_FOUND" | "RANGE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "FailureParetoError";
  }
}

function earlierInstant(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
}

function finite(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : 0;
}

export async function buildFailurePareto(input: {
  organizationId: string;
  siteId: string;
  timeZone: string;
  from: string;
  to: string;
  assetId?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const range = resolveAnalyticsDateRange({ from: input.from, to: input.to, timeZone: input.timeZone });
  if (!range.from || !range.toExclusive) {
    throw new Error("Failure Pareto requires a bounded reporting range");
  }

  if (range.toExclusive.getTime() - range.from.getTime() > (FAILURE_PARETO_MAX_RANGE_DAYS + 1) * 86_400_000) {
    throw new FailureParetoError(
      "RANGE_TOO_LARGE",
      `Failure Pareto is limited to ${FAILURE_PARETO_MAX_RANGE_DAYS} local calendar days per request`,
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
      throw new FailureParetoError("ASSET_NOT_FOUND", "Active asset not found in tenant/site scope");
    }
  }

  const toExclusive = earlierInstant(range.toExclusive, now);
  if (range.from.getTime() >= toExclusive.getTime()) {
    return {
      generatedAt: now.toISOString(),
      timezone: input.timeZone,
      range: { from: range.from.toISOString(), toExclusive: toExclusive.toISOString() },
      assetId: input.assetId ?? null,
      empty: true,
      totalEventCount: 0,
      rankedEventCount: 0,
      points: [] as FailureParetoPoint[],
      definition:
        "Asset failure Pareto ranks assets by non-cancelled corrective maintenance requests. It is not a failure-mode Pareto because structured failure-mode coding is not yet captured.",
    };
  }

  const assetFilter = input.assetId
    ? Prisma.sql`AND wo."assetId" = ${input.assetId}`
    : Prisma.empty;

  const rows = await db.$queryRaw<ParetoRow[]>(Prisma.sql`
    WITH ranked AS (
      SELECT
        asset.id AS "assetId",
        asset.code,
        asset.name,
        COUNT(*)::int AS "eventCount",
        COALESCE(SUM(GREATEST(COALESCE(wo."downtimeMinutes", 0), 0)), 0)::double precision AS "downtimeMinutes"
      FROM "WorkOrder" wo
      INNER JOIN "Site" site ON site.id = wo."siteId"
      INNER JOIN "Asset" asset ON asset.id = wo."assetId"
      WHERE wo."siteId" = ${input.siteId}
        AND site."organizationId" = ${input.organizationId}
        AND site.active = true
        AND asset."archivedAt" IS NULL
        AND wo.type = 'CORRECTIVE'
        AND wo.status <> 'CANCELLED'
        AND wo."assetId" IS NOT NULL
        AND wo."requestedAt" >= ${range.from}
        AND wo."requestedAt" < ${toExclusive}
        ${assetFilter}
      GROUP BY asset.id, asset.code, asset.name
    )
    SELECT
      ranked.*,
      SUM(ranked."eventCount") OVER ()::int AS "totalEventCount"
    FROM ranked
    ORDER BY ranked."eventCount" DESC, ranked."downtimeMinutes" DESC, ranked.code ASC
    LIMIT ${FAILURE_PARETO_LIMIT}
  `);

  const totalEventCount = rows[0]?.totalEventCount ?? 0;
  let cumulativeEvents = 0;
  const points = rows.map((row) => {
    cumulativeEvents += row.eventCount;
    const eventSharePercent = totalEventCount ? (row.eventCount / totalEventCount) * 100 : 0;
    const cumulativePercent = totalEventCount ? (cumulativeEvents / totalEventCount) * 100 : 0;
    return {
      assetId: row.assetId,
      code: row.code,
      name: row.name,
      eventCount: row.eventCount,
      downtimeMinutes: finite(row.downtimeMinutes),
      eventSharePercent,
      cumulativePercent,
    };
  });

  return {
    generatedAt: now.toISOString(),
    timezone: input.timeZone,
    range: { from: range.from.toISOString(), toExclusive: toExclusive.toISOString() },
    assetId: input.assetId ?? null,
    empty: totalEventCount === 0,
    totalEventCount,
    rankedEventCount: points.reduce((sum, point) => sum + point.eventCount, 0),
    points,
    definition:
      "Asset failure Pareto ranks assets by non-cancelled corrective maintenance requests. It is not a failure-mode Pareto because structured failure-mode coding is not yet captured.",
  };
}
