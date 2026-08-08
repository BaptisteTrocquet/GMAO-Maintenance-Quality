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

The connector credential vault described below can supply these runtime credentials. Callers must not persist credentials in connector definitions, default headers, request headers, audit payloads or logs.

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

Object-storage deployment credentials remain infrastructure/server configuration rather than tenant-managed connector credentials.

## Identity-provider adapters

`lib/auth/provider.ts` already defines the provider-neutral `AuthenticationProvider` contract consumed by `loginWithProvider()`. `lib/auth/oidc-provider.ts` supplies the first production adapter: generic OpenID Connect ID-token verification suitable for standards-compliant providers such as Microsoft Entra ID, Okta, Auth0 and Keycloak when configured with their issuer/client/JWKS metadata.

The OIDC adapter is explicitly organization-scoped. Every verification input carries `organizationId`, and a mismatched organization is rejected before any key lookup or network request. It does not provision users: after a token is cryptographically verified, existing login behavior still resolves a pre-existing active OpenGMAO user by normalized email and creates the normal application session. This prevents an external IdP from silently creating or granting local accounts.

Verification is fail-closed and checks:

- HTTPS issuer and JWKS endpoints with no embedded credentials or fragments
- exact issuer match
- configured client ID in `aud`
- `RS256` only, with a matching RSA signing key selected by `kid`
- signature validity
- required `sub`, email and `exp` claims
- expiration plus bounded clock tolerance, optional `nbf`, and future `iat` rejection
- optional strict `email_verified=true`
- configurable email and display-name claim mapping

JWKS retrieval reuses the platform public-IP DNS validation before connecting, pins the HTTPS connection to the validated public address while preserving TLS SNI/Host, applies a 5-second timeout, limits the response to 256 KiB and does not follow redirects. Supported signing keys are cached briefly; an unknown `kid` forces one refresh so normal key rotation works without accepting arbitrary keys.

Provider/network/parser exceptions are converted to a failed verification (`null`) rather than exposing upstream diagnostics or token material. OIDC metadata in `.env.example` is public configuration; no OIDC client secret is required for ID-token verification in this primitive.

`tests/oidc-provider.test.ts` covers signed-token verification, issuer/audience/time/algorithm/signature rejection, organization isolation before network access, claim mapping, optional verified-email enforcement, key rotation/cache refresh, fail-closed upstream errors and environment factory configuration.

## Connector credential vault

`lib/integrations/credential-vault.ts` separates encrypted secret handling from connector definitions and from the eventual persistence technology. The vault depends on a `ConnectorCredentialRecordStore` interface, so a database, managed secret service or another durable store can implement persistence without changing connector code or exposing plaintext credentials to that store.

The vault currently supports the runtime credential shapes consumed by the generic REST connector:

- bearer tokens
- API keys with an explicit header name

Plaintext is encrypted before the record store is called. Encryption uses AES-256-GCM with a fresh 96-bit IV and authenticated additional data binding the ciphertext to `organizationId`, `connectorId`, credential ID, credential kind and key version. Moving an encrypted record to another tenant/connector or altering those fields makes decryption fail closed.

The public metadata returned by `put()` and `list()` includes only ID, tenant/connector scope, label, kind, key version and timestamps. It never includes plaintext, ciphertext, IV or authentication tags. `resolve()` is the only operation that returns secret material, and it produces the existing `RestConnectorCredential` shape with the organization scope attached for the connector's own tenant check.

Key material is supplied by a `CredentialEncryptionKeyProvider`. `createCredentialEncryptionKeyProviderFromEnv()` requires a 32-byte base64 master key and supports one previous key version during rotation. New or updated credentials are always encrypted with the current key; old records remain decryptable while the previous key is configured and can be re-saved to migrate them.

Store exceptions are converted to a generic `STORE_ERROR`, and corruption/decryption failures use a generic `DECRYPTION_FAILED` message. Upstream/store error messages are never propagated, reducing the risk that a vendor SDK or persistence layer places a credential into application logs. The vault itself performs no logging.

Tenant isolation is enforced twice: store operations always receive organization/connector scope, and returned records are independently checked before metadata is returned or ciphertext is decrypted. Cross-organization and cross-connector credential IDs therefore cannot resolve or delete another tenant's credentials.

`tests/credential-vault.test.ts` verifies encryption at rest, safe metadata, runtime credential resolution, organization/connector isolation, authenticated-data tamper resistance, key rotation, previous-key reads, scoped deletion, unsafe credential rejection and redacted store/decryption failures.

The vault is deliberately an abstraction rather than a hard-coded database table. A later durable store implementation can add operational persistence/audit policy without weakening the encryption and tenant-isolation contract.

## Retry policy

`lib/integrations/retry-policy.ts` provides the common retry decision engine for asynchronous integration work. It does not execute requests or sleep inside request handlers; callers persist the returned `nextAttemptAt` and let their worker schedule the next attempt. This keeps retry state durable and makes the policy reusable by webhooks and future ERP/IoT connectors.

Retries are allowed only when the caller explicitly marks the operation idempotent. The default transient HTTP set is `408`, `425`, `429`, `500`, `502`, `503` and `504`; network failures are transient, while permanent outcomes and other HTTP statuses stop immediately. Attempt limits are enforced before another retry is scheduled.

The policy supports configurable attempt limits, delay schedules, maximum delay and bounded jitter. `Retry-After` is parsed as either delta-seconds or an HTTP date; a valid server delay is treated as a minimum wait and is capped by the policy maximum. Randomness is injectable for deterministic contract tests.

Webhook delivery now consumes this generic policy. Its historical retry cadence remains 1 minute, 5 minutes, 30 minutes and 2 hours for attempts 2–5, with no jitter. `429`/transient server failures and network failures are retried; permanent client errors such as `400` are persisted as terminal failures with `nextAttemptAt=null`, ready for the following dead-letter story instead of being retried pointlessly.

Webhook delivery failures no longer persist arbitrary transport exception messages. Network errors are reduced to a generic message; HTTP failures store only the status code and generic status text. This keeps retry state free of accidental upstream secret material.

`tests/retry-policy.test.ts` covers transient/permanent classification, idempotence gating, attempt exhaustion, backoff, bounded jitter, `Retry-After` seconds/date parsing, maximum-delay capping and invalid configuration. `tests/webhook-delivery.test.ts` verifies the webhook integration, including `503`, `429 Retry-After` and terminal `400` behavior.

Dead-letter persistence is intentionally the next E12 primitive. A terminal retry decision is already represented durably by a failed delivery with no next-attempt timestamp, so dead-letter handling can consume that state without inventing a second retry classifier.

## Existing webhook primitive

Signed outbound webhooks are documented separately in `docs/WEBHOOKS.md`. Their existing DNS validation and IP-pinned HTTPS delivery are reused by the REST connector pattern so both outbound integration paths share the same public-network trust boundary.
