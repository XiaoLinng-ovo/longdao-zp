# 2026-09-11 维护日志

## 需求详情路由修复

- `web/src/app/routes.ts` 新增 `/requisitions/:id` → `requisition-detail`，招聘需求列表可点开进入需求详情页，不再是"点不开"的死入口。
- 需求列表接入详情跳转，保留原有需求审批状态机与暂停/关闭原因动作。

## 面试管理与 Offer 管理真实交互改造

- 面试中心、Offer 管理补齐真实交互，移除残留的 `window.prompt` 占位。
- 保留现有后端状态机调用，不另造业务规则。

## 岗位列表 pause/close 原因模态框

- 岗位列表的暂停/关闭动作补齐原因填写模态框，移除全项目最后一个 `window.prompt` 残留。
- 动作仍走现有 `jobAction` 后端路线。

## 岗位说明书 / JD 创建入口

- `web/src/modules/jobs/components/JobTable.vue`：新增 `openDoc` 事件；无说明书时显示"新建说明书"，无 JD 时显示"新建 JD"。
- `web/src/modules/jobs/pages/JobListPage.vue`：新增 `openDoc(row, kind)`，跳转 `job-detail` 并携带 `query.doc`。
- `web/src/modules/jobs/pages/JobDetailPage.vue`：`onMounted` 依据 `route.query.doc` 自动打开对应表单；新增空状态引导卡片；确认/发布逻辑未改动。
- 后端已有 `POST /api/v1/jobs/:id/spec` 与 `/jd` 路线复用，不新增 schema。

## 候选人详情 / 操作入口

- 后端 `getCandidate(id)` 返回候选人 + `applications` + `resumes` + `analysisResults` + `jobs` 映射；路由新增 `GET /api/v1/candidates/:id`。
- 前端候选人 API 新增 `getCandidate`、`updateApplicationStatus`。
- `CandidateTable` 新增 `open` 事件与"详情"按钮；`CandidateListPage` 跳转 `candidate-detail`。
- 新建 `web/src/modules/candidates/pages/CandidateDetailPage.vue`：基础信息、申请记录、推进/淘汰/撤回动作（淘汰必填原因、撤回可选原因）、简历/AI 分析结果摘要。
- 复用 `PageHeader`、`PageFeedback`、`StatusTag`、`describeApiFailure` 等共享组件。
- 注册 `/candidates/:id` → `candidate-detail` 路由。

## 验证结果

- `npm --prefix web run typecheck`：通过。
- `npm --prefix web run build`：通过，`108 modules transformed`。
- `npm --prefix web test -- --run`：19/19 通过（`window.scrollTo` 为 jsdom 已知噪音，非失败）。
- `npm --prefix apps/api run build`：通过。
- `npm --prefix apps/api test`：10/10 通过。
- API 冒烟：`GET /api/v1/health` → `ok`；`GET /api/v1/candidates` → count=4；重启后 `GET /api/v1/candidates/candidate-8821` → `apps=1 resumes=0 results=0 jobs=1`。

## 运行状态

- API：`http://127.0.0.1:3100`（已重启以加载 `GET /candidates/:id` 新路由）。
- Web：`http://localhost:5174`。

## 待继续

- 岗位说明书/JD 创建入口已具备，但草稿持久化与发布审批仍需与后端 `spec`/`jd` 写入链路进一步联调核对。
- 候选人详情推进动作（新建申请、简历上传）后续可在详情页补内联入口，当前列表页仍保留完整创建/上传能力。
- 按设计文档继续推进剩余模块（面试反馈锁定、Offer 审批链、报表看板、系统配置）的细节补全。

## 2026-09-11 第二批：候选人详情闭环 + Offer 状态反馈

### 候选人详情页补齐业务闭环
- `web/src/modules/candidates/pages/CandidateDetailPage.vue` 重写为完整业务页：
  - 新增「新建申请」弹窗（复用 `loadJobs` + `createApplication`），自动排除已申请岗位，避免与后端 `APPLICATION_ALREADY_EXISTS` 冲突。
  - 新增「上传简历并分析」内联表单（复用 `uploadResume`/`processAnalysisTask`/轮询 `getAnalysisResult`），上传后定位到新分析结果并引导人工复核。
  - 每条 AI 分析结果新增「人工复核」入口（`reviewAnalysisResult` 的 accepted / needs_correction）。
  - 保留原推进/淘汰/撤回状态机动作与原因必填校验。
- 未新增后端命令，全部复用已有领域 API 与状态机。

### Offer 操作反馈显示当前状态
- `web/src/modules/offers/api/index.ts` 新增 `offerStatusCode` 类型收窄工具。
- `web/src/modules/offers/pages/OfferListPage.vue` 的 `runAction` 使用返回的 `ApiOffer.status` 展示「XX成功，当前状态 YY」，而非仅显示「XX成功」。

### 验证结果
- `npm --prefix web run typecheck`：通过。
- `npm --prefix web run build`：通过（108 modules transformed）。
- `npm --prefix web test -- --run`：19/19 通过。
- API 冒烟：`GET /api/v1/candidates` → 4 条；`GET /api/v1/offers` → 0 条（尚无 Offer 草稿，属预期）。

### 运行状态
- API：`http://127.0.0.1:3100`（health=200）。
- Web：`http://localhost:5174`（200）。

## 2026-09-11 第三批：岗位说明书/JD 闭环入口与工作台待办跳转

### 修复「没有创建岗位说明书的地方」链路
- 复核结论：后端岗位说明书/JD 的创建 → 确认 → 发布状态机已完整实现并被集成测试覆盖（\pps/api/tests/api.test.ts\ 中 spec → jd → confirm-spec → confirm-jd → publish 全闭环断言通过）。
- 前端入口由此前批次已具备：「岗位列表」无说明书时显示「新建说明书」、无 JD 时显示「新建 JD」，点击跳转详情页并自动打开对应表单；表单保存走现有 \POST /jobs/:id/spec\、\POST /jobs/:id/jd\，确认/发布走现有 \jobAction\。本轮核对后确认该链路不再是死入口。

### 修复「需求详情 → 新建关联岗位」跳转失效
- 根因：\RequisitionDetailPage.openConvert\ 使用不存在的命名路由 \job-list\，导致点击无响应。
- 修复：改用 \outer.push({ path: '/jobs', query: { recruitmentRequestId, create: '1' } })\。
- \JobListPage\ 同步支持：
  - 读取 \oute.query.recruitmentRequestId\ 预填「新建岗位」表单的关联需求；
  - 读取 \oute.query.create === '1'\ 在刷新后自动打开新建岗位弹窗。
- 现在需求「新建关联岗位」可一键直达岗位创建并带上已通过需求 ID。

### 工作台待办需求可点入详情
- \DashboardPage\ 的「待处理需求」整行可点击，并保留标题链接样式，跳转 \equisition-detail\（使用 \ntityId\ 作为主键）。
- 新增键盘可访问（\ole=link\、\	abindex=0\、回车触发）与聚焦/悬停样式。

### 验证结果
- \
pm --prefix web run typecheck\：通过。
- \
pm --prefix web run build\：通过。
- \
pm --prefix web test -- --run\：19/19 通过。
- 后端 \pps/api/tests/api.test.ts\ 已覆盖岗位说明书/JD 闭环（无需新增测试，按验收口径计入）。

### 运行状态
- API：\http://127.0.0.1:3100\（health=200）。
- Web：\http://localhost:5174\（200）。

## 2026-09-11 第四批：Offer 状态机补全（驳回/修订/过期 + 审计事件）

### 背景
- 按设计规划 `docs/superpowers/specs/2026-09-09-smartrecruit-platform-design-roadmap.md` 阶段 F 要求，Offer 需支持版本化、审批、发送、接受、拒绝、过期、取消与入职归档审计。
- 现状核对：本地领域层此前只支持 `submit-approval → approve → send → accept/decline/cancel` 与 `archive-onboarding`，缺少 `reject`（审批驳回）、`expire`（过期）、草稿版本化修订，且 Offer/入职的 `workflowEvents` 审计事件未写入。

### 后端变更
- `apps/api/src/recruiting/service.ts`
  - `updateOffer`：由仅允许修改 title/content 扩展为完整可修订字段（positionTitle/departmentId/employmentType/startDate/baseSalary/bonus/equity/benefits/content），保持 draft-only 约束与 `OFFER_IMMUTABLE`；修订即新增版本并写 `revise` 审计事件。
  - `offerAction`：
    - 新增 `reject`（pending_approval → draft，必填原因，写 `approval.status=rejected` + comment + actedAt）。
    - 新增 `expire`（sent → expired，记录 `expiresAt`）。
    - `approve`/`reject`/`cancel` 同步维护 `approval` 子记录；accept/decline 写 `respondedAt`。
    - 所有转换与 `archive_onboarding` 均写入 `workflowEvents`（subjectType=`offer`/`onboarding`），补齐审计链路。

### 前端变更
- `web/src/modules/offers/api/index.ts`：`OfferAction` 增加 `reject`/`expire`；`OFFER_ACTION_LABEL` 补齐；新增 `updateOffer(id, input)` 调 `PATCH /offers/:id`。
- `web/src/modules/offers/components/OfferTable.vue`：`pending_approval` 增加「审批驳回」，`sent` 增加「标记过期」，`draft` 行显示「修订」按钮并新增 `revise` 事件。
- `web/src/modules/offers/pages/OfferListPage.vue`：新增修订弹窗（自动载入当前版本并支持全字段编辑），`submitRevise` 走 `updateOffer`，成功后刷新列表。

### 测试
- `apps/api/tests/api.test.ts` 新增「supports offer rejection, draft revision, and expiry」集成用例：draft 修订产生 v2 版本、reject 必填原因并回到 draft、expire 由 sent → expired。

### 验证结果
- `npm --prefix apps/api run build`：通过。
- `npm --prefix apps/api test`：11/11 通过。
- `npm --prefix web run typecheck`：通过。
- `npm --prefix web run build`：通过。
- `npm --prefix web test -- --run`：19/19 通过（jsdom `window.scrollTo` 噪音，非失败）。
- 运行中 API 冒烟：`POST /offers` → draft；`submit-approval` → pending_approval；`reject` → draft + approval.rejected + comment；`PATCH /offers/:id` → version 递增。

### 运行状态
- API：`http://127.0.0.1:3100`（health=200，已重启加载新状态机）。
- Web：`http://localhost:5174`（200）。

### 遗留
- `workflowEvents` 尚无可查询的地面线路由/前端展示（管理后台）。事件数据已落库/落本地领域态，供后续 Phase F 尾声接管理/审计视图。
