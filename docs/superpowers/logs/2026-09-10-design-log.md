## 2026-09-10 PostgreSQL 数据库验证

完成内容：

- 新增 `apps/api/src/recruiting/db-health.ts`，提供 PostgreSQL 连接检查、`recruiting_state` 读写、显式事务提交/回滚和测试连接池重建能力。
- 新增 `apps/api/tests/postgres.integration.test.ts`，验证 PostgreSQL 17 连接、`recruiting_state` 表存在、事务回滚不保留数据、事务提交保留数据，以及关闭连接池后重新连接仍能读到已提交数据。
- 集成测试使用唯一的临时状态行，并在测试结束后清理；未修改 `service.ts`、`routes.ts` 或 `web`。
- 未配置 `PGPASSWORD` 或带密码的 `DATABASE_URL` 时，测试通过 Node Test 的 skip 机制跳过；也可设置 `POSTGRES_INTEGRATION_SKIP=1` 显式跳过。

验证命令：`npm run build`、`node --test dist/tests/postgres.integration.test.js`（工作目录：`apps/api`）。

测试结果：TypeScript 构建通过；当前环境未配置数据库密码变量，PostgreSQL 集成测试按约定跳过。

尚未完成：需要在配置 `PGPASSWORD` 或带密码的 `DATABASE_URL` 后重新运行集成测试，完成对当前 `smartrecruit` 数据库实例的实际连接和 PostgreSQL 17 版本断言。
## 2026-09-10 端口调整

- API 默认端口由 `3000` 调整为 `3100`，避免与其他本地平台冲突。
- Web Vite `/api` 代理同步指向 `http://127.0.0.1:3100`。
- 招聘平台 Web 开发端口调整为 `5174`，避免占用带货平台使用的 `5173`。
- UI、数据库和业务逻辑未修改。

## 2026-09-10 真实数据链路继续开发

- 招聘平台首页改为读取 `/api/v1/reports` 和 `/api/v1/recruitment-requests`，动态展示后端招聘漏斗、指标和待办需求。
- 首页增加加载、连接失败和重试状态；API 不可用时不再静默展示演示指标。
- 保持现有 0.0.1 页面结构、样式和导航不变。
- Web 继续使用 `5174`，带货平台原端口 `5173` 未修改。
- 本轮验证：API build 通过，Web typecheck/build 通过，Worker build 通过，`git diff --check` 通过。
- 待继续：规范化 Repository 接入 service、Worker 轮询循环和候选人真实操作页面的并发实现尚待整合；API 真实 PostgreSQL 启动仍需在本机 PowerShell 提供密码。

## 2026-09-10 候选人/Offer 前端真实操作链路

完成内容：

- 共享 JSON 客户端新增 PATCH 方法与 patchJson 导出（web/src/shared/api）。
- 候选人 API 层改为真实后端调用（GET/POST candidates、applications、resumes、analysis-tasks、analysis-results），移除演示数据回退。
- 候选人页面新增：新建候选人、新建申请、简历上传 + 规则分析、结果人工复核（通过/退回修正）；AI 结果仅作为人工复核参考，不自动变更申请状态。
- Offer API 层由裸 fetch 迁移到 apiClient，并按 OfferTable 需要的形状映射 OfferRow。
- 演示数据测试只保留 DemoRecruitingData 与 jobs 演示适配器断言，不再依赖已移除的 listCandidates。

验证结果：

- npm --prefix apps/api run build && test 通过（10/10）。
- npm --prefix apps/worker run build && test 通过（6/6），analysis-task-store 测试 4/4，worker 运行测试 2/2。
- packages/contracts 与 packages/resume-intelligence 测试通过。
- npm --prefix web run typecheck 通过；npm --prefix web run build 通过；npm --prefix web test 通过（19/19）。
- git diff --check 通过。

待继续：

- PostgreSQL 权威持久化启动仍需本机提供 PGPASSWORD 或 DATABASE_URL 后运行 migrate/check/integration/start 脚本。
- 生产 Worker 轮询循环已实现，待与真实数据库连接后联调。

## 2026-09-10 PostgreSQL 凭据配置与权威持久化联调

完成内容：

- 写入本地 `.env`（已被 `.gitignore` 忽略，未提交）：数据库用户 `postgres`、数据库 `smartrecruit`、`DATABASE_URL`（密码含特殊字符已做 URL 编码）及 `PG*` 变量。
- 修复迁移历史不同步：`offers` 相关表/约束/索引已存在但 `schema_migrations` 未记录 0005，补记 0005 后重跑迁移，0006 `recruiting_state_bridge` 正常落地，现 6 个迁移全部一致。
- 构建 `packages/resume-intelligence/dist`（API 启动依赖），API 以 PostgreSQL 权威持久化模式启动于 `127.0.0.1:3100`。
- 启动 Web Vite 于 `http://localhost:5174/`，`/api` 代理联通。

验证结果：

- `migrate-postgres.mjs`：6/6 迁移应用齐全。
- `check-postgres-ready.mjs`：PostgreSQL ready at 127.0.0.1:5432/smartrecruit。
- `postgres.integration.test.js`：真实连接 + 事务 + 重启持久化，1/1 通过。
- 端到端冒烟：建候选人 → 建申请 → 上传简历（quarantined）→ 分析 → 人工复核 accepted，申请状态保持 new（AI 未自动变更状态），数据落库 recruiting_state（candidate=4、application=4、result=1）。

待继续：

- 生产 Worker 轮询循环与真实 PostgreSQL 连接后的联调。
- 可选：为 `smartrecruit` 业务账号补充低权限角色，避免长期使用 `postgres` 超级用户。

## 2026-09-11 生产 Worker 轮询循环与真实 PostgreSQL 联调

完成内容：

- 新增 apps/worker/tests/postgres.integration.test.js：用真实 PostgreSQL 验证「单次消费 + 幂等复查」与「startPersistedPoll 轮询循环消费」两条链路。
- 联调暴露并修复 3 个仅在真库可见的 SQL bug（MockClient 单测无法覆盖）：
  1. UPDATE ... RETURNING 使用带 at. 别名的列清单，PostgreSQL 不接受 FROM 别名限定目标列；新增去别名的 TASK_COLUMNS_UNQUALIFIED。
  2. claimNextTask 的 CTE 列 candidate.id 与目标表裸列 id 歧义；CTE 输出列改为 task_id 并更新 join 条件。
  3. 残留的 RETURNING TASK_COLUMNS（共 3 处）统一替换为无别名清单。
- 修复 Worker 隔离文件目录对 process.cwd() 的脆弱依赖：createResumePayloadResolver 现支持 RECRUITING_QUARANTINE_ROOT 环境变量，优先于启动目录推断，与 API 侧同源。

验证结果：

- node --test apps/worker/dist/tests/postgres.integration.test.js：2/2 通过（PGPASSWORD 配置后）。
- npm --prefix apps/worker run build && test：6/6 通过，无回归。
- 真实生产进程冒烟：WORKER_DB_POLL=true 启动 dist/src/index.js，健康检查 postgres: ok；插入规范化 resumes + analysis_tasks 后，进程自动消费为 status=completed, attempts=1，并落 1 条 analysis_results。

遗留：

- 生产 Worker 尚未把 RECRUITING_QUARANTINE_ROOT 写入 docs 与启动脚本约定；需要统一启动脚本、Compose 与 README 的目录契约。
- Redis/MinIO/ClamAV 仍未接入（健康检查显示 not_configured），隔离扫描、对象存储与队列重建为下一阶段范围。
