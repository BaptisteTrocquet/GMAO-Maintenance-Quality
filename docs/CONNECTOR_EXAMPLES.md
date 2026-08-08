# ERP and IoT connector examples

These examples show how the generic E12 integration primitives fit together without coupling OpenGMAO to a specific ERP, IoT broker, cloud, or vendor SDK.

They are deliberately narrow reference implementations. Production vendor adapters should reuse the same trust boundaries, tenant checks, idempotency identities, credential handling, retry/dead-letter policy, and event ledger.

## ERP work-order outbound example

`lib/integrations/examples/erp-work-orders.ts` demonstrates an outbound maintenance-order upsert.

The flow is:

```text
OpenGMAO business source
  -> append OUTBOUND integration event
  -> check durable delivery receipt
  -> resolve connector credential from vault
  -> tenant-safe REST connector
  -> idempotent ERP PUT
  -> append delivery receipt
  -> mark event PROCESSED
```

The example accepts a stable business `sourceId`, such as the immutable audit ID that caused the export. Event identity is additionally scoped to the connector so the same Work Order can be sent independently to multiple ERP connectors.

The ERP request uses:

```http
PUT /maintenance-orders/{opengmaoWorkOrderId}
Idempotency-Key: {integrationEventId}
X-OpenGMAO-Correlation-Id: {integrationEventId}
```

A conforming ERP endpoint should treat the path as an upsert and honor the idempotency key. This gives two independent protections against duplicate remote orders if a worker crashes after the remote request but before local processing state is committed.

Credentials are never accepted as persisted connector configuration. `credentialVault.resolve()` is called immediately before transport with the exact organization + connector + credential ID scope. The returned bearer/API-key secret is passed only to the existing REST connector. Delivery audit receipts contain connector/event/status metadata only and never the secret or ERP response body.

A non-2xx response leaves the event unprocessed. A worker built around this example should feed the status/network outcome into `retry-policy.ts`; once the common retry policy becomes terminal, it can persist the event through `dead-letter.ts` rather than inventing vendor-specific retry semantics.

### Minimal ERP invocation

```ts
await pushWorkOrderToExampleErp({
  organizationId,
  siteId,
  sourceId: workOrderAuditId,
  connector: erpConnector,
  credentialVault,
  credentialId: erpCredentialId,
  workOrder: {
    id: workOrder.id,
    number: workOrder.number,
    title: workOrder.title,
    status: workOrder.status,
    type: workOrder.type,
    priority: workOrder.priority,
    requestedAt: workOrder.requestedAt,
    dueAt: workOrder.dueAt,
    assetCode,
  },
});
```

## IoT meter-reading inbound example

`lib/integrations/examples/iot-meter-readings.ts` demonstrates an inbound meter reading after transport/device authentication has already succeeded.

The trust boundary is intentionally explicit. The function is named `ingestVerifiedExampleIotMeterReading` and accepts only this normalized application message:

```ts
{
  externalEventId: string;
  assetCode: string;
  meterCode: string;
  value: number;
  observedAt: string;
}
```

Raw MQTT credentials, HTTP authorization headers, cookies, device certificates, bearer tokens, API keys, or arbitrary vendor headers do not belong in this object. A vendor-specific edge adapter must authenticate the message first and establish the OpenGMAO organization/site scope.

The ingestion flow is:

```text
verified vendor/device message
  -> append INBOUND event using provider event ID
  -> check inbound application receipt
  -> resolve assetCode only inside verified site
  -> resolve meterCode only on scoped asset
  -> enforce meter monotonic/rollover rule
  -> create MeterReading once
  -> append safe business + inbound receipts
COMMIT
  -> run idempotent meter PM scheduler
  -> mark integration event PROCESSED
```

`externalEventId` is the stable inbound `sourceId`. The integration event's PostgreSQL advisory lock serializes concurrent deliveries of the same provider message. The reading and receipt are committed in the same transaction, so a repeated message cannot create a second reading.

The PM scheduler is deliberately executed after that transaction and before `PROCESSED`. If the process crashes between reading persistence and PM scheduling, a replay finds the existing inbound receipt, skips creation of a second reading, reruns the scheduler, and then closes the event. Meter-triggered preventive Work Orders already use deterministic plan/threshold numbers, so this recovery path is idempotent.

External payloads never supply OpenGMAO database IDs. `assetCode` is resolved under `siteId`, then `meterCode` is resolved under that asset. This prevents a device/vendor payload from crossing tenant or site boundaries by guessing internal IDs.

The example rejects non-finite/negative readings, invalid timestamps, timestamps more than five minutes in the future, unknown scoped assets/meters, and decreasing readings on meters without rollover enabled.

## What a vendor adapter should add

A production SAP, Dynamics, Maximo, OPC-UA, MQTT, Azure IoT, AWS IoT, or other vendor adapter can add vendor-specific authentication, field mapping, pagination, protocol acknowledgements, and operational scheduling around these examples. It should not weaken the shared primitives:

- organization/site scope is established before resource access;
- connector credentials come from the credential vault, never event payloads or logs;
- outbound HTTP goes through the SSRF-safe REST connector;
- stable inbound/outbound identities feed the integration event log;
- remote or local business effects are idempotent;
- retry/dead-letter behavior uses the common policy;
- audits contain safe metadata, not secrets or unrestricted upstream bodies.

The examples are included in `npm run examples:check` as executable contract examples in addition to the full unit-test suite.
