
# 2026-09-14 维护日志

## 管理后台审计视图补齐

- 后端新增 `GET /api/v1/workflow-events`：
  - 支持 `subjectType` 过滤（`recruitment_request` / `job` / `offer` / `onboarding`）和 `limit` 分页上限。
  - 返回 `WorkflowEventRecord` 并补充 `subjectLabel`，便于前端展示对象名称而不只显示 UUID。
- 后端 `RecruitService` 新增 `listWorkflowEvents`，从本地持久化 `workflowEvents` 读取并倒序返回。
- `apps/api/tests/api.test.ts` 新增审计视图测试，现有测试 12/12 通过。
- 前端管理后台页不再只是占位健康检查：
  - `listAdminChecks` 仍汇总 `/ready` 与 `/health`。
  - 新增 `loadWorkflowEvents` 调用 `/workflow-events`。
  - `AdministrationPage.vue` 新增「流程审计记录」表格和实体筛选。
  - 表格展示时间、实体类型、对象、动作、状态流转、操作人、原因。
- 新增 web/src/modules/administration/api/index.test.ts 与 web/src/modules/administration/pages/AdministrationPage.test.ts，前端测试增至 25/25。
- 新增 web/src/modules/offers/api/index.test.ts，覆盖 Offer 列表映射、详情当前版本、状态收紧和修订/过期 API 调用。

## 验证结果

- `npm --prefix apps/api run build`：通过。
- `npm --prefix apps/api test`：12/12 通过。
- `npm --prefix web run typecheck`：通过。
- `npm --prefix web test -- --run`：25/25 通过（`window.scrollTo` 为 jsdom 已知噪音，非失败）。
- `npm --prefix web run build`：通过（110 modules transformed）。

## 运行状态

- API：`http://127.0.0.1:3100`（health=200，已重启加载 `/workflow-events`）。
- Web：`http://localhost:5174`（200）。




## 后续批次：扩展现有审计覆盖面

- `WorkflowEventRecord.subjectType` 扩展为 `candidate` / `application` / `interview`。
- 后端新增工作流事件生成：
  - 创建候选人、创建职位申请、申请状态变更。
  - 创建面试、提交面试反馈、锁定面试反馈、完成面试。
- `listWorkflowEvents` 增加候选人、职位申请、面试对象名称解析，审计视图可读性更强。
- `GET /api/v1/workflow-events` 的 `subjectType` 过滤同步支持新实体。
- 前端管理后台：
  - `WorkflowEvent` 类型同步扩展。
  - 流程审计筛选新增：候选人、职位申请、面试。
  - 动作标签新增：变更申请状态、提交反馈、锁定反馈。
- `apps/api/tests/api.test.ts` 新增候选人/申请/面试审计事件测试，覆盖创建、状态流转、反馈生命周期。
- 本批次完成后 API 测试增至 13/13；前端测试仍为 25/25。

## 验证结果（更新）

- `npm --prefix apps/api run build`：通过。
- `npm --prefix apps/api test`：13/13 通过。
- `npm --prefix web run typecheck`：通过。
- `npm --prefix web test -- --run`：25/25 通过（`window.scrollTo` 为 jsdom 已知噪音，非失败）。
- `npm --prefix web run build`：通过（110 modules transformed）。

## 运行状态（更新）

- API：`http://127.0.0.1:3100`（health=200，已重启加载扩展审计事件）。
- Web：`http://localhost:5174`（200）。

## 后续批次：岗位说明书 / JD 审计覆盖

- `RecruitService.createSpec` 现在写入 `spec_created` 工作流事件。
- `RecruitService.createJd` 现在写入 `jd_created` 工作流事件。
- 前端管理后台动作标签补齐并统一：
  - `resume`：恢复
  - `create_job` / `job_created`：新建岗位
  - `spec_created`：新建说明书
  - `jd_created`：新建 JD
  - `confirm_spec` / `spec_confirmed`：确认说明书
  - `confirm_jd` / `jd_confirmed`：确认 JD
- `apps/api/tests/api.test.ts` 新增岗位流程审计测试，验证 `create_job`、`spec_created`、`jd_created`、`confirm_spec`、`confirm_jd`、`publish` 均可在审计视图中查询。
- 本批次完成后 API 测试增至 14/14；前端测试仍为 25/25。

## 验证结果（更新 2）

- `npm --prefix apps/api run build`：通过。
- `npm --prefix apps/api test`：14/14 通过。
- `npm --prefix web run typecheck`：通过。
- `npm --prefix web test -- --run`：25/25 通过（`window.scrollTo` 为 jsdom 已知噪音，非失败）。
- `npm --prefix web run build`：通过（110 modules transformed）。

## 运行状态（更新 2）

- API：`http://127.0.0.1:3100`（health=200，已重启加载岗位说明书/JD 审计事件）。
- Web：`http://localhost:5174`（200）。

## 后续批次：Offer / 面试上下文显示增强

- Offer 列表页由 `listOffers` 切换为 `listOfferContextRows`：
  - 同时读取 `/offers`、`/applications`、`/candidates`、`/jobs`。
  - `OfferRow` 增加 `candidate`、`job` 展示字段。
  - Offer 表格新增「候选人」「岗位」两列，保留申请编号列。
  - Offer 详情弹窗同步显示申请对应的候选人和岗位。
- Offer 新建/修订表单的申请下拉选项通过 `loadApplicationsForOffer` 补齐候选人姓名与岗位名称，避免只显示 UUID。
- 面试安排表单的申请下拉选项通过 `loadApplicationsForSchedule` 补齐候选人姓名与岗位名称。
- `web/src/modules/offers/api/index.test.ts` 新增上下文列表测试，覆盖候选人和岗位映射。
- 前端测试由 25/25 增至 26/26。

## 验证结果（本批次）

- `npm --prefix web run typecheck`：通过。
- `npm --prefix web test -- --run`：26/26 通过（`window.scrollTo` 为 jsdom 已知噪音）。
- `npm --prefix web run build`：通过（111 modules transformed）。


## 后续批次：入职归档模块补齐

- 后端新增 `GET /api/v1/onboarding` 与 `GET /api/v1/onboarding/:id`，用于列出入职归档记录和查看详情。
- `RecruitService` 新增 `listOnboarding`、`getOnboarding`，从本地持久化数据读取已归档 Offer 的候选人、岗位及入职信息。
- 前端新增 `web/src/modules/onboarding/`：
  - `api/index.ts` 定义入职状态、数据类型和上下文映射函数。
  - `listOnboardingRows` 同时读取 `/onboarding`、`/applications`、`/candidates`、`/jobs`、`/offers`，补齐候选人姓名、岗位名称与 Offer 状态。
  - 新增 `OnboardingTable.vue` 和 `OnboardingListPage.vue`，用于入职归档列表与详情展示。
- 前端路由新增 `/onboarding`：
  - 标题「入职归档」，导航名「入职归档」，分组在「录用」下。
  - 与原始招聘流程中的「入职归档」对齐，不新增非设计页面。
- 测试补齐：
  - `apps/api/tests/api.test.ts` 新增入职归档列表/详情覆盖。
  - `web/src/modules/onboarding/api/index.test.ts` 新增上下文映射和异常回退覆盖。
  - `web/src/app/router.test.ts` 同步加入 `/onboarding` 预期导航项。

## 验证结果（入职归档批次）

- `npm --prefix apps/api run build`：通过。
- `npm --prefix apps/api test`：15/15 通过。
- `npm --prefix web run typecheck`：通过。
- `npm --prefix web test -- --run`：28/28 通过（`window.scrollTo` 为 jsdom 已知噪音，非失败）。
- `npm --prefix web run build`：通过（118 modules transformed）。


## 后续批次：前端认证与会话 UI 补齐

- 前端新增 `web/src/modules/auth/`：
  - `api/index.ts` 封装 `/auth/login`、`/auth/logout`、`/me`。
  - `session.ts` 全局维护当前用户、会话方式和会话 ID。
  - `pages/LoginPage.vue` 提供本地开发登录页，支持错误提示、自动跳转和默认开发账号。
- 路由新增 `/login`：
  - `hideInNav: true`，不进入主导航。
  - `hideShell: true`，登录页使用独立布局，不显示侧边栏/顶栏。
- `App.vue` 在挂载时读取 `/me`，根据路由 meta 决定是否渲染 `AppShell`。
- `TopBar.vue` 显示当前账号姓名与退出按钮，未登录时显示登录入口。
- `navigationItems` 过滤 `meta.hideInNav`，保持主导航与业务页面不变。
- 新增 `web/src/modules/auth/api/index.test.ts`，覆盖登录、当前用户和退出 API 调用。
- 本次后端无需变更；认证接口与开发 bootstrap 逻辑已存在。

## 验证结果（认证 UI 批次）

- `npm --prefix web run typecheck`：通过。
- `npm --prefix web test -- --run`：31/31 通过（`window.scrollTo` 为 jsdom 已知噪音）。
- `npm --prefix web run build`：通过（124 modules transformed）。
- `npm --prefix apps/api test`：未变更，保持 15/15 通过。


## 后续批次：面试详情补齐

- 后端新增 `GET /api/v1/interviews/:id`，返回面试基础信息、关联申请、反馈状态和完整反馈列表。
- `RecruitingService` 新增 `getInterview(id)`：
  - 未找到面试返回 404。
  - 返回反馈状态优先级：全部锁定为 `locked`，否则取第一条反馈状态，无反馈为 `pending`。
  - 保留 `applicationOrThrow` 的关联一致性校验。
- 前端面试模块新增：
  - `getInterview(id)` API 与 `ApiInterviewDetail` 类型。
  - `InterviewDetailPage.vue`，展示候选人、岗位、申请、轮次、类型、状态、参与人、反馈详情。
  - 面试列表表格新增「详情」入口，并触发路由跳转。
- 前端路由新增 `/interviews/:id`，标题「面试详情」，分组「面试」，不进入主导航列表。
- 测试补齐：
  - `apps/api/tests/api.test.ts` 在面试流程内新增详情读取验证。
  - `web/src/modules/interviews/api/index.test.ts` 新增读取面试详情测试。
  - 前端测试由 31/31 增至 32/32。

## 验证结果（面试详情批次）

- `npm --prefix apps/api run build`：通过。
- `npm --prefix apps/api test`：15/15 通过。
- `npm --prefix web run typecheck`：通过。
- `npm --prefix web test -- --run`：32/32 通过（`window.scrollTo` 为 jsdom 已知噪音）。
- `npm --prefix web run build`：通过（126 modules transformed）。


## 后续批次：Offer 详情补齐

- 前端新增 `web/src/modules/offers/pages/OfferDetailPage.vue`：
  - 展示 Offer 编号、状态、审批状态、候选人、岗位、申请、版本和当前版本内容。
  - 通过 `/applications`、`/candidates`、`/jobs` 补齐候选人姓名和岗位名称，避免只显示 UUID。
  - 展示 Offer 版本历史，支持返回 Offer 列表。
- 前端路由新增 `/offers/:id`，标题「Offer 详情」，分组「录用」，不进入主导航列表。
- 后端无需变更，`GET /api/v1/offers/:id` 已可用。
- 测试保持通过：前端 32/32，API 15/15。

## 验证结果（Offer 详情批次）

- `npm --prefix web run typecheck`：通过。
- `npm --prefix web test -- --run`：32/32 通过（`window.scrollTo` 为 jsdom 已知噪音）。
- `npm --prefix web run build`：通过（128 modules transformed）。
- `npm --prefix apps/api test`：未变更，保持 15/15 通过。

## 后续批次：岗位说明书 / JD 版本历史

- 后端状态新增 `jobSpecVersions`、`jobDescriptionVersions`：
  - 旧数据迁移时从现有 `jobs[].spec` / `jobs[].jd` 补生成初始版本，种子岗位同步补齐首版。
- `RecruitService.createSpec` / `createJd` 在生成新版本时将上一版本写入历史，确保当前版本与历史版本不丢失。
- 后端新增 `RecruitService.listJobSpecVersions` / `listJobDescriptionVersions`。
- `GET /api/v1/jobs/:id/spec-versions` 与 `GET /api/v1/jobs/:id/jd-versions` 已开放，按版本号倒序返回历史记录。
- 前端岗位模块新增：
  - `ApiJobSpecVersion` / `ApiJobJdVersion` 类型。
  - `listJobSpecVersions(id)` / `listJobDescriptionVersions(id)` API。
  - `JobDetailPage.vue` 展示「说明书版本历史」和「JD 版本历史」表格，并在新建说明书/JD 后自动刷新历史。
- 测试补齐：
  - `apps/api/tests/api.test.ts` 在岗位事务链路中验证版本历史读取。
  - 前端既有测试全部通过，岗位页面类型检查通过。

## 验证结果（岗位说明书 / JD 版本历史批次）

- `npm --prefix apps/api run build`：通过。
- `npm --prefix apps/api test`：15/15 通过。
- `npm --prefix web run typecheck`：通过。
- `npm --prefix web test -- --run`：33/33 通过（`window.scrollTo` 为 jsdom 已知噪音，非失败）。
- `npm --prefix web run build`：通过（128 modules transformed）。


## 后续批次：简历上传二进制文件支持

- 后端 `RecruitService.createResume` 支持 `encoding: 'utf8' | 'base64'`：
  - 通过 `Buffer` 解码内容，避免二进制简历被按 UTF-8 文本破坏。
  - 文件大小按实际字节校验，超过 10 MB 返回 `RESUME_TOO_LARGE`。
  - 哈希改为对字节内容计算，避免转码前后不一致。
  - 文件扩展名根据原文件名和 MIME 推断，不再固定 `.txt`。
- 前端候选人详情页：
  - 新增 `fileToBase64`，上传简历时读取为 base64。
  - 简历上传接口类型增加 `encoding?: 'utf8' | 'base64'`。
- API 测试新增 base64 简历上传断言，验证 `resume.doc` 的字节大小、MIME 和扩展名。
- 验证：
  - `npm --prefix apps/api run build`：通过。
  - `npm --prefix apps/api test`：15/15 通过。
  - `npm --prefix web run typecheck`：通过。
  - `npm --prefix web test -- --run`：33/33 通过。
  - `npm --prefix web run build`：通过。
- API 已重启，`/api/v1/health` 返回 200。


## 后续批次：候选人状态流转与档案更新

- 后端新增 `RecruitService.updateCandidate`：
  - 支持更新候选人姓名、邮箱、电话、来源与状态。
  - 状态仅允许 `active`、`archived`、`do_not_contact`。
  - 更新时写入 `updatedAt`。
  - 新增工作流事件：状态变化写 `status_changed`，仅基本信息变化写 `update`。
- 路由新增 `PATCH /api/v1/candidates/:id`。
- 前端候选人详情页：
  - 新增候选人状态操作区，支持恢复有效、归档、设为请勿联系。
  - 状态按钮调用 `updateCandidate`，完成后刷新详情并显示反馈。
- 测试补齐：
  - API 测试覆盖候选人归档、非法状态 400、恢复有效，以及候选人的 `status_changed` 工作流事件。
  - 前端测试保持通过。
- 验证：
  - `npm --prefix apps/api run build`：通过。
  - `npm --prefix apps/api test`：15/15 通过。
  - `npm --prefix web run typecheck`：通过。
  - `npm --prefix web test -- --run`：33/33 通过。
  - `npm --prefix web run build`：通过。
- API 已重启，`/api/v1/health` 返回 200。


## 后续批次：候选人标签与人才库筛选

- 后端类型与状态：
  - `CandidateRecord` 新增 `tags?: string[]`。
  - `RecruitingStoreState` 新增 `candidateTags: string[]`。
  - 种子候选人补充标签，迁移逻辑在旧状态缺少 `candidateTags` 时补默认标签。
- 后端服务：
  - `CreateCandidateInput` / `UpdateCandidateInput` 支持 `tags`。
  - 新增 `normalizeTags`，清洗、去重并过滤空标签。
  - `createCandidate` 持久化标签。
  - `updateCandidate` 支持更新标签，并同步合并到 `candidateTags` 标签池。
  - 新增 `listCandidateTags()`，返回当前人才库标签池。
- 后端路由：
  - 新增 `GET /api/v1/candidate-tags`。
  - 候选人详情仍通过 `PATCH /api/v1/candidates/:id` 更新标签。
- 前端候选人模块：
  - API 类型新增 `tags`，新增 `loadCandidateTags()`，`updateCandidate` 支持 `tags`。
  - 候选人列表新增标签列和标签筛选。
  - 新建候选人表单支持填写逗号分隔标签。
  - 候选人详情新增标签展示与编辑入口，保存后同步刷新标签池。
- 共享类型与演示数据：
  - `Candidate` 类型新增 `tags?: string[]`。
  - 演示候选人补齐标签，保证非数据库路径也可展示。
- 验证：
  - `npm --prefix apps/api run build`：通过。
  - `npm --prefix apps/api test`：15/15 通过。
  - `npm --prefix web run typecheck`：通过。
  - `npm --prefix web test -- --run`：33/33 通过。
  - `npm --prefix web run build`：通过。

## 后续批次：招聘概览汇总 API

- 后端新增 `RecruitingService.getDashboardSummary()`：
  - 汇总申请漏斗、指标、待审批需求、待反馈面试、失败分析任务。
  - 指标保留收到申请、通过筛选、进入面试、发出 Offer；漏斗保留五阶段转化。
  - 待反馈面试从 `interviews` 关联 `interviewFeedback`、`applications`、`candidates`、`jobs`，补齐候选人姓名与岗位名称。
- 后端新增 `GET /api/v1/dashboard/summary`：
  - 已加入受保护路径 `protectedPaths`。
  - 已加入统一鉴权块并返回 `DashboardSummary`。
- 前端工作台切换到真实汇总接口：
  - `web/src/modules/dashboard/api/index.ts` 从原来的 `/reports` + `/recruitment-requests?status=pending_approval` 切换为单次 `GET /dashboard/summary`。
  - 新增 `pendingFeedback`、`failedTasks` 契约字段，`funnel` 使用汇总接口返回值。
- 前端招聘概览页新增：
  - 「待审批需求」继续展示审批人与状态。
  - 「待反馈面试」展示候选人、岗位、轮次、反馈状态，可点击进入面试详情。
  - 「失败分析任务」展示任务编号、状态、尝试次数与失败原因。
- 测试更新：
  - `web/src/modules/dashboard/api/index.test.ts` 改为断言 `/dashboard/summary` 与三类待办数据。
- 验证：
  - `npm --prefix apps/api run build`：通过。
  - `npm --prefix apps/api test`：15/15 通过。
  - `npm --prefix web run typecheck`：通过。
  - `npm --prefix web test -- --run`：33/33 通过（`window.scrollTo` 为 jsdom 已知噪音，非失败）。
  - `npm --prefix web run build`：通过（128 modules transformed）。
- API 已重启，`/api/v1/health` 返回 200；已用会话 Cookie 验证 `GET /api/v1/dashboard/summary` 返回指标、漏斗、待审批需求、待反馈面试、失败分析任务。

## 后续批次：招聘报表核心聚合指标

- 后端 `RecruitingService.getReports()` 扩展三类核心指标：
  - `recruitmentCycle`：从 `applications` / `offers` / `onboarding` 推导已入职人数、平均入职天数与中位入职天数。
  - `feedbackCompletion`：统计应完成反馈与已锁定反馈数量，并计算完成率。
  - `offerAcceptance`：统计已发送与已接受 Offer，并计算接受率。
- 后端 `RecruitingReport` 契约同步补充 `recruitmentCycle`、`feedbackCompletion`、`offerAcceptance` 字段。
- API 测试新增招聘周期、反馈完成度、Offer 接受率三类断言。
- 前端 `web/src/modules/reports/api/index.ts` 契约镜像同步新字段。
- 前端 `ReportOverviewPage.vue` 新增三块指标区：
  - 「招聘周期」展示已入职人数、平均入职天数、中位入职天数。
  - 「面试反馈完成度」展示已锁定反馈、应完成反馈、完成率。
  - 「Offer 接受率」展示已发送、已接受与接受率。
- 验证：
  - `npm --prefix apps/api run build`：通过。
  - `npm --prefix apps/api test`：15/15 通过。
  - `npm --prefix web run typecheck`：通过。
  - `npm --prefix web test -- --run`：33/33 通过（`window.scrollTo` 为 jsdom 已知噪音，非失败）。
  - `npm --prefix web run build`：通过（128 modules transformed）。
- API 已重启，`/api/v1/health` 返回 200；用会话 Cookie 验证 `GET /api/v1/reports` 返回：
  - `recruitmentCycle.hiredCount = 1`。
  - `feedbackCompletion.expected = 1, locked = 1`。
  - `offerAcceptance.sent = 1, accepted = 1`。


## 后续批次：面试与 Offer 详情操作闭环及测试补齐

- 前端 `InterviewDetailPage.vue` 由只读详情升级为可操作详情：
  - 支持直接填写并锁定面试反馈。
  - 支持对已安排或已完成面试执行完成结论（下一轮 / Offer / 淘汰）。
  - 操作成功后刷新详情，保持面试中心已有业务能力一致。
- 前端 `OfferDetailPage.vue` 由只读详情升级为可操作详情：
  - 支持草稿修订、提交审批、审批通过/驳回、发送、接受、拒绝、过期、取消、入职归档。
  - 下拉状态操作区根据当前 Offer 状态展示合法动作。
  - 修订后刷新版本和当前版本内容，不再要求用户回到列表处理详情。
- 前端测试补齐：
  - 新增 `reports/api/index.test.ts`：断言 `/reports` 返回招聘周期、面试反馈完成度、Offer 接受率。
  - 新增 `reports/pages/ReportOverviewPage.test.ts`：渲染三类指标并支持错误重试。
  - 新增 `jobs/api/index.test.ts`：证明岗位说明书、JD、版本历史和动作均走真实 API。
  - 新增 `candidates/api/index.test.ts`：覆盖候选人读取、状态更新、标签保留、人工复核分析结果与详情数据结构。
- 验证：
  - `npm --prefix web run typecheck`：通过。
  - `npm --prefix web test -- --run`：45/45 通过（`window.scrollTo` 为 jsdom 已知噪音，非失败）；面试详情「完成面试」已放开到 `scheduled` / `completed` 状态。
  - `npm --prefix web run build`：通过。
  - `npm --prefix apps/api run build`：通过。
  - `npm --prefix apps/api test`：15/15 通过。



