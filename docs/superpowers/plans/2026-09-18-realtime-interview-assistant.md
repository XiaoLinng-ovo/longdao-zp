# Realtime Interview Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a persisted onsite interview session that transcribes speaker-attributed audio through a real FunASR-compatible service and analyzes completed candidate answers through the configured OpenAI-compatible model.

**Architecture:** The browser records microphone chunks and submits them to API-owned interview-session endpoints. An ASR adapter returns timestamped anonymous speakers, a deterministic role mapper assigns interview roles with confidence, and an LLM analyzer produces advisory evidence and next-question suggestions only for eligible candidate segments. PostgreSQL remains authoritative; unavailable external services fail explicitly.

**Tech Stack:** Vue 3, TypeScript, Node HTTP API, PostgreSQL migrations, MediaRecorder, FunASR-compatible HTTP service, OpenAI-compatible chat completions.

## Global Constraints

- AI never changes application status and never automatically rejects, hires, or offers.
- Browser code never receives ASR or OpenAI credentials and never calls either service directly.
- No configured external service means an explicit unavailable/failed state, never fabricated transcript or analysis.
- Existing interview feedback, locking, conclusion, and uncommitted `web/src/shared/styles/components.css` changes must remain intact.
- Version one supports an onsite shared microphone only; DingTalk/system audio and voice enrollment are out of scope.

---

### Task 1: Role Mapping and FunASR Adapter

**Files:**
- Create: `apps/api/src/interviews/role-mapper.ts`
- Create: `apps/api/src/interviews/role-mapper.test.ts`
- Create: `apps/api/src/interviews/funasr-client.ts`
- Create: `apps/api/src/interviews/funasr-client.test.ts`

**Interfaces:**
- Produce `mapInterviewRoles(segments, previous): RoleMapping[]` using anonymous speaker continuity, interview phase, question/answer semantics, and confidence.
- Produce `createFunAsrClient(config, fetchImpl).transcribe(audio): Promise<AsrSegment[]>` with explicit configuration and upstream errors.

- [ ] Write role mapping and adapter tests first; verify failures are caused by missing implementations.
- [ ] Implement minimal deterministic mapping and validated FunASR response parsing.
- [ ] Run focused API tests and commit.

### Task 2: Structured Answer Analyzer

**Files:**
- Create: `apps/api/src/interviews/answer-analyzer.ts`
- Create: `apps/api/src/interviews/answer-analyzer.test.ts`

**Interfaces:**
- Produce `createInterviewAnswerAnalyzer(env, fetchImpl)` returning `analyze(input): Promise<InterviewAnswerAnalysis>`.
- Output contains summary, evidence, dimension scores, concerns, confidence, and `nextQuestion`; it contains no hiring decision.

- [ ] Write tests for valid structured output, missing configuration, invalid JSON, and forbidden decision fields; verify red.
- [ ] Implement the single OpenAI-compatible `/chat/completions` call and strict output validation.
- [ ] Run focused API tests and commit.

### Task 3: PostgreSQL Session Model and API

**Files:**
- Create: `db/migrations/0014_realtime_interview_sessions.sql`
- Create: `apps/api/src/interviews/session-repository.ts`
- Create: `apps/api/src/interviews/session-repository.test.ts`
- Modify: `apps/api/src/routes.ts`

**Interfaces:**
- Endpoints create/read/end a session, accept transcript/audio chunks, correct speaker roles, and analyze eligible candidate segments.
- Persist session, transcript segment, question, analysis, role correction, external status, timestamps, actor, and model/prompt metadata.

- [ ] Write repository and route behavior tests first and verify red.
- [ ] Add normalized tables, constraints, repository transactions, permissions, and request validation.
- [ ] Wire Task 1 and Task 2 adapters without fallback data.
- [ ] Run API tests and PostgreSQL integration checks; commit.

### Task 4: Browser Interview Room

**Files:**
- Create: `web/src/modules/interviews/components/LiveInterviewRoom.vue`
- Create: `web/src/modules/interviews/components/LiveInterviewRoom.test.ts`
- Modify: `web/src/modules/interviews/api/index.ts`
- Modify: `web/src/modules/interviews/pages/InterviewDetailPage.vue`

**Interfaces:**
- Use MediaRecorder after one explicit start action, upload timed audio chunks, poll/refresh finalized transcript and analysis, and expose pause, resume, role correction, retry analysis, and end-session actions.

- [ ] Write component/API tests first for permission denial, recording states, transcript roles, external failure, and correction actions; verify red.
- [ ] Implement the responsive three-region interview room without changing the manual feedback flow.
- [ ] Run web unit tests, typecheck, and build; commit.

### Task 5: Integration and Acceptance

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml` if a repository-owned service profile exists
- Modify: relevant deployment documentation

- [ ] Document exact FunASR endpoint, timeout, model requirements, retention, and consent behavior.
- [ ] Run migrations against PostgreSQL and exercise create session -> transcript -> role mapping -> LLM analysis -> reload history.
- [ ] Run root build, typecheck, and tests.
- [ ] Validate `/interviews/:id` at desktop and mobile sizes; record any browser-tool limitation explicitly.
