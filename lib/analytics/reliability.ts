import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveAnalyticsDateRange } from "@/lib/analytics/date-range";

export type ReliabilityMetric = {
  hours: number | null;
  sampleCount: number;
};

export type ReliabilityDashboard = {
  generatedAt: string;
  timezone: string;
  range: {
    from: string | null;
    toExclusive: string;
  };
  assetId: string | null;
  mttr: ReliabilityMetric & { excludedIncomplete: number };
  mtbf: ReliabilityMetric & { assetCount: number };
  definitions: {
    mttr: string;
    mtbf: string;
  };
};

type MttrRow = {
  sampleCount: number;
  excludedIncomplete: number;
  hours: number | null;
};

type MtbfRow = {
  intervalCount: number;
  assetCount: number;
  hours: number | null;
};

export class ReliabilityAnalyticsError extends Error {
  constructor(
    public readonly code: "ASSET_NOT_FOUND" | "RANGE_IN_FUTURE",
    message: string,
  ) {
    super(message);
    this.name = "ReliabilityAnalyticsError";
  }
}

function finiteOrNull(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

function earlierInstant(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
}

export async function buildReliabilityDashboard(input: {
  organizationId: string;
  siteId: string;
  timeZone: string;
  from?: string | null;
  to?: string | null;
  assetId?: string | null;
  now?: Date;
}): Promise<ReliabilityDashboard> {
  const now = input.now ?? new Date();
  const requestedRange = resolveAnalyticsDateRange({
    from: input.from,
    to: input.to,
    timeZone: input.timeZone,
  });
  const toExclusive = requestedRange.toExclusive
    ? earlierInstant(requestedRange.toExclusive, now)
    : now;

  if (requestedRange.from && requestedRange.from.getTime() >= toExclusive.getTime()) {
    throw new ReliabilityAnalyticsError(
      "RANGE_IN_FUTURE",
      "The reporting window must include time on or before now",
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
      throw new ReliabilityAnalyticsError(
        "ASSET_NOT_FOUND",
        "Active asset not found in the requested tenant/site scope",
      );
    }
  }

  const assetFilter = input.assetId
    ? Prisma.sql`AND wo."assetId" = ${input.assetId}`
    : Prisma.empty;
  const mttrFromFilter = requestedRange.from
    ? Prisma.sql`AND wo."completedAt" >= ${requestedRange.from}`
    : Prisma.empty;
  const mtbfFromFilter = requestedRange.from
    ? Prisma.sql`AND "requestedAt" >= ${requestedRange.from}`
    : Prisma.empty;

  const [mttrRows, mtbfRows] = await Promise.all([
    db.$queryRaw<MttrRow[]>(Prisma.sql`
      SELECT
        COUNT(*) FILTER (
          WHERE wo."startedAt" IS NOT NULL
            AND wo."startedAt" >= wo."requestedAt"
            AND wo."completedAt" >= wo."startedAt"
        )::int AS "sampleCount",
        COUNT(*) FILTER (
          WHERE wo."startedAt" IS NULL
            OR wo."startedAt" < wo."requestedAt"
            OR wo."completedAt" < wo."startedAt"
        )::int AS "excludedIncomplete",
        AVG(
          EXTRACT(EPOCH FROM (wo."completedAt" - wo."startedAt")) / 3600.0
        ) FILTER (
          WHERE wo."startedAt" IS NOT NULL
            AND wo."startedAt" >= wo."requestedAt"
            AND wo."completedAt" >= wo."startedAt"
        )::double precision AS "hours"
      FROM "WorkOrder" wo
      INNER JOIN "Site" site ON site.id = wo."siteId"
      WHERE wo."siteId" = ${input.siteId}
        AND site."organizationId" = ${input.organizationId}
        AND site.active = true
        AND wo.type = 'CORRECTIVE'
        AND wo.status = 'COMPLETED'
        AND wo."completedAt" IS NOT NULL
        ${mttrFromFilter}
        AND wo."completedAt" < ${toExclusive}
        ${assetFilter}
    `),
    db.$queryRaw<MtbfRow[]>(Prisma.sql`
      WITH failures AS (
        SELECT
          wo."assetId",
          wo."requestedAt",
          (
            SELECT MAX(previous."completedAt")
            FROM "WorkOrder" previous
            WHERE previous."siteId" = wo."siteId"
              AND previous."assetId" = wo."assetId"
              AND previous.type = 'CORRECTIVE'
              AND previous.status = 'COMPLETED'
              AND previous."completedAt" IS NOT NULL
              AND previous."completedAt" < wo."requestedAt"
          ) AS "previousCompletedAt"
        FROM "WorkOrder" wo
        INNER JOIN "Site" site ON site.id = wo."siteId"
        WHERE wo."siteId" = ${input.siteId}
          AND site."organizationId" = ${input.organizationId}
          AND site.active = true
          AND wo.type = 'CORRECTIVE'
          AND wo.status <> 'CANCELLED'
          AND wo."assetId" IS NOT NULL
          AND wo."requestedAt" < ${toExclusive}
          ${assetFilter}
      ), intervals AS (
        SELECT
          "assetId",
          "requestedAt",
          EXTRACT(EPOCH FROM ("requestedAt" - "previousCompletedAt")) / 3600.0 AS hours
        FROM failures
        WHERE "previousCompletedAt" IS NOT NULL
          ${mtbfFromFilter}
      )
      SELECT
        COUNT(*)::int AS "intervalCount",
        COUNT(DISTINCT "assetId")::int AS "assetCount",
        AVG(hours)::double precision AS "hours"
      FROM intervals
    `),
  ]);

  const mttr = mttrRows[0] ?? { sampleCount: 0, excludedIncomplete: 0, hours: null };
  const mtbf = mtbfRows[0] ?? { intervalCount: 0, assetCount: 0, hours: null };

  return {
    generatedAt: now.toISOString(),
    timezone: input.timeZone,
    range: {
      from: requestedRange.from?.toISOString() ?? null,
      toExclusive: toExclusive.toISOString(),
    },
    assetId: input.assetId ?? null,
    mttr: {
      hours: finiteOrNull(mttr.hours),
      sampleCount: mttr.sampleCount,
      excludedIncomplete: mttr.excludedIncomplete,
    },
    mtbf: {
      hours: finiteOrNull(mtbf.hours),
      sampleCount: mtbf.intervalCount,
      assetCount: mtbf.assetCount,
    },
    definitions: {
      mttr:
        "Average elapsed hours from startedAt to completedAt for completed corrective work orders whose completion falls inside the reporting window. Missing or chronologically invalid startedAt values are excluded and counted separately.",
      mtbf:
        "Calendar-time MTBF: average elapsed hours from the latest completed corrective repair before a failure to requestedAt of the next non-cancelled corrective event on the same asset. The next failure must fall inside the reporting window; the prior repair may precede it. This measures calendar uptime and is not operating-hours MTBF when assets are not continuously operated.",
    },
  };
}
