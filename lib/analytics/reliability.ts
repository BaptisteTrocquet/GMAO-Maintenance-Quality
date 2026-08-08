import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type ReliabilityMetric = {
  hours: number | null;
  sampleCount: number;
};

export type ReliabilityDashboard = {
  generatedAt: string;
  mttr: ReliabilityMetric;
  mtbfProxy: ReliabilityMetric & { assetCount: number };
  definitions: {
    mttr: string;
    mtbfProxy: string;
  };
};

type MttrRow = {
  sampleCount: number;
  hours: number | null;
};

type MtbfRow = {
  intervalCount: number;
  assetCount: number;
  hours: number | null;
};

function finiteOrNull(value: number | null) {
  return value !== null && Number.isFinite(value) ? value : null;
}

export async function buildReliabilityDashboard(input: {
  organizationId: string;
  siteId: string;
  now?: Date;
}): Promise<ReliabilityDashboard> {
  const now = input.now ?? new Date();

  const [mttrRows, mtbfRows] = await Promise.all([
    db.$queryRaw<MttrRow[]>(Prisma.sql`
      SELECT
        COUNT(*)::int AS "sampleCount",
        AVG(EXTRACT(EPOCH FROM (wo."completedAt" - wo."startedAt")) / 3600.0)::double precision AS "hours"
      FROM "WorkOrder" wo
      INNER JOIN "Site" site ON site.id = wo."siteId"
      WHERE wo."siteId" = ${input.siteId}
        AND site."organizationId" = ${input.organizationId}
        AND site.active = true
        AND wo.type = 'CORRECTIVE'
        AND wo.status = 'COMPLETED'
        AND wo."startedAt" IS NOT NULL
        AND wo."completedAt" IS NOT NULL
        AND wo."startedAt" <= ${now}
        AND wo."completedAt" <= ${now}
        AND wo."completedAt" >= wo."startedAt"
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
          AND wo.status = 'COMPLETED'
          AND wo."assetId" IS NOT NULL
          AND wo."requestedAt" <= ${now}
      ), intervals AS (
        SELECT
          "assetId",
          EXTRACT(EPOCH FROM ("requestedAt" - "previousRequestedAt")) / 3600.0 AS hours
        FROM failures
        WHERE "previousRequestedAt" IS NOT NULL
          AND "requestedAt" > "previousRequestedAt"
      )
      SELECT
        COUNT(*)::int AS "intervalCount",
        COUNT(DISTINCT "assetId")::int AS "assetCount",
        AVG(hours)::double precision AS "hours"
      FROM intervals
    `),
  ]);

  const mttr = mttrRows[0] ?? { sampleCount: 0, hours: null };
  const mtbf = mtbfRows[0] ?? { intervalCount: 0, assetCount: 0, hours: null };

  return {
    generatedAt: now.toISOString(),
    mttr: {
      hours: finiteOrNull(mttr.hours),
      sampleCount: mttr.sampleCount,
    },
    mtbfProxy: {
      hours: finiteOrNull(mtbf.hours),
      sampleCount: mtbf.intervalCount,
      assetCount: mtbf.assetCount,
    },
    definitions: {
      mttr:
        "Average elapsed hours from startedAt to completedAt for completed corrective work orders with valid timestamps.",
      mtbfProxy:
        "Average elapsed hours between successive requestedAt timestamps of completed corrective work orders on the same asset. This is an event-interval proxy until explicit failure/uptime telemetry exists.",
    },
  };
}
