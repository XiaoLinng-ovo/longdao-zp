# SmartRecruit Pro 分阶段实施设计与 Phase 1 实施说明

> 文档版本：v1.1
> 编写日期：2026-09-08
> 适用范围：从现有 0.0.x 演示系统演进为单组织商业化内部招聘平台
> 当前目标：先实现可运行的核心平台骨架，再逐步补充完整招聘闭环、安全、智能能力和生产运维

## 1. 文档目的

本文将 `docs/superpowers/specs/2026-09-08-commercial-recruiting-platform-detailed-design.md` 的总体设计转化为可执行的阶段性实施方案，并规定第一阶段的实际交付边界。项目不再继续扩展旧单文件 Demo，而采用“领域闭环优先、每阶段可验证、每阶段可回滚”的方式实施。

## 2. 当前基线与问题

当前仓库已有：

- `web/`：Vue 3 + TypeScript + Vite 的模块化前端，包括仪表盘、招聘需求、岗位、候选人、面试、Offer、报表和管理页面；
- `index.html`、`server.mjs`、`worker.mjs`：可以演示流程的旧版单页和 Node/Cloudflare 兼容入口；
- `web/src/shared/data/demo-recruiting-data.ts`：只读演示数据适配器；
- `docs/superpowers/specs/` 与 `docs/superpowers/plans/`：总体架构和前端模块化设计。

当前限制：

1. 新前端尚未连接正式 API；
2. 旧 `/api/state` 是整体 JSON 状态读写，不能作为正式业务写入接口；
3. 没有 PostgreSQL 权威数据源、数据库迁移、服务端 Session、RBAC、审计、文件隔离、任务租约和恢复机制；
4. `Candidate` 与 `Application` 尚未拆分，无法正确支持多岗位申请；
5. 简历智能能力仍与旧接口耦合，尚未形成内部可测试的能力包。

## 3. 目标与范围

### 3.1 V1 目标

支持内部招聘成员完成：

```text
登录 → 创建招聘需求 → 审批 → 创建岗位/JD → 导入候选人
→ 上传简历 → 安全扫描 → AI 分析 → 人工复核
→ 面试 → Offer 审批 → 入职归档
```

### 3.2 V1 非目标

暂不实现多租户、完整 HRMS、薪酬考勤、公开招聘门户、OCR、复杂多 Agent、FAISS/向量数据库、多供应商模型路由和复杂通知中心。

## 4. 来源复用原则

### 4.1 CandiSift

在取得作者书面授权并固定来源 commit 后，将其解析、抽取、脱敏、标准化、匹配、评分和报告能力按接口与测试迁移到 `packages/resume-intelligence`。由于来源技术栈与本项目主线不同，优先采用 TypeScript 原生实现或受控适配，不保留独立用户体系、页面和公开 API。AI 只提供建议、证据和风险标记，不能自动淘汰、录用或发送 Offer。

### 4.2 Frappe HR

记录来源版本、授权和许可证信息。借鉴招聘需求、岗位、候选人、面试、反馈、评分表、Offer、审批、时间线和招聘统计的业务经验；重新映射为本项目自己的 PostgreSQL 表、领域服务和 API。不引入完整 Frappe Framework、HRMS、薪酬、考勤或品牌页面。

### 4.3 合规要求

建立来源审计、迁移矩阵和许可证清单。授权记录必须包含授权主体、范围、时间、来源 commit/tag、署名/分发要求和第三方依赖许可证。授权不等于自动免除依赖许可证义务。

## 5. 目标架构

```text
Vue 静态前端
      ↓
Nginx/Caddy → Node.js/TypeScript API
                    ├─ PostgreSQL：业务事实来源
                    ├─ MinIO：原始简历和附件
                    ├─ Redis：队列、缓存、锁
                    └─ Outbox → Worker → resume-intelligence → OpenAI 兼容接口
```

原则：页面只调用领域 API；路由不决定业务状态；PostgreSQL 是权威事实来源；Redis 可丢失且可重建；API Key 只存在服务端；AI 结果必须包含模型、版本、时间和人工复核提示。

## 6. 分阶段实施路线

### Phase 0：来源审计与领域冻结

交付：授权文件、来源 commit、许可证清单、迁移矩阵、实体关系、状态机、脱敏简历 Golden Dataset。

完成标志：冻结 `Candidate`/`Application` 分离、状态转换和 AI 人工边界；禁止新增 `/api/state` 正式写入逻辑。

### Phase 1：工程骨架、共享契约与异步/前端边界（当前并行实施）

交付：

- `apps/api/`：最小 API 服务、配置、request id、统一响应和健康检查；
- `apps/worker/`：任务信封、重试分类、幂等边界、简历分析处理器和健康检查；
- `packages/contracts/`：前后端共享 DTO、状态枚举、API 错误契约；
- `packages/resume-intelligence/`：迁移后的简历解析、抽取、脱敏、匹配、评分和报告能力；
- `web/src/shared/api/`：统一 JSON API 客户端和错误边界；
- `db/migrations/`：PostgreSQL 首批迁移入口；
- `deploy/`：PostgreSQL、Redis、MinIO 和 ClamAV 的本地 Compose 基础设施入口；
- `docs/compliance/`：CandiSift 与 Frappe HR 的来源登记、迁移矩阵和发布前合规记录。

本阶段不实现完整认证、数据库写入和具体业务页面接入；Worker 暂不连接 Redis/PostgreSQL/MinIO，简历智能包先提供确定性规则能力和安全边界。先保证 API、Worker、契约、前端传输边界和智能能力包可独立构建，避免前端继续依赖 Demo 类型。

验收：API 可启动并返回 `/api/v1/health`、`/api/v1/ready`；未登录访问 `/api/v1/me` 有明确响应；统一错误包含 request id；Worker 可执行简历分析骨架任务并报告重试/幂等结果；共享类型、前端 API 客户端和简历智能包可以独立检查和测试。

### Phase 2：认证、RBAC 与审计

实现 Session Cookie、密码哈希、CSRF、Origin 校验、五类角色、部门数据范围、401/403、登录限流和审计日志。先保护所有写接口，再开放业务写入。

### Phase 3：招聘需求、审批、岗位与 JD

实现 `RecruitmentRequest`、`ApprovalInstance`、`ApprovalStep`、`ApprovalRecord`、`Job`、`JobSpecVersion`、`JobDescriptionVersion`，并把 `web/src/modules/requisitions` 和 `web/src/modules/jobs` 从 Demo 适配器切换为真实 API。

### Phase 4：候选人、职位申请、简历与智能分析

实现 `Candidate`、`Application`、`Resume`、隔离桶、ClamAV、Outbox、Redis Worker、解析、脱敏、抽取、匹配、评分、报告和人工复核。此阶段完成后形成第一个有业务价值的核心 MVP。

### Phase 5：面试、Offer 与入职归档

实现面试轮次、面试官、评分表、反馈锁定、Offer 版本、审批、文档生成、发送、接受/拒绝/过期和入职归档。

### Phase 6：报表、迁移与生产化

实现后端聚合报表、`state.json` 迁移与校验、备份恢复、HTTPS、日志监控、数据清理和旧入口下线/只读化。

## 7. Phase 1 文件边界

本轮阶段性交付允许以下写入范围：

```text
apps/api/
apps/worker/
packages/contracts/
packages/resume-intelligence/
web/src/shared/api/
db/
deploy/
docs/compliance/
docs/superpowers/specs/2026-09-08-phased-implementation-design.md
```

以下旧 Demo 入口和业务页面暂不改写：

```text
web/src/modules/
web/src/app/
index.html
server.mjs
worker.mjs
functions/
```

这样既建立正式平台边界，又保留旧 Demo 回滚能力；下一阶段再以共享契约和 API 客户端为边界接入登录、招聘需求和岗位业务。

## 8. 后续数据库设计顺序

首批表：

```text
users, departments, roles, user_roles, sessions,
recruitment_requests, approval_instances, approval_steps, approval_records,
jobs, job_spec_versions, job_description_versions,
candidates, applications, resumes,
analysis_tasks, analysis_results, outbox_events, workflow_events, audit_logs
```

数据变更必须通过迁移脚本和领域命令完成；不能使用整体 JSON 覆盖。

## 9. 测试策略

- 单元测试：状态机、权限策略、DTO 校验、脱敏、评分归一化、AI 响应解析；
- 集成测试：API + PostgreSQL、文件隔离与扫描、Outbox + Redis、任务幂等与恢复；
- 合约测试：前端适配器与共享 DTO；
- E2E：登录至入职归档的主流程；
- 运维测试：容器重启、Worker 重启、Redis 丢失、备份恢复和删除记录重放。

每个阶段独立提交、独立验收、独立回滚；禁止在未完成基础安全和数据模型前扩展高级 AI。

## 10. 当前执行结论

截至 2026-09-09，Phase 1 的第一轮骨架已经落地：API 健康检查、共享契约、PostgreSQL 首批迁移、基础设施 Compose、Worker 任务运行时、CandiSift 能力迁移包、前端统一 API 客户端和来源合规登记均已具备独立文件边界与测试入口。真实 Redis/PostgreSQL/MinIO/ClamAV 连接、认证和业务写入仍待后续阶段接入。

当前验证结果：API 4 项、Worker 6 项、简历智能 3 项、前端 14 项测试通过；各包 TypeScript 检查和前端生产构建通过。下一阶段先实现 Session、RBAC、CSRF、Origin 校验和审计，再把招聘需求、审批、岗位和 JD 接到正式 API。旧 Demo 继续保留，作为原型和迁移参考。

