# Database migrations

`migrations/0001_initial_schema.sql` through `0006_recruiting_state_bridge.sql` establish the first SmartRecruit Pro domain schema. The API currently uses a PostgreSQL JSONB transaction bridge while normalized repositories are migrated incrementally. It deliberately separates `candidates` from `applications` and keeps workflow, analysis, outbox, and audit history append-oriented.

Migration files are applied by the Node.js runner in `scripts/migrate-postgres.mjs`. It uses the API's existing `pg` dependency and does not require the PostgreSQL `psql` executable. Applied files are recorded in `schema_migrations`; each migration runs in its own transaction and concurrent runners are serialized by a PostgreSQL advisory lock.

From the repository root, build the API and run the migration:

```powershell
npm --prefix apps/api run build
node scripts/migrate-postgres.mjs
```

The runner accepts either `DATABASE_URL` or the `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE` variables. `DATABASE_URL` takes precedence when both forms are set. Defaults are `127.0.0.1:5432`, user `postgres`, and database `smartrecruit`; malformed ports, URLs, and pool settings fail before a connection is attempted. Credentials are never included in readiness or migration output.

To check PostgreSQL without applying migrations:

```powershell
node scripts/check-postgres-ready.mjs
```

Do not use `state.json` writes to update these tables. Domain commands and later application services own all business transitions.
