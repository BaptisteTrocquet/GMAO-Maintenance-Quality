import { PrismaClient, type Priority, type WorkOrderStatus, type WorkOrderType } from "@prisma/client";
import { performance } from "node:perf_hooks";
import { buildBacklogDashboard } from "../lib/analytics/backlog";
import { buildDowntimeDashboard } from "../lib/analytics/downtime";
import { buildReliabilityDashboard } from "../lib/analytics/reliability";

const prisma = new PrismaClient();

const BENCHMARK_SLUG = "synthetic-analytics-benchmark";
const WORK_ORDER_COUNT = 10_000;
const ASSET_COUNT = 20;
const CHUNK_SIZE = 1_000;
const QUERY_BUDGET_MS = 5_000;
const TOTAL_QUERY_BUDGET_MS = 10_000;
const NOW = new Date("2026-08-08T10:00:00.000Z");

function dayBefore(days: number) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

async function timed<T>(label: string, work: () => Promise<T>) {
  const start = performance.now();
  const result = await work();
  const durationMs = performance.now() - start;
  if (durationMs > QUERY_BUDGET_MS) {
    throw new Error(`${label} exceeded ${QUERY_BUDGET_MS}ms benchmark budget: ${durationMs.toFixed(1)}ms`);
  }
  return { result, durationMs };
}

async function createFixture() {
  await prisma.organization.deleteMany({ where: { slug: BENCHMARK_SLUG } });

  const organization = await prisma.organization.create({
    data: {
      slug: BENCHMARK_SLUG,
      name: "Synthetic Analytics Benchmark",
      timezone: "Europe/Paris",
      locale: "en",
    },
  });
  const site = await prisma.site.create({
    data: {
      organizationId: organization.id,
      code: "BENCH",
      name: "Synthetic Benchmark Site",
    },
  });
  const assets = await Promise.all(
    Array.from({ length: ASSET_COUNT }, (_, index) =>
      prisma.asset.create({
        data: {
          siteId: site.id,
          code: `BENCH-${String(index + 1).padStart(2, "0")}`,
          name: `Synthetic Asset ${index + 1}`,
          status: "ACTIVE",
          criticality: index % 5 === 0 ? "CRITICAL" : "MEDIUM",
        },
      }),
    ),
  );

  const statuses: WorkOrderStatus[] = [
    "REQUESTED",
    "APPROVED",
    "PLANNED",
    "IN_PROGRESS",
    "BLOCKED",
    "COMPLETED",
  ];
  const priorities: Priority[] = ["LOW", "NORMAL", "HIGH", "URGENT"];

  for (let offset = 0; offset < WORK_ORDER_COUNT; offset += CHUNK_SIZE) {
    const rows = Array.from(
      { length: Math.min(CHUNK_SIZE, WORK_ORDER_COUNT - offset) },
      (_, localIndex) => {
        const index = offset + localIndex;
        const asset = assets[index % assets.length];
        const requestedAt = dayBefore(index % 365);
        const status = statuses[index % statuses.length];
        const corrective = index % 3 !== 0;
        const type: WorkOrderType = corrective ? "CORRECTIVE" : "PREVENTIVE";
        const completed = status === "COMPLETED";
        const startedAt = completed && corrective
          ? new Date(requestedAt.getTime() + 60 * 60 * 1000)
          : status === "IN_PROGRESS"
            ? new Date(requestedAt.getTime() + 60 * 60 * 1000)
            : null;
        const completedAt = completed
          ? new Date(requestedAt.getTime() + 4 * 60 * 60 * 1000)
          : null;
        const dueAt = new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1000);

        return {
          number: `BENCH-WO-${String(index + 1).padStart(6, "0")}`,
          siteId: site.id,
          assetId: asset.id,
          title: `Synthetic benchmark work order ${index + 1}`,
          type,
          status,
          priority: priorities[index % priorities.length],
          requestedAt,
          plannedStart: status === "REQUESTED" || status === "APPROVED" ? null : requestedAt,
          dueAt,
          startedAt,
          completedAt,
          downtimeMinutes: completed ? (index % 8) * 15 : null,
          laborMinutes: completed ? 60 + (index % 6) * 15 : null,
        };
      },
    );
    await prisma.workOrder.createMany({ data: rows });
  }

  await prisma.$executeRaw`ANALYZE "WorkOrder"`;
  return { organizationId: organization.id, siteId: site.id };
}

async function main() {
  const fixtureStarted = performance.now();
  const fixture = await createFixture();
  const fixtureMs = performance.now() - fixtureStarted;

  try {
    const backlog = await timed("Backlog dashboard", () =>
      buildBacklogDashboard({
        ...fixture,
        timeZone: "Europe/Paris",
        now: NOW,
      }),
    );
    const reliability = await timed("Reliability dashboard", () =>
      buildReliabilityDashboard({
        ...fixture,
        timeZone: "Europe/Paris",
        from: "2025-08-09",
        to: "2026-08-08",
        now: NOW,
      }),
    );
    const downtime = await timed("Downtime dashboard", () =>
      buildDowntimeDashboard({
        ...fixture,
        timeZone: "Europe/Paris",
        from: "2025-08-09",
        to: "2026-08-08",
        now: NOW,
      }),
    );

    if (backlog.result.totalOpen <= 0) throw new Error("Backlog benchmark fixture produced no open work");
    if (reliability.result.mttr.sampleCount <= 0) throw new Error("Reliability benchmark fixture produced no MTTR samples");
    if (reliability.result.mtbf.sampleCount <= 0) throw new Error("Reliability benchmark fixture produced no MTBF intervals");
    if (downtime.result.eventCount <= 0) throw new Error("Downtime benchmark fixture produced no downtime events");

    const queryMs = backlog.durationMs + reliability.durationMs + downtime.durationMs;
    if (queryMs > TOTAL_QUERY_BUDGET_MS) {
      throw new Error(`Analytics query suite exceeded ${TOTAL_QUERY_BUDGET_MS}ms budget: ${queryMs.toFixed(1)}ms`);
    }

    console.log(
      JSON.stringify(
        {
          fixture: { workOrders: WORK_ORDER_COUNT, assets: ASSET_COUNT, createMs: Number(fixtureMs.toFixed(1)) },
          queriesMs: {
            backlog: Number(backlog.durationMs.toFixed(1)),
            reliability: Number(reliability.durationMs.toFixed(1)),
            downtime: Number(downtime.durationMs.toFixed(1)),
            total: Number(queryMs.toFixed(1)),
          },
          samples: {
            openBacklog: backlog.result.totalOpen,
            mttr: reliability.result.mttr.sampleCount,
            mtbf: reliability.result.mtbf.sampleCount,
            downtime: downtime.result.eventCount,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.organization.deleteMany({ where: { slug: BENCHMARK_SLUG } });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
