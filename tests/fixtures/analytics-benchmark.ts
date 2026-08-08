import type { Prisma } from "@prisma/client";

export const ANALYTICS_BENCHMARK = {
  organizationId: "benchmark-e9-org",
  organizationSlug: "benchmark-e9-analytics",
  siteId: "benchmark-e9-site",
  siteCode: "BENCH",
  timezone: "Europe/Paris",
  assetCount: 80,
  partCount: 40,
  workOrderCount: 12_000,
  now: new Date("2026-08-01T12:00:00.000Z"),
  from: "2025-08-01",
  to: "2026-08-01",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function padded(value: number, width = 5) {
  return String(value).padStart(width, "0");
}

export function benchmarkAssetId(index: number) {
  return `benchmark-e9-asset-${padded(index, 3)}`;
}

export function benchmarkPartId(index: number) {
  return `benchmark-e9-part-${padded(index, 3)}`;
}

export function benchmarkWorkOrderId(index: number) {
  return `benchmark-e9-wo-${padded(index, 5)}`;
}

export function buildAnalyticsBenchmarkFixture() {
  const assets: Prisma.AssetCreateManyInput[] = Array.from(
    { length: ANALYTICS_BENCHMARK.assetCount },
    (_, index) => ({
      id: benchmarkAssetId(index),
      siteId: ANALYTICS_BENCHMARK.siteId,
      code: `BENCH-A-${padded(index + 1, 3)}`,
      name: `Synthetic benchmark asset ${index + 1}`,
      category: index % 4 === 0 ? "PUMP" : index % 4 === 1 ? "MOTOR" : "PROCESS",
      status: index % 17 === 0 ? "OUT_OF_SERVICE" : "ACTIVE",
      criticality: index % 9 === 0 ? "CRITICAL" : index % 3 === 0 ? "HIGH" : "MEDIUM",
      commissionedAt: new Date("2022-01-01T00:00:00.000Z"),
    }),
  );

  const parts: Prisma.PartCreateManyInput[] = Array.from(
    { length: ANALYTICS_BENCHMARK.partCount },
    (_, index) => ({
      id: benchmarkPartId(index),
      organizationId: ANALYTICS_BENCHMARK.organizationId,
      sku: `BENCH-SP-${padded(index + 1, 3)}`,
      name: `Synthetic benchmark spare ${index + 1}`,
      unit: index % 5 === 0 ? "M" : "EA",
      quantityOnHand: 100 + index,
      reorderPoint: 10,
      unitCost: String(5 + (index % 25) * 1.75),
      active: true,
    }),
  );

  const statuses = [
    "COMPLETED",
    "COMPLETED",
    "IN_PROGRESS",
    "PLANNED",
    "REQUESTED",
    "APPROVED",
    "BLOCKED",
    "CANCELLED",
  ] as const;
  const priorities = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

  const workOrders: Prisma.WorkOrderCreateManyInput[] = [];
  const preventiveAuditLogs: Prisma.AuditLogCreateManyInput[] = [];
  const consumptions: Prisma.WorkOrderPartConsumptionCreateManyInput[] = [];

  for (let index = 0; index < ANALYTICS_BENCHMARK.workOrderCount; index += 1) {
    const id = benchmarkWorkOrderId(index);
    const status = statuses[index % statuses.length];
    const type = index % 5 === 0 ? "PREVENTIVE" : "CORRECTIVE";
    const requestedAt = new Date(
      ANALYTICS_BENCHMARK.now.getTime() - (index % 700) * DAY_MS - (index % 24) * HOUR_MS,
    );
    const dueAt = new Date(requestedAt.getTime() + ((index % 10) + 1) * DAY_MS);
    const startedAt =
      status === "COMPLETED" || status === "IN_PROGRESS"
        ? new Date(requestedAt.getTime() + ((index % 4) + 1) * HOUR_MS)
        : null;
    const completedAt =
      status === "COMPLETED" && startedAt
        ? new Date(startedAt.getTime() + ((index % 16) + 1) * HOUR_MS)
        : null;

    workOrders.push({
      id,
      number: `BENCH-E9-${padded(index + 1, 6)}`,
      siteId: ANALYTICS_BENCHMARK.siteId,
      assetId: benchmarkAssetId(index % ANALYTICS_BENCHMARK.assetCount),
      title: `Synthetic benchmark work order ${index + 1}`,
      description: "Deterministic synthetic analytics benchmark record.",
      type,
      status,
      priority: priorities[index % priorities.length],
      requestedAt,
      plannedStart: index % 6 === 0 ? null : new Date(requestedAt.getTime() + DAY_MS),
      dueAt,
      startedAt,
      completedAt,
      downtimeMinutes: status === "COMPLETED" ? (index % 240) + 1 : null,
      laborMinutes: status === "COMPLETED" ? (index % 360) + 15 : null,
      completionNote: status === "COMPLETED" ? "Synthetic benchmark completion." : null,
      createdAt: requestedAt,
      updatedAt: completedAt ?? startedAt ?? requestedAt,
    });

    if (type === "PREVENTIVE" && status !== "CANCELLED") {
      preventiveAuditLogs.push({
        id: `benchmark-e9-pm-audit-${padded(index, 5)}`,
        entityType: "WorkOrder",
        entityId: id,
        action: "PREVENTIVE_GENERATED",
        afterJson: JSON.stringify({ synthetic: true }),
        createdAt: requestedAt,
      });
    }

    if (status === "COMPLETED" && index % 2 === 0) {
      consumptions.push({
        id: `benchmark-e9-consumption-${padded(index, 5)}`,
        workOrderId: id,
        partId: benchmarkPartId(index % ANALYTICS_BENCHMARK.partCount),
        quantity: (index % 5) + 1,
        unitCost: index % 9 === 0 ? null : String(5 + (index % 25) * 1.75),
        idempotencyKey: `benchmark-e9-consume-${padded(index, 5)}`,
        createdAt: completedAt ?? requestedAt,
      });
    }
  }

  return { assets, parts, workOrders, preventiveAuditLogs, consumptions };
}
