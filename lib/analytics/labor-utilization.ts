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

export const LABOR_UTILIZATION_LIMIT = 50;
export const LABOR_UTILIZATION_MAX_RANGE_DAYS = 731;

export class LaborUtilizationError extends Error {
  constructor(
    public readonly code: "ASSET_NOT_FOUND" | "RANGE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "LaborUtilizationError";
  }
}

type SummaryRow = {
  completedWorkOrders: number;
  recordedWorkOrders: number;
  laborMinutes: number;
  unassignedLaborMinutes: number;
};

type AssigneeRow = {
  assigneeId: string | null;
  displayName: string;
  workOrderCount: number;
  laborMinutes: number;
};

function earlierInstant(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
}

function numeric(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : 0;
}

export async function buildLaborUtilizationDashboard(input: {
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
      `Labor reporting is limited to ${LABOR_UTILIZATION_MAX_RANGE_DAYS} local calendar days per request`,
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

  const toExclusive = earlierInstant(range.toExclusive, now);
  if (range.from.getTime() >= toExclusive.getTime()) {
    return {
      generatedAt: now.toISOString(),
      timezone: input.timeZone,
      range: { from: range.from.toISOString(), toExclusive: toExclusive.toISOString() },
      assetId: input.assetId ?? null,
      empty: true,
      completedWorkOrders: 0,
      recordedWorkOrders: 0,
      recordingCoveragePercent: null,
      laborMinutes: 0,
      laborHours: 0,
      unassignedLaborMinutes: 0,
      unassignedSharePercent: null,
      capacityMode: "RECORDED_ONLY" as const,
      businessDays: 0,
      configuredCapacityUsers: 0,
      capacityMinutes: 0,
      capacityHours: 0,
      capacityCoveredLaborMinutes: 0,
      capacityCoveragePercent: null,
      utilizationPercent: null,
      assignees: [] as Array<{
        assigneeId: string | null;
        displayName: string;
        workOrderCount: number;
        laborMinutes: number;
        laborHours: number;
        recordedLaborSharePercent: number;
        weeklyCapacityMinutes: number | null;
        capacityMinutes: number | null;
        utilizationPercent: number | null;
      }>,
      definition:
        "Recorded-labor distribution only. Configure a weekly capacity baseline for maintenance users to calculate utilization; no workforce capacity is inferred automatically.",
    };
  }

  const assetFilter = input.assetId
    ? Prisma.sql`AND wo."assetId" = ${input.assetId}`
    : Prisma.empty;

  const [summaryRows, assigneeRows, capacityProfiles] = await Promise.all([
    db.$queryRaw<SummaryRow[]>(Prisma.sql`
      SELECT
        COUNT(*)::int AS "completedWorkOrders",
        COUNT(*) FILTER (WHERE wo."laborMinutes" > 0)::int AS "recordedWorkOrders",
        COALESCE(SUM(GREATEST(COALESCE(wo."laborMinutes", 0), 0)), 0)::double precision AS "laborMinutes",
        COALESCE(
          SUM(GREATEST(COALESCE(wo."laborMinutes", 0), 0)) FILTER (WHERE wo."assigneeId" IS NULL),
          0
        )::double precision AS "unassignedLaborMinutes"
      FROM "WorkOrder" wo
      INNER JOIN "Site" site ON site.id = wo."siteId"
      WHERE wo."siteId" = ${input.siteId}
        AND site."organizationId" = ${input.organizationId}
        AND site.active = true
        AND wo.status = 'COMPLETED'
        AND wo."completedAt" >= ${range.from}
        AND wo."completedAt" < ${toExclusive}
        ${assetFilter}
    `),
    db.$queryRaw<AssigneeRow[]>(Prisma.sql`
      SELECT
        wo."assigneeId" AS "assigneeId",
        COALESCE(assignee."displayName", 'Unassigned') AS "displayName",
        COUNT(*)::int AS "workOrderCount",
        COALESCE(SUM(wo."laborMinutes"), 0)::double precision AS "laborMinutes"
      FROM "WorkOrder" wo
      INNER JOIN "Site" site ON site.id = wo."siteId"
      LEFT JOIN "User" assignee ON assignee.id = wo."assigneeId"
      WHERE wo."siteId" = ${input.siteId}
        AND site."organizationId" = ${input.organizationId}
        AND site.active = true
        AND wo.status = 'COMPLETED'
        AND wo."completedAt" >= ${range.from}
        AND wo."completedAt" < ${toExclusive}
        AND wo."laborMinutes" > 0
        ${assetFilter}
      GROUP BY wo."assigneeId", assignee."displayName"
      ORDER BY "laborMinutes" DESC, "displayName" ASC
      LIMIT ${LABOR_UTILIZATION_LIMIT}
    `),
    listLaborCapacityProfiles({
      organizationId: input.organizationId,
      siteId: input.siteId,
    }),
  ]);

  const summary = summaryRows[0] ?? {
    completedWorkOrders: 0,
    recordedWorkOrders: 0,
    laborMinutes: 0,
    unassignedLaborMinutes: 0,
  };
  const laborMinutes = numeric(summary.laborMinutes);
  const completedWorkOrders = numeric(summary.completedWorkOrders);
  const recordedWorkOrders = numeric(summary.recordedWorkOrders);
  const unassignedLaborMinutes = numeric(summary.unassignedLaborMinutes);

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
  const laborByUser = new Map(
    assigneeRows
      .filter((row) => row.assigneeId)
      .map((row) => [row.assigneeId as string, row]),
  );

  const userIds = new Set([...capacityByUser.keys(), ...laborByUser.keys()]);
  const assignedRows = [...userIds].map((userId) => {
    const labor = laborByUser.get(userId);
    const capacity = capacityByUser.get(userId);
    const minutes = numeric(labor?.laborMinutes);
    const capacityMinutes = capacity?.capacityMinutes ?? null;
    return {
      assigneeId: userId,
      displayName: labor?.displayName ?? capacity?.displayName ?? "Unknown",
      workOrderCount: numeric(labor?.workOrderCount),
      laborMinutes: minutes,
      laborHours: minutes / 60,
      recordedLaborSharePercent: laborMinutes > 0 ? (minutes / laborMinutes) * 100 : 0,
      weeklyCapacityMinutes: capacity?.weeklyCapacityMinutes ?? null,
      capacityMinutes,
      utilizationPercent:
        capacityMinutes !== null && capacityMinutes > 0 ? (minutes / capacityMinutes) * 100 : null,
    };
  });

  const unassigned = assigneeRows.find((row) => row.assigneeId === null);
  const assignees = [
    ...assignedRows,
    ...(unassigned
      ? [
          {
            assigneeId: null,
            displayName: unassigned.displayName,
            workOrderCount: numeric(unassigned.workOrderCount),
            laborMinutes: numeric(unassigned.laborMinutes),
            laborHours: numeric(unassigned.laborMinutes) / 60,
            recordedLaborSharePercent:
              laborMinutes > 0 ? (numeric(unassigned.laborMinutes) / laborMinutes) * 100 : 0,
            weeklyCapacityMinutes: null,
            capacityMinutes: null,
            utilizationPercent: null,
          },
        ]
      : []),
  ].sort((left, right) => {
    const leftUtilization = left.utilizationPercent ?? -1;
    const rightUtilization = right.utilizationPercent ?? -1;
    return rightUtilization - leftUtilization || right.laborMinutes - left.laborMinutes;
  });

  const capacityMinutes = capacityProfiles.reduce(
    (sum, profile) => sum + baselineCapacityMinutes(profile.weeklyCapacityMinutes, businessDays),
    0,
  );
  const capacityCoveredLaborMinutes = capacityProfiles.reduce(
    (sum, profile) => sum + numeric(laborByUser.get(profile.userId)?.laborMinutes),
    0,
  );
  const assignedLaborMinutes = Math.max(laborMinutes - unassignedLaborMinutes, 0);
  const capacityCoveragePercent =
    assignedLaborMinutes > 0 ? (capacityCoveredLaborMinutes / assignedLaborMinutes) * 100 : null;
  const utilizationPercent =
    capacityMinutes > 0 ? (capacityCoveredLaborMinutes / capacityMinutes) * 100 : null;

  return {
    generatedAt: now.toISOString(),
    timezone: input.timeZone,
    range: { from: range.from.toISOString(), toExclusive: toExclusive.toISOString() },
    assetId: input.assetId ?? null,
    empty: completedWorkOrders === 0,
    completedWorkOrders,
    recordedWorkOrders,
    recordingCoveragePercent:
      completedWorkOrders > 0 ? (recordedWorkOrders / completedWorkOrders) * 100 : null,
    laborMinutes,
    laborHours: laborMinutes / 60,
    unassignedLaborMinutes,
    unassignedSharePercent:
      laborMinutes > 0 ? (unassignedLaborMinutes / laborMinutes) * 100 : null,
    capacityMode: capacityProfiles.length ? ("CONFIGURED_BASELINE" as const) : ("RECORDED_ONLY" as const),
    businessDays,
    configuredCapacityUsers: capacityProfiles.length,
    capacityMinutes,
    capacityHours: capacityMinutes / 60,
    capacityCoveredLaborMinutes,
    capacityCoveragePercent,
    utilizationPercent,
    assignees,
    definition: capacityProfiles.length
      ? "Configured baseline labor utilization = recorded labor for users with a capacity profile divided by their weekly capacity prorated across Monday-Friday days in the reporting window. This is a planning baseline: holidays, leave and shift timing are not inferred."
      : "Recorded-labor distribution only. Configure a weekly capacity baseline for maintenance users to calculate utilization; no workforce capacity is inferred automatically.",
  };
}
