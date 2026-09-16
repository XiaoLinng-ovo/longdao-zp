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
- 当前为单进程内存实现（`MemoryIdempotencyStore`），重启即失效；多实例/需持久化时替换为 PostgreSQL 实现（唯一键 + 指纹 + 响应体），中间件与调用方无需改动。

```bash
curl -X POST http://127.0.0.1:3100/api/v1/candidates \
  -H "authorization: <token>" -H "content-type: application/json" \
  -H "idempotency-key: 5b1f0c2e-9a44-4c31-8f2a-7c0d1e2f3a4b" \
  -d '{"fullName":"张三"}'
```
