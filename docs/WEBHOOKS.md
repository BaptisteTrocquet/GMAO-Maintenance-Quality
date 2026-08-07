# Webhook subscriptions

OpenGMAO webhooks provide signed server-to-server notifications. The first supported event is:

- `work_order.created`

Webhook subscriptions are site-scoped and managed by authenticated site managers. Subscription configuration, delivery attempts and retry state are persisted as immutable `AuditLog` records.

## Required server configuration

Configure two secrets with at least 32 characters:

```text
WEBHOOK_SIGNING_MASTER_SECRET=<random server-only master secret>
WEBHOOK_WORKER_SECRET=<random worker trigger secret>
```

`WEBHOOK_SIGNING_MASTER_SECRET` deterministically derives a unique `whsec_...` signing secret for each subscription. The raw per-subscription secret is not stored in the database. Keep the master stable across deployments; rotating it rotates every webhook signing secret.

`WEBHOOK_WORKER_SECRET` protects the internal queue-processing endpoint.

## Create a subscription

```text
POST /api/webhooks
```

Example payload:

```json
{
  "organizationId": "org-id",
  "siteId": "site-id",
  "name": "Maintenance integration",
  "url": "https://hooks.example.test/opengmao",
  "eventTypes": ["work_order.created"]
}
```

The creation response returns the subscription metadata and its `signingSecret`. Save the signing secret at creation time. Normal list responses never return it.

A site may have at most 20 active subscriptions.

## Endpoint security / SSRF protection

Webhook URLs must:

- use HTTPS
- contain no URL credentials or fragments
- not use localhost, `.local` or `.internal` hostnames
- not use private, loopback, link-local, multicast or reserved literal IPs
- resolve exclusively to public IP addresses at delivery time

OpenGMAO resolves the hostname before each delivery and connects directly to the validated IP address while preserving the original hostname for TLS SNI and the HTTP `Host` header. Redirects are not followed. Delivery times out after five seconds.

This prevents a subscription from being used as a generic server-side request proxy and reduces DNS-rebinding exposure.

## Event body

Example:

```json
{
  "id": "audit-event-id",
  "type": "work_order.created",
  "createdAt": "2026-08-07T20:00:00.000Z",
  "data": {
    "workOrder": {
      "id": "work-order-id",
      "number": "WO-P-DEMO",
      "title": "Unexpected vibration",
      "status": "REQUESTED",
      "requestedAt": "2026-08-07T20:00:00.000Z",
      "assetCode": "ASSET-100"
    }
  }
}
```

Events are delivered only to subscriptions in the same organization/site as the work order and only for events occurring after the subscription was created.

## Signature headers

Each request includes:

```text
X-OpenGMAO-Event: work_order.created
X-OpenGMAO-Event-Id: <event id>
X-OpenGMAO-Timestamp: <unix seconds>
X-OpenGMAO-Signature: v1=<hex HMAC-SHA256>
```

The signature is HMAC-SHA256 over:

```text
<timestamp>.<raw request body>
```

using the subscription's `whsec_...` signing secret as the HMAC key.

Node.js verification example:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhook(rawBody: string, timestamp: string, header: string, secret: string) {
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const supplied = header.startsWith("v1=") ? header.slice(3) : "";
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Receivers should also reject timestamps outside a small tolerance window and deduplicate using `X-OpenGMAO-Event-Id`.

## Durable processing and retries

Work-order creation events already exist in OpenGMAO's audit log. The webhook worker scans recent `WorkOrder` creation audit events and creates a deterministic delivery identity for each `(subscription, source event)` pair.

Failed delivery state is persisted in `AuditLog` and retried with increasing backoff for up to five attempts. Successful deliveries are never resent by the normal worker scan.

Trigger processing from a trusted scheduler:

```text
POST /api/internal/webhooks/process
Authorization: Bearer <WEBHOOK_WORKER_SECRET>
```

A one-minute schedule is recommended. This works with a system cron, container scheduler, Power Automate/other trusted orchestration, or a hosting-platform cron facility. The worker endpoint must not be exposed with its secret to browser code.

## Listing and revocation

List:

```text
GET /api/webhooks?organizationId=<org>&siteId=<site>
```

Revoke:

```text
DELETE /api/webhooks
```

```json
{
  "organizationId": "org-id",
  "siteId": "site-id",
  "subscriptionId": "subscription-uuid"
}
```

Revoked subscriptions are excluded from future delivery and retries.
