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

## Quick start

```bash
cp .env.example .env
docker compose up -d db
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:seed
npm run dev
```

Then open `http://localhost:3000`.

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
