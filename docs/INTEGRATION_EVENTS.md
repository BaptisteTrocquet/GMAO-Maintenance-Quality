# Integration event log

OpenGMAO uses an append-only integration event ledger for durable inbound and outbound interoperability events.

## Event identity

`lib/integrations/event-log.ts` derives each event ID as SHA-256 over:

```text
organizationId + direction + channel + sourceId
```

The same tenant/source identity can therefore be submitted repeatedly without creating duplicate events. Recording is protected by a PostgreSQL transaction-scoped advisory lock. If the same identity is presented with different event metadata or payload content, the operation fails with `EVENT_IDENTITY_CONFLICT` rather than silently overwriting history.

This contract works in both directions:

- `OUTBOUND` — an internal source such as a Work Order audit record becomes an integration event once
- `INBOUND` — a future ERP/IoT adapter can use the provider's stable external event/message ID as `sourceId`

## Envelope

Every recorded event has a versioned envelope containing:

- organization and optional site scope
- `INBOUND` or `OUTBOUND` direction
- channel and event type
- stable source ID
- optional correlation/causation IDs
- optional subject type/ID
- occurrence time
- SHA-256 payload hash
- JSON payload

Payloads are limited to 256 KiB. Credential-like fields such as authorization headers, cookies, API keys, passwords, secrets and access/refresh tokens are rejected before persistence. Tenant/site ownership is verified before any event is appended.

## Append-only lifecycle

Integration events reuse the existing immutable `AuditLog` ledger rather than introducing a mutable queue table:

```text
RECORDED -> PROCESSED
```

`RECORDED` contains the immutable event envelope. `PROCESSED` contains only safe routing metadata and the payload hash, not a duplicate payload. Processing never edits or deletes the original event.

`listPendingIntegrationEvents()` determines pending work from the latest ledger state for each deterministic event ID, so there is no age-based lookback window. This makes queue recovery independent of worker downtime.

## Webhook integration

Work Order creation now appends `work_order.created` in the same database transaction as the Work Order and its business audit entry. This applies to both authenticated Work Order creation and public maintenance requests.

The webhook worker consumes pending `OUTBOUND/webhook` integration events directly. It no longer reconstructs events from Work Orders or limits discovery to the previous 24 hours.

For each event, webhook delivery remains idempotent through the deterministic delivery ID derived from subscription ID + event ID. If a worker restarts after some deliveries but before the event is marked processed, existing delivery state prevents duplicate sends. Retry/dead-letter state remains managed by the dedicated retry and DLQ primitives.

Subscriptions created after an event occurred do not receive that historical event.

## Adapter guidance

Future ERP/IoT connectors should:

1. verify/authenticate the provider message before recording it;
2. use a provider-stable message/event ID as `sourceId` for inbound idempotence;
3. record the event under the verified organization/site scope;
4. keep credentials and raw bearer/session tokens outside event payloads;
5. use correlation/causation IDs instead of embedding transport secrets or unrestricted headers;
6. process from the ledger and append `PROCESSED` only after durable downstream handling is complete.

The event ledger is an integration primitive, not a replacement for business-domain audit events. Business mutations continue to write their normal audit entries; the integration event references those stable sources where appropriate.
