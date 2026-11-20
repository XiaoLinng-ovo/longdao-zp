# Local Runtime Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PostgreSQL-backed local runtime start reproducibly and pass the real resume scan through onboarding flow.

**Architecture:** Database configuration selects PostgreSQL identity everywhere. Startup applies idempotent migrations and explicit development seeds. Worker readiness reflects object-storage reachability, while ClamAV controls the quarantine-to-clean transition.

**Tech Stack:** TypeScript, Node.js, PostgreSQL, Docker Compose, MinIO/S3, ClamAV, Node test runner, PowerShell.

## Global Constraints

- PostgreSQL remains authoritative for local business and identity records when configured.
- Resume analysis never bypasses the clean virus-scan gate.
- DingTalk, external LLM, and PP-StructureV3 are not reported as verified without real configuration.
- Existing local business data is preserved.

---

### Task 1: PostgreSQL Identity Selection And Startup

**Files:**
- Modify: `apps/api/src/auth/auth-service.ts`
- Test: `apps/api/src/auth/session-repository.test.ts`
- Modify: `scripts/start-api-local.mjs`

- [x] Add a failing factory test proving development uses PostgreSQL when DB credentials exist.
- [x] Make the factory select PostgreSQL for every configured environment and retain production fail-closed behavior.
- [x] Extend local startup to execute the idempotent development seed after migrations.
- [x] Run the focused auth tests and API build.

### Task 2: Idempotent Migration

**Files:**
- Modify: `db/migrations/0005_offers.sql`
- Test: real repeated `scripts/migrate-postgres.mjs` execution.

- [x] Reproduce the repeated migration failure against the local database.
- [x] Guard `offers_current_version_fk` with a PostgreSQL catalog check.
- [x] Run migration twice and require both executions to exit zero.

### Task 3: Dependency Health And Compose

**Files:**
- Modify: `apps/worker/src/worker.ts`
- Test: `apps/worker/tests/worker.test.ts`
- Modify: `deploy/docker-compose.yml`

- [x] Add failing worker tests for successful and failed object-storage health probes.
- [x] Probe storage on worker startup and publish `ok`, `unavailable`, or `error`.
- [x] Correct the ClamAV healthcheck to call `clamdscan --ping 3`.
- [x] Run focused worker tests and validate the rendered Compose configuration.

### Task 4: Real Asynchronous Flow Verification

**Files:**
- Modify: `scripts/verify-v1-flow.mjs`
- Modify: `start-local.ps1` only if required for verified service propagation.

- [x] Replace immediate quarantined-resume analysis with bounded polling for `clean` and completed analysis.
- [x] Configure and restart the local worker against PostgreSQL, MinIO, and ClamAV.
- [x] Run the full verifier and require every assertion to pass.
- [x] Run all API/worker tests, builds, type checks, and inspect the final Git diff.
