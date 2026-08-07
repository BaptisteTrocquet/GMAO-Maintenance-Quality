import { db } from "@/lib/db";

export type ForecastState = "OVERDUE" | "DUE_SOON" | "UPCOMING";
export type ForecastKind = "CALENDAR_PLAN" | "METER_PLAN" | "PREVENTIVE_WORK_ORDER";

export type MaintenanceForecastEntry = {
  id: string;
  kind: ForecastKind;
  state: ForecastState;
  title: string;
  assetCode: string | null;
  dueAt: Date | null;
  meterCode: string | null;
  meterUnit: string | null;
  currentMeterValue: number | null;
  dueMeterValue: number | null;
  remainingMeterValue: number | null;
};

type PlanInput = {
  id: string;
  name: string;
  active: boolean;
  frequencyValue: number;
  frequencyUnit: string;
  nextDueAt: Date | null;
  nextDueMeterValue: number | null;
  asset: { code: string };
  meter: {
    code: string;
    unit: string;
    readings: Array<{ value: number; readingAt: Date }>;
  } | null;
};

type WorkOrderInput = {
  id: string;
  number: string;
  title: string;
  dueAt: Date | null;
  asset: { code: string } | null;
};

function stateRank(state: ForecastState) {
  return state === "OVERDUE" ? 0 : state === "DUE_SOON" ? 1 : 2;
}

export function calculateMaintenanceForecast(input: {
  plans: PlanInput[];
  workOrders: WorkOrderInput[];
  now: Date;
  horizonDays: number;
}) {
  const horizonAt = new Date(input.now.getTime() + input.horizonDays * 24 * 60 * 60 * 1000);
  const entries: MaintenanceForecastEntry[] = [];
  let pausedPlans = 0;

  for (const plan of input.plans) {
    if (!plan.active) {
      pausedPlans += 1;
      continue;
    }

    if (plan.frequencyUnit === "METER") {
      const currentValue = plan.meter?.readings[0]?.value ?? null;
      const threshold = plan.nextDueMeterValue;
      if (!plan.meter || currentValue === null || threshold === null) continue;

      const remaining = threshold - currentValue;
      const dueSoonWindow = Math.max(1, plan.frequencyValue * 0.2);
      const state: ForecastState =
        remaining <= 0 ? "OVERDUE" : remaining <= dueSoonWindow ? "DUE_SOON" : "UPCOMING";

      entries.push({
        id: plan.id,
        kind: "METER_PLAN",
        state,
        title: plan.name,
        assetCode: plan.asset.code,
        dueAt: null,
        meterCode: plan.meter.code,
        meterUnit: plan.meter.unit,
        currentMeterValue: currentValue,
        dueMeterValue: threshold,
        remainingMeterValue: remaining,
      });
      continue;
    }

    if (!plan.nextDueAt) continue;
    const state: ForecastState =
      plan.nextDueAt < input.now
        ? "OVERDUE"
        : plan.nextDueAt <= horizonAt
          ? "DUE_SOON"
          : "UPCOMING";
    entries.push({
      id: plan.id,
      kind: "CALENDAR_PLAN",
      state,
      title: plan.name,
      assetCode: plan.asset.code,
      dueAt: plan.nextDueAt,
      meterCode: null,
      meterUnit: null,
      currentMeterValue: null,
      dueMeterValue: null,
      remainingMeterValue: null,
    });
  }

  for (const workOrder of input.workOrders) {
    if (!workOrder.dueAt) continue;
    const state: ForecastState =
      workOrder.dueAt < input.now
        ? "OVERDUE"
        : workOrder.dueAt <= horizonAt
          ? "DUE_SOON"
          : "UPCOMING";
    entries.push({
      id: workOrder.id,
      kind: "PREVENTIVE_WORK_ORDER",
      state,
      title: `${workOrder.number} · ${workOrder.title}`,
      assetCode: workOrder.asset?.code ?? null,
      dueAt: workOrder.dueAt,
      meterCode: null,
      meterUnit: null,
      currentMeterValue: null,
      dueMeterValue: null,
      remainingMeterValue: null,
    });
  }

  entries.sort((a, b) => {
    const rank = stateRank(a.state) - stateRank(b.state);
    if (rank !== 0) return rank;
    if (a.dueAt && b.dueAt) return a.dueAt.getTime() - b.dueAt.getTime();
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    return (a.remainingMeterValue ?? Number.POSITIVE_INFINITY) -
      (b.remainingMeterValue ?? Number.POSITIVE_INFINITY);
  });

  const overduePlans = entries.filter(
    (entry) => entry.state === "OVERDUE" && entry.kind !== "PREVENTIVE_WORK_ORDER",
  ).length;
  const overdueWorkOrders = entries.filter(
    (entry) => entry.state === "OVERDUE" && entry.kind === "PREVENTIVE_WORK_ORDER",
  ).length;
  const dueSoon = entries.filter((entry) => entry.state === "DUE_SOON").length;

  const penalties = {
    overduePlans: Math.min(30, overduePlans * 10),
    overdueWorkOrders: Math.min(60, overdueWorkOrders * 15),
    dueSoon: Math.min(10, dueSoon * 2),
  };
  const score = Math.max(0, 100 - penalties.overduePlans - penalties.overdueWorkOrders - penalties.dueSoon);
  const health = score >= 85 ? "HEALTHY" : score >= 65 ? "WATCH" : "AT_RISK";

  return {
    generatedAt: input.now,
    horizonDays: input.horizonDays,
    horizonAt,
    health: {
      score,
      status: health,
      penalties,
      overduePlans,
      overdueWorkOrders,
      dueSoon,
      pausedPlans,
    },
    entries,
  };
}

export async function getMaintenanceForecast(input: {
  organizationId: string;
  siteId: string;
  horizonDays?: number;
  now?: Date;
}) {
  const site = await db.site.findFirst({
    where: {
      id: input.siteId,
      organizationId: input.organizationId,
      active: true,
      organization: { active: true },
    },
    select: { id: true, code: true, name: true },
  });
  if (!site) return null;

  const [plans, workOrders] = await Promise.all([
    db.maintenancePlan.findMany({
      where: { asset: { siteId: input.siteId, archivedAt: null } },
      include: {
        asset: { select: { code: true } },
        meter: {
          select: {
            code: true,
            unit: true,
            readings: { orderBy: { readingAt: "desc" }, take: 1, select: { value: true, readingAt: true } },
          },
        },
      },
    }),
    db.workOrder.findMany({
      where: {
        siteId: input.siteId,
        type: "PREVENTIVE",
        status: { notIn: ["COMPLETED", "CANCELLED"] },
        dueAt: { not: null },
      },
      select: {
        id: true,
        number: true,
        title: true,
        dueAt: true,
        asset: { select: { code: true } },
      },
    }),
  ]);

  return {
    site,
    ...calculateMaintenanceForecast({
      plans,
      workOrders,
      now: input.now ?? new Date(),
      horizonDays: input.horizonDays ?? 30,
    }),
  };
}
