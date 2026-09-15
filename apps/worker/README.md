# SmartRecruit Pro Worker

`apps/worker` 是 SmartRecruit Pro 的异步任务运行时骨架。它只使用 TypeScript 和 Node.js 标准库，当前**不连接 Redis、PostgreSQL、MinIO、ClamAV 或 OpenAI**，用于先冻结任务边界、重试策略和健康检查协议。

## 当前能力

- 任务信封：`id`、`type`、`payload`、`attempts`、`maxAttempts`、`idempotencyKey`、时间元数据；
- 已注册任务类型：`resume-analysis`；
- `resume-analysis` 处理器：验证候选人申请/简历输入，支持内联文本或注入文本加载器，并通过分析器端口返回安全的分析结果；
- 默认分析器是骨架实现，只返回可持久化的输入摘要，不冒充完整的 `resume-intelligence` 报告；下一阶段可注入 `packages/resume-intelligence` 适配器；
- 失败分类：校验、未找到、冲突、超时、限流、依赖不可用、网络、内部错误和未知错误；
- 只对明确的瞬态失败（超时、限流、依赖不可用、网络）自动判断可重试；
- 进程内幂等存储，用于测试和单进程演示。生产环境应替换为 Redis/数据库实现，并使用原子 `SETNX`/唯一约束；
- `/health` 和 `/ready` 原生 HTTP 健康检查；
- `SIGINT`/`SIGTERM` 优雅停止入口。

## 任务语义

`attempts` 表示**本次执行开始之前已经消耗的尝试次数**。例如，初始任务是 `attempts: 0, maxAttempts: 3`，第一次执行返回 `attempts: 1`；如果失败且可重试，重新入队时应使用 `attempts: 1`。当本次执行后的次数达到 `maxAttempts` 时，不再重试。

`idempotencyKey` 只在任务成功完成后记录。重复投递一个已完成的 key 会返回 `status: "skipped"`，不会再次调用处理器。当前实现的幂等记录仅存在于进程内，Worker 重启后会丢失，这是有意保留的基础设施替换边界。

AI/规则分析结果始终携带以下安全约束：

```text
advisoryOnly: true
applicationStatusMutation: none
autoReject: false
autoHire: false
autoOffer: false
```

Worker 不会因为分析结果自动淘汰、录用或发放 Offer。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_NAME` | `smartrecruit-pro-worker` | 服务名称 |
| `APP_VERSION` | `0.1.0` | 服务版本 |
| `NODE_ENV` | `development` | 运行环境 |
| `WORKER_ID` | `${hostname}-${pid}` | Worker 实例标识 |
| `WORKER_QUEUE_NAME` | `smartrecruit.tasks` | 预留队列名称 |
| `WORKER_MAX_ATTEMPTS` | `3` | 默认最大尝试次数 |
| `WORKER_POLL_INTERVAL_MS` | `1000` | 预留轮询间隔 |
| `WORKER_LEASE_DURATION_MS` | `60000` | 预留任务租约时间 |
| `WORKER_HEALTH_HOST` | `127.0.0.1` | 健康检查监听地址 |
| `WORKER_HEALTH_PORT` | `4001` | 健康检查监听端口，`0` 表示随机端口 |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `10000` | 预留优雅停止超时 |

## 独立运行

在本目录执行：

```powershell
npm install
npm test
npm start
```

启动后可访问：

```text
GET http://127.0.0.1:4001/health
GET http://127.0.0.1:4001/ready
```

当前没有队列消费循环，因此启动进程只提供运行时和健康检查。后续接入 Redis 时，应新增 queue adapter，而不是让任务处理器直接依赖 Redis。

## 文件边界

- `src/task.ts`：任务类型、任务信封和运行时校验；
- `src/errors.ts`：失败分类和重试策略；
- `src/handlers/resume-analysis.ts`：简历分析任务处理器及分析器/文本加载器端口；
- `src/runner.ts`：任务分发、尝试次数和幂等执行；
- `src/health.ts`：健康状态和 HTTP 探针；
- `src/worker.ts`：Worker 运行时和生命周期；
- `src/index.ts`：公共导出和进程启动入口；
- `tests/worker.test.ts`：原生 `node:test` 测试。
