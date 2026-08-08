import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  localDateStartUtc,
  resolveAnalyticsDateRange,
  shiftCalendarDate,
} from "@/lib/analytics/date-range";

export const LABOR_UTILIZATION_TOP_LIMIT = 25;
export const LABOR_UTILIZATION_MAX_RANGE_DAYS = 731;

type SummaryRow = {
  completedCount: number;
  recordedCount: number;
  excludedMissingLabor: number;
  totalMinutes: number;
  personMinutes: number;
  teamMinutes: number;
  unassignedMinutes: number;
};

type PersonRow = {
  id: string;
  label: string;
  workOrderCount: number;
  minutes: number;
};

type TeamRow = PersonRow;

export type LaborUtilizationPoint = {
  id: string;
  kind: "PERSON" | "TEAM";
  label: string;
  workOrderCount: number;
  minutes: number;
  hours: number;
  sharePercent: number;
};

export class LaborUtilizationError extends Error {
  constructor(
    public readonly code: "ASSET_NOT_FOUND" | "RANGE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "LaborUtilizationError";
  }
}

function minDate(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
}

function numeric(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : 0;
}

export async function buildLaborUtilization(input: {
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
    throw new Error("Labor utilization requires a bounded reporting range");
  }

  const maxToExclusive = localDateStartUtc(
    shiftCalendarDate(input.from, LABOR_UTILIZATION_MAX_RANGE_DAYS),
    input.timeZone,
  );
  if (range.toExclusive.getTime() > maxToExclusive.getTime()) {
    throw new LaborUtilizationError(
      "RANGE_TOO_LARGE",
      `Labor utilization is limited to ${LABOR_UTILIZATION_MAX_RANGE_DAYS} local calendar days per request`,
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
      throw new LaborUtilizationError(
        "ASSET_NOT_FOUND",
        "Active asset not found in the requested tenant/site scope",
      );
    }
  }

  const toExclusive = minDate(range.toExclusive, now);
  const definition =
    "Recorded-labor utilization proxy: distribution of positive laborMinutes on completed work orders by assignee, then team, then unassigned. This is not capacity utilization because contractual or scheduled working-hour capacity is not modeled.";

  if (range.from.getTime() >= toExclusive.getTime()) {
    return {
      generatedAt: now.toISOString(),
      timezone: input.timeZone,
      range: { from: range.from.toISOString(), toExclusive: toExclusive.toISOString() },
      assetId: input.assetId ?? null,
      empty: true,
      completedWorkOrders: 0,
      recordedWorkOrders: 0,
      excludedMissingLabor: 0,
      captureCoveragePercent: null,
      totalMinutes: 0,
      totalHours: 0,
      personMinutes: 0,
      teamMinutes: 0,
      unassignedMinutes: 0,
      attributedPercent: null,
      people: [] as LaborUtilizationPoint[],
      teams: [] as LaborUtilizationPoint[],
      definition,
    };
  }

  const assetFilter = input.assetId
    ? Prisma.sql`AND wo."assetId" = ${input.assetId}`
    : Prisma.empty;

  const [summaryRows, personRows, teamRows] = await Promise.all([
    db.$queryRaw<SummaryRow[]>(Prisma.sql`
      SELECT
        COUNT(*)::int AS "completedCount",
        COUNT(*) FILTER (WHERE wo."laborMinutes" IS NOT NULL AND wo."laborMinutes" > 0)::int AS "recordedCount",
        COUNT(*) FILTER (WHERE wo."laborMinutes" IS NULL OR wo."laborMinutes" <= 0)::int AS "excludedMissingLabor",
        COALESCE(SUM(GREATEST(COALESCE(wo."laborMinutes", 0), 0)), 0)::double precision AS "totalMinutes",
        COALESCE(SUM(CASE WHEN wo."laborMinutes" > 0 AND wo."assigneeId" IS NOT NULL THEN wo."laborMinutes" ELSE 0 END), 0)::double precision AS "personMinutes",
        COALESCE(SUM(CASE WHEN wo."laborMinutes" > 0 AND wo."assigneeId" IS NULL AND wo."teamId" IS NOT NULL THEN wo."laborMinutes" ELSE 0 END), 0)::double precision AS "teamMinutes",
        COALESCE(SUM(CASE WHEN wo."laborMinutes" > 0 AND wo."assigneeId" IS NULL AND wo."teamId" IS NULL THEN wo."laborMinutes" ELSE 0 END), 0)::double precision AS "unassignedMinutes"
      FROM "WorkOrder" wo
      INNER JOIN "Site" site ON site.id = wo."siteId"
      WHERE wo."siteId" = ${input.siteId}
        AND site."organizationId" = ${input.organizationId}
        AND site.active = true
        AND wo.status = 'COMPLETED'
        AND wo."completedAt" IS NOT NULL
        AND wo."completedAt" >= ${range.from}
        AND wo."completedAt" < ${toExclusive}
        ${assetFilter}
    `),
    db.$queryRaw<PersonRow[]>(Prisma.sql`
      SELECT
        user_account.id,
        user_account."displayName" AS label,
        COUNT(*)::int AS "workOrderCount",
        COALESCE(SUM(wo."laborMinutes"), 0)::double precision AS minutes
      FROM "WorkOrder" wo
      INNER JOIN "Site" site ON site.id = wo."siteId"
      INNER JOIN "User" user_account ON user_account.id = wo."assigneeId"
      WHERE wo."siteId" = ${input.siteId}
        AND site."organizationId" = ${input.organizationId}
        AND site.active = true
        AND wo.status = 'COMPLETED'
        AND wo."completedAt" IS NOT NULL
        AND wo."completedAt" >= ${range.from}
        AND wo."completedAt" < ${toExclusive}
        AND wo."laborMinutes" IS NOT NULL
        AND wo."laborMinutes" > 0
        AND wo."assigneeId" IS NOT NULL
        ${assetFilter}
      GROUP BY user_account.id, user_account."displayName"
      ORDER BY minutes DESC, label ASC
      LIMIT ${LABOR_UTILIZATION_TOP_LIMIT}
    `),
    db.$queryRaw<TeamRow[]>(Prisma.sql`
      SELECT
        team.id,
        team.name AS label,
        COUNT(*)::int AS "workOrderCount",
        COALESCE(SUM(wo."laborMinutes"), 0)::double precision AS minutes
      FROM "WorkOrder" wo
      INNER JOIN "Site" site ON site.id = wo."siteId"
      INNER JOIN "MaintenanceTeam" team ON team.id = wo."teamId"
      WHERE wo."siteId" = ${input.siteId}
        AND site."organizationId" = ${input.organizationId}
        AND site.active = true
        AND wo.status = 'COMPLETED'
        AND wo."completedAt" IS NOT NULL
        AND wo."completedAt" >= ${range.from}
        AND wo."completedAt" < ${toExclusive}
        AND wo."laborMinutes" IS NOT NULL
        AND wo."laborMinutes" > 0
        AND wo."assigneeId" IS NULL
        AND wo."teamId" IS NOT NULL
        ${assetFilter}
      GROUP BY team.id, team.name
      ORDER BY minutes DESC, label ASC
      LIMIT ${LABOR_UTILIZATION_TOP_LIMIT}
    `),
  ]);

  const summary = summaryRows[0] ?? {
    completedCount: 0,
    recordedCount: 0,
    excludedMissingLabor: 0,
    totalMinutes: 0,
    personMinutes: 0,
    teamMinutes: 0,
    unassignedMinutes: 0,
  };
  const totalMinutes = numeric(summary.totalMinutes);
  const personMinutes = numeric(summary.personMinutes);
  const teamMinutes = numeric(summary.teamMinutes);
  const unassignedMinutes = numeric(summary.unassignedMinutes);

  function points(rows: PersonRow[] | TeamRow[], kind: "PERSON" | "TEAM") {
    return rows.map((row) => {
      const minutes = numeric(row.minutes);
      return {
        id: row.id,
        kind,
        label: row.label,
        workOrderCount: row.workOrderCount,
        minutes,
        hours: minutes / 60,
        sharePercent: totalMinutes ? (minutes / totalMinutes) * 100 : 0,
      } satisfies LaborUtilizationPoint;
    });
  }

  return {
    generatedAt: now.toISOString(),
    timezone: input.timeZone,
    range: { from: range.from.toISOString(), toExclusive: toExclusive.toISOString() },
    assetId: input.assetId ?? null,
    empty: summary.recordedCount === 0,
    completedWorkOrders: summary.completedCount,
    recordedWorkOrders: summary.recordedCount,
    excludedMissingLabor: summary.excludedMissingLabor,
    captureCoveragePercent:
      summary.completedCount === 0 ? null : (summary.recordedCount / summary.completedCount) * 100,
    totalMinutes,
    totalHours: totalMinutes / 60,
    personMinutes,
    teamMinutes,
    unassignedMinutes,
    attributedPercent:
      totalMinutes === 0 ? null : ((personMinutes + teamMinutes) / totalMinutes) * 100,
    people: points(personRows, "PERSON"),
    teams: points(teamRows, "TEAM"),
    definition,
  };
}
