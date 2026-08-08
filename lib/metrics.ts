type ReadinessResult = "success" | "failure";

type MemoryUsage = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
};

type MetricsRuntime = {
  nowMs: () => number;
  memoryUsage: () => MemoryUsage;
};

const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

function finiteNonNegative(value: number) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function metricNumber(value: number) {
  const safe = finiteNonNegative(value);
  return Number.isInteger(safe) ? String(safe) : safe.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

export type ApplicationMetrics = {
  recordReadinessCheck: (result: ReadinessResult) => void;
  recordMetricsScrape: () => void;
  renderPrometheus: (input: { databaseReady: boolean }) => string;
};

export function createApplicationMetrics(input?: {
  startedAtMs?: number;
  runtime?: Partial<MetricsRuntime>;
}): ApplicationMetrics {
  const runtime: MetricsRuntime = {
    nowMs: input?.runtime?.nowMs ?? (() => Date.now()),
    memoryUsage:
      input?.runtime?.memoryUsage ??
      (() => {
        const usage = process.memoryUsage();
        return {
          rss: usage.rss,
          heapTotal: usage.heapTotal,
          heapUsed: usage.heapUsed,
        };
      }),
  };

  const startedAtMs = input?.startedAtMs ?? runtime.nowMs();
  let readinessSuccess = 0;
  let readinessFailure = 0;
  let metricsScrapes = 0;

  return {
    recordReadinessCheck(result) {
      if (result === "success") readinessSuccess += 1;
      else readinessFailure += 1;
    },

    recordMetricsScrape() {
      metricsScrapes += 1;
    },

    renderPrometheus({ databaseReady }) {
      const nowMs = runtime.nowMs();
      const memory = runtime.memoryUsage();
      const uptimeSeconds = Math.max(0, nowMs - startedAtMs) / 1_000;
      const databaseGauge = databaseReady ? 1 : 0;

      return [
        "# HELP opengmao_process_start_time_seconds Unix timestamp when this application process metrics registry started.",
        "# TYPE opengmao_process_start_time_seconds gauge",
        `opengmao_process_start_time_seconds ${metricNumber(startedAtMs / 1_000)}`,
        "# HELP opengmao_process_uptime_seconds Application process uptime in seconds.",
        "# TYPE opengmao_process_uptime_seconds gauge",
        `opengmao_process_uptime_seconds ${metricNumber(uptimeSeconds)}`,
        "# HELP opengmao_process_resident_memory_bytes Resident set size of the Node.js process.",
        "# TYPE opengmao_process_resident_memory_bytes gauge",
        `opengmao_process_resident_memory_bytes ${metricNumber(memory.rss)}`,
        "# HELP opengmao_process_heap_total_bytes Total V8 heap size allocated by the Node.js process.",
        "# TYPE opengmao_process_heap_total_bytes gauge",
        `opengmao_process_heap_total_bytes ${metricNumber(memory.heapTotal)}`,
        "# HELP opengmao_process_heap_used_bytes V8 heap bytes currently used by the Node.js process.",
        "# TYPE opengmao_process_heap_used_bytes gauge",
        `opengmao_process_heap_used_bytes ${metricNumber(memory.heapUsed)}`,
        "# HELP opengmao_database_ready Whether PostgreSQL was reachable during this metrics scrape.",
        "# TYPE opengmao_database_ready gauge",
        `opengmao_database_ready ${databaseGauge}`,
        "# HELP opengmao_readiness_checks_total Number of readiness checks by result since process start.",
        "# TYPE opengmao_readiness_checks_total counter",
        `opengmao_readiness_checks_total{result=\"success\"} ${readinessSuccess}`,
        `opengmao_readiness_checks_total{result=\"failure\"} ${readinessFailure}`,
        "# HELP opengmao_metrics_scrapes_total Number of metrics endpoint scrapes handled since process start.",
        "# TYPE opengmao_metrics_scrapes_total counter",
        `opengmao_metrics_scrapes_total ${metricsScrapes}`,
        "",
      ].join("\n");
    },
  };
}

export const applicationMetrics = createApplicationMetrics();
export const prometheusContentType = PROMETHEUS_CONTENT_TYPE;
