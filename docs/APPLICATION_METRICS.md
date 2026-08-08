# Application metrics

OpenGMAO exposes a small production-safe Prometheus endpoint at:

```text
GET /api/metrics
```

The response uses Prometheus text exposition format (`text/plain; version=0.0.4`) and is never cached.

## Metrics

The initial E14 operational set is intentionally low-cardinality:

- `opengmao_process_start_time_seconds`
- `opengmao_process_uptime_seconds`
- `opengmao_process_resident_memory_bytes`
- `opengmao_process_heap_total_bytes`
- `opengmao_process_heap_used_bytes`
- `opengmao_database_ready`
- `opengmao_readiness_checks_total{result="success|failure"}`
- `opengmao_metrics_scrapes_total`

`opengmao_database_ready` is evaluated during each scrape with a minimal PostgreSQL `SELECT 1`.

A database outage does **not** make `/api/metrics` return an HTTP error. The endpoint stays scrapeable and emits:

```text
opengmao_database_ready 0
```

Use `/api/ready` for traffic admission decisions. The metrics endpoint is for observation, not orchestration readiness.

## Security and cardinality

The metrics surface deliberately does not expose:

- organization/site identifiers;
- user/member identifiers;
- asset or work-order identifiers;
- document names or contents;
- URLs, credentials, tokens or secrets;
- request paths containing user-controlled identifiers;
- provider/vendor exception messages.

No tenant or resource ID is used as a Prometheus label. This prevents both information disclosure and unbounded time-series cardinality.

The endpoint is unauthenticated because its output is limited to generic process/dependency state. Production ingress should still avoid publishing operational endpoints to the public Internet when the platform can route monitoring traffic over an internal network.

## Scraping example

```yaml
scrape_configs:
  - job_name: opengmao
    metrics_path: /api/metrics
    static_configs:
      - targets: ["opengmao:3000"]
```

Recommended alerts can start with:

- `opengmao_database_ready == 0` for sustained database unavailability;
- abnormal process restarts inferred from changes in `opengmao_process_start_time_seconds`;
- memory thresholds based on RSS/heap gauges;
- an increasing readiness failure rate from `opengmao_readiness_checks_total`.

## Multi-replica deployments

Metrics are **per process / per replica**. Counters reset when a replica restarts and must be aggregated by the monitoring system. Do not sum process memory gauges across unrelated services unless that is the intended capacity view.

## Extending metrics

New metrics should remain operational and bounded. Avoid user-, tenant-, asset-, work-order-, document-, URL-, exception-message-, or free-text labels. Business analytics belong in the analytics domain; AuditLog remains the source for auditable business events.