# Product Roadmap

The roadmap is organized as Epics. Each Epic contains stories and mandatory engineering checks.

## E0 — Engineering foundation
Stories: reproducible local setup; lint/format/typecheck; unit/integration/E2E harness; migrations; seed fixtures; CI; error boundaries; logging; environment validation; contribution templates.
Checks: clean clone works; CI green; no secrets; deterministic seed; build succeeds.

## E1 — Identity, organizations and access
Stories: organizations; sites; users; invitations; roles; permissions; session management; SSO-ready auth abstraction; tenant isolation.
Checks: tenant-bound tests; unauthorized API tests; permission matrix tests.

## E2 — Asset registry
Stories: site/location hierarchy; assets; parent-child assemblies; categories; criticality; status; manufacturer/model; serials; commissioning; meters; photos; attachments; QR codes; asset history.
Checks: hierarchy integrity; unique codes per site; audit log; mobile usability.

## E3 — Work requests and work orders
Stories: public/internal request; triage; approval; assignment; priority; planning; execution; checklist; labor; downtime; consumed parts; attachments; completion; cancellation; reopen; timeline.
Checks: state-machine tests; permissions; inventory transaction consistency; audit trail.

## E4 — Preventive and condition-based maintenance
Stories: PM templates; calendar frequency; meter frequency; job generation; checklists; overdue handling; completion compliance; recurring scheduling; forecasting.
Checks: scheduler idempotency; date/timezone tests; meter threshold tests; duplicate WO prevention.

## E5 — Inventory and purchasing foundation
Stories: parts; warehouses; bins; stock movements; reservations; min/max; cycle counts; suppliers; purchase-request foundation; asset BOM.
Checks: stock cannot silently drift; transaction ledger tests; concurrency tests.

## E6 — Controlled document management
Stories: document master; revisions; uploads; metadata; review; approval; effective date; obsolete state; controlled copy; asset applicability; search; acknowledgement/read receipt.
Checks: immutable released revisions; approval permissions; checksum/storage tests; auditability.

## E7 — Quality management
Stories: events/nonconformities; containment; root-cause methods; CAPA; 5 Why; Ishikawa data model; 8D workflow; effectiveness checks; linked actions; linked assets/documents/work orders.
Checks: workflow transition tests; required evidence; full history.

## E8 — Planning and operations UX
Stories: maintenance Kanban; calendar; workload; team view; due/overdue filters; saved views; global search; command palette; notifications.
Checks: keyboard/accessibility; responsive UI; large-list performance.

## E9 — Dashboards and reliability
Stories: backlog; PM compliance; MTTR; MTBF; downtime; Pareto; labor; parts cost; configurable KPI cards; export.
Checks: KPI formula tests; data-range/timezone consistency; benchmark fixtures.

## E10 — Embedding and developer platform
Stories: public API versioning; OpenAPI; API keys; scoped tokens; CORS allowlists; webhooks; iframe embeds; script-loader widgets; theme tokens; TypeScript SDK; examples for static HTML/React/Next.js.
Checks: origin validation; token scope tests; XSS/CSP review; API compatibility tests; example app CI.

## E11 — Mobile / PWA
Stories: installable PWA; QR scan; camera attachments; offline queue; technician mode; signatures; sync conflict strategy.
Checks: offline/online transitions; retry/idempotency; mobile E2E.

## E12 — Integrations
Stories: webhook framework; generic REST connector; CSV import/export; Microsoft/Google identity adapters; object storage adapters; later ERP/IoT connectors.
Checks: connector contract tests; retry/dead-letter behavior; secrets isolation.

## E13 — AI and semantic search
Stories: pluggable LLM provider; embeddings abstraction; RAG over effective documents; asset assistant; work-order summarization; suggested troubleshooting; citations; AI audit events.
Checks: authorization before retrieval; source citations; no cross-tenant retrieval; non-AI fallback.

## E14 — Deployment, observability and operations
Stories: production Docker image; health/readiness; backups; restore procedure; metrics; structured logs; rate limiting; deployment docs; upgrade docs.
Checks: restore drill; container vulnerability scan; migration rollback strategy; health probes.

## Release gates

### v0.2 — Usable CMMS
E0–E4 core vertical slice.

### v0.3 — CMMS + controlled documents
E5–E6.

### v0.4 — Quality + planning
E7–E9.

### v0.5 — Embeddable platform
E10–E12.

### v1.0 — Production-ready open platform
Security, operations, migration stability, documentation and end-to-end test gates complete.
