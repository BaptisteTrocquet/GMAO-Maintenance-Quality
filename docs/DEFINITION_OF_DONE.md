# Definition of Done

A story is not complete because the screen appears to work.

## Mandatory checks for every story

- acceptance criteria implemented
- TypeScript passes without unsafe shortcuts introduced for convenience
- input validation on server-side writes
- authorization checked at the server boundary
- relevant unit/integration tests added
- build passes
- no secret, personal data or organization-specific private data committed
- Prisma schema changes include a reviewed versioned migration in `prisma/migrations/`
- important mutations emit audit events when applicable
- error and empty states considered
- responsive behavior checked for user-facing UI
- documentation updated when public behavior/API changes

## Additional checks by domain

### Maintenance
- valid work-order state transitions
- due dates/timezones
- labor/downtime consistency
- parts usage consistency

### Documents
- revision immutability after effective release
- permissions for approval
- storage/checksum integrity
- obsolete/effective selection rules

### Multi-tenant
- data access tested across two synthetic tenants
- IDs alone must never bypass tenant boundaries

### Embeds/API
- token scope
- allowed origin
- rate limit behavior
- XSS/CSP review
- version compatibility

### AI
- retrieval authorization before model call
- citations to source records/documents
- no cross-tenant context
- graceful fallback if AI provider is unavailable

## Pre-merge verification

1. install locked dependencies with `npm ci`
2. generate Prisma client
3. apply versioned migrations to disposable PostgreSQL with `npm run prisma:migrate:deploy`
4. verify migration status and schema drift
5. seed synthetic fixtures and run database smoke checks
6. run typecheck, lint, tests, SDK/examples checks and build
7. inspect diff for private/sensitive data and accidental secrets

See `docs/DATABASE_MIGRATIONS.md` for the database workflow and baseline procedure.
