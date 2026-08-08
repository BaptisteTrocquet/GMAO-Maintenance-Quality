# Structured logging

OpenGMAO writes application logs as one JSON object per console line through `lib/logger.ts`. Container and process supervisors should collect stdout/stderr rather than writing application-managed log files inside the container.

## Stable fields

Every emitted record owns these fields server-side/client-side:

- `timestamp`: UTC ISO-8601 timestamp;
- `level`: `debug`, `info`, `warn`, or `error`;
- `service`: `opengmao`;
- `environment`: runtime `NODE_ENV` when available;
- `message`: stable event/message identifier.

Caller context is added as extra JSON fields but cannot overwrite the logger-owned fields above.

Prefer stable event names such as `readiness_check_failed`, `delivery_completed`, or `work_order_created` rather than prose that changes between releases.

## Log level

Set `LOG_LEVEL` to one of:

- `debug`
- `info`
- `warn`
- `error`

The default is `debug` outside production and `info` in production. Entries below the configured threshold are not emitted.

## Correlation context

Use `logger.child()` to bind safe identifiers shared by several events:

```ts
const operationLogger = logger.child({
  component: "webhook-worker",
  organizationId,
  siteId,
});

operationLogger.info("delivery_completed", { deliveryId });
```

Identifiers are useful for correlation, but callers should still avoid attaching full database records, request bodies, document text, AI prompts/answers, or arbitrary third-party payloads.

## Secret safety

The logger applies a defense-in-depth sanitizer before JSON serialization.

Sensitive keys are replaced with `[REDACTED]`, including authorization/cookie fields, passwords, secrets, tokens, API/access/private keys, credentials, database URLs, connection strings, DSNs, and sessions. This check is recursive and case/separator insensitive.

String values are also scrubbed for common secret-bearing shapes, including:

- URI userinfo (`scheme://user:password@host`);
- authorization/cookie header fragments;
- Bearer tokens;
- `gmao_sk_...` API keys;
- `whsec_...` webhook secrets;
- JWT-shaped values;
- common secret-bearing query/form parameters.

`Error` instances are deliberately reduced to safe metadata (`name` and a primitive `code` when present). Their message and stack are not serialized automatically because database/provider errors frequently contain URLs, SQL, headers, credentials, or external payloads. Emit a stable application error code separately when operational diagnosis needs one.

The sanitizer also bounds object depth, array size, object key count, and string length, and handles circular/unserializable values without breaking the application operation that attempted to log.

Redaction is a last line of defense, not permission to log secrets intentionally. New logging call sites must project only the operational metadata they actually need.

## Browser logging

Runtime code under `app/` and `lib/` is required to route console output through the structured logger. CI tests prevent direct `console.debug/info/log/warn/error` calls outside `lib/logger.ts`.

The application error boundary records only its opaque Next.js digest, and the PWA registration path records only a fixed failure event; neither sends raw browser `Error` objects to the console.

## Aggregation

A production platform may ingest stdout/stderr into its normal logging backend. Parse each line as JSON and index stable fields such as:

- `level`
- `service`
- `environment`
- `component`
- `organizationId`
- `siteId`
- entity/delivery/job identifiers appropriate to the event.

Retention and access controls must match the deployment's security/privacy policy. Logs are operational records and should not be treated as a substitute for the domain `AuditLog`, which remains the source of truth for auditable business mutations.
