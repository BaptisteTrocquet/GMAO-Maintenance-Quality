# Product roadmap and delivered baseline

GitHub issues and Epics are the source of truth for product delivery status. This document records the scope that produced the current platform baseline; it is not a second backlog and does not pre-announce future Epics or version numbers.

All planned Epics **E0 through E14 are complete**. Future product work should be opened as GitHub issues/Epics first and only summarized here after its scope is explicit.

## Delivered Epics

### E0 — Engineering foundation (#1) — complete
Reproducible local setup; lint/format/typecheck; unit/integration/E2E harness; migrations; seed fixtures; CI; error boundaries; logging; environment validation; contribution templates.

### E1 — Identity, organizations and access (#2) — complete
Organizations; sites; users; invitations; roles; permissions; session management; SSO-ready authentication abstraction; tenant isolation.

### E2 — Asset registry (#3) — complete
Site/location hierarchy; assets; parent-child assemblies; categories; criticality; status; manufacturer/model; serials; commissioning; meters; photos; attachments; QR codes; asset history.

### E3 — Work requests and work orders (#4) — complete
Public/internal requests; triage; approval; assignment; priority; planning; execution; checklists; labor; downtime; consumed parts; attachments; completion; cancellation; reopen; timeline.

### E4 — Preventive and condition-based maintenance (#5) — complete
PM templates; calendar and meter frequency; job generation; checklists; overdue handling; completion compliance; recurring scheduling; forecasting.

### E5 — Inventory and purchasing foundation (#6) — complete
Parts; warehouses; bins; stock movements; reservations; min/max; cycle counts; suppliers; purchase-request foundation; asset BOM.

### E6 — Controlled document management (#7) — complete
Document masters; revisions; uploads; metadata; review; approval; effective dates; obsolete state; controlled copies; asset applicability; search; acknowledgement/read receipt.

### E7 — Quality management (#8) — complete
Events/nonconformities; containment; root-cause methods; CAPA; 5 Why; Ishikawa data; 8D workflow; effectiveness checks; linked actions/assets/documents/work orders.

### E8 — Planning and operations UX (#9) — complete
Maintenance Kanban; calendar; workload/team view; due/overdue filters; saved views; global search; command palette; notifications; bulk operations.

### E9 — Dashboards and reliability (#10) — complete
Backlog; PM compliance; MTTR; MTBF; downtime; Pareto; labor; parts cost; configurable KPI cards; export; realistic-volume benchmark fixtures.

### E10 — Embedding and developer platform (#11) — complete
Versioned API; OpenAPI; API keys; scoped tokens; CORS allowlists; webhooks; iframe embeds; script-loader widgets; theme tokens; TypeScript SDK; integration examples.

### E11 — Mobile / PWA (#12) — complete
Installable PWA; QR scan; camera attachments; offline queue/read cache; technician mode; signatures; retry/idempotency and conflict-resolution strategy.

### E12 — Integrations (#13) — complete
Webhook framework; generic REST connector; CSV import/export; identity-provider adapters; object-storage adapters; connector credential vault; retry/dead-letter handling; integration event log; ERP/IoT examples.

The encrypted credential vault now also has the repository-provided durable Prisma/PostgreSQL store delivered after the original Epic in #228/#229.

### E13 — AI and semantic search (#14) — complete
Pluggable LLM provider abstraction; embedding/vector-store abstraction; semantic search over effective controlled documents; asset assistant; work-order summarization; authorized troubleshooting; source citations; AI audit events; provider-disabled fallback.

The vector-store abstraction now also has the repository-provided durable native PostgreSQL baseline delivered after the original Epic in #230/#231. Specialized indexed vector backends can still implement the same adapter contract.

### E14 — Deployment, observability and operations (#15) — complete
Production Docker; health/readiness; backups and restore drill; structured logs; metrics; rate limiting; upgrade/migration strategy; environment hardening; deployment examples; release/versioning process; previous-supported-release upgrade drill.

## Current release contract

Release/versioning policy lives in `release/release-policy.json` and `docs/RELEASING.md`. Do not infer a future release number from the historical Epic sequence in this document.

The repository currently uses Semantic Versioning, immutable release identities and a tested N-1 upgrade baseline. Production upgrade and rollback/forward-fix procedure lives in `docs/UPGRADING.md`.

## Future roadmap

There is intentionally **no pre-created E15** in this file. New product work should be justified from concrete user needs, operational gaps or repository findings, then tracked in GitHub before this document is changed.
