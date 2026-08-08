import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: mocks.queryRaw,
  },
}));

import { GET as getMetrics } from "@/app/api/metrics/route";
import { createApplicationMetrics } from "@/lib/metrics";

describe("application metrics registry", () => {
  it("renders bounded process and operational metrics in Prometheus format", () => {
    const metrics = createApplicationMetrics({
      startedAtMs: 1_000,
      runtime: {
        nowMs: () => 3_500,
        memoryUsage: () => ({
          rss: 120_000,
          heapTotal: 80_000,
          heapUsed: 42_000,
        }),
      },
    });

    metrics.recordReadinessCheck("success");
    metrics.recordReadinessCheck("success");
    metrics.recordReadinessCheck("failure");
    metrics.recordMetricsScrape();

    const output = metrics.renderPrometheus({ databaseReady: true });

    expect(output).toContain("# TYPE opengmao_process_uptime_seconds gauge");
    expect(output).toContain("opengmao_process_start_time_seconds 1");
    expect(output).toContain("opengmao_process_uptime_seconds 2.5");
    expect(output).toContain("opengmao_process_resident_memory_bytes 120000");
    expect(output).toContain("opengmao_process_heap_total_bytes 80000");
    expect(output).toContain("opengmao_process_heap_used_bytes 42000");
    expect(output).toContain("opengmao_database_ready 1");
    expect(output).toContain('opengmao_readiness_checks_total{result="success"} 2');
    expect(output).toContain('opengmao_readiness_checks_total{result="failure"} 1');
    expect(output).toContain("opengmao_metrics_scrapes_total 1");
  });

  it("clamps invalid runtime values instead of emitting invalid Prometheus numbers", () => {
    const metrics = createApplicationMetrics({
      startedAtMs: 10_000,
      runtime: {
        nowMs: () => 5_000,
        memoryUsage: () => ({ rss: Number.NaN, heapTotal: -1, heapUsed: Number.POSITIVE_INFINITY }),
      },
    });

    const output = metrics.renderPrometheus({ databaseReady: false });

    expect(output).toContain("opengmao_process_uptime_seconds 0");
    expect(output).toContain("opengmao_process_resident_memory_bytes 0");
    expect(output).toContain("opengmao_process_heap_total_bytes 0");
    expect(output).toContain("opengmao_process_heap_used_bytes 0");
    expect(output).toContain("opengmao_database_ready 0");
    expect(output).not.toMatch(/\b(?:NaN|Infinity|-Infinity)\b/);
  });
});

describe("GET /api/metrics", () => {
  beforeEach(() => {
    mocks.queryRaw.mockReset();
  });

  it("returns scrapeable Prometheus metrics when PostgreSQL is reachable", async () => {
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);

    const response = await getMetrics();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(body).toContain("opengmao_database_ready 1");
    expect(body).toContain("opengmao_process_uptime_seconds");
    expect(body).toContain("opengmao_metrics_scrapes_total");
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("stays scrapeable and exposes only a zero gauge when PostgreSQL is unavailable", async () => {
    mocks.queryRaw.mockRejectedValue(
      new Error("postgresql://operator:super-secret-password@private-db.internal:5432/opengmao"),
    );

    const response = await getMetrics();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("opengmao_database_ready 0");
    expect(body).not.toContain("super-secret-password");
    expect(body).not.toContain("private-db.internal");
    expect(body).not.toContain("operator");
  });
});
