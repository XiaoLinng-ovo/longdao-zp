# 设计合规偏差与修复计划

> 状态：进行中  
> 更新日期：2026-09-15  
> 目标：以 `docs/superpowers/specs/2026-09-08-commercial-recruiting-platform-detailed-design.md`、`2026-09-09-recruitment-job-api-contract.md`、`2026-09-09-smartrecruit-platform-design-roadmap.md` 为基准，逐项记录当前实现偏差。  
> 原则：先修核心功能，再修安全、契约、数据架构和基础设施。每次完成一项修改后，必须回到本文档打勾并补充验证结果。

---

## 0. 当前诊断结论

当前版本能够跑通本地招聘主流程，API 测试 15/15 通过，但不是设计 V1 的完整实现。主要问题是：

1. 身份角色与设计不一致。
2. Application 状态机与设计不一致。
3. 审批、Offer、岗位等关键契约不完整。
4. 安全边界仍缺失。
5. 数据层仍以 JSON state 为主，不是设计要求的 PostgreSQL 领域仓储。
6. 文件与异步基础设施未按目标架构接入。

修复顺序应优先保证“真实招聘闭环可执行、状态可追溯、权限可执行、关键契约对齐”，再处理外部存储与高级运维。

---

## 1. 核心功能偏差清单

### 1.1 身份与角色模型

- [ ] 目标：五类角色 `admin / hr_admin / recruiter / hiring_manager / interviewer`
- [ ] 当前：`recruiter / hiring_manager / approver / admin`
- [ ] 差异：
  - 缺 `hr_admin`
  - 缺 `interviewer`
  - `approver` 是当前审批人角色，但设计里审批人主要通过 `hr_admin` 或对象审批链表达。
- [ ] 修复计划：
  - 保留 `approver` 兼容，或映射为 `hr_admin`/审批职责。
  - 新增 `interviewer`，用于面试分配与可见性。
  - 新增 `hr_admin`，用于 Offer 审批、入职归档等 HR 管理动作。
  - 更新测试与种子账号。

### 1.2 Application 状态机

- [ ] 目标状态：
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
- [ ] 当前：
  - `new | screening | interview | offer | hired | rejected | withdrawn`
- [ ] 差异：
  - 为主流程关键领域模型偏差。
  - 当前测试和前端组件都依赖旧状态。
- [ ] 修复计划：
  - 更新 `apps/api/src/recruiting/types.ts`。
  - 更新 service 中状态流转逻辑。
  - 更新测试数据与断言。
  - 更新前端 `web/src/shared/types/recruiting.ts`、状态标签和页面判断。

### 1.3 招聘需求审批模型

- [ ] 目标：
  - `ApprovalInstance`
  - `ApprovalStep`
  - `ApprovalRecord`
  - 重新提交生成新审批实例并保留历史
  - 全部步骤通过后才进入下一步
- [ ] 当前：
  - 仅有 `request.approval` 摘要字段。
  - 有简单“审批人审批”测试，但没有实例、步骤和历史资源。
- [ ] 修复计划：
  - 先在当前状态桥内建立可观察的审批实例/记录结构。
  - 增加 `GET /recruitment-requests/:id/approval`。
  - 需要新增审批查询与保留历史。

### 1.4 岗位/JD 契约

- [ ] 目标：
  - 标准分页结构 `page / pageSize`
  - `Idempotency-Key`
  - `If-Match / ETag / VERSION_CONFLICT`
  - 已发布岗位编辑产生新版本并重新确认
  - Approval 查询资源
- [ ] 当前：
  - 列表有状态过滤，未完全按契约分页。
  - 无明显乐观锁。
- [ ] 修复计划：
  - 在当前 API 层加统一分页响应。
  - 加写操作幂等键支持。
  - 为状态写和字段写增加版本校验。
  - 增加版本冲突错误。

### 1.5 权限 / DataScope

- [ ] 目标：
  - 资源动作 + 数据范围双层权限。
  - 覆盖需求、岗位、候选人、申请、面试、Offer、报表等。
- [ ] 当前：
  - 仅基础 RBAC 和 `hiring_manager` 对需求/岗位的部门过滤。
- [ ] 修复计划：
  - 继续扩展 DataScope。
  - 先修高频模块：候选人、申请、面试、Offer、报表 summary。

### 1.6 Offer 与入职归档

- [ ] 当前主流程可运行，但 Application 状态未与 Offer 状态严格同步。
- [ ] 目标要求 Application 与 Offer 状态命令必须同事务校验。
- [ ] 修复计划：
  - 结合 Application 新状态机，统一过渡命令。
  - Offer 状态保留现有设计，补充 Application 联动。

### 1.7 前端权限边界

- [ ] 目标：
  - 登录守卫
  - 导航按角色隐藏
  - 401/403 页面
  - 权限级路由守卫
- [ ] 当前：
  - 有 auth 模块，但无路由守卫和权限导航。
- [ ] 修复计划：
  - 先接 `auth/me` 和简单角色权限。
  - 未登录跳转登录页。
  - 导航根据角色隐藏管理类入口。

---

## 2. 安全偏差清单

### 2.1 会话与密码

- [ ] 目标：Argon2id 或同等安全散列；登录失败限流；禁用用户立即失效。
- [ ] 当前：SHA-256。
- [ ] 修复计划：
  - 短期本地实现可用 `crypto.scrypt` 增强，设计上应最终接 Argon2id。
  - 增加基础登录失败限流。

### 2.2 Cookie

- [ ] 目标：`__Host-` 前缀、HttpOnly、Secure、SameSite=Lax。
- [ ] 当前：`smartrecruit_session; Path=/; HttpOnly; SameSite=Lax`。
- [ ] 修复计划：
  - 本地 dev 不支持 Secure 时可保留开关；生产配置 `Secure` 与 `__Host-`。
  - 至少增加配置项，不在代码写死。

### 2.3 CSRF / Origin

- [ ] 目标：所有 Cookie 写请求通过 Origin 校验 + CSRF Token。
- [ ] 当前：未实现。
- [ ] 修复计划：
  - 增加 `GET /api/v1/auth/csrf`。
  - 对写方法校验 `X-CSRF-Token` 与 Origin。
  - 前端请求封装自动取 Token。

### 2.4 跨域 CORS

- [ ] 目标：不开放跨域凭证 CORS。
- [ ] 当前：需继续核实。
- [ ] 修复计划：
  - 限制 CORS origin，不允许 `*` + credentials。

---

## 3. 数据架构偏差清单

- [ ] 目标：
  - PostgreSQL 为权威业务数据。
  - normalized Repository：需求、审批、岗位、候选人、申请、简历、分析、事件、审计等。
- [ ] 当前：
  - 默认 JSON state 存储。
  - `PostgresRecruitingStore` 只是 JSON state 桥。
- [ ] 修复计划：
  - 第一轮可不重构全部仓储，但必须建立清晰接口边界。
  - 优先把新增审批/版本/幂等数据先按可迁移结构落到当前存储层。

---

## 4. 基础设施偏差清单

- [ ] 目标：
  - MinIO、ClamAV、Redis、Worker、可恢复异步任务。
- [ ] 当前：
  - 本地文件隔离目录，无真正扫描。
  - Worker 是本地/polling 骨架。
- [ ] 修复计划：
  - 先确保本地闭环和测试覆盖。
  - 再推进 Docker Compose 与真实外部服务。

---

## 5. 验收缺口

- [ ] 干净服务器 Compose 启动、迁移、健康、HTTPS、备份恢复未完成。
- [ ] 恢复库开放前重放删除记录未验证。
- [ ] 所有写操作缺失 CSRF/Origin。
- [ ] 并发状态命令幂等和乐观锁验证未完成。

---

## 6. 已完成项

- [x] 基础 RBAC 写权限矩阵。
- [x] 招聘需求审批基础角色限制。
- [x] `hiring_manager` 对需求/岗位基础 DataScope。
- [x] API 测试 15/15 通过。
