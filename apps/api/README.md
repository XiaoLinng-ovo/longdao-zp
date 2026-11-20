# SmartRecruit Pro API — Phase 1

## 目标

本目录是 SmartRecruit Pro Phase 1 的最小 Node.js + TypeScript HTTP API 骨架。业务 service/routes 保持现有边界；本地 PostgreSQL 的配置校验、readiness 和 migration 由 `src/db/` 与仓库根目录 `scripts/` 提供。

## 本阶段设计

```text
HTTP Server
  ↓
配置加载 → 错误处理中间件 → Request ID 中间件 → 路由 → 统一 JSON 响应
```

### 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/health` | 进程存活检查 |
| GET | `/api/v1/ready` | Phase 1 配置就绪检查 |
| GET | `/api/v1/me` | 当前用户；未认证时返回 401 |
| POST | `/api/v1/integrations/dingtalk/jobs` | 钉钉简化发布岗位，创建平台待完善岗位 |

### 统一响应结构

成功响应：

```json
{
  "ok": true,
  "data": {},
  "requestId": "..."
}
```

错误响应：

```json
{
  "ok": false,
  "error": {
    "code": "AUTHENTICATION_REQUIRED",
    "message": "未登录，请先完成身份认证"
  },
  "requestId": "..."
}
```

每个请求都会返回 `x-request-id` 响应头。客户端传入符合格式限制的 `x-request-id` 时会复用，否则生成 UUID。

## 配置

配置在 HTTP 边界通过 `loadConfig()` 读取，默认值如下：

- `APP_NAME=smartrecruit-pro-api`
- `APP_VERSION=0.1.0`
- `HOST=127.0.0.1`
- `PORT=3100`
- `NODE_ENV=development`
- `DINGTALK_INTEGRATION_TOKEN`：钉钉服务端调用专用 Bearer Token；未配置时接口保持关闭
- `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET`：企业内部应用凭据，用于获取 access token 并发起审批实例
- `DINGTALK_CALLBACK_TOKEN` / `DINGTALK_CALLBACK_AES_KEY` / `DINGTALK_CALLBACK_CORP_ID`：钉钉 HTTP 加密回调配置
- `PLATFORM_BASE_URL=http://127.0.0.1:5174`：返回给钉钉的岗位完善页面根地址

端口设置为 `0` 可用于测试时让操作系统分配临时端口。

## 运行

在本目录执行：

```bash
npm run build
npm test
npm start
```

API 测试在 `NODE_ENV=test` 下使用隔离的本地适配器；正常启动命令必须连接 PostgreSQL 并执行 migration。没有 PostgreSQL 时只能运行单元测试，不能启动业务 API。

本地同时启动前后端（避免与带货平台的 5173 端口冲突）：

```bash
# 终端一：apps/api
npm start

# 终端二：web
npm run dev -- --host 127.0.0.1 --port 5174
```

Vite 已将 `/api` 代理到 `http://127.0.0.1:3100`。

招聘平台 Web 地址：`http://127.0.0.1:5174/`。

## 钉钉简化发布岗位

钉钉侧只采集岗位名称、部门编码、招聘人数和创建人，其余 JD、任职要求、工作地点等内容回到招聘平台补充。该接口不使用网站登录态，也不接受 Cookie；钉钉宜搭、连接器或企业内部应用应在服务端保存并发送集成 Token。

```powershell
$env:DINGTALK_INTEGRATION_TOKEN = '<generate-a-long-random-token>'
$env:PLATFORM_BASE_URL = 'https://recruit.example.com'
```

```bash
curl -X POST http://127.0.0.1:3100/api/v1/integrations/dingtalk/jobs \
  -H "Authorization: Bearer <DINGTALK_INTEGRATION_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "evt-001",
    "externalJobId": "ding-job-001",
    "title": "高级后端工程师",
    "departmentCode": "dept-tech",
    "headcount": 2,
    "creatorUserId": "ding-user-001"
  }'
```

首次调用创建一条 `draft` 招聘需求和一条 `draft` 岗位，并返回 `completeUrl`；相同 `eventId` 和相同负载只回放原结果，不会重复创建。相同 `eventId` 携带不同负载返回 `409 DINGTALK_EVENT_CONFLICT`。`departmentCode` 必须已存在于平台 `departments.code`；可通过 `external_entity_mappings` 预先把钉钉用户 ID 映射到平台用户，未映射时岗位仍可创建，但创建人为空。

## 钉钉真实审批

平台用户提交招聘需求时，若已完整配置钉钉应用和加密回调参数，API 会按部门的 `department_approval_policies` 查找流程模板，调用钉钉 `/v1.0/workflow/processInstances` 发起审批并保存 `processInstanceId`。外部审批进行中，网站的本地同意/驳回接口返回 `409 DINGTALK_APPROVAL_ACTIVE`，最终结果只能由验签、解密成功的钉钉回调写入。

### 接口与源码对应关系

| 用途 | 钉钉接口/平台接口 | 项目代码 | 查找步骤 |
| --- | --- | --- | --- |
| 获取 access token | `POST https://api.dingtalk.com/v1.0/oauth2/accessToken` | `apps/api/src/integrations/dingtalk/approval-client.ts` 的 `accessToken()` | 搜索 `oauth2/accessToken` |
| 发起审批实例 | `POST https://api.dingtalk.com/v1.0/workflow/processInstances` | 同文件 `startProcess()`；业务编排在 `approval-workflow.ts` 的 `start()` | 搜索 `processInstances` 或 `startExternalApproval` |
| 查询审批实例 | `GET https://api.dingtalk.com/v1.0/workflow/processInstances/{id}` | `approval-client.ts` 的 `getProcessInstance()` | 搜索 `getProcessInstance` |
| 接收加密回调 | `POST /api/v1/integrations/dingtalk/approvals/callback` | `apps/api/src/routes.ts` 回调路由；`approval-workflow.ts` 的 `handleCallback()` | 搜索 `approvals/callback` |
| 回调验签/解密 | 钉钉 HTTP 加密回调协议 | `apps/api/src/integrations/dingtalk/callback-crypto.ts` | 搜索 `DingTalkCallbackCrypto` |
| 写入最终结果 | 平台内部 `workflow_events` 与 `approval_instances` | `postgres-approval-workflow.ts` 的 `applyDecision()` | 搜索 `dingtalk.approval.finished` |
| 回调丢失补偿 | 重复调用查询审批实例接口 | `approval-workflow.ts` 的 `reconcilePending()`；`server.ts` 后台定时任务 | 搜索 `reconcilePending` |
| 前端查看审批 | `GET /api/v1/recruitment-requests/{id}/approval` | `routes.ts`、`recruiting/service.ts`、`RequisitionDetailPage.vue` | 搜索 `/approval` 或 `钉钉审批详情` |

### 钉钉接口请求概要

1. 获取 access token：向 `https://api.dingtalk.com/v1.0/oauth2/accessToken` 发送 JSON `{ "appKey": "...", "appSecret": "..." }`。
2. 发起审批实例：向 `https://api.dingtalk.com/v1.0/workflow/processInstances` 发送 Bearer 头 `x-acs-dingtalk-access-token`，请求体包含 `processCode`、`originatorUserId`、`deptId` 和 `formComponentValues`。
3. 查询审批实例：使用同一个访问令牌请求 `/v1.0/workflow/processInstances/{processInstanceId}`；服务端用于回调丢失后的补偿。

### 钉钉后台配置步骤

1. 打开钉钉开发者后台，进入目标内部应用（本项目当前应用为招聘应用）。
2. 在权限管理中开通审批实例写入、审批实例读取、审批表单读写以及审批流相关权限，并发布应用。
3. 在审批管理中创建多级审批模板，复制模板的 `processCode`。
4. 为每个部门在 `department_approval_policies` 配置模板；其中 `department_external_id` 填钉钉部门 ID，不是平台 UUID。
5. 在 `external_entity_mappings` 中维护平台用户 UUID 与钉钉用户 ID 的映射，提交人必须能解析到钉钉用户。
6. 在事件订阅中选择审批实例相关 HTTP 事件，填写公网 HTTPS 回调地址：

```text
POST https://<api-domain>/api/v1/integrations/dingtalk/approvals/callback
```

7. 将钉钉生成的回调 Token、AES Key、Corp ID 写入服务端环境变量，并发布应用后再联调。

### 环境变量与补偿任务

- `DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET`：内部应用凭据，仅服务端使用。
- `DINGTALK_CALLBACK_TOKEN` / `DINGTALK_CALLBACK_AES_KEY` / `DINGTALK_CALLBACK_CORP_ID`：HTTP 加密回调配置。
- `DINGTALK_APPROVAL_RECONCILE=on|off`：审批补偿开关，默认 `on`；未完整配置时不会启动。
- `DINGTALK_APPROVAL_RECONCILE_MS`：补偿间隔，默认 `300000` 毫秒（5 分钟，最小接受 10000 毫秒）。

### 数据库字段映射与验证

- `approval_instances.provider = 'dingtalk'`、`external_instance_id = processInstanceId`、`completed_at` 保存外部审批实例和完成时间。
- `approval_steps.external_step_id` 预留钉钉节点 ID；节点进度写入 `workflow_events`。
- `dingtalk.approval.progress` 和 `dingtalk.approval.finished` 事件会在需求详情页合并显示。
- 前端检测到钉钉审批实例处于 pending 时，会隐藏平台本地“审批通过/驳回”按钮。
- 回调使用事件幂等记录；相同事件重复投递不会重复写入，不同内容复用同一事件 ID 会标记冲突。
- 本地联调先查看 API 返回的 `externalInstanceId`、事件日志和需求审批详情；再分别验证通过与驳回，确认平台状态更新。
- Offer 审批仍未改造；`funasr-service/` 保持不变。


钉钉后台的 HTTP 回调地址配置为：

```text
POST https://<api-domain>/api/v1/integrations/dingtalk/approvals/callback
```

上线前必须为部门配置流程代码，并为提交人配置钉钉用户映射：

```sql
INSERT INTO department_approval_policies (department_id, subject_type, process_code)
VALUES ('<department-uuid>', 'recruitment_request', '<ding-process-code>')
ON CONFLICT (department_id, subject_type)
DO UPDATE SET process_code = EXCLUDED.process_code, is_active = true, updated_at = now();

INSERT INTO external_entity_mappings
  (provider, external_type, external_id, internal_type, internal_id)
VALUES ('dingtalk', 'user', '<ding-user-id>', 'user', '<platform-user-uuid>')
ON CONFLICT (provider, external_type, external_id)
DO UPDATE SET internal_id = EXCLUDED.internal_id, last_synced_at = now();
```

回调采用钉钉官方 SHA1 排序签名、AES-256-CBC 解密、CorpId/AppKey 校验，并返回加密的 `success`。代码级协议测试已经覆盖，但“真实接入完成”仍以在钉钉管理后台配置回调后，用企业真实流程完成一次提交、批准和驳回联调为准。

## 本地 PostgreSQL 启动

先准备 PostgreSQL，并在当前 PowerShell 会话设置连接配置。可以使用 `DATABASE_URL`：

```powershell
$env:DATABASE_URL = 'postgresql://smartrecruit:change-me-in-development@127.0.0.1:5432/smartrecruit'
```

也可以分别设置 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD` 和 `PGDATABASE`。`DATABASE_URL` 存在时优先使用它；配置错误会在连接前直接失败。不要把真实密码提交到 `.env.example` 或代码库。

推荐的单命令本地启动会依次执行 TypeScript 构建、PostgreSQL readiness、全部未执行 migration，然后启动 API：

```powershell
node scripts/start-api-local.mjs
```

只执行 migration：

```powershell
npm --prefix apps/api run build
node scripts/migrate-postgres.mjs
```

只检查数据库 readiness：

```powershell
node scripts/check-postgres-ready.mjs
```

成功后 API 默认监听 `127.0.0.1:3100`。migration 使用 `pg` 直接发送 SQL，不依赖宿主机 `psql`；状态保存在 PostgreSQL 的 `schema_migrations` 表中。

TypeScript 和 Node 类型声明已经记录在 `apps/api/package.json`，本次没有安装或新增依赖。

## 后续扩展边界

- `ready` 应在接入 PostgreSQL、Redis 后增加显式依赖检查。
- `me` 应在 Phase 2 接入服务端 Session、RBAC、CSRF 和 Origin 校验。
- 路由层只做 HTTP 映射，招聘需求、岗位、候选人和申请等业务规则应放入后续领域模块。
- 整体状态 JSON 接口已移除；所有业务写入必须通过 `/api/v1` 领域接口完成。

## 列表分页结构

所有列表接口（需求、岗位、候选人、申请、面试、Offer、入职、简历、分析任务/结果、候选标签）统一走 `routes.ts` 的 `sendList`：

- 不传 `page` / `pageSize`：`data` 仍是数组（保持旧客户端兼容），不返回 `meta`。
- 传参：`data = { items, total, page, pageSize }`，同时给出 `meta.pagination = { page, pageSize, total, totalPages }`，与 `packages/contracts` 的 `PaginationMeta` 同形。
- 校验：`page` 必须 ≥ 1 的整数，`pageSize` 必须为 1–100 的整数，否则 `400 VALIDATION_ERROR`；只给 `pageSize` 时 `page` 默认 1；越界页返回空 `items` 而不是报错。

```bash
curl -H "authorization: <token>" "http://127.0.0.1:3100/api/v1/candidates?page=2&pageSize=20"
# { "ok": true, "data": { "items": [...], "total": 41, "page": 2, "pageSize": 20 },
#   "meta": { "pagination": { "page": 2, "pageSize": 20, "total": 41, "totalPages": 3 } },
#   "requestId": "..." }
```

## 部门数据范围（DataScope）

只有「招聘需求 / 岗位」自带 `departmentId`；候选人主档、申请、面试、Offer、入职归档、简历都没有部门字段，其归属一律沿 `岗位.departmentId → 申请.jobId → 下游对象` 推断（实现见 `recruiting/service.ts` 的 `filterStateByDepartment`，列表/报表/看板共用同一口径）。

- `recruiter / admin / hr_admin` 不受限；`hiring_manager` 只看本部门链路内的数据。
- 列表接口按范围过滤（`listCandidates / listApplications / listInterviews / listOffers / listOnboarding / listResumes` 均接受 `departmentId`）。
- 详情与写操作在 `routes.ts` 里先做越权断言，命中他部门数据返回 `403 FORBIDDEN`：`assertCandidateInScope / assertApplicationInScope / assertInterviewInScope / assertOfferInScope / assertOnboardingInScope`（分别覆盖候选人读取与修改、申请状态变更、面试读取与反馈/结论、Offer 全部动作、入职归档读取与推进）。
- `/api/v1/reports` 与 `/api/v1/dashboard/summary` 的聚合口径同步收敛，避免从报表侧看到他部门漏斗。

## 幂等写接口（Idempotency-Key）

写请求（POST/PATCH/PUT/DELETE）可带 `Idempotency-Key`，中间件实现在 `src/idempotency.ts`，管线位置在鉴权之后、路由之前（见 `src/server.ts`）：

| 场景 | 行为 |
| --- | --- |
| 首次请求 | 正常执行，2xx 后记录 `{ key, 指纹, 状态码, 响应 }` |
| 同键 + 同请求（method + path + 操作人 + 请求体哈希） | 直接回放原响应，附响应头 `idempotency-replay: true`，不重复写库 |
| 同键 + 不同请求 | `409 IDEMPOTENCY_KEY_REUSED` |
| 键格式非法（非 8–128 位 `[A-Za-z0-9._:-]`） | `400 IDEMPOTENCY_KEY_INVALID` |
| 首次请求返回非 2xx | 不落记录，同键可安全重试 |
| 不带该头 | 行为完全不变 |

- 请求体统一由 `src/body.ts` 的 `readBody` 读取并缓存（1 MB 上限），因此指纹与路由内 `readJson` 使用同一份解析结果。
- 可调参数在 `src/idempotency.ts` 顶部：`DEFAULT_IDEMPOTENCY_TTL_MS`（默认 24h）、`DEFAULT_IDEMPOTENCY_MAX_ENTRIES`（默认 1000）、`IDEMPOTENCY_ENABLED=false` 可整体关闭；`/api/v1/auth/*` 与 GET/HEAD 不参与幂等。
- `NODE_ENV=test` 使用单进程内存实现；开发和生产环境使用 `PostgresIdempotencyStore` 持久化到 `idempotency_records`，支持跨实例和重启重放。

```bash
curl -X POST http://127.0.0.1:3100/api/v1/candidates \
  -H "authorization: <token>" -H "content-type: application/json" \
  -H "idempotency-key: 5b1f0c2e-9a44-4c31-8f2a-7c0d1e2f3a4b" \
  -d '{"fullName":"张三"}'
```
## PostgreSQL 业务闭环（本阶段接入范围）

此前只有需求、审批、岗位主体、候选人、申请、简历与分析走 PostgreSQL 仓储；面试、Offer、入职归档、岗位说明书与 JD 版本、流程事件、报表/看板只在内存状态（`NODE_ENV=test`）下可用，非测试环境会因状态对象未初始化而抛 `TypeError`。现在这些聚合已全部接入仓储，且读接口统一走同一个状态视图，测试模式与 PostgreSQL 模式共用一套过滤、排序与聚合逻辑。

### 运行（本地三步）

```bash
export DATABASE_URL='postgresql://smartrecruit:<password>@127.0.0.1:5432/smartrecruit'
node scripts/migrate-postgres.mjs      # 应用 db/migrations 下全部迁移
node scripts/seed-dev-postgres.mjs     # 部门 / 角色 / 初始账号（仅开发与验证环境）
node scripts/verify-v1-flow.mjs        # 在真实 PostgreSQL 上跑完整 V1 闭环并逐项断言
```

`verify-v1-flow.mjs` 会启动一个 `NODE_ENV=production` 的服务实例（会话与业务数据都走 PostgreSQL），覆盖：登录 → 招聘需求 → 审批 → 岗位 → 说明书/JD → 确认 → 发布 → 候选人 → 申请 → 简历隔离 → 分析 → 人工复核 → 面试 → 反馈提交/锁定 → 结论 → Offer 审批/发送/接受 → 入职归档 → 报表/看板/流程事件 → 部门数据范围 → 分页 → 幂等重放，共 51 项断言。

### 仓储口径约定

- **部门标识**：对外一律使用 `departments.code`（如 `dept-tech`），不使用 UUID。会话身份（`/api/v1/me` 的 `departmentId`）、岗位、需求三处口径一致，部门数据范围（DataScope）才能对齐。
- **日期**：`date` 列（`onboarding_records.planned_start_date`、`offer_versions.start_date`）按 `YYYY-MM-DD` 字面返回；若交给驱动解析成 `Date` 再序列化，会因本地时区偏移出现差一天。
- **申请初始状态**：`pending_analysis`。迁移 `0009_application_status_alignment.sql` 已把列默认值从遗留的 `new` 改为 `pending_analysis`，并补齐 12 个状态 CHECK（此前 applications 是全库唯一没有状态约束的聚合表）。
- **操作者解析**：写接口的 actor 与 `interviewerId` 需能解析到 `users` 中的真实用户（UUID 或邮箱）。`interview_feedback.interviewer_id` 为 NOT NULL，无法解析会返回校验错误；其余审计列可空，解析不到时写 NULL。
- **部门范围**：仍从岗位推出（`job.departmentId → application → 下游`），只允许 `hiring_manager` 受部门约束。

### 仍未接入的部分

- `audit_logs` 与 `outbox_events` 两张表仍无代码写入，当前审计轨迹落在 `workflow_events`。
- Offer 审批人没有独立列（设计中的 `offer_approvals` 未建表），PostgreSQL 模式下 `approval.approver` 返回空串；审批人、理由可在流程事件中查到。
- `job_description_versions` 无 `language` 列，读取时统一按 `zh-CN` 返回。
- `candidates` 无标签列，`/api/v1/candidate-tags` 在 PostgreSQL 模式返回空数组。
- 简历仍落本地隔离目录；MinIO / ClamAV / Redis 未接入，Worker 仍用 PostgreSQL 租约轮询。
- 幂等记录已在非测试环境写入 PostgreSQL；部署前必须执行包含 `idempotency_records` 的 migration。
- 管理后台接口已提供用户、角色、系统设置、分析任务与审计日志查询/维护能力，并由 `admin / hr_admin` 角色保护。
