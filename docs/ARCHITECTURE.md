# Architecture

## Domains

### Asset management
Sites, locations, hierarchical assets, criticality, meters, linked spare parts and linked documents.

### Maintenance
Work requests/orders, assignment, planning, preventive maintenance, checklists, downtime, labor and consumed parts.

### Document control
Document master records, revisions, lifecycle status, approvals, effective/obsolete dates, equipment applicability and storage abstraction.

### Cross-cutting
RBAC foundation, audit logs, REST API and relational PostgreSQL model.

## Extension points

- storage adapter: S3, Azure Blob, MinIO
- authentication provider
- notification service
- search/indexing
- AI/RAG service
- ERP/SCADA/IoT connectors

## Next modules

1. Work-order detail + controlled state transitions
2. Document revision editor + approval inbox
3. Preventive scheduling service
4. QR-code asset labels
5. Spare-part reservations
6. Reliability KPIs
7. Multi-site tenancy
8. Webhooks and outbound integrations
9. AI document assistant
