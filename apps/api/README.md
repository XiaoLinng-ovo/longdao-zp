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
