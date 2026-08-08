import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const ANALYTICS_BENCHMARK_SLUG = "analytics-benchmark";
export const ANALYTICS_BENCHMARK_TIMEZONE = "Europe/Paris";
export const ANALYTICS_BENCHMARK_ASSET_COUNT = 250;
export const ANALYTICS_BENCHMARK_WORK_ORDER_COUNT = 20_000;
export const ANALYTICS_BENCHMARK_NOW = new Date("2026-08-08T10:00:00.000Z");
export const ANALYTICS_BENCHMARK_FROM = "2025-08-09";
export const ANALYTICS_BENCHMARK_TO = "2026-08-08";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const BATCH_SIZE = 2_000;

export type AnalyticsBenchmarkScope = {
  organizationId: string;
  siteId: string;
  timeZone: string;
};

export async function clearAnalyticsBenchmarkFixture() {
  await db.organization.deleteMany({ where: { slug: ANALYTICS_BENCHMARK_SLUG } });
}

export async function createAnalyticsBenchmarkFixture(): Promise<AnalyticsBenchmarkScope> {
  await clearAnalyticsBenchmarkFixture();

  const organization = await db.organization.create({
    data: {
      slug: ANALYTICS_BENCHMARK_SLUG,
      name: "Synthetic Analytics Benchmark",
      timezone: ANALYTICS_BENCHMARK_TIMEZONE,
      locale: "en",
    },
  });
  const site = await db.site.create({
    data: {
      organizationId: organization.id,
      code: "BENCH",
      name: "Synthetic Benchmark Site",
      description: "Disposable synthetic tenant used only by analytics performance checks.",
    },
  });

  await db.asset.createMany({
    data: Array.from({ length: ANALYTICS_BENCHMARK_ASSET_COUNT }, (_, index) => ({
      siteId: site.id,
      code: `BENCH-${String(index + 1).padStart(4, "0")}`,
      name: `Synthetic benchmark asset ${index + 1}`,
      category: index % 4 === 0 ? "PUMP" : index % 4 === 1 ? "MOTOR" : index % 4 === 2 ? "VALVE" : "OTHER",
      criticality: index % 20 === 0 ? "CRITICAL" : index % 5 === 0 ? "HIGH" : "MEDIUM",
      status: "ACTIVE",
    })),
  });

  const assets = await db.asset.findMany({
    where: { siteId: site.id },
    select: { id: true },
    orderBy: { code: "asc" },
  });

  const statuses = ["REQUESTED", "APPROVED", "PLANNED", "IN_PROGRESS", "BLOCKED", "COMPLETED"] as const;
  const priorities = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
  const types = ["CORRECTIVE", "PREVENTIVE", "INSPECTION", "OTHER"] as const;

  for (let start = 0; start < ANALYTICS_BENCHMARK_WORK_ORDER_COUNT; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, ANALYTICS_BENCHMARK_WORK_ORDER_COUNT);
    const rows: Prisma.WorkOrderCreateManyInput[] = [];

    for (let index = start; index < end; index += 1) {
      const requestedAt = new Date(ANALYTICS_BENCHMARK_NOW.getTime() - (index % 365) * DAY_MS - (index % 23) * HOUR_MS);
      const status = statuses[index % statuses.length];
      const completed = status === "COMPLETED";
      const startedAt = completed || status === "IN_PROGRESS" || status === "BLOCKED"
        ? new Date(requestedAt.getTime() + (1 + (index % 6)) * HOUR_MS)
        : null;
      const completedAt = completed && startedAt
        ? new Date(startedAt.getTime() + (1 + (index % 18)) * HOUR_MS)
        : null;

      rows.push({
        number: `BENCH-${String(index + 1).padStart(6, "0")}`,
        siteId: site.id,
        assetId: assets[index % assets.length]?.id ?? null,
        title: `Synthetic benchmark work order ${index + 1}`,
        description: "Deterministic synthetic workload for analytics performance verification.",
        type: types[index % types.length],
        status,
        priority: priorities[index % priorities.length],
        requestedAt,
        plannedStart: index % 5 === 0 ? null : new Date(requestedAt.getTime() + 2 * HOUR_MS),
        dueAt: new Date(requestedAt.getTime() + (1 + (index % 21)) * DAY_MS),
        startedAt,
        completedAt,
        downtimeMinutes: completed && index % 3 !== 0 ? 15 + (index % 480) : null,
        laborMinutes: completed ? 30 + (index % 360) : null,
      });
    }

    await db.workOrder.createMany({ data: rows });
  }

  return {
    organizationId: organization.id,
    siteId: site.id,
    timeZone: organization.timezone,
  };
}
