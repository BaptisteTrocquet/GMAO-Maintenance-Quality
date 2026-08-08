import { describe, expect, it } from "vitest";
import {
  ANALYTICS_BENCHMARK,
  benchmarkAssetId,
  benchmarkPartId,
  benchmarkWorkOrderId,
  buildAnalyticsBenchmarkFixture,
} from "@/tests/fixtures/analytics-benchmark";

describe("analytics benchmark fixture", () => {
  it("builds deterministic realistic-volume analytics data", () => {
    const fixture = buildAnalyticsBenchmarkFixture();

    expect(fixture.assets).toHaveLength(ANALYTICS_BENCHMARK.assetCount);
    expect(fixture.parts).toHaveLength(ANALYTICS_BENCHMARK.partCount);
    expect(fixture.workOrders).toHaveLength(ANALYTICS_BENCHMARK.workOrderCount);
    expect(fixture.assets[0]?.id).toBe(benchmarkAssetId(0));
    expect(fixture.parts[0]?.id).toBe(benchmarkPartId(0));
    expect(fixture.workOrders[0]?.id).toBe(benchmarkWorkOrderId(0));
    expect(new Set(fixture.workOrders.map((workOrder) => workOrder.id)).size).toBe(
      ANALYTICS_BENCHMARK.workOrderCount,
    );
  });

  it("covers open/completed/cancelled, corrective/preventive and incomplete-cost cases", () => {
    const fixture = buildAnalyticsBenchmarkFixture();
    const statuses = new Set(fixture.workOrders.map((workOrder) => workOrder.status));
    const types = new Set(fixture.workOrders.map((workOrder) => workOrder.type));

    expect(statuses).toEqual(
      expect.objectContaining({})
    );
    expect(statuses.has("COMPLETED")).toBe(true);
    expect(statuses.has("IN_PROGRESS")).toBe(true);
    expect(statuses.has("CANCELLED")).toBe(true);
    expect(types.has("CORRECTIVE")).toBe(true);
    expect(types.has("PREVENTIVE")).toBe(true);
    expect(fixture.preventiveAuditLogs.length).toBeGreaterThan(0);
    expect(fixture.consumptions.some((line) => line.unitCost === null)).toBe(true);
    expect(fixture.consumptions.some((line) => line.unitCost !== null)).toBe(true);
  });

  it("keeps scheduled-PM provenance aligned with synthetic preventive work orders", () => {
    const fixture = buildAnalyticsBenchmarkFixture();
    const workById = new Map(fixture.workOrders.map((workOrder) => [workOrder.id, workOrder]));

    for (const audit of fixture.preventiveAuditLogs) {
      const workOrder = workById.get(audit.entityId);
      expect(audit.action).toBe("PREVENTIVE_GENERATED");
      expect(workOrder?.type).toBe("PREVENTIVE");
      expect(workOrder?.status).not.toBe("CANCELLED");
    }
  });
});
