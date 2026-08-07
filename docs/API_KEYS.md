# Server API keys

OpenGMAO API keys are intended for trusted server-to-server integrations. They are not browser credentials and must never be embedded in HTML, JavaScript bundles, iframe URLs or mobile application source.

## Create an API key

A site manager creates a key through the authenticated application endpoint:

```text
POST /api/api-keys
```

Example payload:

```json
{
  "organizationId": "org-id",
  "siteId": "site-id",
  "name": "ERP connector",
  "scopes": ["asset:read", "document:read", "kpi:read"],
  "expiresInDays": 90
}
```

The authenticated manager must have `site:manage` and must also possess every domain permission being delegated.

The returned secret starts with `gmao_sk_` and is shown only in the creation response. OpenGMAO stores only its SHA-256 hash. Capability scopes are stored in the immutable credential-creation audit snapshot; changing capabilities requires key rotation.

## Authentication

Send the raw key only in the `X-API-Key` header to the server-only v1 routes:

```text
POST /api/v1/server/maintenance-requests
GET  /api/v1/server/request-status?trackingId=<tracking id>
GET  /api/v1/server/assets?assetCode=<asset code>
GET  /api/v1/server/documents?documentCode=<document code>&asOf=<optional ISO date>
GET  /api/v1/server/kpis
```

Example:

```bash
curl https://gmao.example.test/api/v1/server/assets?assetCode=ASSET-100 \
  -H 'X-API-Key: gmao_sk_REPLACE_WITH_SECRET'
```

Maintenance-request creation also requires a unique `Idempotency-Key` header.

## Browser isolation

Server API-key routes do not expose a CORS contract. Requests containing a browser `Origin` header are rejected with `API_KEY_BROWSER_FORBIDDEN`. The key record has no allowed browser origins and cannot render an iframe. Browser integrations must use scoped `EMBEDDED` tokens instead.

This is defense in depth: a secret placed deliberately into same-origin client-side code should still be considered compromised and rotated immediately.

## Capabilities

- `maintenance:request:create`
- `maintenance:request:status`
- `asset:read`
- `document:read`
- `kpi:read`

The server routes reuse the same domain services as public/embedded integrations, including tenant/site isolation, idempotency, effective controlled-document resolution, integrity verification, audit events and rate limits.

## Rotation and revocation

List metadata:

```text
GET /api/api-keys?organizationId=<org>&siteId=<site>
```

The list never returns the raw secret.

Revoke:

```text
DELETE /api/api-keys
```

```json
{
  "organizationId": "org-id",
  "siteId": "site-id",
  "apiKeyId": "key-record-id"
}
```

Create a replacement key before revoking the old key when zero-downtime rotation is required.
