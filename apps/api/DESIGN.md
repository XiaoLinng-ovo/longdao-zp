# Phase 1 API 骨架设计说明

## 1. 范围

本设计只覆盖 `apps/api/`：建立可编译、可测试、可启动的最小 HTTP API。数据库、队列、对象存储、认证和具体招聘领域模块留到后续阶段，避免在工程骨架阶段引入不必要的外部依赖和基础设施耦合。

## 2. 设计决策

1. 使用 Node.js 原生 `node:http`，不引入运行时 Web 框架。
2. 使用 TypeScript `NodeNext` 模块模式，输出原生 ESM。
3. 使用轻量中间件组合器，统一承载错误处理、request id 和路由扩展。
4. 所有 API 响应都包含 `ok` 和 `requestId`。
5. 错误使用稳定的机器可读 `error.code`，消息面向调用方。
6. 未认证的 `/api/v1/me` 明确返回 HTTP 401，不伪造用户身份。
7. 配置只在 API 边界读取，并允许注入环境对象，便于测试。

## 3. 目录结构

```text
apps/api/
├─ package.json
├─ tsconfig.json
├─ README.md
├─ DESIGN.md
├─ src/
│  ├─ config.ts
│  ├─ http.ts
│  ├─ middleware.ts
│  ├─ error-middleware.ts
│  ├─ response.ts
│  ├─ routes.ts
│  ├─ server.ts
│  └─ index.ts
└─ tests/
   └─ api.test.ts
```

## 4. 演进计划

- Phase 1：保留纯 HTTP 骨架和健康检查。
- Phase 2：在中间件链中加入 Session、权限、CSRF 和审计上下文。
- Phase 3：增加招聘需求、审批、岗位和 JD 模块，并保持统一响应契约。
- Phase 4：增加 Candidate/Application/Resume 以及异步简历分析任务。
- Phase 5：增加面试、Offer 和报表模块。

每次扩展都应保持：路由负责协议转换，领域服务负责状态机，Repository 负责持久化，Worker 负责耗时任务。
