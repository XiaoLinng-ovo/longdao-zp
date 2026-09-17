# SmartRecruit Pro 当前最终总设计

> 文档状态：当前实施基线 v1.0
> 更新时间：2026-09-17
> 适用范围：单组织内部招聘系统
> 背景基线：`2026-09-08-commercial-recruiting-platform-detailed-design.md`

## 1. 目标与边界

SmartRecruit Pro 是单组织内部招聘系统，支持多个部门和内部账号，但不实现多租户、计费、客户自助开通、租户级品牌或模型供应商路由。

核心闭环：

```text
招聘需求 → 需求审批 → 岗位/JD → 候选人/申请
→ 简历上传与安全扫描 → 简历解析与 AI 建议 → 人工复核
→ 多轮面试与反馈 → Offer 版本与审批 → 入职归档
```

PostgreSQL 是唯一业务事实源。生产环境不保留 JSON state fallback。测试环境可使用纯内存 `LocalRecruitingStore`，不得写状态文件。

AI 只能提供解析、匹配、评分和风险提示，不能自动淘汰候选人、自动录用或自动发送 Offer。

另一开发分支负责并行维护以下边界，本分支不重复实现或修改：

- API 分页契约与分页响应；
- DataScope 读取隔离；
- 数据库连接配置和错误脱敏。

## 2. 技术架构

```text
Vue 3 + TypeScript + Vite
        │ HTTPS / JSON API
        ▼
Node.js + TypeScript API
  ├─ Auth / Session / CSRF / RBAC
  ├─ DataScope / Idempotency / Optimistic Lock
  ├─ Application Services
  ├─ Domain State Machines
  └─ PostgreSQL Repository
        │
        ├─ PostgreSQL：唯一业务事实源
        ├─ Redis：队列、租约、限流、短期缓存
        ├─ MinIO/S3：私有简历与附件
        └─ Worker：扫描、解析、AI 分析、重试
```

生产部署使用 Docker Compose：前端静态资源由 Nginx/Caddy 提供，API 负责业务请求，Worker 负责异步任务，PostgreSQL 保存业务数据，Redis 提供队列，MinIO 保存私有对象，ClamAV 执行病毒扫描。浏览器不得直接访问数据库、队列、对象存储、扫描器或模型服务。

## 3. 角色与权限

最终角色模型：

| 角色 | 主要权限 |
| --- | --- |
| `admin` | 用户、角色、系统设置、审计、全局管理 |
| `hr_admin` | 招聘流程、Offer、入职和审批管理 |
| `recruiter` | 需求、岗位、候选人、申请、简历、面试 |
| `hiring_manager` | 本部门岗位、候选人、申请、面试和审批范围 |
| `interviewer` | 被分配的面试和反馈 |
| `approver` | 兼容角色，执行审批动作 |

授权分为两层：

1. 动作权限：能否创建、编辑、提交、审批、锁定或归档。
2. 数据范围：能看到哪些部门、岗位、申请、候选人、面试、Offer 和报表。

服务端是最终授权点；前端隐藏导航只改善体验，不能代替服务端鉴权。

## 4. 领域模型与状态机

### 4.1 招聘需求

```text
draft → pending_approval → approved
                     └───→ rejected
approved → closed
draft/rejected → resubmitted
```

每次提交创建新的 `approval_instance`、`approval_steps` 和审批记录，历史实例不可覆盖。

### 4.2 岗位与 JD

```text
draft → ready → published → paused → published
published/paused/ready → closed
```

岗位说明书和 JD 均为版本化资源。已发布岗位编辑必须生成新版本并重新确认后才能再次发布。

### 4.3 Application

```text
pending_analysis → analysis_queued → human_review → interviewing
→ offer_approval → offer_sent → offer_accepted → onboarding_archived
```

终止状态：`rejected`、`offer_declined`、`offer_cancelled`、`offer_expired`。

客户端不得直接写状态；所有迁移由领域命令校验，并在同一事务内更新关联对象和事件。

### 4.4 面试

面试包含轮次、类型、时间、地点、会议地址、参与人、评分表和结论。反馈状态为：

```text
draft → submitted → locked
```

锁定后不可原地修改，只能追加更正记录。结论可以推进申请到面试、淘汰或 Offer 审批阶段。

### 4.5 Offer

Offer 主记录与 `offer_versions` 分离。主记录保存状态、审批状态、发送/回应/过期时间；版本保存职位、部门、用工类型、薪酬、福利和正文。

```text
draft → pending_approval → approved → sent
sent → accepted / declined / expired
```

每次状态动作必须同步 Application 状态并写入工作流事件。

### 4.6 入职归档

```text
pending → scheduled → completed
pending/scheduled → cancelled
```

完成归档时同步更新 onboarding record、Application 和审计事件。

## 5. PostgreSQL 数据设计

核心表：

```text
users, roles, user_roles, departments
sessions, login_attempts
recruitment_requests
approval_instances, approval_steps, approval_records
jobs, job_spec_versions, job_description_versions
candidates, candidate_tags, candidate_tag_links, applications
resumes, resume_files
analysis_tasks, analysis_results
interviews, interview_feedback
offers, offer_versions, onboarding_records
workflow_events, audit_logs, outbox_events
idempotency_records, system_settings
```

数据约束：

- 业务主键使用 UUID，对外编号独立保存；
- 外键、唯一约束和状态 CHECK 约束由数据库保证；
- 状态写入使用事务和 `SELECT ... FOR UPDATE`；
- 状态变化同步写入 workflow event，安全/管理动作写入 audit log；
- migration 按编号执行，每个迁移独立事务并记录到 `schema_migrations`；
- 列表查询使用显式排序，不依赖物理行顺序；
- 所有生产业务查询和写入通过 Repository，不允许直接在路由中拼接领域 SQL。

## 6. API 契约

统一前缀：`/api/v1`。

统一响应：

```json
{ "data": {}, "meta": { "requestId": "..." } }
```

列表统一由并行分支维护分页字段：`page`、`pageSize`、`total`、`totalPages`。

核心资源：

```text
GET/POST       /recruitment-requests
GET/PATCH      /recruitment-requests/:id
POST           /recruitment-requests/:id/submit|approve|reject
GET            /recruitment-requests/:id/approval

GET/POST       /jobs
GET/PATCH      /jobs/:id
POST           /jobs/:id/spec|jd|publish|pause|close

GET/POST       /candidates
GET/PATCH      /candidates/:id
GET/POST       /applications
GET/POST       /resumes

GET            /analysis-tasks
POST           /analysis-tasks/:id/retry
GET            /analysis-results
POST           /analysis-results/:id/review

GET/POST       /interviews
GET/PATCH      /interviews/:id
POST           /interviews/:id/feedback|feedback/lock|conclude

GET/POST       /offers
GET/PATCH      /offers/:id
POST           /offers/:id/submit-approval|approve|reject|send|accept|decline|expire|archive-onboarding

GET            /onboarding
GET/PATCH      /onboarding/:id
POST           /onboarding/:id/schedule|complete|cancel

GET            /dashboard/summary
GET            /reports|/reports/funnel|/reports/channels|/reports/cycle-time

GET/PATCH      /admin/users|/admin/roles|/admin/settings
GET            /admin/analysis-tasks|/admin/audit-logs
```

写请求要求认证、Origin/CSRF 校验、角色权限、DataScope 校验，并按接口要求使用 `Idempotency-Key` 和 `If-Match`。版本冲突统一返回 `VERSION_CONFLICT`。错误响应不得泄露 SQL、连接串、密钥、密码或内部堆栈。

## 7. 前端信息架构

保留模块化目录：

```text
web/src/app
web/src/modules/{dashboard,requisitions,jobs,candidates,interviews,offers,onboarding,reports,administration,auth}
web/src/shared/{api,components,types,utils}
```

前端要求：

- 未登录跳转登录页；无权路由显示 403；401 自动清理会话；
- 列表统一分页、筛选、加载态、空态和错误态；
- 状态标签来自共享状态字典；
- 详情页显示流程时间线和审计事件；
- AI 结果明确标注为“建议”，人工确认后才影响业务状态；
- 管理入口按角色隐藏，但服务端仍执行最终权限校验。

## 8. 简历、AI 与异步任务

### 8.1 文件流程

```text
上传 → 临时对象 → MIME/大小/扩展名校验 → ClamAV 扫描
→ clean 才进入正式对象 → 文本提取 → analysis_task → Worker 分析
→ analysis_result → 人工复核
```

未扫描文件不得进入业务下载区。对象键使用随机不可猜标识，不使用原始文件名作为主键。元数据必须保存对象键、原始文件名、MIME、字节数、SHA-256、扫描状态、上传者、保留期限和时间戳。

### 8.2 AI 客户端

只使用一个 OpenAI-compatible 客户端：

```text
OPENAI_BASE_URL
OPENAI_API_KEY
OPENAI_MODEL
OPENAI_TIMEOUT_MS
```

不做模型供应商路由，不把密钥暴露给浏览器。AI 输出使用结构化 Schema，保存模型、提示词版本、输入哈希和结果版本。超时、限流、格式错误进入失败状态并支持重试。

### 8.3 Worker

Redis 队列任务：`resume.scan`、`resume.extract`、`resume.analyze`、`report.rebuild`、`notification.send`。

任务状态：

```text
queued → processing → completed
                    └→ failed
```

任务必须包含租约、尝试次数、可执行时间、错误信息、开始/完成时间、幂等键、最大重试次数和人工重试入口。

## 9. 安全、审计与生命周期

- 生产使用 PostgreSQL Session Repository，Session token 只存哈希；
- 密码使用 scrypt/Argon2id 等强哈希，旧哈希仅允许一次性迁移；
- 生产 Cookie 使用 `__Host-`、HttpOnly、Secure、SameSite=Lax；
- 登录失败限流，禁用用户立即使现有 Session 失效；
- 写请求校验 Origin 和 CSRF Token；不允许 `*` 与凭证 CORS 组合；
- 连接串、密码、API Key 不进入响应、日志和异常；
- 上传、下载、分析、导出、权限变更和管理配置都记录审计；
- `workflow_events` 保存业务时间线，`audit_logs` 保存安全/管理操作，`outbox_events` 保存待投递事件；
- 简历和附件按组织保留策略清理，删除动作记录审计并支持恢复期策略。

## 10. Dashboard、Reports 与运营管理

Dashboard 提供待审批需求、开放岗位、候选人/申请、待反馈面试、Offer、入职和失败任务摘要。Reports 提供招聘漏斗、渠道转化、岗位填充率、招聘周期、状态分布以及 AI 覆盖率和失败率。

报表必须由 PostgreSQL 聚合查询产生，不能在浏览器加载全量业务列表后自行计算。服务端先应用 DataScope，再执行聚合。

管理后台提供用户、角色、系统设置、失败任务和审计查询。模型连接设置只显示脱敏状态，不允许通过业务 API 覆盖部署级密钥和地址。

## 11. 部署、备份与恢复

启动顺序：

1. 启动 PostgreSQL、Redis、MinIO、ClamAV；
2. 执行 migration；
3. API readiness 检查数据库和依赖；
4. 启动 API 和 Worker；
5. Nginx/Caddy 提供 HTTPS 和反向代理；
6. 前端仅访问 API。

PostgreSQL 执行定时逻辑/物理备份和 WAL 保护；MinIO 同步备份对象及元数据；Redis 不作为业务事实源。恢复演练必须验证迁移、对象关联、任务重放和权限数据。

## 12. 测试与验收

测试层级：

1. 状态机单元测试；
2. Repository SQL contract 测试；
3. API 路由、权限、CSRF、幂等和版本冲突集成测试；
4. 真实 PostgreSQL 集成测试；
5. Worker 租约、重试和幂等测试；
6. 前端组件和页面测试；
7. 浏览器关键流程测试；
8. 干净环境构建、Compose 启动和 readiness 测试；
9. 备份恢复和故障重放演练。

V1 必须证明：需求审批可重提且历史保留；岗位/JD 可版本化发布；申请和简历可追踪；未扫描简历不能分析；AI 失败可重试且人工复核可覆盖；反馈锁定不可修改；Offer 版本和状态可追溯；接受 Offer 可归档入职；角色和部门不能越权；关键动作均有事件/审计；重启和恢复不丢失业务数据。

## 13. 实施顺序

### Phase 0：基线冻结

冻结本文件和原始产品设计，清理中间设计文档，明确另一分支边界。

### Phase 1：领域契约对齐

统一 Application 状态，补齐审批实例/步骤/记录，完善 Offer/Application 联动、乐观锁、幂等和审计。

### Phase 2：文件与异步基础设施

接入 MinIO、ClamAV、Redis Worker、租约、失败重试和人工重试。

### Phase 3：前端正式闭环

替换演示数据，完善 401/403、筛选、分页、错误态、管理后台和审计查询。

### Phase 4：生产部署

完成 Compose、HTTPS、迁移、readiness、备份恢复和真实服务器验收。

## 14. 文档保留规则

保留：

- `2026-09-08-commercial-recruiting-platform-detailed-design.md`：最初产品设计基线；
- 本文件：当前实现和后续开发的最终总设计。

删除：

- 前端模块化设计；
- 内招平台设计；
- 分阶段实施设计；
- 数据库事务设计；
- 招聘/JD API 契约；
- 项目路线图；
- 旧进度汇总；
- 设计合规偏差清单。

删除这些文档只清理中间目标和过期诊断，不删除源代码、数据库迁移、测试或运行文档。
