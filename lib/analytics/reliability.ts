import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type ReliabilityMetric = {
  hours: number | null;
  sampleCount: number;
};

export type ReliabilityDashboard = {
  generatedAt: string;
  mttr: ReliabilityMetric & { excludedIncomplete: number };
  mtbfProxy: ReliabilityMetric & { assetCount: number };
  definitions: {
    mttr: string;
    mtbfProxy: string;
  };
};

type MttrRow = {
  sampleCount: number | bigint;
  excludedIncomplete: number | bigint;
  totalSeconds: number | bigint | null;
};

type MtbfRow = {
  intervalCount: number | bigint;
  assetCount: number | bigint;
  totalSeconds: number | bigint | null;
};

function asNumber(value: number | bigint | null | undefined) {
  if (value === null || value === undefined) return 0;
  return typeof value === "bigint" ? Number(value) : value;
}

export function averageHours(
  totalSeconds: number | bigint | null | undefined,
  sampleCount: number | bigint | null | undefined,
) {
  const count = asNumber(sampleCount);
  const seconds = asNumber(totalSeconds);
  if (count <= 0 || !Number.isFinite(seconds) || seconds < 0) return null;
  return seconds / count / 3600;
}

export async function buildReliabilityDashboard(input: {
  organizationId: string;
  siteId: string;
  now?: Date;
}): Promise<ReliabilityDashboard> {
  const now = input.now ?? new Date();

  const [mttrRows, mtbfRows] = await Promise.all([
    db.$queryRaw<MttrRow[]>(Prisma.sql`
      WITH scoped AS (
        SELECT
          wo."requestedAt",
          wo."startedAt",
          wo."completedAt"
        FROM "WorkOrder" wo
        INNER JOIN "Site" site ON site.id = wo."siteId"
        WHERE wo."siteId" = ${input.siteId}
          AND site."organizationId" = ${input.organizationId}
          AND site.active = true
          AND wo.type = 'CORRECTIVE'
          AND wo.status = 'COMPLETED'
          AND wo."requestedAt" <= ${now}
      )
      SELECT
        COUNT(*) FILTER (
          WHERE "startedAt" IS NOT NULL
            AND "completedAt" IS NOT NULL
            AND "startedAt" >= "requestedAt"
            AND "startedAt" <= ${now}
            AND "completedAt" >= "startedAt"
            AND "completedAt" <= ${now}
        )::int AS "sampleCount",
        COUNT(*) FILTER (
          WHERE NOT (
            "startedAt" IS NOT NULL
            AND "completedAt" IS NOT NULL
            AND "startedAt" >= "requestedAt"
            AND "startedAt" <= ${now}
            AND "completedAt" >= "startedAt"
            AND "completedAt" <= ${now}
          )
        )::int AS "excludedIncomplete",
        COALESCE(
          SUM(EXTRACT(EPOCH FROM ("completedAt" - "startedAt"))) FILTER (
            WHERE "startedAt" IS NOT NULL
              AND "completedAt" IS NOT NULL
              AND "startedAt" >= "requestedAt"
              AND "startedAt" <= ${now}
              AND "completedAt" >= "startedAt"
              AND "completedAt" <= ${now}
          ),
          0
        )::double precision AS "totalSeconds"
      FROM scoped
    `),
    db.$queryRaw<MtbfRow[]>(Prisma.sql`
      WITH failures AS (
        SELECT
          wo."assetId",
          wo."requestedAt",
          LAG(wo."requestedAt") OVER (
            PARTITION BY wo."assetId"
            ORDER BY wo."requestedAt", wo.id
          ) AS "previousRequestedAt"
        FROM "WorkOrder" wo
        INNER JOIN "Site" site ON site.id = wo."siteId"
        WHERE wo."siteId" = ${input.siteId}
          AND site."organizationId" = ${input.organizationId}
          AND site.active = true
          AND wo.type = 'CORRECTIVE'
          AND wo.status <> 'CANCELLED'
          AND wo."assetId" IS NOT NULL
          AND wo."requestedAt" <= ${now}
      ), intervals AS (
        SELECT
          "assetId",
          EXTRACT(EPOCH FROM ("requestedAt" - "previousRequestedAt")) AS seconds
        FROM failures
        WHERE "previousRequestedAt" IS NOT NULL
          AND "requestedAt" > "previousRequestedAt"
      )
      SELECT
        COUNT(*)::int AS "intervalCount",
        COUNT(DISTINCT "assetId")::int AS "assetCount",
        COALESCE(SUM(seconds), 0)::double precision AS "totalSeconds"
      FROM intervals
    `),
  ]);

  const mttr = mttrRows[0] ?? {
    sampleCount: 0,
    excludedIncomplete: 0,
    totalSeconds: 0,
  };
  const mtbf = mtbfRows[0] ?? { intervalCount: 0, assetCount: 0, totalSeconds: 0 };
  const mttrSampleCount = asNumber(mttr.sampleCount);
  const mtbfSampleCount = asNumber(mtbf.intervalCount);

  return {
    generatedAt: now.toISOString(),
    mttr: {
      hours: averageHours(mttr.totalSeconds, mttr.sampleCount),
      sampleCount: mttrSampleCount,
      excludedIncomplete: asNumber(mttr.excludedIncomplete),
    },
    mtbfProxy: {
      hours: averageHours(mtbf.totalSeconds, mtbf.intervalCount),
      sampleCount: mtbfSampleCount,
      assetCount: asNumber(mtbf.assetCount),
    },
    definitions: {
      mttr:
        "Average elapsed hours from startedAt to completedAt for completed corrective work orders with valid chronological timestamps. Invalid or missing timestamps are excluded and counted separately.",
      mtbfProxy:
        "Average elapsed hours between successive non-cancelled corrective requestedAt events on the same asset. This is an event-interval proxy until explicit failure and operating-hours telemetry exists.",
    },
  };
}
