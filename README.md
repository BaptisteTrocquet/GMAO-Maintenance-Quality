# GMAO Maintenance Quality

A modern open-source CMMS + controlled document management platform.

> Public-safe by design: examples and seed data are synthetic. Never commit private company, employee, supplier, equipment, serial-number, customer or internal-document data.

## Vision

Build a modern alternative to legacy CMMS/GMAO products with a clean UX, strong document control and an API-first architecture ready for future AI integrations.

## Current foundation

- hierarchical sites, locations and assets
- corrective and preventive work orders
- maintenance plans and checklists
- spare parts and stock
- meters and readings
- controlled documents, revisions and approvals
- asset ↔ document relationships
- role/permission foundation
- audit-log foundation
- REST API
- PostgreSQL + Prisma
- Next.js + TypeScript
- local document-storage adapter ready to be replaced by S3/MinIO

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

Before a production build or upgrade, the repository also runs:

```bash
npm run upgrade:check
```

See [`docs/UPGRADING.md`](docs/UPGRADING.md) for the production expand/contract, backup, migration, rollback and forward-fix procedure.

## Production deployment

The repository includes a hardened production Docker runtime plus reference Docker Compose and Kubernetes deployment patterns.

Start with [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), then review [`docs/PRODUCTION_HARDENING.md`](docs/PRODUCTION_HARDENING.md) before exposing a deployment to users. Production secrets remain runtime-only and database migrations are an explicit release step rather than application startup behavior.

## Roadmap

- [x] Core data model
- [x] Asset hierarchy
- [x] Work orders
- [x] Preventive maintenance
- [x] Spare parts
- [x] Document revisions and approvals
- [x] Initial dashboard
- [x] Initial REST API
- [ ] Authentication UI
- [ ] Fine-grained RBAC administration
- [ ] Work-order state-transition UI
- [ ] Preventive scheduler job
- [ ] QR labels
- [ ] Kanban and calendar planning
- [ ] S3/MinIO uploads
- [ ] Full-text document search
- [ ] Reliability KPIs (MTBF/MTTR/backlog/compliance)
- [ ] Notifications
- [ ] PWA/mobile mode
- [ ] Multi-site tenant isolation
- [ ] Webhooks/integrations
- [ ] AI/RAG assistant

## License

AGPL-3.0-only.
