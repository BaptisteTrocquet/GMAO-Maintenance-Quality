import { performance } from "node:perf_hooks";
import { db } from "../lib/db";
import { buildBacklogDashboard } from "../lib/analytics/backlog";
import { buildDowntimeDashboard } from "../lib/analytics/downtime";
import { buildFailurePareto } from "../lib/analytics/failure-pareto";
import { buildLaborUtilization } from "../lib/analytics/labor-utilization";
import { buildPartsCostDashboard } from "../lib/analytics/parts-cost";
import { buildPmCompliance } from "../lib/analytics/pm-compliance";
import { buildReliabilityDashboard } from "../lib/analytics/reliability";
import { localDateStartUtc, shiftCalendarDate } from "../lib/analytics/date-range";
import {
  ANALYTICS_BENCHMARK,
  buildAnalyticsBenchmarkFixture,
} from "../tests/fixtures/analytics-benchmark";

const BATCH_SIZE = 1_000;
const SAMPLE_COUNT = 3;

const budgetsMs = {
  backlog: 5_000,
  pmCompliance: 5_000,
  reliability: 5_000,
  downtime: 5_000,
  failurePareto: 5_000,
  partsCost: 5_000,
  laborUtilization: 5_000,
} as const;

type BenchmarkName = keyof typeof budgetsMs;
type BenchmarkResult = {
  name: BenchmarkName;
  medianMs: number;
  samplesMs: number[];
  budgetMs: number;
};

function chunks<T>(items: T[]) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += BATCH_SIZE) {
    result.push(items.slice(index, index + BATCH_SIZE));
  }
  return result;
}

async function resetFixture() {
  await db.workOrderPartConsumption.deleteMany({
    where: { workOrderId: { startsWith: "benchmark-e9-wo-" } },
  });
  await db.auditLog.deleteMany({
    where: {
      entityType: "WorkOrder",
      entityId: { startsWith: "benchmark-e9-wo-" },
    },
  });
  await db.organization.deleteMany({
    where: {
      OR: [
        { id: ANALYTICS_BENCHMARK.organizationId },
        { slug: ANALYTICS_BENCHMARK.organizationSlug },
      ],
    },
  });
}

async function seedFixture() {
  const fixture = buildAnalyticsBenchmarkFixture();

  await resetFixture();
  await db.organization.create({
    data: {
      id: ANALYTICS_BENCHMARK.organizationId,
      slug: ANALYTICS_BENCHMARK.organizationSlug,
      name: "Synthetic Analytics Benchmark",
      timezone: ANALYTICS_BENCHMARK.timezone,
      locale: "en",
    },
  });
  await db.site.create({
    data: {
      id: ANALYTICS_BENCHMARK.siteId,
      organizationId: ANALYTICS_BENCHMARK.organizationId,
      code: ANALYTICS_BENCHMARK.siteCode,
      name: "Synthetic Benchmark Site",
      description: "Disposable deterministic fixture for analytics performance checks.",
    },
  });

  await db.asset.createMany({ data: fixture.assets });
  await db.part.createMany({ data: fixture.parts });
  for (const batch of chunks(fixture.workOrders)) {
    await db.workOrder.createMany({ data: batch });
  }
  for (const batch of chunks(fixture.preventiveAuditLogs)) {
    await db.auditLog.createMany({ data: batch });
  }
  for (const batch of chunks(fixture.consumptions)) {
    await db.workOrderPartConsumption.createMany({ data: batch });
  }

  await db.$executeRawUnsafe('ANALYZE "WorkOrder"');
  await db.$executeRawUnsafe('ANALYZE "WorkOrderPartConsumption"');
  await db.$executeRawUnsafe('ANALYZE "AuditLog"');
  await db.$executeRawUnsafe('ANALYZE "Asset"');
  await db.$executeRawUnsafe('ANALYZE "Part"');
}

function median(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? Number.POSITIVE_INFINITY;
}

async function measure(
  name: BenchmarkName,
  operation: () => Promise<unknown>,
): Promise<BenchmarkResult> {
  await operation();

  const samplesMs: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const startedAt = performance.now();
    await operation();
    samplesMs.push(Number((performance.now() - startedAt).toFixed(1)));
  }
  const medianMs = Number(median(samplesMs).toFixed(1));
  const budgetMs = budgetsMs[name];
  if (medianMs > budgetMs) {
    throw new Error(
      `${name} median ${medianMs}ms exceeded ${budgetMs}ms budget on ` +
        `${ANALYTICS_BENCHMARK.workOrderCount} synthetic work orders`,
    );
  }
  return { name, medianMs, samplesMs, budgetMs };
}

async function main() {
  const fixtureStartedAt = performance.now();
  await seedFixture();
  const fixtureMs = Number((performance.now() - fixtureStartedAt).toFixed(1));

  try {
    const fromDate = localDateStartUtc(
      ANALYTICS_BENCHMARK.from,
      ANALYTICS_BENCHMARK.timezone,
    );
    const toDate = localDateStartUtc(
      shiftCalendarDate(ANALYTICS_BENCHMARK.to, 1),
      ANALYTICS_BENCHMARK.timezone,
    );
    const common = {
      organizationId: ANALYTICS_BENCHMARK.organizationId,
      siteId: ANALYTICS_BENCHMARK.siteId,
    };
    const localRange = {
      timeZone: ANALYTICS_BENCHMARK.timezone,
      from: ANALYTICS_BENCHMARK.from,
      to: ANALYTICS_BENCHMARK.to,
      now: ANALYTICS_BENCHMARK.now,
    };

    const backlogSample = await buildBacklogDashboard({ ...common, ...localRange });
    const pmSample = await buildPmCompliance({
      ...common,
      from: fromDate,
      to: toDate,
      now: ANALYTICS_BENCHMARK.now,
    });
    const reliabilitySample = await buildReliabilityDashboard({ ...common, ...localRange });
    const downtimeSample = await buildDowntimeDashboard({ ...common, ...localRange });
    const paretoSample = await buildFailurePareto({ ...common, ...localRange });
    const partsCostSample = await buildPartsCostDashboard({ ...common, ...localRange });
    const laborSample = await buildLaborUtilization({ ...common, ...localRange });

    if (backlogSample.totalOpen <= 0) throw new Error("Benchmark fixture produced no open backlog");
    if (pmSample.due <= 0) throw new Error("Benchmark fixture produced no scheduled PM occurrences");
    if (reliabilitySample.mttr.sampleCount <= 0) throw new Error("Benchmark fixture produced no MTTR samples");
    if (reliabilitySample.mtbf.sampleCount <= 0) throw new Error("Benchmark fixture produced no MTBF intervals");
    if (downtimeSample.eventCount <= 0) throw new Error("Benchmark fixture produced no downtime events");
    if (paretoSample.totalEventCount <= 0) throw new Error("Benchmark fixture produced no corrective Pareto events");
    if (partsCostSample.lineCount <= 0) throw new Error("Benchmark fixture produced no parts-consumption lines");
    if (partsCostSample.unpricedLineCount <= 0) throw new Error("Benchmark fixture must exercise unpriced cost coverage");
    if (laborSample.recordedWorkOrders <= 0) throw new Error("Benchmark fixture produced no recorded labor samples");

    const results = await Promise.all([
      measure("backlog", () => buildBacklogDashboard({ ...common, ...localRange })),
      measure("pmCompliance", () =>
        buildPmCompliance({
          ...common,
          from: fromDate,
          to: toDate,
          now: ANALYTICS_BENCHMARK.now,
        }),
      ),
      measure("reliability", () => buildReliabilityDashboard({ ...common, ...localRange })),
      measure("downtime", () => buildDowntimeDashboard({ ...common, ...localRange })),
      measure("failurePareto", () => buildFailurePareto({ ...common, ...localRange })),
      measure("partsCost", () => buildPartsCostDashboard({ ...common, ...localRange })),
      measure("laborUtilization", () => buildLaborUtilization({ ...common, ...localRange })),
    ]);

    const totalMedianMs = Number(
      results.reduce((sum, result) => sum + result.medianMs, 0).toFixed(1),
    );
    if (totalMedianMs > 20_000) {
      throw new Error(`Analytics median suite exceeded 20000ms budget: ${totalMedianMs}ms`);
    }

    console.log(
      JSON.stringify(
        {
          fixture: {
            workOrders: ANALYTICS_BENCHMARK.workOrderCount,
            assets: ANALYTICS_BENCHMARK.assetCount,
            parts: ANALYTICS_BENCHMARK.partCount,
            seedMs: fixtureMs,
          },
          results,
          totalMedianMs,
          samples: {
            openBacklog: backlogSample.totalOpen,
            scheduledPmDue: pmSample.due,
            mttr: reliabilitySample.mttr.sampleCount,
            mtbf: reliabilitySample.mtbf.sampleCount,
            downtime: downtimeSample.eventCount,
            failurePareto: paretoSample.totalEventCount,
            partsConsumptionLines: partsCostSample.lineCount,
            unpricedPartsLines: partsCostSample.unpricedLineCount,
            recordedLaborWorkOrders: laborSample.recordedWorkOrders,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await resetFixture();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
