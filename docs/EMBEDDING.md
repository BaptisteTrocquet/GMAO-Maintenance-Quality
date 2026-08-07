# Embedding Strategy

A central goal is to let an organization integrate selected GMAO capabilities into an existing website with minimal development.

## Supported integration levels

### Level A — Link / SSO
The simplest integration: link from the existing site to the full application. Later SSO can remove the second login.

### Level B — iframe widgets
All iframe widgets use scoped `EMBEDDED` tokens rather than administrator credentials. The scoped secret belongs in the URL fragment, not the query string. The iframe removes the fragment from visible history after bootstrap.

The server validates the browser-supplied parent `Referer`, requires an exact allowed origin and signs a short-lived proof binding `tokenId + parent origin + expiry`. The proof-bound iframe APIs also require the scoped bearer secret. Each iframe response applies a restrictive CSP with exact `frame-ancestors`, no inline scripts/styles and no arbitrary object/embed content.

#### Maintenance request

```html
<iframe
  title="Maintenance request"
  src="https://gmao.example.test/embed/maintenance-request?tokenId=TOKEN_ID#token=SCOPED_TOKEN_SECRET"
  referrerpolicy="strict-origin"
  sandbox="allow-scripts allow-same-origin">
</iframe>
```

Requires `maintenance:request:create`. A complete host example lives in `examples/maintenance-request-iframe.html`.

#### Request status

`/embed/request-status?tokenId=TOKEN_ID&trackingId=TRACKING_ID#token=SCOPED_TOKEN_SECRET`

Requires `maintenance:request:status`. It exposes only the public work-order number, status and lifecycle timestamps.

#### Asset card

`/embed/asset-card?tokenId=TOKEN_ID&assetCode=ASSET-100#token=SCOPED_TOKEN_SECRET`

Requires `asset:read`. Asset codes are resolved only inside the site bound to the token. The card excludes description, serial number, internal IDs, work-order assignments and other internal maintenance data. Failed lookups are audited and consume the same rate-limit budget as successful lookups.

#### Controlled document

`/embed/controlled-document?tokenId=TOKEN_ID&documentCode=SOP-100#token=SCOPED_TOKEN_SECRET`

Requires `document:read`. A document is exposed only when it is applicable to at least one non-archived asset in the token site. The viewer reuses the E6 controlled-copy service to resolve the effective revision, verify SHA-256 integrity and audit issuance. PDF/PNG/JPEG/WebP can be previewed; other file types remain download-only.

#### KPI card

`/embed/kpi-card?tokenId=TOKEN_ID#token=SCOPED_TOKEN_SECRET`

Requires `kpi:read`. The response is aggregate-only: open work orders, overdue work orders, work orders in progress, assets out of service and the generation timestamp. It never includes work-order titles/numbers, users, asset identities, assignees, teams or internal IDs.

Dynamic `assetCode`, `documentCode`, tracking IDs and proof values are HTML-attribute escaped before iframe markup is emitted.

### Level C — script-loader widgets

`GET /embed.js` creates the secured iframe using DOM APIs. It does not use `innerHTML`, `document.write` or `eval`. The loader supports all five widgets:

- `maintenance-request`
- `request-status`
- `asset-card`
- `controlled-document`
- `kpi-card`

Example:

```html
<div id="gmao-maintenance-request"></div>
<script
  src="https://gmao.example.test/embed.js"
  data-widget="maintenance-request"
  data-target="#gmao-maintenance-request"
  data-token-id="TOKEN_ID"
  data-token="SCOPED_TOKEN_SECRET"
  data-theme-accent="#2563eb"
  data-theme-background="#f4f7fb"
  data-theme-surface="#ffffff"
  data-theme-text="#111827"
  data-theme-radius="16">
</script>
```

The loader reads the scoped secret, immediately removes the `data-token` attribute, and places the secret only in the created iframe URL fragment. It sets `referrerpolicy="strict-origin"`, `sandbox="allow-scripts allow-same-origin"` and lazy loading. `data-target` is optional; without it, the loader creates a container immediately before the script element.

Widget-specific attributes:

- `request-status`: `data-tracking-id`
- `asset-card`: `data-asset-code`
- `controlled-document`: `data-document-code`, optional `data-as-of`
- all widgets: optional `data-height`, `data-max-width`

A complete script-loader example lives in `examples/widget-loader.html`.

### Theme tokens

The host can pass only the following named theme tokens:

- `data-theme-accent` → `#RRGGBB`
- `data-theme-background` → `#RRGGBB`
- `data-theme-surface` → `#RRGGBB`
- `data-theme-text` → `#RRGGBB`
- `data-theme-radius` → integer `0..32` pixels

The iframe server validates these values before generating `/embed/theme.css`. Invalid colors, CSS expressions, URLs, declarations and out-of-range radii are replaced with safe defaults. Arbitrary CSS strings are never reflected into the iframe stylesheet.

### Level D — Headless API / SDK

The TypeScript SDK source lives in `sdk/` and builds as the dependency-free ESM package `@opengmao/sdk` with generated declaration files.

```ts
import { OpenGmaoClient } from "@opengmao/sdk";

const gmao = new OpenGmaoClient({
  baseUrl: "https://gmao.example.test",
  tokenId: "TOKEN_ID",
  token: "SCOPED_TOKEN_SECRET",
});

const request = await gmao.maintenanceRequests.create({
  title: "Unexpected vibration",
  assetCode: "ASSET-100",
});

const status = await gmao.maintenanceRequests.status(request.trackingId);
const asset = await gmao.assets.get("ASSET-100");
const controlledCopy = await gmao.documents.download("SOP-100");
const kpis = await gmao.kpis.get();
```

`documents.download()` returns `Uint8Array` file bytes plus revision, effective-date and SHA-256 traceability metadata. Non-2xx API responses throw `OpenGmaoApiError` with HTTP status, API code, safe message and optional validation details. A custom `fetch` implementation can be injected for server runtimes or tests.

The SDK uses the same scoped-token capabilities and `/api/v1` contract as direct HTTP integrations; it does not use administrator credentials.

## Versioned public API

New integrations should target `/api/v1`:

```text
POST /api/v1/public/maintenance-requests?tokenId=<non-secret token id>
GET  /api/v1/public/request-status?tokenId=<token id>&trackingId=<opaque tracking id>
GET  /api/v1/public/assets?tokenId=<token id>&assetCode=<asset code>
GET  /api/v1/public/documents?tokenId=<token id>&documentCode=<document code>&asOf=<optional ISO date>
GET  /api/v1/public/kpis?tokenId=<token id>
```

The pre-version endpoint `/api/public/maintenance-requests` remains available for backward compatibility and delegates to the same handler as v1. Compatibility tests prevent route drift.

The machine-readable OpenAPI 3.1 document is published at:

```text
GET /api/openapi.json
```

Its `info.version` identifies the public API contract independently from the application release version.

## Scoped integration tokens

A site manager creates a scoped token through `POST /api/public-request-tokens`. Tokens are bound to one organization/site, expire, can be revoked and store only a SHA-256 hash server-side. `EMBEDDED` tokens require one or more exact allowed origins. The raw secret is returned only at creation.

Capabilities are immutable; changing them requires token rotation:

- `maintenance:request:create`
- `maintenance:request:status`
- `asset:read`
- `document:read`
- `kpi:read`

The server verifies that the authenticated site manager may delegate every requested capability. Legacy request tokens without capability metadata retain only the two maintenance capabilities; new tokens without valid capability metadata fail closed.

## Security requirements

- never expose administrator credentials to browser widgets
- scoped embed tokens with immutable least-privilege capabilities
- expiration and revocation
- explicit allowed origins
- rate limiting
- CSP/frame-ancestors policy enforced by the iframe server
- all input validated server-side
- dynamic HTML attributes escaped
- arbitrary theme CSS rejected
- all sensitive fields hidden by default
- tenant/site boundaries enforced server-side

## Architectural rule
Embedded UI must call the same service/domain layer as the full application. We do not maintain a second business-logic implementation for widgets.
