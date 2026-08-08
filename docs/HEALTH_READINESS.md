# Health and readiness probes

The production service exposes separate unauthenticated liveness and readiness endpoints for orchestrators and load balancers.

## Liveness

`GET /api/health`

A successful response is HTTP `200` and reports that the application process is alive. This endpoint deliberately does **not** query PostgreSQL or any other external dependency.

Use liveness to decide whether the process itself should be restarted. A temporary database outage must not create a restart loop.

Example response:

```json
{
  "data": {
    "status": "ok",
    "service": "opengmao",
    "checks": {
      "process": "alive"
    }
  }
}
```

## Readiness

`GET /api/ready`

Readiness executes a minimal PostgreSQL `SELECT 1` through Prisma.

- HTTP `200` means the application can currently reach its required database dependency.
- HTTP `503` means traffic should not be routed to the replica yet.

The failure response is intentionally generic. Database exception messages, connection URLs, credentials and host details are not returned to callers or copied into readiness logs.

Example success response:

```json
{
  "data": {
    "status": "ready",
    "service": "opengmao",
    "checks": {
      "database": "reachable"
    }
  }
}
```

Both endpoints send `Cache-Control: no-store`.

## Docker

The production `Dockerfile` defines its built-in `HEALTHCHECK` against `/api/health`, so Docker's process-health signal stays independent of PostgreSQL availability. A transient database outage therefore does not by itself make the container fail its liveness healthcheck.

For orchestrators with separate probe types, use:

- liveness: `/api/health`
- readiness: `/api/ready`

Readiness failure means the replica should be removed from traffic; it does not mean the process should be restarted.

## CI verification

The CI pipeline:

1. runs unit tests proving liveness does not query the database;
2. proves readiness returns `503` with safe output when the database probe fails;
3. builds the real production Docker image;
4. starts that image against the CI PostgreSQL service;
5. calls both HTTP probe endpoints;
6. verifies Docker transitions the container to `healthy` through the liveness healthcheck.

The probes expose no tenant data and require no organization/site context because their payload is restricted to process/dependency availability.
