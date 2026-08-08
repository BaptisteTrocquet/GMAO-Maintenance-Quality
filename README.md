# GMAO Maintenance Quality

A modern open-source **CMMS / GMAO + controlled document + Quality platform** built with Next.js, TypeScript, PostgreSQL and Prisma.

> Public-safe by design: examples, fixtures and seed data are synthetic. Never commit private company, employee, supplier, equipment, serial-number, customer or internal-document data.

## What the platform includes

GMAO Maintenance Quality combines maintenance, document control and Quality workflows in one multi-tenant application:

- hierarchical organizations, sites, locations and assets;
- corrective work requests and Work Orders;
- preventive and condition-based maintenance with calendar and meter triggers;
- technician execution workflows, checklists, labor, downtime, attachments and signatures;
- spare-parts inventory, immutable stock movements, reservations, replenishment and cycle counts;
- controlled documents with revisions, review/approval, effective dates, checksums, applicability and read acknowledgement;
- Quality events / nonconformities, containment, root-cause analysis, CAPA and 8D;
- Kanban, calendar planning, workload, saved views, notifications and bulk operations;
- reliability analytics including backlog, PM compliance, MTTR, MTBF, downtime, Pareto, labor and parts-cost views;
- installable PWA / mobile technician workflows with QR, camera and offline-safe patterns;
- versioned REST API, OpenAPI, TypeScript SDK, embeds/widgets, API keys and browser-scoped tokens;
- integrations/connectors, webhooks, CSV exchange, object-storage and identity-provider adapters;
- optional AI / semantic-search capabilities with tenant-safe retrieval, source citations, audit events and provider-disabled fallback;
- production Docker, health/readiness probes, backups/restores, structured logs, metrics, rate limiting, hardening and release/upgrade procedures.

## Architecture and security principles

The central tenancy boundary is **Organization → Site → business data**. A resource ID by itself is never an authorization decision: important reads and writes are validated against organization, site, membership and server-side domain permissions.

`AuditLog` is a cross-cutting trace for meaningful business mutations and operational events. Retry-prone flows are designed with explicit idempotence, controlled-document effective revisions are immutable, and inventory follows ledger-style movement semantics instead of silent quantity rewrites.

AI is optional. Core maintenance, Quality, document, inventory and planning workflows remain usable without an LLM provider.

## Stack

- Next.js 15.5 / React 19 / TypeScript 5.7
- PostgreSQL / Prisma 6.19 with committed migrations
- Zod 4
- Vitest + Playwright
- Node.js 22 / npm 10
- ESLint + Prettier

## Quick start from a clean clone

Prerequisites: Node.js 22 and Docker with Compose.

```bash
nvm use
cp .env.example .env
docker compose up -d db
npm ci
npm run db:bootstrap
npm run dev
```

Then open `http://localhost:3000`.

`db:bootstrap` generates Prisma Client, applies the committed migration history and loads deterministic synthetic seed data.

## Quality gates

The repository exposes the main developer checks individually:

```bash
npm run typecheck
npm run lint
npm run test
npm run sdk:build
npm run examples:check
npm run build
```

and the combined gate:

```bash
npm run check
```

CI also exercises PostgreSQL migrations, deterministic seed data, database smoke tests, realistic analytics fixtures, browser E2E tests, deployment/runtime contracts and release/upgrade checks.

## Database migration workflow

The Prisma schema and `prisma/migrations/` history must move together.

For a local schema change, create and review a migration before committing:

```bash
npm run prisma:migrate -- --name describe_your_change
npm run prisma:status
```

CI and deployed environments apply only committed migrations:

```bash
npm run prisma:deploy
```

Do not use `prisma db push` as the normal project migration path.

Before a production build or upgrade, run:

```bash
npm run upgrade:check
```

See [`docs/UPGRADING.md`](docs/UPGRADING.md) for the production expand/contract, backup, migration, rollback and forward-fix procedure.

## Production operations

Start with these runbooks before exposing a deployment to users:

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — supported Docker Compose / Kubernetes deployment patterns;
- [`docs/PRODUCTION_DOCKER.md`](docs/PRODUCTION_DOCKER.md) — production image and runtime contract;
- [`docs/PRODUCTION_HARDENING.md`](docs/PRODUCTION_HARDENING.md) — environment and security hardening;
- [`docs/BACKUP.md`](docs/BACKUP.md) — backup procedure;
- [`docs/RESTORE.md`](docs/RESTORE.md) — restore procedure and drill expectations;
- [`docs/UPGRADING.md`](docs/UPGRADING.md) — database/application upgrade strategy;
- [`docs/RELEASING.md`](docs/RELEASING.md) — Semantic Versioning, release checks, tags and supported upgrade baseline.

Production secrets are runtime-only. Database migrations are an explicit deployment/release step rather than an application-startup side effect.

## Roadmap and delivery status

**GitHub Epic issues are the source of truth for product delivery status.** The old feature checklist in this README was intentionally removed because it had become stale as completed capabilities continued to ship.

All planned Epics **E0 through E14 are complete**:

- [x] [E0 — Engineering foundation (#1)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/1)
- [x] [E1 — Identity, organizations & access control (#2)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/2)
- [x] [E2 — Asset registry and hierarchy (#3)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/3)
- [x] [E3 — Work requests & Work Orders (#4)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/4)
- [x] [E4 — Preventive & condition-based maintenance (#5)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/5)
- [x] [E5 — Inventory & spare parts (#6)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/6)
- [x] [E6 — Controlled Document Management (#7)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/7)
- [x] [E7 — Quality Management (#8)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/8)
- [x] [E8 — Planning & Operations UX (#9)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/9)
- [x] [E9 — Dashboards & reliability analytics (#10)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/10)
- [x] [E10 — Embedding & Developer Platform (#11)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/11)
- [x] [E11 — Mobile / PWA technician experience (#12)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/12)
- [x] [E12 — Integrations & interoperability (#13)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/13)
- [x] [E13 — AI & semantic search (#14)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/14)
- [x] [E14 — Deployment, observability & operations (#15)](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/15)

Future roadmap work should be represented by GitHub issues/Epics first, then reflected here only at a high level so the README does not become a second, conflicting tracker.

## License

AGPL-3.0-only.
