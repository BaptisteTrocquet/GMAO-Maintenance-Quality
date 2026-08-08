# Database migrations

The PostgreSQL schema is managed with versioned Prisma Migrate files under `prisma/migrations/`.

## Rules

- Treat `prisma/schema.prisma` and `prisma/migrations/` as one change set.
- Do not use `prisma db push` for shared, staging, production, or CI databases.
- Create schema changes locally with `npm run prisma:migrate -- --name <change_name>` and review the generated SQL before committing it.
- Apply committed migrations in deployment environments with `npm run prisma:migrate:deploy`.
- CI applies migrations to a clean PostgreSQL database, checks migration status, and compares the migrated database with `schema.prisma` for drift.
- Never edit a migration that has already been deployed. Add a new forward migration instead.

## Clean local setup

```bash
cp .env.example .env
docker compose up -d db
npm ci
npm run prisma:generate
npm run prisma:migrate:deploy
npm run prisma:seed
npm run dev
```

For normal development after the baseline is applied, create and apply new migrations with:

```bash
npm run prisma:migrate -- --name describe_change
```

## Existing databases created before the migration baseline

`0_init` represents the schema that existed when versioned migrations were introduced. An existing database that already matches that schema must be baselined rather than having `0_init` executed against it.

1. Back up the database.
2. Confirm the database schema matches the application version that introduced `0_init`.
3. Generate/review a schema diff if there is any uncertainty.
4. Mark the baseline as already applied:

```bash
npx prisma migrate resolve --applied 0_init
```

5. Confirm migration state:

```bash
npm run prisma:migrate:status
```

6. Apply any later pending migrations:

```bash
npm run prisma:migrate:deploy
```

Do not run `migrate resolve --applied 0_init` on an empty database. Empty databases must receive the baseline through `migrate deploy`.

## Drift check

The repository exposes the same drift check used by CI:

```bash
npm run prisma:migrate:drift
```

Exit code `0` means the migrated database matches `schema.prisma`; a non-zero result must be resolved with a new migration or by correcting an unintended database change.
