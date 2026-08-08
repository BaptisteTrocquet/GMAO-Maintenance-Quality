# Integration primitives

OpenGMAO integrations are built from generic tenant-safe primitives before vendor-specific adapters are added.

## Generic REST connector

`lib/integrations/rest-connector.ts` defines the outbound REST contract used by future ERP, IoT and other HTTP adapters.

A connector definition contains only non-secret configuration:

```ts
const connector = createRestConnector({
  id: "erp-primary",
  organizationId: "org-id",
  name: "Primary ERP",
  baseUrl: "https://erp.example.com/api/v1/",
  defaultHeaders: { "X-Client": "OpenGMAO" },
});
```

Secrets are deliberately excluded from connector definitions. Credentials are supplied only at execution time:

```ts
await connector.execute({
  context: {
    organizationId: "org-id",
    siteId: "site-id",
    correlationId: "operation-id",
  },
  credential: {
    kind: "bearer",
    organizationId: "org-id",
    token: "runtime-secret",
  },
  request: {
    method: "POST",
    path: "work-orders",
    body: { number: "WO-100" },
  },
});
```

The later credential-vault story will provide these runtime credentials. Callers must not persist credentials in connector definitions, default headers, request headers, audit payloads or logs.

## Contract guarantees

The generic REST connector enforces the following before a request is sent:

- connector definition, execution context and runtime credential must belong to the same organization
- base URLs must use HTTPS and cannot contain embedded credentials or fragments
- operation paths are relative and cannot change origin or escape the configured base path
- `Authorization`, cookies, API-key headers, `Host` and `Content-Length` cannot be supplied through persisted/default or per-request headers
- bearer/API-key secrets are injected only through the runtime credential contract
- the final target is resolved with the existing public-address SSRF protection before each call
- the transport connects to the validated IP while preserving the original hostname for TLS SNI and `Host`
- redirects are not followed by the transport
- request timeouts and response-size limits are bounded
- transport failures return generic connector errors rather than propagating vendor messages that may contain secrets
- sensitive response headers such as `Set-Cookie` are removed before the response reaches adapter code

The connector deliberately returns non-2xx responses instead of automatically retrying them. Retry policy, dead-letter handling and integration-event persistence are separate E12 primitives so vendor adapters cannot silently invent incompatible retry semantics.

## Connector contract tests

`tests/rest-connector-contract.test.ts` exercises the common contract that future HTTP adapters must preserve:

- scoped request construction
- tenant and credential isolation
- secret-header discipline
- origin/base-path confinement
- redacted network errors
- sensitive response-header filtering
- public-target enforcement

Vendor-specific connector examples should build on this primitive rather than calling unrestricted `fetch` directly.

## CSV import/export

The first CSV interoperability surface is asset master data:

```text
GET  /api/integrations/csv/assets?organizationId=<org>&siteId=<site>
POST /api/integrations/csv/assets?organizationId=<org>&siteId=<site>&mode=validate
POST /api/integrations/csv/assets?organizationId=<org>&siteId=<site>&mode=upsert
```

Exports require `asset:read`; validation and imports require `asset:write`. Both authenticate against the organization and verify that the selected site belongs to that organization before any asset data is returned or mutated.

Supported columns are:

```text
code,name,description,category,manufacturer,model,serialNumber,criticality,status,installedAt,commissionedAt,locationCode,parentAssetCode
```

Only `code` and `name` are required. Optional columns may be omitted entirely. When an optional nullable column is present, a blank cell clears that value during an upsert; when the column is absent, an existing value is preserved. `criticality` and `status` use the platform enums and dates use ISO-8601.

`mode=validate` is a dry run. It performs CSV/schema validation, site-scoped location/parent resolution, duplicate detection and hierarchy-cycle detection, then reports how many rows would create or update assets without writing anything.

`mode=upsert` runs only after the same validation succeeds. The batch is ordered parent-first and applied in one database transaction using `(siteId, code)` as the stable asset identity. Every changed asset receives an immutable audit entry and status transitions receive normal status-history records. A final import summary audit entry records row/create/update counts without storing the source CSV.

CSV processing is bounded to 1 MB and 1,000 data rows. The parser supports quoted commas, escaped quotes, CRLF/LF and embedded newlines. Exports prefix spreadsheet-formula-looking user values before serialization to reduce CSV/Excel formula-injection risk.

The CSV API never accepts IDs for cross-asset or location references. Human-stable `locationCode` and `parentAssetCode` values are resolved only inside the selected site, preventing cross-tenant reference injection.

## Object-storage adapters

`lib/storage.ts` exposes one `StorageAdapter` contract used by document files, quality evidence and work-order attachments. Existing callers continue to use the same `put`, `get` and `delete` methods regardless of backend.

Two server-side providers are supported:

- `local` — filesystem storage rooted at `STORAGE_LOCAL_DIR`; this remains the default for development and single-node deployments
- `s3` / `s3-compatible` — path-style HTTPS object storage signed with AWS Signature Version 4, suitable for AWS S3 and compatible services that support SigV4

The provider is selected with `STORAGE_PROVIDER`. S3-compatible deployments configure `STORAGE_S3_ENDPOINT`, `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION`, `STORAGE_S3_ACCESS_KEY_ID` and `STORAGE_S3_SECRET_ACCESS_KEY`; temporary credentials may also supply `STORAGE_S3_SESSION_TOKEN`. `STORAGE_S3_PREFIX` can isolate one OpenGMAO deployment inside a shared bucket.

Storage secrets are read only from the server environment. They are never encoded into persisted storage keys, returned from the adapter or included in provider error messages. The adapter ignores provider error bodies and converts transport failures to generic errors so credential-bearing upstream messages cannot be logged accidentally by callers.

Both backends share the same key validation: absolute paths, traversal segments, null bytes, Windows separators and empty path segments are rejected. The S3 adapter additionally requires HTTPS, does not follow redirects, signs each request independently, applies a bounded timeout and caps downloaded object size before returning bytes to application code.

`tests/storage.test.ts` is the common storage contract suite. It covers local traversal protection plus S3-compatible PUT/GET/DELETE signing, namespace prefixing, temporary credentials, redacted provider failures, unsafe endpoint rejection, object-size limits and provider factory selection.

The credential-vault E12 story is intentionally separate. Object-storage deployment credentials remain infrastructure/server configuration rather than tenant-managed connector credentials.

## Existing webhook primitive

Signed outbound webhooks are documented separately in `docs/WEBHOOKS.md`. Their existing DNS validation and IP-pinned HTTPS delivery are reused by the REST connector pattern so both outbound integration paths share the same public-network trust boundary.
