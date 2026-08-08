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
    ? Prisma.sql`AND "failureRequestedAt" >= ${requestedRange.from}`
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
      WITH scoped AS MATERIALIZED (
        SELECT
          wo."assetId",
          wo."requestedAt",
          wo."completedAt",
          wo.status
        FROM "WorkOrder" wo
        INNER JOIN "Site" site ON site.id = wo."siteId"
        WHERE wo."siteId" = ${input.siteId}
          AND site."organizationId" = ${input.organizationId}
          AND site.active = true
          AND wo.type = 'CORRECTIVE'
          AND wo."assetId" IS NOT NULL
          AND (
            wo."requestedAt" < ${toExclusive}
            OR (
              wo.status = 'COMPLETED'
              AND wo."completedAt" IS NOT NULL
              AND wo."completedAt" < ${toExclusive}
            )
          )
          ${assetFilter}
      ), timeline AS (
        SELECT
          "assetId",
          "completedAt" AS "eventAt",
          1 AS "eventKind",
          "completedAt" AS "repairCompletedAt",
          NULL::timestamp AS "failureRequestedAt"
        FROM scoped
        WHERE status = 'COMPLETED'
          AND "completedAt" IS NOT NULL
          AND "completedAt" < ${toExclusive}

        UNION ALL

        SELECT
          "assetId",
          "requestedAt" AS "eventAt",
          0 AS "eventKind",
          NULL::timestamp AS "repairCompletedAt",
          "requestedAt" AS "failureRequestedAt"
        FROM scoped
        WHERE status <> 'CANCELLED'
          AND "requestedAt" < ${toExclusive}
      ), sequenced AS (
        SELECT
          "assetId",
          "failureRequestedAt",
          MAX("repairCompletedAt") OVER (
            PARTITION BY "assetId"
            ORDER BY "eventAt", "eventKind"
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ) AS "previousCompletedAt"
        FROM timeline
      ), intervals AS (
        SELECT
          "assetId",
          EXTRACT(EPOCH FROM ("failureRequestedAt" - "previousCompletedAt")) / 3600.0 AS hours
        FROM sequenced
        WHERE "failureRequestedAt" IS NOT NULL
          AND "previousCompletedAt" IS NOT NULL
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
