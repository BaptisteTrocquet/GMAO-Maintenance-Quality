# GMAO Maintenance Quality

A modern open-source CMMS/GMAO combining maintenance operations, controlled document management, quality management, inventory, reliability analytics, mobile technician workflows, integrations and optional AI capabilities.

> Public-safe by design: examples, tests and seed data are synthetic. Never commit private company, employee, supplier, equipment, serial-number, customer or internal-document data.

## Vision

Build a modern alternative to legacy CMMS/GMAO products with a clean UX, strong multi-tenant isolation, controlled documentation, quality workflows and an API-first architecture that can be self-hosted and integrated into an existing information system.

AI features are optional. Core maintenance, quality, document, inventory and integration workflows remain usable when no LLM provider is configured.

## Product capabilities

### Maintenance and assets

- organization → site tenant model with server-side authorization and fine-grained permissions;
- hierarchical sites, locations, assets and parent/child assemblies;
- lifecycle metadata, status history, meters/counters, QR labels, photos and attachments;
- corrective work requests and work orders with triage, assignment, state transitions and execution capture;
- preventive calendar and meter-based maintenance with deterministic work-order generation;
- checklists, labor, downtime, parts consumption, signatures and complete activity timelines;
- Kanban, calendar planning, drag-and-drop rescheduling, team workload, saved views, notifications and bulk actions;
- installable PWA technician experience with QR scanning, camera attachments and offline read/write workflows.

### Inventory and spare parts

- part master, warehouses and bins;
- immutable stock-movement ledger for receipts, issues and adjustments;
- work-order reservations and idempotent consumption;
- min/max and reorder alerts, cycle counts, supplier references and asset BOMs;
- purchase-request foundation.

### Controlled documents

- document masters and immutable revision history;
- file storage through pluggable local and object-storage adapters;
- SHA-256 integrity checks and controlled-copy delivery;
- review, approval, effective-date, obsolete/superseded and read-acknowledgement workflows;
- asset applicability, search/filtering and audit timeline.

### Quality management

- quality events and nonconformities;
- immediate containment;
- 5 Why and structured Ishikawa root-cause analysis;
- CAPA and 8D workflows;
- corrective/preventive actions, owners, due dates and effectiveness verification;
- links to assets, work orders and controlled documents;
- evidence attachments and quality timeline.

### Analytics and operations UX

- backlog and preventive-maintenance compliance dashboards;
- MTTR and MTBF;
- downtime trends and failure Pareto;
- labor utilization and parts-cost analysis;
- configurable KPI cards with date/site/asset filters and CSV export;
- global search, command palette and personal dashboard.

### Developer platform and integrations

- versioned REST API and OpenAPI contract;
- server API keys and scoped browser/embed tokens;
- allowed-origin enforcement, CORS controls and iframe widgets;
- maintenance-request, request-status, asset, controlled-document and KPI widgets;
- `embed.js`, theme tokens and compiled TypeScript SDK;
- webhooks with HMAC signing, retry/idempotency and SSRF protections;
- generic REST connector pattern, CSV import/export, object-storage and identity-provider adapters;
- connector credential-vault abstraction, retry/dead-letter handling and integration event log;
- public-safe static HTML, React, Next.js and ERP/IoT examples.

### Optional AI

- pluggable LLM provider and vector-store abstractions;
- embeddings and semantic search over authorized EFFECTIVE controlled documents;
- asset-context assistant, work-order summaries and troubleshooting suggestions;
- source citations and AI audit events;
- authorization and tenant filtering before retrieval/model calls;
- provider-disabled fallback so the core product has no LLM dependency.

### Production operations

- hardened multi-stage production Docker image running non-root;
- separate minimal Prisma migration image;
- health/readiness endpoints and Prometheus-format metrics;
- application rate limiting and structured logs;
- backup and isolated restore procedures;
- production hardening guidance;
- Docker Compose and Kubernetes deployment examples;
- container vulnerability scanning;
- formal Semantic Versioning/release policy and automated N-1 upgrade drill.

## Technology

- Next.js 15.5 + React 19 + TypeScript 5.7;
- PostgreSQL + Prisma 6.19 with committed migrations;
- Zod 4 validation;
- Vitest unit/integration tests and Playwright browser E2E;
- Node.js 22 and npm 10.

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

The main repository check is:

```bash
npm run check
```

It combines TypeScript, lint, tests, SDK/examples checks, migration/upgrade policy, production hardening, deployment examples, release policy and the production build. GitHub Actions also exercises PostgreSQL integration, browser E2E, backup/restore, production container contracts, vulnerability scans and the supported previous-release upgrade path.

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

Before a production build or upgrade, the repository also verifies migration, deployment, hardening and release policy. See [`docs/UPGRADING.md`](docs/UPGRADING.md) for expand/contract, backup, migration, rollback and forward-fix guidance.

## Production deployment and releases

Start with:

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for Docker Compose and Kubernetes examples;
- [`docs/PRODUCTION_HARDENING.md`](docs/PRODUCTION_HARDENING.md) for the production security boundary;
- [`docs/BACKUP.md`](docs/BACKUP.md) and [`docs/RESTORE.md`](docs/RESTORE.md) for recovery;
- [`docs/UPGRADING.md`](docs/UPGRADING.md) for database/application upgrades;
- [`docs/RELEASING.md`](docs/RELEASING.md) for Semantic Versioning, immutable release tags and artifact publication.

Production secrets remain runtime-only. Database migrations are an explicit release step rather than application startup behavior.

## Project status

The original E0–E14 product roadmap is complete. GitHub Epic issues are the source of truth for delivered scope and acceptance checks:

- [x] [E0 — Engineering foundation](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/1)
- [x] [E1 — Identity, organizations & access control](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/2)
- [x] [E2 — Asset registry and hierarchy](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/3)
- [x] [E3 — Work requests & Work Orders](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/4)
- [x] [E4 — Preventive & condition-based maintenance](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/5)
- [x] [E5 — Inventory & spare parts](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/6)
- [x] [E6 — Controlled Document Management](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/7)
- [x] [E7 — Quality Management](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/8)
- [x] [E8 — Planning & Operations UX](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/9)
- [x] [E9 — Dashboards & reliability analytics](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/10)
- [x] [E10 — Embedding & Developer Platform](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/11)
- [x] [E11 — Mobile / PWA technician experience](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/12)
- [x] [E12 — Integrations & interoperability](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/13)
- [x] [E13 — AI & semantic search](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/14)
- [x] [E14 — Deployment, observability & operations](https://github.com/BaptisteTrocquet/GMAO-Maintenance-Quality/issues/15)

New roadmap work should be tracked through new GitHub issues/Epics instead of editing this list speculatively.

## License

AGPL-3.0-only.
