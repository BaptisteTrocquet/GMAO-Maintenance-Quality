import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveAnalyticsDateRange } from "@/lib/analytics/date-range";

export const PARTS_COST_TOP_PART_LIMIT = 10;
export const PARTS_COST_MAX_RANGE_DAYS = 731;

export class PartsCostAnalyticsError extends Error {
  constructor(
    public readonly code: "ASSET_NOT_FOUND" | "RANGE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "PartsCostAnalyticsError";
  }
}

type AggregateRow = {
  month: string;
  lineCount: number;
  pricedLineCount: number;
  unpricedLineCount: number;
  quantity: number;
  costAmount: number;
};

type PartRow = {
  partId: string;
  sku: string;
  name: string;
  unit: string;
  lineCount: number;
  pricedLineCount: number;
  unpricedLineCount: number;
  quantity: number;
  costAmount: number;
};

function minDate(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
}

function finite(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : 0;
}

export async function buildPartsCostDashboard(input: {
  organizationId: string;
  siteId: string;
  timeZone: string;
  from: string;
  to: string;
  assetId?: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const range = resolveAnalyticsDateRange({
    from: input.from,
    to: input.to,
    timeZone: input.timeZone,
  });
  if (!range.from || !range.toExclusive) {
    throw new Error("Parts cost analytics requires a bounded reporting range");
  }
  if (
    range.toExclusive.getTime() - range.from.getTime() >
    (PARTS_COST_MAX_RANGE_DAYS + 1) * 24 * 60 * 60 * 1000
  ) {
    throw new PartsCostAnalyticsError(
      "RANGE_TOO_LARGE",
      `Parts cost reporting is limited to ${PARTS_COST_MAX_RANGE_DAYS} local calendar days per request`,
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
      throw new PartsCostAnalyticsError(
        "ASSET_NOT_FOUND",
        "Active asset not found in the requested tenant/site scope",
      );
    }
  }

  const toExclusive = minDate(range.toExclusive, now);
  const emptyBase = {
    generatedAt: now.toISOString(),
    timezone: input.timeZone,
    range: { from: range.from.toISOString(), toExclusive: toExclusive.toISOString() },
    assetId: input.assetId ?? null,
  };
  if (range.from.getTime() >= toExclusive.getTime()) {
    return {
      ...emptyBase,
      empty: true,
      lineCount: 0,
      pricedLineCount: 0,
      unpricedLineCount: 0,
      quantity: 0,
      costAmount: 0,
      averageCostPerPricedLine: null,
      incompleteCost: false,
      trend: [] as Array<AggregateRow>,
      topParts: [] as Array<PartRow>,
      definition:
        "Consumed-parts cost uses quantity × captured unitCost on WorkOrderPartConsumption. Currency is not yet modeled on consumption records.",
    };
  }

  const assetFilter = input.assetId
    ? Prisma.sql`AND wo."assetId" = ${input.assetId}`
    : Prisma.empty;

  const [monthlyRows, partRows] = await Promise.all([
    db.$queryRaw<AggregateRow[]>(Prisma.sql`
      SELECT
        TO_CHAR((c."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${input.timeZone}, 'YYYY-MM') AS month,
        COUNT(*)::int AS "lineCount",
        COUNT(*) FILTER (WHERE c."unitCost" IS NOT NULL)::int AS "pricedLineCount",
        COUNT(*) FILTER (WHERE c."unitCost" IS NULL)::int AS "unpricedLineCount",
        COALESCE(SUM(c.quantity), 0)::double precision AS quantity,
        COALESCE(SUM(CASE WHEN c."unitCost" IS NOT NULL THEN c.quantity * c."unitCost" ELSE 0 END), 0)::double precision AS "costAmount"
      FROM "WorkOrderPartConsumption" c
      INNER JOIN "WorkOrder" wo ON wo.id = c."workOrderId"
      INNER JOIN "Site" site ON site.id = wo."siteId"
      INNER JOIN "Part" part ON part.id = c."partId"
      WHERE wo."siteId" = ${input.siteId}
        AND site."organizationId" = ${input.organizationId}
        AND site.active = true
        AND part."organizationId" = ${input.organizationId}
        AND c."createdAt" >= ${range.from}
        AND c."createdAt" < ${toExclusive}
        ${assetFilter}
      GROUP BY 1
      ORDER BY 1 ASC
    `),
    db.$queryRaw<PartRow[]>(Prisma.sql`
      SELECT
        part.id AS "partId",
        part.sku,
        part.name,
        part.unit,
        COUNT(*)::int AS "lineCount",
        COUNT(*) FILTER (WHERE c."unitCost" IS NOT NULL)::int AS "pricedLineCount",
        COUNT(*) FILTER (WHERE c."unitCost" IS NULL)::int AS "unpricedLineCount",
        COALESCE(SUM(c.quantity), 0)::double precision AS quantity,
        COALESCE(SUM(CASE WHEN c."unitCost" IS NOT NULL THEN c.quantity * c."unitCost" ELSE 0 END), 0)::double precision AS "costAmount"
      FROM "WorkOrderPartConsumption" c
      INNER JOIN "WorkOrder" wo ON wo.id = c."workOrderId"
      INNER JOIN "Site" site ON site.id = wo."siteId"
      INNER JOIN "Part" part ON part.id = c."partId"
      WHERE wo."siteId" = ${input.siteId}
        AND site."organizationId" = ${input.organizationId}
        AND site.active = true
        AND part."organizationId" = ${input.organizationId}
        AND c."createdAt" >= ${range.from}
        AND c."createdAt" < ${toExclusive}
        ${assetFilter}
      GROUP BY part.id, part.sku, part.name, part.unit
      ORDER BY "costAmount" DESC, part.sku ASC
      LIMIT ${PARTS_COST_TOP_PART_LIMIT}
    `),
  ]);

  const trend = monthlyRows.map((row) => ({
    ...row,
    quantity: finite(row.quantity),
    costAmount: finite(row.costAmount),
  }));
  const topParts = partRows.map((row) => ({
    ...row,
    quantity: finite(row.quantity),
    costAmount: finite(row.costAmount),
  }));
  const totals = trend.reduce(
    (sum, row) => ({
      lineCount: sum.lineCount + row.lineCount,
      pricedLineCount: sum.pricedLineCount + row.pricedLineCount,
      unpricedLineCount: sum.unpricedLineCount + row.unpricedLineCount,
      quantity: sum.quantity + row.quantity,
      costAmount: sum.costAmount + row.costAmount,
    }),
    { lineCount: 0, pricedLineCount: 0, unpricedLineCount: 0, quantity: 0, costAmount: 0 },
  );

  return {
    ...emptyBase,
    empty: totals.lineCount === 0,
    ...totals,
    averageCostPerPricedLine:
      totals.pricedLineCount === 0 ? null : totals.costAmount / totals.pricedLineCount,
    incompleteCost: totals.unpricedLineCount > 0,
    trend,
    topParts,
    definition:
      "Consumed-parts cost uses quantity × captured unitCost on WorkOrderPartConsumption. Lines with missing unitCost are reported as unpriced instead of being silently treated as zero-cost. Currency is not yet modeled on consumption records.",
  };
}
