# Embedding Strategy

A central goal is to let an organization integrate selected GMAO capabilities into an existing website with minimal development.

## Supported integration levels

### Level A — Link / SSO
The simplest integration: link from the existing site to the full application. Later SSO can remove the second login.

### Level B — iframe widgets
Fastest general-purpose embed. The maintenance-request iframe is available at `/embed/maintenance-request` and uses scoped `EMBEDDED` request tokens rather than an administrator credential.

Example:

```html
<iframe
  title="Maintenance request"
  src="https://gmao.example.test/embed/maintenance-request?tokenId=TOKEN_ID#token=SCOPED_TOKEN_SECRET"
  referrerpolicy="strict-origin"
  sandbox="allow-scripts allow-same-origin"
  style="width:100%;max-width:720px;height:650px;border:0"
></iframe>
```

Use an exact allowed origin matching the host page. The non-secret token id is in the query string; the scoped secret is in the URL fragment, which browsers do not send in the iframe HTTP request. The iframe reads it once, removes the fragment from visible history, and submits through the proof-bound `/api/v1/embed/maintenance-requests` endpoint.

The server validates the browser-supplied parent `Referer` before rendering the iframe and signs a short-lived proof binding `tokenId + parent origin + expiry`. The iframe API requires both that proof and the scoped bearer secret. Copying an iframe URL to a different parent origin therefore does not create a valid embed session.

The iframe response applies a restrictive CSP with dynamic `frame-ancestors`, no inline scripts, no inline styles, no object/embed content and `base-uri 'none'`. A complete static host example lives in `examples/maintenance-request-iframe.html`.

The request-status iframe is available at `/embed/request-status?tokenId=TOKEN_ID&trackingId=TRACKING_ID#token=SCOPED_TOKEN_SECRET`. It exposes only the public work-order number, status and lifecycle timestamps; internal descriptions, assignment data and completion notes are not returned.

The asset-card iframe requires `asset:read` and is available at:

```html
<iframe
  title="Asset card"
  src="https://gmao.example.test/embed/asset-card?tokenId=TOKEN_ID&assetCode=ASSET-100#token=SCOPED_TOKEN_SECRET"
  referrerpolicy="strict-origin"
  sandbox="allow-scripts allow-same-origin"
  style="width:100%;max-width:680px;height:430px;border:0"
></iframe>
```

Asset codes are resolved only inside the site bound to the token. The card exposes code, name, status, criticality, category, manufacturer/model, location and update time. It deliberately excludes description, serial number, internal IDs, work-order assignments and other internal maintenance data. Asset-card lookups are rate-limited and audited, including failed lookups, to reduce enumeration risk.

The controlled-document iframe requires `document:read` and is available at:

```html
<iframe
  title="Controlled document"
  src="https://gmao.example.test/embed/controlled-document?tokenId=TOKEN_ID&documentCode=SOP-100#token=SCOPED_TOKEN_SECRET"
  referrerpolicy="strict-origin"
  sandbox="allow-scripts allow-same-origin"
  style="width:100%;max-width:900px;height:760px;border:0"
></iframe>
```

A document is exposed only when it is applicable to at least one non-archived asset in the site bound to the token. The server then reuses the E6 controlled-copy service: it resolves the revision effective at the optional `asOf` date, reads the stored file, verifies its SHA-256 digest and audits controlled-copy issuance. Missing effective revisions and failed file-integrity checks are never silently replaced by another revision.

The viewer displays traceability metadata and always provides the verified controlled copy for download. It previews only PDF, PNG, JPEG and WebP blobs. Other file types remain downloadable but are not rendered inside the iframe. PDF preview is placed in a sandboxed nested frame; arbitrary object/embed content remains disabled by CSP. Failed and successful document-code lookups consume a 60/hour/token limit and are audited to reduce enumeration risk.

Dynamic `assetCode`, `documentCode` and proof values are HTML-attribute escaped before iframe markup is emitted.

The KPI iframe requires `kpi:read` and is available at:

```html
<iframe
  title="Maintenance KPIs"
  src="https://gmao.example.test/embed/kpi-card?tokenId=TOKEN_ID#token=SCOPED_TOKEN_SECRET"
  referrerpolicy="strict-origin"
  sandbox="allow-scripts allow-same-origin"
  style="width:100%;max-width:760px;height:330px;border:0"
></iframe>
```

The KPI contract is aggregate-only and site-scoped. It returns four counts: open work orders, overdue work orders, work orders currently in progress, and non-archived assets out of service, plus the generation timestamp. It never exposes work-order titles/numbers, user identities, asset codes/names, assignees, teams or internal IDs. KPI reads use the same exact-origin, bearer-token and proof model and are limited to 120 views/hour/token.

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

New integrations should target the stable versioned prefix `/api/v1`:

```text
POST /api/v1/public/maintenance-requests?tokenId=<non-secret token id>
GET  /api/v1/public/request-status?tokenId=<token id>&trackingId=<opaque tracking id>
GET  /api/v1/public/assets?tokenId=<token id>&assetCode=<asset code>
GET  /api/v1/public/documents?tokenId=<token id>&documentCode=<document code>&asOf=<optional ISO date>
GET  /api/v1/public/kpis?tokenId=<token id>
```

The pre-version endpoint `/api/public/maintenance-requests` remains available for backward compatibility and delegates to the same handler as v1. Compatibility tests prevent the two routes from drifting.

The machine-readable OpenAPI 3.1 document is published by every deployment at:

```text
GET /api/openapi.json
```

Its `info.version` identifies the public API contract version independently from the application release version.

## Scoped integration tokens

A site manager creates a scoped token through `POST /api/public-request-tokens`. Tokens are bound to one organization/site, expire, can be revoked, and store only a SHA-256 hash server-side. `EMBEDDED` tokens require one or more exact allowed origins. The raw token is returned only when the token is created.

Each token also receives an immutable capability list. Changing capabilities requires token rotation rather than silently widening an existing browser credential.

Supported capabilities are:

- `maintenance:request:create` — submit a maintenance request
- `maintenance:request:status` — read the minimal public status for a request created by the same token
- `asset:read` — read minimal asset cards from the token's site
- `document:read` — read effective, integrity-verified controlled documents applicable to the token's site
- `kpi:read` — read aggregate maintenance KPIs for the token's site

Example token creation payload:

```json
{
  "organizationId": "org-id",
  "siteId": "site-id",
  "name": "Maintenance portal",
  "mode": "EMBEDDED",
  "allowedOrigins": ["https://portal.example.test"],
  "scopes": [
    "maintenance:request:create",
    "maintenance:request:status",
    "asset:read",
    "document:read",
    "kpi:read"
  ],
  "expiresInDays": 30
}
```

The server verifies that the authenticated site manager is allowed to delegate every requested capability. Existing legacy request tokens without capability metadata retain only the two maintenance capabilities. New tokens without valid capability metadata fail closed with no capabilities.

## Scoped public maintenance requests

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
- scoped embed tokens with immutable least-privilege capabilities
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
