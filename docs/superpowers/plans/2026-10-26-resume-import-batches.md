# Resume Import Batches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable, cancellable resume batch imports with three-lane client uploads and server-side candidate/application/resume creation.

**Architecture:** PostgreSQL stores one batch and its file items. The browser uploads each item independently with bounded concurrency and progress. The API creates candidate, application, resume and analysis task for each uploaded item; the existing Worker continues analysis.

**Tech Stack:** Vue 3, TypeScript, Node HTTP API, PostgreSQL, existing object storage and persisted analysis worker.

## Global Constraints

- A batch targets exactly one job.
- One resume file is limited to 10 MB and the existing PDF/DOC/DOCX/TXT/MD formats.
- Browser upload concurrency is exactly 3.
- Cancel keeps uploaded and analyzed resumes.
- All batch queries are organization-scoped.

---

### Task 1: Bounded upload scheduler

**Files:**
- Create: `web/src/modules/candidates/utils/resume-upload-queue.ts`
- Create: `web/src/modules/candidates/utils/resume-upload-queue.test.ts`

**Interfaces:**
- Produces: `runResumeUploadQueue<T>(items, concurrency, worker, signal?): Promise<Array<{ item: T; ok: true; value: unknown } | { item: T; ok: false; error: unknown }>>`

- [ ] **Step 1: Write the failing test** covering max concurrency 3, one failure not stopping later items, and abort preventing new starts.
- [ ] **Step 2: Run** `npm --prefix web test -- resume-upload-queue.test.ts` and verify the missing module failure.
- [ ] **Step 3: Implement** a small worker-pool loop that checks `signal.aborted` before claiming each item.
- [ ] **Step 4: Run the focused test** and verify PASS.
- [ ] **Step 5: Commit** the scheduler and tests.

### Task 2: Durable batch store and service

**Files:**
- Create: `db/migrations/0051_resume_import_batches.sql`
- Create: `apps/api/src/recruiting/resume-import.ts`
- Create: `apps/api/src/recruiting/resume-import.test.ts`

**Interfaces:**
- Produces: `ResumeImportService.createBatch`, `uploadItem`, `getBatch`, `listBatches`, `cancelBatch`.
- Produces: `MemoryResumeImportStore` and `PostgresResumeImportStore` implementing `ResumeImportStore`.

- [ ] **Step 1: Write failing service tests** for create, successful upload, retry idempotency, failure isolation and cancel retention.
- [ ] **Step 2: Run** `npm --prefix apps/api test -- resume-import.test.js` and verify missing implementation failure.
- [ ] **Step 3: Implement** the in-memory store, PostgreSQL store and service using existing `RecruitingService` methods.
- [ ] **Step 4: Add migration** with organization scope, item uniqueness and status constraints.
- [ ] **Step 5: Run focused tests** and verify PASS.
- [ ] **Step 6: Commit** the batch store, service and migration.

### Task 3: API routes and upload body limit

**Files:**
- Modify: `apps/api/src/routes.ts`
- Modify: `apps/api/src/body.ts`
- Modify: `web/src/shared/api/client.ts`
- Modify: `web/src/shared/api/index.ts`
- Create: `apps/api/tests/resume-import-batches.test.ts`

**Interfaces:**
- Consumes: `ResumeImportService`.
- Produces: batch create/detail/list/cancel routes and item content upload route.

- [ ] **Step 1: Write failing route tests** for create, detail, per-item upload, cancel and 10 MB body handling.
- [ ] **Step 2: Run focused API tests** and verify routes are missing.
- [ ] **Step 3: Implement routes** under `/api/v1/resume-import-batches`.
- [ ] **Step 4: Extend workspace-scoped path detection and resume body limit** for item content.
- [ ] **Step 5: Run focused route tests** and verify PASS.
- [ ] **Step 6: Commit** the API surface.

### Task 4: Three-lane upload and progress UI

**Files:**
- Modify: `web/src/modules/candidates/api/index.ts`
- Modify: `web/src/modules/candidates/pages/CandidateListPage.vue`
- Modify: `web/src/modules/candidates/pages/CandidateListPage.batch-upload.test.ts`
- Modify: `web/src/modules/candidates/pages/CandidateListPage.test.ts`

**Interfaces:**
- Consumes: `runResumeUploadQueue` and batch API functions.
- Produces: per-file upload percentage, retry, cancel and restored batch progress.

- [ ] **Step 1: Write failing page tests** for three-lane dispatch, progress rows, cancel and restored batch.
- [ ] **Step 2: Run focused Web tests** and verify old serial implementation fails them.
- [ ] **Step 3: Implement batch API helpers and XHR progress upload.**
- [ ] **Step 4: Replace serial loop with three-lane scheduler and batch polling.**
- [ ] **Step 5: Add cancel and localStorage recovery UI.**
- [ ] **Step 6: Run focused Web tests and verify PASS.**
- [ ] **Step 7: Commit** the customer-facing progress flow.

### Task 5: Full verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- None.

- [ ] **Step 1: Document batch import behavior and limits.**
- [ ] **Step 2: Run** `npm --prefix web test`.
- [ ] **Step 3: Run** `npm --prefix web run typecheck`.
- [ ] **Step 4: Run** `npm --prefix apps/api test`.
- [ ] **Step 5: Run** `git diff --check`.
- [ ] **Step 6: Commit** documentation and verification fixes.
