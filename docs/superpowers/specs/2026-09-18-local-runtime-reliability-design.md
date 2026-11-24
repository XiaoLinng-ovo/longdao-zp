# Local Runtime Reliability Design

## Goal

Make the supported local PostgreSQL workflow reproducible from startup through resume scanning, analysis, interview, offer, and onboarding. Local verification must use the same PostgreSQL-backed identity and business records instead of mixing file-backed development sessions with database-backed recruiting data.

## Runtime Architecture

- PostgreSQL is the authority for users, sessions, roles, departments, and recruiting records whenever database configuration is present.
- Local startup builds the API, applies idempotent migrations, seeds development identities idempotently, and starts the API with PostgreSQL authentication enabled.
- The worker uses the same PostgreSQL and object-storage configuration as the API. ClamAV is optional at configuration time but required for a resume to advance from quarantine to analysis.
- MinIO is the default local object store when S3 variables are configured. Local filesystem storage remains an explicit fallback.

## Startup And Identity

`createAuthSessionStore` selects PostgreSQL whenever database configuration is present, not only when `NODE_ENV=production`. Production still fails closed when database configuration is absent.

The local startup command runs migrations and the idempotent development seed before starting the API. Migration `0005_offers.sql` must tolerate a database where its foreign-key constraint already exists.

Development credentials are created only by the explicit local seed script. Production startup never creates accounts automatically.

## Dependency Health

The ClamAV Compose healthcheck must call `clamdscan --ping` with its required retry argument. The worker probes its selected object storage during startup and records `ok`, `unavailable`, or `error` in health output. PostgreSQL readiness remains mandatory when database polling is enabled.

Worker readiness reports the configured dependency state honestly. A configured but unreachable MinIO or ClamAV service cannot be reported as healthy.

## Resume Workflow

Uploads remain quarantined. The worker claims quarantined resumes, reads the exact uploaded object from the shared object store, scans it through ClamAV, and updates it to `clean`, `infected`, or `failed`. Only `clean` resumes are eligible for analysis.

The full-flow verifier waits for the asynchronous scan and worker analysis with bounded condition polling. It does not modify scan state directly and does not bypass the security gate. It then verifies the persisted advisory-only result and human review.

## Verification

Regression tests cover:

- PostgreSQL authentication selection in development when database settings exist.
- Worker object-storage health status for successful and failed probes.
- Idempotent migration behavior.
- Correct ClamAV healthcheck command through Compose configuration inspection.

Acceptance runs:

1. API and worker unit/integration tests.
2. Type checking and builds.
3. Docker dependency health checks.
4. The real PostgreSQL full-flow verifier, including asynchronous scan and analysis.

## External Integration Boundary

Real DingTalk approval, OpenAI-compatible model calls, and PP-StructureV3 OCR require external credentials or a running OCR service. Their absence is reported as not configured, never as passed. This change makes the local security and deterministic-analysis path complete without fabricating external integration results.
