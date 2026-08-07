# Embedding Strategy

A central goal is to let an organization integrate selected GMAO capabilities into an existing website with minimal development.

## Supported integration levels

### Level A — Link / SSO
The simplest integration: link from the existing site to the full application. Later SSO can remove the second login.

### Level B — iframe widgets
Fastest general-purpose embed. The iframe runtime itself is part of E10; it will use the same scoped public-request capability described below rather than an administrator credential.

### Level C — script-loader widgets
Target developer experience:

```html
<div id="gmao-maintenance-request"></div>
<script
  src="https://gmao.example.com/embed.js"
  data-widget="maintenance-request"
  data-target="#gmao-maintenance-request"
  data-token="SCOPED_TOKEN">
</script>
```

This allows theme adaptation and a more native visual integration.

### Level D — Headless API / SDK
For custom portals:

```ts
const gmao = new GmaoClient({ baseUrl, apiKey });
await gmao.workRequests.create({ assetCode, title, description });
```

## Versioned public API

New integrations should target the stable versioned prefix `/api/v1`. The first public operation is:

```text
POST /api/v1/public/maintenance-requests?tokenId=<non-secret token id>
```

The pre-version endpoint `/api/public/maintenance-requests` remains available for backward compatibility and delegates to the same handler as v1. Compatibility tests prevent the two routes from drifting.

The machine-readable OpenAPI 3.1 document is published by every deployment at:

```text
GET /api/openapi.json
```

Its `info.version` identifies the public API contract version independently from the application release version.

## Scoped public maintenance requests

E3 provides the backend primitive for public and embedded maintenance-request forms.

A maintenance manager creates a scoped token through `POST /api/public-request-tokens`. Tokens are bound to one organization/site, expire, can be revoked, and store only a SHA-256 hash server-side. `EMBEDDED` tokens require one or more exact allowed origins. The raw token is returned only when the token is created.

External applications submit to:

```text
POST /api/v1/public/maintenance-requests?tokenId=<non-secret token id>
Authorization: Bearer <scoped token secret>
Idempotency-Key: <unique request id>
Content-Type: application/json
```

Example payload:

```json
{
  "title": "Abnormal machine noise",
  "description": "Noise noticed during operation.",
  "assetCode": "A-100",
  "requesterName": "External Requester",
  "requesterEmail": "requester@example.local",
  "requesterRef": "PORTAL-1234"
}
```

The public endpoint can only create a `REQUESTED`, `NORMAL` priority, `CORRECTIVE` work order in the site bound to the token. The normal internal triage workflow decides priority, category, assignment and planning. An optional `assetCode` is resolved only inside that site.

Browser integrations use exact-origin CORS. Preflight requests include the non-secret `tokenId`; the bearer secret is only sent on the actual request. Requests are idempotent and rate-limited per token. No administrator/session secret is exposed to the browser.

## First embeddable use cases

1. Public maintenance request form
2. Request status tracker
3. Asset information card
4. Controlled document viewer
5. KPI card

## Security requirements

- never expose administrator credentials to browser widgets
- scoped embed tokens
- expiration and revocation
- explicit allowed origins
- rate limiting
- CSRF strategy where cookies are used
- CSP/frame-ancestors policy configurable per tenant
- all input validated server-side
- all sensitive fields hidden by default
- tenant/site boundaries enforced server-side

## Architectural rule
Embedded UI must call the same service/domain layer as the full application. We do not maintain a second business logic implementation for widgets.
