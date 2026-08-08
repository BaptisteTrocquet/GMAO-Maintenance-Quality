import { performance } from "node:perf_hooks";
import { buildBacklogDashboard } from "../lib/analytics/backlog";
import { buildDowntimeDashboard } from "../lib/analytics/downtime";
import { buildFailurePareto } from "../lib/analytics/failure-pareto";
import { buildReliabilityDashboard } from "../lib/analytics/reliability";
import { db } from "../lib/db";
import {
  ANALYTICS_BENCHMARK_ASSET_COUNT,
  ANALYTICS_BENCHMARK_FROM,
  ANALYTICS_BENCHMARK_NOW,
  ANALYTICS_BENCHMARK_TO,
  ANALYTICS_BENCHMARK_WORK_ORDER_COUNT,
  clearAnalyticsBenchmarkFixture,
  createAnalyticsBenchmarkFixture,
} from "./analytics-benchmark-fixture";

const QUERY_BUDGET_MS = 5_000;
const TOTAL_QUERY_BUDGET_MS = 15_000;

async function timed<T>(label: string, work: () => Promise<T>) {
  const start = performance.now();
  const result = await work();
  const durationMs = performance.now() - start;
  if (durationMs > QUERY_BUDGET_MS) {
    throw new Error(`${label} exceeded ${QUERY_BUDGET_MS}ms benchmark budget: ${durationMs.toFixed(1)}ms`);
  }
  return { result, durationMs };
}

async function main() {
  const fixtureStarted = performance.now();
  const fixture = await createAnalyticsBenchmarkFixture();
  await db.$executeRaw`ANALYZE "WorkOrder"`;
  await db.$executeRaw`ANALYZE "Asset"`;
  const fixtureMs = performance.now() - fixtureStarted;

  try {
    const backlog = await timed("Backlog dashboard", () =>
      buildBacklogDashboard({
        ...fixture,
        now: ANALYTICS_BENCHMARK_NOW,
      }),
    );
    const reliability = await timed("Reliability dashboard", () =>
      buildReliabilityDashboard({
        ...fixture,
        from: ANALYTICS_BENCHMARK_FROM,
        to: ANALYTICS_BENCHMARK_TO,
        now: ANALYTICS_BENCHMARK_NOW,
      }),
    );
    const downtime = await timed("Downtime dashboard", () =>
      buildDowntimeDashboard({
        ...fixture,
        from: ANALYTICS_BENCHMARK_FROM,
        to: ANALYTICS_BENCHMARK_TO,
        now: ANALYTICS_BENCHMARK_NOW,
      }),
    );
    const pareto = await timed("Failure Pareto", () =>
      buildFailurePareto({
        ...fixture,
        from: ANALYTICS_BENCHMARK_FROM,
        to: ANALYTICS_BENCHMARK_TO,
        now: ANALYTICS_BENCHMARK_NOW,
      }),
    );

    if (backlog.result.totalOpen <= 0) throw new Error("Backlog benchmark fixture produced no open work");
    if (reliability.result.mttr.sampleCount <= 0) throw new Error("Reliability benchmark fixture produced no MTTR samples");
    if (reliability.result.mtbf.sampleCount <= 0) throw new Error("Reliability benchmark fixture produced no MTBF intervals");
    if (downtime.result.eventCount <= 0) throw new Error("Downtime benchmark fixture produced no downtime events");
    if (pareto.result.totalEventCount <= 0) throw new Error("Failure Pareto benchmark fixture produced no corrective events");

    const queryMs =
      backlog.durationMs + reliability.durationMs + downtime.durationMs + pareto.durationMs;
    if (queryMs > TOTAL_QUERY_BUDGET_MS) {
      throw new Error(
        `Analytics query suite exceeded ${TOTAL_QUERY_BUDGET_MS}ms budget: ${queryMs.toFixed(1)}ms`,
      );
    }

    console.log(
      JSON.stringify(
        {
          fixture: {
            workOrders: ANALYTICS_BENCHMARK_WORK_ORDER_COUNT,
            assets: ANALYTICS_BENCHMARK_ASSET_COUNT,
            createMs: Number(fixtureMs.toFixed(1)),
          },
          budgetsMs: {
            perQuery: QUERY_BUDGET_MS,
            suite: TOTAL_QUERY_BUDGET_MS,
          },
          queriesMs: {
            backlog: Number(backlog.durationMs.toFixed(1)),
            reliability: Number(reliability.durationMs.toFixed(1)),
            downtime: Number(downtime.durationMs.toFixed(1)),
            failurePareto: Number(pareto.durationMs.toFixed(1)),
            total: Number(queryMs.toFixed(1)),
          },
          samples: {
            openBacklog: backlog.result.totalOpen,
            mttr: reliability.result.mttr.sampleCount,
            mtbf: reliability.result.mtbf.sampleCount,
            downtime: downtime.result.eventCount,
            failurePareto: pareto.result.totalEventCount,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await clearAnalyticsBenchmarkFixture();
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
