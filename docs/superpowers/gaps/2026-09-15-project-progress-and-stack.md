# SmartRecruit Pro 项目开发进度与技术栈汇总

> 生成日期：2026-09-16
> 项目路径：`C:\项目\code\longdao-jianli`
> 文档性质：用于团队汇报 / 项目交接 / 后续开发依据的汇总文件  
> 当前状态：本地闭环可运行，但尚未达到 V1 设计文档完整验收标准

---

## 1. 项目定位

SmartRecruit Pro 是一个面向单组织内部招聘团队的招聘流程管理平台，核心业务链路为：

```text
招聘需求 → 审批 → 岗位/JD → 候选人 → 职位申请
→ 简历安全扫描 → 简历解析与智能建议 → 人工复核
→ 面试 → Offer 审批 → 入职归档
```

目标架构是：

```text
Vue 3 前端
  ↓ 统一 API Client
Node.js / TypeScript API
  ↓ Session / RBAC / DataScope / Application Service
Domain State Machine + Repository
  ↓
PostgreSQL ← Outbox → Redis → Worker
    ↑
Audit / Workflow Events / Reports
```

浏览器不直接调用 OpenAI、对象存储或内部 AI 模块。AI 只提供建议、评分和风险提示，不允许自动淘汰、送 Offer 或录用。

---

## 2. 当前完成度结论

### 2.1 一句话结论

当前项目已经从“单页演示系统”演进为“本地可运行的招聘平台闭环 Demo”，主流程基本打通，但离设计文档要求的 V1 完整实现仍有明显差距。

### 2.2 当前真实可运行能力

- 登录 / 退出 / Session
- 招聘需求创建、编辑、状态推进、审批、驳回、转岗位
- 岗位创建、编辑、岗位说明、JD、版本查询、发布/暂停/关闭等动作
- 候选人主档案、职位申请、简历、AI 分析任务与结果
- 面试创建、反馈提交、反馈锁定、面试结论
- Offer 草稿、审批、发送、接受、拒绝、取消、过期
- 入职归档记录
- 审计 / 流程事件展示
- 后端最小 RBAC 和部分部门 DataScope
- 前端页面模块拆分：仪表盘、招聘需求、岗位、候选人、面试、Offer、报表、管理后台

### 2.3 当前测试情况（以本工作区实测为准）

- API 测试：当前环境未能复现通过；`apps/api` 的 TypeScript 工具链/依赖未完整安装，需先恢复干净安装后再验证
- 前端测试：`npm --prefix web test -- --run` → 45/45 通过
- 前端类型检查：`npm --prefix web run typecheck` → 通过
- 前端构建：`npm --prefix web run build` → 通过

### 2.4 尚未达到 V1 的关键点

- 五类角色已在 API 类型、默认账号和权限分组中出现，但仍需补齐端到端权限矩阵与验收用例
- Application 状态机与设计文档不一致
- 审批模型不完整：没有完整 `ApprovalInstance / ApprovalStep / ApprovalRecord`
- 数据层仍以本地 JSON state 为主，PostgreSQL 只是桥接/骨架
- 安全边界仍处于过渡态：密码仍为开发级 SHA-256，本地 Session JSON；CSRF/Origin/Secure Cookie 已有首版防护，但尚未完成生产级认证闭环与集成验收
- 岗位/JD 契约不完整：分页、乐观锁、幂等 Key 未完整落地
- 文件隔离与病毒扫描未接 MinIO / ClamAV
- Worker 未完整接 Redis 队列
- 前端已经有登录路由守卫、管理路由 `adminOnly`/角色限制及导航过滤；401/403 页面与全局错误体验仍待完善

---

## 3. 技术栈汇总

### 3.1 前端

| 项 | 技术 / 依赖 |
|---|---|
| 框架 | Vue 3 |
| 语言 | TypeScript |
| 构建工具 | Vite 6 |
| 路由 | Vue Router 4 |
| 测试 | Vitest + jsdom |
| 类型检查 | vue-tsc |
| 前端目录 | `web/` |
| 主要模块 | 仪表盘、招聘需求、岗位、候选人、面试、Offer、报表、管理后台 |

### 3.2 后端

| 项 | 技术 / 依赖 |
|---|---|
| 语言 | TypeScript |
| 运行时 | Node.js >= 18 |
| API 目录 | `apps/api/` |
| HTTP | Node 原生 HTTP 服务封装 |
| 构建 | tsc |
| 测试 | node:test |
| 数据库驱动 | `pg` |
| 数据存储 | 当前默认 `data/recruiting-state.json` 类 JSON state；存在 PostgreSQL 状态桥接 |
| 身份 | 本地 Session Store：`data/auth-sessions.json` |

### 3.3 数据与基础设施

| 项 | 技术 / 状态 |
|---|---|
| 权威数据库目标 | PostgreSQL 15+ |
| 当前数据库 | 已有初始 Migration，但业务写操作仍主要走 JSON state |
| 缓存/队列目标 | Redis |
| 当前队列 | 本地任务 / polling 骨架 |
| 文件存储目标 | MinIO |
| 当前文件存储 | 本地目录 `data/resumes/quarantine` |
| 病毒扫描目标 | ClamAV |
| 当前病毒扫描 | 未实际接入 |
| 部署 | Docker Compose 配置文件存在，但未完成干净服务器验证 |

### 3.4 包与目录

- 根目录：
  - `apps/api/`：新版 TypeScript API
  - `web/`：Vue 3 前端
  - `packages/contracts/`：领域 DTO / 状态枚举
  - `packages/resume-intelligence/`：简历解析与智能能力
  - `db/migrations/`：PostgreSQL 初始 Schema
  - `deploy/`：Docker Compose、Nginx / Caddy 等部署配置
  - `docs/superpowers/specs/`：设计文档
  - `docs/superpowers/logs/`：维护日志
- 旧兼容入口：
  - `index.html`：旧单文件招聘演示
  - `server.mjs`：旧 Node 兼容入口
  - `worker.mjs`：旧 Cloudflare Worker AI 代理
  - `functions/`：Cloudflare Pages Functions

---

## 4. 当前功能清单与完成度

### 4.1 已完成 / 基本可用

| 模块 | 当前能力 | 完成度 |
|---|---|---|
| 基础 API 运行 | health、ready、me、统一响应、404、错误结构 | 已完成 |
| 账号体系 | 本地账号、登录、退出、Session | 基础可用 |
| 招聘需求 | 创建、编辑、查询、状态推进、审批、驳回、部门范围 | 基础可用，审批模型待补 |
| 岗位/JD | 创建、编辑、岗位说明、JD、版本查询、动作流转 | 基础可用，契约待补 |
| 候选人 | 列表、详情、创建、编辑、申请关系 | 基础可用 |
| 简历 | 本地隔离、文本/Base64 内容分析、分析结果持久化 | 基础可用，未接 MinIO/ClamAV |
| AI 分析 | 任务、结果、分数回写 | 基础可用 |
| 面试 | 创建、轮次、反馈提交、锁定、结论 | 基础可用 |
| Offer | 草稿、审批、发送、接受、拒绝、取消、过期 | 基础可用 |
| 入职归档 | Offer 接受后归档、记录查询 | 基础可用 |
| 审计 | 招聘需求、岗位、候选人、面试、Offer 审计事件展示 | 基础可用 |
| 报表 | 后端聚合接口、前端报表页 | 基础可用，DataScope 未完整 |
| 前端模块化 | 8 个领域模块 + 详情页 + 审计页 | 已完成主要页面 |

### 4.2 核心偏差 / 待补功能

#### 身份与角色

- 设计角色：`admin / hr_admin / recruiter / hiring_manager / interviewer`
- 当前 API 角色：`recruiter / hiring_manager / approver / admin / hr_admin / interviewer`
- 当前状态：角色常量、默认账号和部分路由权限已加入；仍需将权限矩阵、DataScope 和前端页面访问逐项验收

#### Application 状态机

- 设计要求：
  - `pending_analysis`
  - `analysis_queued`
  - `human_review`
  - `interviewing`
  - `offer_approval`
  - `offer_sent`
  - `offer_accepted`
  - `onboarding_archived`
  - `rejected`
  - `offer_declined`
  - `offer_cancelled`
  - `offer_expired`
- 当前实现：`new / screening / interview / offer / hired / rejected / withdrawn`
- 状态：领域模型偏差，需优先修复。

#### 招聘需求审批模型

- 当前：只有 `request.approval` 摘要字段。
- 目标：需要 `ApprovalInstance / ApprovalStep / ApprovalRecord`，支持重新提交生成新审批实例并保留历史。

#### 安全

- 当前：SHA-256 密码哈希。
- 目标：Argon2id 或同等安全散列。
- 当前：无登录限流。
- 当前：Cookie 缺少 `Secure` 和 `__Host-` 前缀。
- 当前：已增加 CSRF Token、Origin 白名单和生产 Cookie 属性的首版实现；认证仍依赖本地 Session Store 与 SHA-256 密码哈希。
- 待补：Argon2id、PostgreSQL Session、登录限流、完整 CSRF 集成测试与安全配置审计。

#### API 契约

- 当前：页面能执行 CRUD 主流程。
- 待补：
  - `page / pageSize` 分页结构
  - `Idempotency-Key`
  - `If-Match / ETag / VERSION_CONFLICT`
  - 已发布岗位编辑后生成新版本并重新确认

#### 数据层

- 当前：主要业务写操作仍走 JSON state 文件。
- 目标：PostgreSQL 权威业务数据 + normalized Repository。
- 已有：`db/migrations/0001_initial_schema.sql` 初始表结构。
- 待补：真实 Repository、事务、乐观锁、Postgres 领域写路径。

#### 文件与异步

- 当前：本地隔离目录，没有真实 ClamAV。
- 当前：Worker / analysis 是可运行的本地/polling 骨架。
- 目标：MinIO、ClamAV、Redis 队列、可恢复异步任务。

#### 前端权限

- 当前：已有登录模块、全局路由守卫、管理路由 `adminOnly`/角色限制和导航过滤。
- 待补：401 / 403 页面、接口级错误态统一处理，以及与后端权限矩阵的端到端测试。

---

## 6. 当前阶段与下一阶段

当前处于“设计对齐后的安全底座与运行基线”阶段，而不是功能扩展阶段。近期并发改动只覆盖仓库卫生、依赖基线、认证首版和前端权限基线；这些改动不代表生产级认证已经完成。

下一阶段按以下顺序推进：

1. 恢复并锁定根级依赖安装与 API/Worker 构建、测试命令，形成可复现基线；
2. 将认证升级为 Argon2id + PostgreSQL Session + 登录限流，并补齐 CSRF/Origin 集成测试；
3. 以规范化 PostgreSQL Repository 迁移需求、岗位、候选人和申请的写路径，保留 JSON state 只读回退；
4. 再接入 MinIO、ClamAV、Outbox/Redis 和可恢复 Worker 链路。

验收时必须区分“源码已实现”“本地测试通过”“干净环境构建通过”和“真实部署验收”，不得仅依据页面可操作或旧进度记录宣称完成。

---

## 5. 现有设计文档

| 文档 | 路径 | 作用 |
|---|---|---|
| 详细设计 | `docs/superpowers/specs/2026-09-08-commercial-recruiting-platform-detailed-design.md` | 基线设计，定义领域、安全、权限、验收 |
| 前端模块化设计 | `docs/superpowers/specs/2026-09-08-frontend-modularization-design.md` | 前端模块化规划 |
| 内招平台设计 | `docs/superpowers/specs/2026-09-08-internal-recruiting-platform-design.md` | 早期内招平台设计 |
| 分阶段实施设计 | `docs/superpowers/specs/2026-09-08-phased-implementation-design.md` | 分阶段实施规划 |
| 数据库事务设计 | `docs/superpowers/specs/2026-09-09-database-transaction-design.md` | 数据库事务设计 |
| 招聘/岗位 API 契约 | `docs/superpowers/specs/2026-09-09-recruitment-job-api-contract.md` | API 契约 |
| 项目设计规划 | `docs/superpowers/specs/2026-09-09-smartrecruit-platform-design-roadmap.md` | 总体路线图 |
| 偏差文档 | `docs/superpowers/gaps/2026-09-15-design-compliance-gaps.md` | 当前实现与设计的偏差清单 |

---

## 6. 启动与验证命令

### 6.1 API

```bash
npm --prefix apps/api run build
npm --prefix apps/api test
npm --prefix apps/api run start
```

当前 API 地址：`http://127.0.0.1:3100`

### 6.2 Web

```bash
npm --prefix web run typecheck
npm --prefix web test -- --run
npm --prefix web run build
npm --prefix web run dev
```

当前 Web 地址：`http://localhost:5174`

### 6.3 开发账号

| 角色 | 邮箱 | 密码 |
|---|---|---|
| 系统管理员 | admin@smartrecruit.local | admin123 |
| 招聘专员 | recruiter@smartrecruit.local | recruiter123 |
| 部门负责人 | manager@smartrecruit.local | manager123 |
| 审批人 | approver@smartrecruit.local | approver123 |

> 说明：这些是开发种子账号，不用于生产。业务配置密码请使用环境变量或正式租户初始化流程，不要写入源码或仓库。

---

## 7. 下一阶段建议顺序

1. 对齐身份与角色模型。
2. 修复 Application 状态机。
3. 补招聘需求审批实例 / 步骤 / 记录。
4. 补岗位/JD 合约：分页、幂等 Key、乐观锁。
5. 补安全：CSRF / Origin / Cookie / 登录限流。
6. 扩展 DataScope 到候选人、申请、面试、Offer、报表。
7. 接前端路由守卫、导航权限、401/403。
8. 逐步把 JSON state 替换为 PostgreSQL Repository。
9. 再接 MinIO / ClamAV / Redis Worker / 恢复验证。
10. 完成生产化部署与恢复演练。

---

## 8. 结论

- 项目已经具备明显的“正式产品骨架”，但还不是一个完整的 V1。
- 当前最好的评价是：**核心招聘流程已本地闭环，技术栈清楚，测试通过，但关键设计和工程能力仍处于补齐阶段。**
- 后续继续开发时，建议严格按照设计文档逐项核销，不再只看页面数量或测试数量，而要落实每个领域能力的权限、状态机、事务、事件和验收条件。
