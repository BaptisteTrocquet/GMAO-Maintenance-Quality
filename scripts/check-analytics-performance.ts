import { performance } from "node:perf_hooks";
import { db } from "../lib/db";
import { buildBacklogDashboard } from "../lib/analytics/backlog";
import { buildDowntimeDashboard } from "../lib/analytics/downtime";
import { buildFailurePareto } from "../lib/analytics/failure-pareto";
import { buildPartsCostDashboard } from "../lib/analytics/parts-cost";
import { buildReliabilityDashboard } from "../lib/analytics/reliability";

const ORGANIZATION_SLUG = "synthetic-analytics-benchmark";
const ORGANIZATION_ID = "bench-org";
const SITE_ID = "bench-site";
const ASSET_COUNT = 200;
const WORK_ORDER_COUNT = 20_000;
const PART_COUNT = 50;
const CONSUMPTION_COUNT = 10_000;
const QUERY_BUDGET_MS = 4_000;
const FROM = "2025-08-01";
const TO = "2026-07-31";
const NOW = new Date("2026-08-08T12:00:00.000Z");

async function removeFixture() {
  await db.organization.deleteMany({ where: { slug: ORGANIZATION_SLUG } });
}

async function seedFixture() {
  await removeFixture();
  await db.organization.create({
    data: {
      id: ORGANIZATION_ID,
      slug: ORGANIZATION_SLUG,
      name: "Synthetic Analytics Benchmark",
      timezone: "UTC",
      locale: "en",
    },
  });
  await db.site.create({
    data: {
      id: SITE_ID,
      organizationId: ORGANIZATION_ID,
      code: "BENCH",
      name: "Synthetic benchmark site",
    },
  });

  await db.$executeRaw`
    INSERT INTO "Asset" (
      id, "siteId", code, name, status, criticality, "createdAt", "updatedAt"
    )
    SELECT
      'bench-asset-' || gs::text,
      ${SITE_ID},
      'EQ-' || LPAD(gs::text, 4, '0'),
      'Synthetic benchmark asset ' || gs::text,
      'ACTIVE'::"AssetStatus",
      CASE WHEN gs % 20 = 0 THEN 'CRITICAL'::"Criticality" ELSE 'MEDIUM'::"Criticality" END,
      ${new Date("2025-01-01T00:00:00.000Z")},
      ${new Date("2025-01-01T00:00:00.000Z")}
    FROM generate_series(1, ${ASSET_COUNT}) AS gs
  `;

  await db.$executeRaw`
    INSERT INTO "Part" (
      id, "organizationId", sku, name, unit, "quantityOnHand", "reorderPoint", active, "createdAt", "updatedAt"
    )
    SELECT
      'bench-part-' || gs::text,
      ${ORGANIZATION_ID},
      'SP-' || LPAD(gs::text, 4, '0'),
      'Synthetic benchmark part ' || gs::text,
      'EA',
      100,
      10,
      true,
      ${new Date("2025-01-01T00:00:00.000Z")},
      ${new Date("2025-01-01T00:00:00.000Z")}
    FROM generate_series(1, ${PART_COUNT}) AS gs
  `;

  const fixtureStart = new Date("2025-08-01T00:00:00.000Z");
  await db.$executeRaw`
    INSERT INTO "WorkOrder" (
      id, number, "siteId", "assetId", title, type, status, priority,
      "requestedAt", "plannedStart", "dueAt", "startedAt", "completedAt",
      "downtimeMinutes", "laborMinutes", "createdAt", "updatedAt"
    )
    SELECT
      'bench-wo-' || gs::text,
      'BENCH-' || LPAD(gs::text, 6, '0'),
      ${SITE_ID},
      'bench-asset-' || (((gs - 1) % ${ASSET_COUNT}) + 1)::text,
      'Synthetic benchmark work order ' || gs::text,
      CASE WHEN gs % 4 = 0 THEN 'PREVENTIVE'::"WorkOrderType" ELSE 'CORRECTIVE'::"WorkOrderType" END,
      CASE
        WHEN gs % 17 = 0 THEN 'CANCELLED'::"WorkOrderStatus"
        WHEN gs % 5 = 0 THEN 'IN_PROGRESS'::"WorkOrderStatus"
        ELSE 'COMPLETED'::"WorkOrderStatus"
      END,
      CASE WHEN gs % 29 = 0 THEN 'URGENT'::"Priority" ELSE 'NORMAL'::"Priority" END,
      ${fixtureStart} + ((gs % 365) * INTERVAL '1 day') + ((gs % 24) * INTERVAL '1 hour'),
      ${fixtureStart} + ((gs % 365) * INTERVAL '1 day') + INTERVAL '1 hour',
      ${fixtureStart} + ((gs % 365) * INTERVAL '1 day') + INTERVAL '3 day',
      CASE WHEN gs % 17 = 0 THEN NULL ELSE ${fixtureStart} + ((gs % 365) * INTERVAL '1 day') + INTERVAL '2 hour' END,
      CASE
        WHEN gs % 17 = 0 OR gs % 5 = 0 THEN NULL
        ELSE ${fixtureStart} + ((gs % 365) * INTERVAL '1 day') + ((3 + (gs % 10)) * INTERVAL '1 hour')
      END,
      CASE WHEN gs % 9 = 0 THEN NULL ELSE (gs % 180)::int END,
      CASE WHEN gs % 13 = 0 THEN NULL ELSE (15 + (gs % 240))::int END,
      ${fixtureStart} + ((gs % 365) * INTERVAL '1 day'),
      ${fixtureStart} + ((gs % 365) * INTERVAL '1 day')
    FROM generate_series(1, ${WORK_ORDER_COUNT}) AS gs
  `;

  await db.$executeRaw`
    INSERT INTO "WorkOrderPartConsumption" (
      id, "workOrderId", "partId", quantity, "unitCost", "idempotencyKey", "createdAt"
    )
    SELECT
      'bench-consumption-' || gs::text,
      'bench-wo-' || gs::text,
      'bench-part-' || (((gs - 1) % ${PART_COUNT}) + 1)::text,
      (1 + (gs % 5))::double precision,
      CASE WHEN gs % 20 = 0 THEN NULL ELSE (5 + ((gs - 1) % ${PART_COUNT}))::numeric END,
      'bench-consumption-key-' || gs::text,
      ${fixtureStart} + ((gs % 365) * INTERVAL '1 day') + INTERVAL '4 hour'
    FROM generate_series(1, ${CONSUMPTION_COUNT}) AS gs
  `;

  await db.$executeRawUnsafe('ANALYZE "WorkOrder"');
  await db.$executeRawUnsafe('ANALYZE "WorkOrderPartConsumption"');
  await db.$executeRawUnsafe('ANALYZE "Asset"');

  const [workOrders, assets, consumptions] = await Promise.all([
    db.workOrder.count({ where: { siteId: SITE_ID } }),
    db.asset.count({ where: { siteId: SITE_ID } }),
    db.workOrderPartConsumption.count({ where: { workOrder: { siteId: SITE_ID } } }),
  ]);
  if (workOrders !== WORK_ORDER_COUNT || assets !== ASSET_COUNT || consumptions !== CONSUMPTION_COUNT) {
    throw new Error(
      `Synthetic analytics fixture mismatch: workOrders=${workOrders}, assets=${assets}, consumptions=${consumptions}`,
    );
  }
}

async function timed<T>(name: string, run: () => Promise<T>, validate: (value: T) => void) {
  const started = performance.now();
  const value = await run();
  const elapsedMs = performance.now() - started;
  validate(value);
  if (elapsedMs > QUERY_BUDGET_MS) {
    throw new Error(
      `${name} exceeded the ${QUERY_BUDGET_MS}ms CI budget on ${WORK_ORDER_COUNT.toLocaleString()} synthetic work orders: ${elapsedMs.toFixed(1)}ms`,
    );
  }
  console.log(`${name}: ${elapsedMs.toFixed(1)}ms`);
}

async function runBenchmarks() {
  const common = {
    organizationId: ORGANIZATION_ID,
    siteId: SITE_ID,
    timeZone: "UTC",
    from: FROM,
    to: TO,
    now: NOW,
  };

  await timed(
    "Backlog dashboard",
    () => buildBacklogDashboard({ ...common }),
    (result) => {
      if (result.totalOpen <= 0 || result.oldest.length === 0) {
        throw new Error("Backlog benchmark returned no representative open-work data");
      }
    },
  );
  await timed(
    "Downtime trends",
    () => buildDowntimeDashboard(common),
    (result) => {
      if (result.eventCount <= 0 || result.trend.length === 0) {
        throw new Error("Downtime benchmark returned no representative data");
      }
    },
  );
  await timed(
    "Reliability MTTR/MTBF",
    () => buildReliabilityDashboard(common),
    (result) => {
      if (result.mttr.sampleCount <= 0 || result.mtbf.sampleCount <= 0) {
        throw new Error("Reliability benchmark returned insufficient synthetic samples");
      }
    },
  );
  await timed(
    "Failure Pareto",
    () => buildFailurePareto(common),
    (result) => {
      if (result.totalEventCount <= 0 || result.points.length === 0) {
        throw new Error("Failure Pareto benchmark returned no representative data");
      }
    },
  );
  await timed(
    "Parts cost",
    () => buildPartsCostDashboard(common),
    (result) => {
      if (result.lineCount <= 0 || result.topParts.length === 0) {
        throw new Error("Parts-cost benchmark returned no representative data");
      }
      if (!result.incompleteCost) {
        throw new Error("Parts-cost benchmark must exercise unpriced-line handling");
      }
    },
  );
}

async function main() {
  const started = performance.now();
  try {
    await seedFixture();
    await runBenchmarks();
    console.log(
      `Analytics benchmark passed with ${WORK_ORDER_COUNT.toLocaleString()} work orders, ${ASSET_COUNT} assets and ${CONSUMPTION_COUNT.toLocaleString()} consumption lines in ${(performance.now() - started).toFixed(1)}ms total.`,
    );
  } finally {
    await removeFixture();
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
