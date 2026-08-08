import { describe, expect, it } from "vitest";
import {
  ANALYTICS_BENCHMARK,
  benchmarkAssetId,
  benchmarkPartId,
  benchmarkWorkOrderId,
  buildAnalyticsBenchmarkFixture,
} from "./fixtures/analytics-benchmark";

describe("analytics benchmark fixture", () => {
  it("builds a deterministic realistic-volume synthetic dataset", () => {
    const fixture = buildAnalyticsBenchmarkFixture();

    expect(fixture.assets).toHaveLength(80);
    expect(fixture.parts).toHaveLength(40);
    expect(fixture.workOrders).toHaveLength(12_000);
    expect(fixture.preventiveAuditLogs.length).toBeGreaterThan(1_500);
    expect(fixture.consumptions.length).toBeGreaterThan(1_000);

    expect(fixture.assets[0]?.id).toBe(benchmarkAssetId(0));
    expect(fixture.parts[0]?.id).toBe(benchmarkPartId(0));
    expect(fixture.workOrders[0]?.id).toBe(benchmarkWorkOrderId(0));
    expect(fixture.workOrders.at(-1)?.number).toBe("BENCH-E9-012000");

    expect(new Set(fixture.workOrders.map((row) => row.status))).toEqual(
      new Set([
        "COMPLETED",
        "IN_PROGRESS",
        "PLANNED",
        "REQUESTED",
        "APPROVED",
        "BLOCKED",
        "CANCELLED",
      ]),
    );
    expect(new Set(fixture.workOrders.map((row) => row.type))).toEqual(
      new Set(["CORRECTIVE", "PREVENTIVE"]),
    );
    expect(fixture.consumptions.some((row) => row.unitCost === null)).toBe(true);
    expect(fixture.consumptions.some((row) => row.unitCost !== null)).toBe(true);
    expect(new Set(fixture.parts.map((row) => row.unit))).toEqual(new Set(["EA", "M"]));
  });

  it("keeps benchmark identifiers isolated from demo or production-like data", () => {
    expect(ANALYTICS_BENCHMARK.organizationId).toMatch(/^benchmark-e9-/);
    expect(ANALYTICS_BENCHMARK.organizationSlug).toMatch(/^benchmark-e9-/);
    expect(ANALYTICS_BENCHMARK.siteId).toMatch(/^benchmark-e9-/);
    expect(benchmarkAssetId(7)).toBe("benchmark-e9-asset-007");
    expect(benchmarkPartId(7)).toBe("benchmark-e9-part-007");
    expect(benchmarkWorkOrderId(7)).toBe("benchmark-e9-wo-00007");
  });
});
