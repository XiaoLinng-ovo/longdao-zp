# 前端模块化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立独立的 Vue 3 + TypeScript + Vite 前端，将招聘演示页面按业务域拆分为可直接访问的 8 个路由模块。

**Architecture:** 新建 `web/` 前端工程，使用 Vue Router 组织懒加载页面，使用 `shared/data` 的只读演示 DTO 和各模块 API 适配层隔离数据来源。应用壳、共享组件和业务页面分开维护；旧 `index.html` 与后端入口保持不变。

**Tech Stack:** Vue 3、TypeScript strict、Vite、Vue Router 4、原生 CSS、Vitest。

## Global Constraints

- 新工程位于仓库根目录 `web/`，不修改旧 `index.html`、`server.mjs` 或 Cloudflare Functions。
- 页面不得直接读取或写入旧页面全局 `state`，不得直接调用 `fetch`。
- 首批数据只读；不得包含模型 API Key 输入、持久化或直接模型调用。
- 8 个路由必须支持直接访问、刷新和侧边栏切换。
- 共享组件不包含招聘流程判断；TypeScript 启用严格模式。
- 必须提供 `dev`、`build`、`typecheck`、`test` 命令。

---

### Task 1: Web 工程与应用壳

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`
- Create: `web/src/main.ts`, `web/src/App.vue`
- Create: `web/src/app/router.ts`, `web/src/app/routes.ts`, `web/src/app/navigation.ts`
- Create: `web/src/app/layout/AppShell.vue`, `web/src/app/layout/SidebarNav.vue`, `web/src/app/layout/TopBar.vue`
- Create: `web/src/shared/styles/base.css`, `web/src/shared/styles/layout.css`
- Test: `web/src/app/router.test.ts`

**Interfaces:**
- Produces `createAppRouter()` and `navigationItems` consumed by all page modules.
- Route metadata shape: `{ title: string; navLabel: string; icon: string }`.

- [ ] **Step 1: Create package and strict compiler configuration**

Add scripts `dev`, `build`, `typecheck`, `test`; configure Vite Vue plugin and strict TypeScript including `src/**/*.ts` and `src/**/*.vue`.

- [ ] **Step 2: Implement router and route metadata**

Define routes `/`, `/requisitions`, `/jobs`, `/candidates`, `/interviews`, `/offers`, `/reports`, `/administration`; use dynamic imports for each page and redirect unknown paths to `/`.

- [ ] **Step 3: Implement responsive shell**

Build sidebar navigation from `navigationItems`, top bar title from route meta, and a responsive main content slot. Use CSS media query at 760px to collapse sidebar into a horizontal menu.

- [ ] **Step 4: Add router tests and verify**

Test route paths, titles, unknown-route redirect, and metadata. Run `pnpm --dir web test -- --run src/app/router.test.ts` and `pnpm --dir web typecheck`.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat: scaffold modular vue frontend"
```

### Task 2: Shared Types, Demo Data and UI Components

**Files:**
- Create: `web/src/shared/types/recruiting.ts`
- Create: `web/src/shared/data/demo-recruiting-data.ts`
- Create: `web/src/shared/components/StatusTag.vue`, `PageHeader.vue`, `MetricCard.vue`, `EmptyState.vue`, `DataTable.vue`
- Create: `web/src/shared/styles/components.css`
- Create: `web/src/modules/*/api/index.ts` for all 8 modules
- Test: `web/src/shared/data/demo-recruiting-data.test.ts`

**Interfaces:**
- `DemoRecruitingData` exports readonly arrays: `metrics`, `requisitions`, `jobs`, `candidates`, `interviews`, `offers`, `reports`, `adminChecks`.
- Module API functions are synchronous now, e.g. `listCandidates(): readonly CandidateSummary[]`.

- [ ] **Step 1: Define DTO types and seed data**

Create typed readonly records derived from current demo concepts, including status, owner, updatedAt and summary fields. Keep data synthetic and free of secrets.

- [ ] **Step 2: Implement module API adapters**

Each module exports one list/read function that returns the relevant readonly slice from `DemoRecruitingData`; no page imports the data file directly.

- [ ] **Step 3: Build shared presentation components**

Implement typed props, accessible table headers, status color mapping by semantic status family, loading/empty variants, and compact responsive styling.

- [ ] **Step 4: Test data immutability and adapter output**

Verify every module adapter returns expected records and data is not mutated by a consumer. Run `pnpm --dir web test -- --run src/shared/data/demo-recruiting-data.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add web/src/shared web/src/modules/*/api
git commit -m "feat: add recruiting demo data adapters"
```

### Task 3: Core Recruitment Pages (parallel)

**Files:**
- Create: `web/src/modules/dashboard/pages/DashboardPage.vue`, `web/src/modules/dashboard/components/FunnelSummary.vue`
- Create: `web/src/modules/requisitions/pages/RequisitionListPage.vue`, `web/src/modules/requisitions/components/RequisitionTable.vue`
- Create: `web/src/modules/jobs/pages/JobListPage.vue`, `web/src/modules/jobs/components/JobTable.vue`
- Create: `web/src/modules/candidates/pages/CandidateListPage.vue`, `web/src/modules/candidates/components/CandidateTable.vue`

**Interfaces:**
- Pages consume only their module `api/index.ts` functions and shared components.
- Pages expose no write handlers; unavailable actions render disabled state with a concise reason.

- [ ] **Step 1: Implement dashboard**

Render metric cards, pending approvals list and funnel summary from dashboard API.

- [ ] **Step 2: Implement requisition list**

Render department, headcount, budget, approver and status columns with local status filter.

- [ ] **Step 3: Implement job list**

Render title, department, JD status, publishing channels and updated time.

- [ ] **Step 4: Implement candidate list**

Render candidate, applied job, score, AI analysis status and application status; preserve independent application status wording.

- [ ] **Step 5: Build and smoke-test core pages**

Run `pnpm --dir web typecheck` and `pnpm --dir web build`.

- [ ] **Step 6: Commit**

```bash
git add web/src/modules/dashboard web/src/modules/requisitions web/src/modules/jobs web/src/modules/candidates
git commit -m "feat: add core recruiting pages"
```

### Task 4: Workflow, Reporting and Administration Pages (parallel)

**Files:**
- Create: `web/src/modules/interviews/pages/InterviewListPage.vue`, `web/src/modules/interviews/components/InterviewTable.vue`
- Create: `web/src/modules/offers/pages/OfferListPage.vue`, `web/src/modules/offers/components/OfferTable.vue`
- Create: `web/src/modules/reports/pages/ReportOverviewPage.vue`, `web/src/modules/reports/components/ReportMetricGrid.vue`
- Create: `web/src/modules/administration/pages/AdministrationPage.vue`, `web/src/modules/administration/components/SecurityNotice.vue`

**Interfaces:**
- Pages consume only their module adapters and shared components.
- Administration page displays configuration categories and secure-key status without any secret input.

- [ ] **Step 1: Implement interview list**

Show candidate, job, round, scheduled time, interviewers and feedback status.

- [ ] **Step 2: Implement offer list**

Show candidate, job, approval status, delivery status, response and updated time.

- [ ] **Step 3: Implement reports overview**

Show funnel counts, channel comparison, average cycle days and AI usage summary using compact tables and metric cards.

- [ ] **Step 4: Implement administration overview**

Show users/roles, workflow, model provider, storage, notifications and audit categories; key row only shows configured/disabled and last rotation date.

- [ ] **Step 5: Verify**

Run `pnpm --dir web typecheck` and `pnpm --dir web build`.

- [ ] **Step 6: Commit**

```bash
git add web/src/modules/interviews web/src/modules/offers web/src/modules/reports web/src/modules/administration
git commit -m "feat: add workflow reporting and admin pages"
```

### Task 5: Integration, Responsive Review and Documentation

**Files:**
- Modify: `web/src/App.vue`, `web/src/app/layout/*`, `web/src/shared/styles/*`
- Create: `web/README.md`
- Test: `web/src/integration/navigation.test.ts`

**Interfaces:**
- All route modules are reachable from `navigationItems` and render inside `AppShell`.

- [ ] **Step 1: Add navigation integration test**

Mount the router and assert every navigation item resolves to a page component and route changes update document title.

- [ ] **Step 2: Polish responsive layout**

Check 1440px and 390px widths; ensure sidebar/menu, tables, headings and status tags do not overlap or overflow. Use horizontal table scrolling where needed.

- [ ] **Step 3: Document local development**

Document `pnpm install`, `pnpm dev`, `pnpm build`, `pnpm typecheck`, and the fact that old root `index.html` remains the legacy demo.

- [ ] **Step 4: Run complete verification**

Run `pnpm --dir web test -- --run`, `pnpm --dir web typecheck`, `pnpm --dir web build`, and `git diff --check`.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "test: verify modular frontend navigation"
```
