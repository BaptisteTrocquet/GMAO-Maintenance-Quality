import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  localDateStartUtc,
  resolveAnalyticsDateRange,
  shiftCalendarDate,
} from "@/lib/analytics/date-range";

export const DOWNTIME_TOP_ASSET_LIMIT = 10;
export const DOWNTIME_MAX_RANGE_DAYS = 731;

export type DowntimeTrendPoint = {
  month: string;
  eventCount: number;
  minutes: number;
  hours: number;
};

export type DowntimeAssetPoint = {
  assetId: string;
  code: string;
  name: string;
  eventCount: number;
  minutes: number;
  hours: number;
};

export class DowntimeAnalyticsError extends Error {
  constructor(
    public readonly code: "ASSET_NOT_FOUND" | "RANGE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "DowntimeAnalyticsError";
  }
}

type MonthlyRow = {
  month: string;
  eventCount: number;
  minutes: number;
};

type AssetRow = {
  assetId: string;
  code: string;
  name: string;
  eventCount: number;
  minutes: number;
};

function minDate(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
}

function numeric(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : 0;
}

export async function buildDowntimeDashboard(input: {
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
    throw new Error("Downtime analytics requires a bounded reporting range");
  }

  // Enforce the horizon in local calendar days rather than elapsed milliseconds so DST
  // transitions do not make an otherwise valid range appear one hour too long or short.
  const maxToExclusive = localDateStartUtc(
    shiftCalendarDate(input.from, DOWNTIME_MAX_RANGE_DAYS),
    input.timeZone,
  );
  if (range.toExclusive.getTime() > maxToExclusive.getTime()) {
    throw new DowntimeAnalyticsError(
      "RANGE_TOO_LARGE",
      `Downtime reporting is limited to ${DOWNTIME_MAX_RANGE_DAYS} local calendar days per request`,
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
      throw new DowntimeAnalyticsError(
        "ASSET_NOT_FOUND",
        "Active asset not found in the requested tenant/site scope",
      );
    }
  }

  const toExclusive = minDate(range.toExclusive, now);
  if (range.from.getTime() >= toExclusive.getTime()) {
    return {
      generatedAt: now.toISOString(),
      timezone: input.timeZone,
      range: { from: range.from.toISOString(), toExclusive: toExclusive.toISOString() },
      assetId: input.assetId ?? null,
      empty: true,
      totalMinutes: 0,
      totalHours: 0,
      eventCount: 0,
      averageMinutesPerEvent: null,
      trend: [] as DowntimeTrendPoint[],
      topAssets: [] as DowntimeAssetPoint[],
      definition:
        "Downtime recorded on completed work orders, attributed to the completion month in the site timezone.",
    };
  }

  const assetFilter = input.assetId
    ? Prisma.sql`AND wo."assetId" = ${input.assetId}`
    : Prisma.empty;

  const [monthlyRows, assetRows] = await Promise.all([
    db.$queryRaw<MonthlyRow[]>(Prisma.sql`
      SELECT
        TO_CHAR((wo."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${input.timeZone}, 'YYYY-MM') AS month,
        COUNT(*)::int AS "eventCount",
        COALESCE(SUM(wo."downtimeMinutes"), 0)::double precision AS minutes
      FROM "WorkOrder" wo
      INNER JOIN "Site" site ON site.id = wo."siteId"
      WHERE wo."siteId" = ${input.siteId}
        AND site."organizationId" = ${input.organizationId}
        AND site.active = true
        AND wo.status = 'COMPLETED'
        AND wo."completedAt" >= ${range.from}
        AND wo."completedAt" < ${toExclusive}
        AND wo."downtimeMinutes" IS NOT NULL
        AND wo."downtimeMinutes" > 0
        ${assetFilter}
      GROUP BY 1
      ORDER BY 1 ASC
    `),
    db.$queryRaw<AssetRow[]>(Prisma.sql`
      SELECT
        asset.id AS "assetId",
        asset.code,
        asset.name,
        COUNT(*)::int AS "eventCount",
        COALESCE(SUM(wo."downtimeMinutes"), 0)::double precision AS minutes
      FROM "WorkOrder" wo
      INNER JOIN "Site" site ON site.id = wo."siteId"
      INNER JOIN "Asset" asset ON asset.id = wo."assetId"
      WHERE wo."siteId" = ${input.siteId}
        AND site."organizationId" = ${input.organizationId}
        AND site.active = true
        AND asset."archivedAt" IS NULL
        AND wo.status = 'COMPLETED'
        AND wo."completedAt" >= ${range.from}
        AND wo."completedAt" < ${toExclusive}
        AND wo."downtimeMinutes" IS NOT NULL
        AND wo."downtimeMinutes" > 0
        ${assetFilter}
      GROUP BY asset.id, asset.code, asset.name
      ORDER BY minutes DESC, asset.code ASC
      LIMIT ${DOWNTIME_TOP_ASSET_LIMIT}
    `),
  ]);

  const trend = monthlyRows.map((row) => {
    const minutes = numeric(row.minutes);
    return {
      month: row.month,
      eventCount: row.eventCount,
      minutes,
      hours: minutes / 60,
    };
  });
  const topAssets = assetRows.map((row) => {
    const minutes = numeric(row.minutes);
    return {
      ...row,
      minutes,
      hours: minutes / 60,
    };
  });
  const totalMinutes = trend.reduce((sum, point) => sum + point.minutes, 0);
  const eventCount = trend.reduce((sum, point) => sum + point.eventCount, 0);

  return {
    generatedAt: now.toISOString(),
    timezone: input.timeZone,
    range: { from: range.from.toISOString(), toExclusive: toExclusive.toISOString() },
    assetId: input.assetId ?? null,
    empty: eventCount === 0,
    totalMinutes,
    totalHours: totalMinutes / 60,
    eventCount,
    averageMinutesPerEvent: eventCount === 0 ? null : totalMinutes / eventCount,
    trend,
    topAssets,
    definition:
      "Downtime recorded on completed work orders, attributed to the completion month in the site timezone.",
  };
}
