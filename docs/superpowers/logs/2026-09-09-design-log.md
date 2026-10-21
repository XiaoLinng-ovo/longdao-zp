# SmartRecruit Pro 设计日志

> 日志日期：2026-09-09
> 记录范围：当前项目审查、Phase 1 骨架和后续设计规划

## 1. 本次审查结论

项目当前有旧 Demo 和新版模块化前端两条实现路径：

- 旧根目录入口可以演示招聘流程、简历分析和整体状态保存，适合继续作为交互参考和迁移数据来源。
- `web/` 已拆分为 8 个招聘业务模块，但模块 API 仍然直接返回 `DemoRecruitingData`，尚未连接正式 API。
- `apps/api/`、`apps/worker/`、`packages/contracts/`、`packages/resume-intelligence/`、`db/` 和 `deploy/` 已形成 Phase 1 工程边界。

## 2. 已完成事项

### 2026-09-08 至 2026-09-09

- 阅读并整理商业化招聘平台详细设计、内部招聘平台设计和前端模块化设计。
- 明确 PostgreSQL 是业务事实来源，Redis 只承担队列、缓存和锁。
- 冻结 `Candidate` 与 `Application` 分离的建模原则。
- 明确 AI 只能输出建议，不能自动淘汰、录用或发送 Offer。
- 新增 Phase 1 分阶段实施设计文档。
- 建立 `apps/api/` Node.js + TypeScript API 骨架。
- 建立统一响应格式、request id、health、ready 和未认证 `me` 响应。
- 建立 `packages/contracts/` 共享 DTO、状态枚举和 API 错误契约。
- 建立 PostgreSQL 首批迁移，覆盖用户、角色、Session、需求、审批、岗位、候选人、申请、简历、分析、工作流、Outbox 和审计表。
- 建立 Compose 基础设施配置，包含 PostgreSQL、Redis、MinIO 和 ClamAV。
- 建立 `apps/worker/` 任务信封、尝试次数、重试分类、幂等存储、简历分析处理器和健康检查。
- 建立 `packages/resume-intelligence/`，包含解析、抽取、脱敏、标准化、匹配、评分、报告和 Prompt 安全边界。
- 建立 `web/src/shared/api/`，统一处理 JSON API、request id、401/403、网络错误和协议错误。
- 建立 CandiSift/Frappe HR 来源登记和迁移矩阵。
- 增加 TypeScript 构建产物忽略规则，避免 `dist`、`dist-test` 和测试输出进入 Git。
- 增加可选的 GitHub Actions 基础设施验证入口，准备在 GitHub Runner 上验证 Compose、Migration 和服务健康状态。

## 3. 验证记录

- API 测试：4 项通过。
- Worker 测试：6 项通过。
- 简历智能测试：3 项通过。
- 前端测试：14 项通过。
- Contracts TypeScript 检查通过。
- Resume intelligence 源码和测试类型检查通过。
- Web TypeScript 检查通过。
- Web Vite 构建通过。
- 本地 Vite 页面已启动并通过浏览器检查：首页和岗位页面可加载，控制台无错误。
- 本机未安装 Docker Desktop、Docker CLI、Docker Compose 和宿主机 `psql`。
- 本机存在 `wsl.exe`，但 WSL2 没有可用发行版，虚拟化环境也未就绪。

## 4. 尚未完成事项

- 新版前端仍使用 Demo 数据，没有真实业务读写。
- 尚未实现 Session、登录、RBAC、DataScope、CSRF、Origin 校验和登录限流。
- 尚未实现招聘需求、审批、岗位和 JD 的 Repository、状态机、应用服务和正式 API。
- 尚未实现 Candidate/Application/Resume 的正式 API。
- 尚未实现文件上传、隔离桶、ClamAV 真实扫描和附件访问审计。
- Worker 尚未连接 Redis、PostgreSQL、MinIO，也没有真实租约和恢复机制。
- 尚未把简历分析结果持久化到 `analysis_results` 并接入人工复核。
- 尚未实现真实面试反馈、Offer 版本、Offer 审批、发送和入职归档。
- 报表仍是 Demo 聚合，不是 PostgreSQL 查询结果。
- 尚未执行真实 Compose、PostgreSQL Migration、Redis、MinIO 和 ClamAV 集成验证。
- 尚未完成旧 `state.json` 到 PostgreSQL 的迁移脚本和校验报告。
- 来源授权文件、固定 commit/tag、许可证和 NOTICE 仍需补齐正式证据。

## 5. 当前不做

- 不进入 Phase 2 认证和权限业务开发。
- 不在本机安装 Docker、psql 或 npm 依赖。
- 不修改旧 Demo 的业务代码和页面行为。
- 不新增完整 HRMS、薪酬、考勤、公开招聘门户、OCR、向量数据库和复杂 Agent。
- 不把 `/api/state` 扩展为正式业务写接口。

## 6. 下一步执行队列

当前设计阶段结束后，按以下顺序执行：

1. 建立招聘需求、审批、岗位和 JD 的正式 API 接口清单与状态转换测试，但暂不开放业务写入。
2. 完成 Session、RBAC、DataScope、CSRF、Origin 校验、审计上下文和登录限流等安全基线。
3. 实现对应 Repository、事务和应用服务，再开放招聘需求、审批、岗位和 JD 的正式 API。
4. 切换 `web/src/modules/requisitions` 和 `web/src/modules/jobs` 到正式 API。
5. 在 GitHub Actions 或部署环境中执行基础设施集成验证，完成第一个真实闭环验收。

## 7. 日志维护规则

每次功能开发完成后记录：

```text
日期：
完成内容：
涉及文件：
验证命令：
测试结果：
尚未完成：
下一步：
```

设计日志只记录实际完成的工作，不用计划代替结果；任何延期、降级或临时兼容方案都要写明原因。

## 8. 本轮补充记录

- 未修改业务代码，未进入 Phase 2，未安装 Docker、`psql` 或 npm 依赖。
- 使用工作区已有依赖启动新版前端：`web/` 的 Vite 服务运行在 `http://127.0.0.1:5173/`。
- 通过 HTTP 请求确认首页返回 `200`，页面入口可访问。
- 本机浏览器自动化命令不可用，因此本轮未重复执行自动化截图；此前已完成首页、岗位页面导航和控制台无错误检查。
- 当前仍未完成真实 API、数据库和基础设施集成；下一步继续按本文第 6 节队列执行。

## 9. 2026-09-09 后续执行记录

- 新增 `packages/contracts/src/workflow.ts`，集中定义招聘需求和岗位/JD 动作及状态转换规则。
- 补充 `RecruitmentRequestStatus.Withdrawn`、`RecruitmentRequestStatus.Closed`，与总体设计中的需求生命周期对齐；保留已有 `converted`、`cancelled` 兼容状态。
- 新增 `packages/contracts/tests/workflow.test.ts`，覆盖需求动作、原因校验、岗位双文档确认、发布前置条件和岗位生命周期。
- 新增 `docs/superpowers/specs/2026-09-09-recruitment-job-api-contract.md`，冻结资源边界、正式 API 清单、状态矩阵、错误映射和未实现项。
- 验证 `packages/contracts`：`npm run typecheck` 通过；`npm test` 通过，状态机自检 4 组通过。
- 新增招聘需求、岗位、岗位说明书、JD 和动作输入契约及基础字段校验；客户端输入不包含可直接覆盖的状态、审批、版本和审计字段。
- 补充命令契约校验测试，覆盖合法输入、必填字段、人数、预算上下限和岗位关联需求。
- 再次验证 `packages/contracts`：`npm run typecheck` 通过；`npm test` 通过，状态机和命令契约共 2 个测试文件、9 组断言通过。
- 本轮仍未开放 HTTP 业务写接口，未连接数据库，未进入认证/RBAC Phase 2，也未修改旧 Demo 或新版业务页面。
- 下一步：先完成安全基线设计和测试边界，再实现 Repository/事务与招聘需求、岗位 API。

## 10. 2026-09-09 业务实现记录

- 按 `0.0.1` 标签重新校准新版前端视觉：恢复深海军蓝侧栏、蓝色主色、浅灰工作区、紧凑表格、导航分组和 SmartRecruit Pro 品牌头部；没有继续沿用之前偏青绿色的壳层。
- 新增 `apps/api/src/recruiting/` 本地事务实现：需求、审批、岗位、岗位说明书、JD、工作流事件和版本字段。
- 新增正式业务 API：招聘需求列表/创建/编辑/提交/审批/驳回/撤回/关闭，岗位列表/创建/编辑/文档创建/确认/发布/暂停/恢复/关闭。
- 将 `web/src/modules/requisitions` 和 `web/src/modules/jobs` 接入真实 API；API 不可用时保留 Demo 数据降级。需求页已支持新建、审批动作和筛选，岗位页已支持文档确认和生命周期动作。
- 新增 `db/migrations/0002_recruitment_workflow_constraints.sql`，补充状态约束、文档确认字段、工作流索引和幂等记录表。
- 新增 `docs/superpowers/specs/2026-09-09-database-transaction-design.md`，记录 PostgreSQL 事务、行锁、版本、事件和本地适配器对应关系。
- 验证结果：API 5 项测试通过；前端 14 项测试、TypeScript 检查和 Vite 构建通过；contracts 类型检查和 2 个测试文件通过；本地 API 与前端 HTTP 联调均返回 200。
- 当前仍未完成：候选人、简历、面试、Offer、报表的真实 API；这些页面目前仍保留 Demo 数据。下一步优先实现候选人/Application 分离、简历上传和分析任务，再接面试和 Offer。
- 继续实现候选人/Application 第一层闭环：本地事务状态增加 `candidates` 与 `applications`，新增候选人和申请查询/创建及申请状态推进 API。
- `web/src/modules/candidates` 已从 Demo 切换为真实候选人和岗位申请查询，保留 API 不可用时的 Demo 降级。
- 当前尚未实现简历文件上传、病毒扫描、AI 分析持久化和人工复核；下一步接入 Resume/AnalysisTask。

## 11. Resume 与 AnalysisTask 业务实现

日期：2026-09-09

完成内容：

- 扩展本地事务状态，增加 `resumes`、`analysisTasks`、`analysisResults`，保持 Candidate、Application、Resume、AnalysisResult 独立建模。
- 新增 `POST/GET /api/v1/resumes`，上传内容先写入 `data/resumes/quarantine`，保存文件名、MIME、大小、SHA-256 和 `quarantined` 状态；关联申请时在事务内校验申请属于同一候选人。
- 新增 `GET /api/v1/analysis-tasks`、`POST /api/v1/analysis-tasks/:id`、`GET /api/v1/analysis-tasks/:id/result`。
- 接入本地规则分析：任务完成后写入 `analysis_results`，更新申请 `aiStatus=completed` 和建议分数，但不修改申请生命周期状态。
- 新增 `db/migrations/0003_resume_analysis_constraints.sql`，补充简历扫描状态、分析任务状态、人工复核状态约束和查询索引。
- 候选人页面补充与 `0.0.1` 视觉一致的文本简历上传区和“上传并分析”操作，保留原有表格和导航结构。

涉及文件：`apps/api/src/recruiting/types.ts`、`apps/api/src/recruiting/store.ts`、`apps/api/src/recruiting/service.ts`、`apps/api/src/routes.ts`、`apps/api/tests/api.test.ts`、`db/migrations/0003_resume_analysis_constraints.sql`、`web/src/modules/candidates/api/index.ts`、`web/src/modules/candidates/pages/CandidateListPage.vue`、`web/src/shared/types/recruiting.ts`。

验证命令：`apps/api/npm test`、`packages/resume-intelligence/npm test`、`web/npm run typecheck`、`web/npm run build`。

测试结果：API 7 项通过；Resume intelligence 3 项通过；Web 类型检查和 Vite 构建通过。

尚未完成：本地适配器仍未连接 PostgreSQL；文件仍在隔离目录，不代表病毒扫描通过；当前只接收 TXT/Markdown，PDF/DOCX、MinIO、ClamAV、Redis Worker、Outbox 和人工复核命令尚未完成；分析实现暂时为 API 内本地规则分析，尚未复用 `packages/resume-intelligence` 的完整报告对象。

下一步：将 API 内本地分析替换为 `packages/resume-intelligence` 的正式报告构建；增加人工复核接口和候选人详情视图；再实现面试反馈锁定和 Offer 版本审批。

## 13. 2026-09-10 PostgreSQL 本地存储切换

完成内容：

- 确认 Windows 原生 PostgreSQL 17 服务已运行，监听 `127.0.0.1:5432`，项目数据库 `smartrecruit` 已执行 `0001` 至 `0005` Migration。
- 增加 PostgreSQL 驱动 `pg` 和类型声明。
- 新增 `apps/api/src/recruiting/postgres-store.ts`，API 默认使用真实 PostgreSQL 连接池、事务、事务级锁、行锁、提交和回滚。
- 新增 `db/migrations/0006_recruiting_state_bridge.sql`，建立 PostgreSQL JSONB 状态桥接表；文件 Store 仅在测试或显式 `RECRUITING_STORE=local` 时使用。
- 保持现有 UI 和业务服务命令边界不变。

尚未完成：需要在本机执行 `0006` Migration 后启动 API；当前桥接表用于迁移期真实持久化，规范化表拆分 Repository 仍是后续数据库深化工作。未提供密码的环境不会连接数据库，也不会自动退回文件 Store。

下一步：执行 `0006`，用 PostgreSQL 启动 API，验证重启后数据仍存在；随后逐步将招聘需求、候选人、申请和岗位查询改为规范化 SQL Repository，并补 Redis、MinIO、ClamAV 真实连接。

## 12. 2026-09-09 简历分析正式报告接入

完成内容：API 分析任务接入 `packages/resume-intelligence` 的 `buildRuleBasedReport`，将岗位说明书 requirements 和 skills 映射为正式 `JobRequirements`；新增分析结果按 ID 查询和人工复核接口，复核状态同步写入报告的 `humanReview`。

涉及文件：`apps/api/src/recruiting/service.ts`、`apps/api/src/recruiting/types.ts`、`apps/api/src/routes.ts`、`apps/api/tests/api.test.ts`、`packages/resume-intelligence/src`。

验证命令：`packages/resume-intelligence/npm test`、`apps/api/npm test`。
