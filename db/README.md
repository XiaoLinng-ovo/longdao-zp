# Database migrations

`migrations/0001_initial_schema.sql` through `0007_auth_security.sql` establish the SmartRecruit Pro domain schema. Migration 0007 adds persistent CSRF token records, login-attempt throttling data, and revocation/lookup indexes for database-backed sessions. Business entities are persisted in normalized PostgreSQL tables; the API deliberately separates `candidates` from `applications` and keeps workflow, analysis, outbox, and audit history append-oriented.

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

Authentication tables

- `users`, `roles`, `user_roles`, and `sessions` are created by migration 0001.
- `csrf_tokens` stores only token hashes and is scoped to a session.
- `login_attempts` records success/failure events for rate limiting and security review; application code should prune old rows according to the retention policy.
- Session revocation is represented by `sessions.revoked_at`; callers must reject revoked or expired sessions.
