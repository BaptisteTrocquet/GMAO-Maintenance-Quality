import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  localCalendarDate,
  localDateStartUtc,
  resolveAnalyticsDateRange,
  shiftCalendarDate,
} from "@/lib/analytics/date-range";
import {
  baselineCapacityMinutes,
  countWeekdaysInclusive,
  listLaborCapacityProfiles,
} from "@/lib/analytics/labor-capacity";

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
  weeklyCapacityMinutes?: number | null;
  capacityMinutes?: number | null;
  utilizationPercent?: number | null;
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
  const noCapacityDefinition =
    "Recorded-labor distribution only. Configure a weekly capacity baseline for maintenance users to calculate utilization; no workforce capacity is inferred automatically.";

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
      capacityMode: "RECORDED_ONLY" as const,
      businessDays: 0,
      configuredCapacityUsers: 0,
      capacityMinutes: 0,
      capacityHours: 0,
      capacityCoveredLaborMinutes: 0,
      capacityCoveragePercent: null,
      utilizationPercent: null,
      definition: noCapacityDefinition,
    };
  }

  const assetFilter = input.assetId
    ? Prisma.sql`AND wo."assetId" = ${input.assetId}`
    : Prisma.empty;

  const [summaryRows, personRows, teamRows, capacityProfiles] = await Promise.all([
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
    listLaborCapacityProfiles({
      organizationId: input.organizationId,
      siteId: input.siteId,
    }),
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

  const lastIncludedInstant = new Date(Math.max(range.from.getTime(), toExclusive.getTime() - 1));
  const lastCapacityDay = localCalendarDate(lastIncludedInstant, input.timeZone);
  const businessDays = countWeekdaysInclusive(input.from, lastCapacityDay);
  const capacityByUser = new Map(
    capacityProfiles.map((profile) => [
      profile.userId,
      {
        ...profile,
        capacityMinutes: baselineCapacityMinutes(profile.weeklyCapacityMinutes, businessDays),
      },
    ]),
  );
  const laborByUser = new Map(personRows.map((row) => [row.id, row]));

  const peopleIds = new Set([...laborByUser.keys(), ...capacityByUser.keys()]);
  const people = [...peopleIds]
    .map((userId): LaborUtilizationPoint => {
      const labor = laborByUser.get(userId);
      const capacity = capacityByUser.get(userId);
      const minutes = numeric(labor?.minutes);
      const capacityMinutes = capacity?.capacityMinutes ?? null;
      return {
        id: userId,
        kind: "PERSON",
        label: labor?.label ?? capacity?.displayName ?? "Unknown",
        workOrderCount: numeric(labor?.workOrderCount),
        minutes,
        hours: minutes / 60,
        sharePercent: totalMinutes ? (minutes / totalMinutes) * 100 : 0,
        weeklyCapacityMinutes: capacity?.weeklyCapacityMinutes ?? null,
        capacityMinutes,
        utilizationPercent:
          capacityMinutes !== null && capacityMinutes > 0 ? (minutes / capacityMinutes) * 100 : null,
      };
    })
    .sort((left, right) => right.minutes - left.minutes || left.label.localeCompare(right.label))
    .slice(0, LABOR_UTILIZATION_TOP_LIMIT);

  const teams = teamRows.map((row): LaborUtilizationPoint => {
    const minutes = numeric(row.minutes);
    return {
      id: row.id,
      kind: "TEAM",
      label: row.label,
      workOrderCount: row.workOrderCount,
      minutes,
      hours: minutes / 60,
      sharePercent: totalMinutes ? (minutes / totalMinutes) * 100 : 0,
      weeklyCapacityMinutes: null,
      capacityMinutes: null,
      utilizationPercent: null,
    };
  });

  const capacityMinutes = capacityProfiles.reduce(
    (sum, profile) => sum + baselineCapacityMinutes(profile.weeklyCapacityMinutes, businessDays),
    0,
  );
  const capacityCoveredLaborMinutes = capacityProfiles.reduce(
    (sum, profile) => sum + numeric(laborByUser.get(profile.userId)?.minutes),
    0,
  );
  const capacityCoveragePercent =
    personMinutes > 0 ? (capacityCoveredLaborMinutes / personMinutes) * 100 : null;
  const utilizationPercent =
    capacityMinutes > 0 ? (capacityCoveredLaborMinutes / capacityMinutes) * 100 : null;
  const definition = capacityProfiles.length
    ? "Configured baseline labor utilization = recorded person-attributed labor for users with a capacity profile divided by their weekly capacity prorated across Monday-Friday days in the reporting window. Team-only and unassigned labor remain visible but are not assigned to an individual capacity denominator. This is a planning baseline: holidays, leave and shift timing are not inferred."
    : noCapacityDefinition;

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
    people,
    teams,
    capacityMode: capacityProfiles.length ? ("CONFIGURED_BASELINE" as const) : ("RECORDED_ONLY" as const),
    businessDays,
    configuredCapacityUsers: capacityProfiles.length,
    capacityMinutes,
    capacityHours: capacityMinutes / 60,
    capacityCoveredLaborMinutes,
    capacityCoveragePercent,
    utilizationPercent,
    definition,
  };
}
