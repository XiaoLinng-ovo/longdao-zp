# SmartRecruit Pro 项目设计规划

> 文档版本：v1.0
> 日期：2026-09-09
> 目标：把当前招聘演示系统逐步建设为可用的单组织内部招聘平台
> 当前执行范围：完成现状审查、冻结目标设计、保留本地可运行入口；暂不进入 Phase 2 开发

## 1. 项目定位

SmartRecruit Pro 是面向企业内部招聘团队的招聘流程管理平台，核心流程为：

```text
招聘需求 → 审批 → 岗位/JD → 候选人 → 职位申请 → 简历安全扫描
→ 简历解析与智能建议 → 人工复核 → 面试 → Offer 审批 → 入职归档
```

平台的事实来源应当是 PostgreSQL。浏览器只通过业务 API 工作；Redis 用于可重建的队列、缓存和锁；MinIO 用于简历和附件；ClamAV 用于隔离文件扫描；Worker 负责异步任务。AI 只能给出建议、证据和风险提示，不能自动淘汰、录用或发送 Offer。

## 2. 现状审查

### 2.1 现有功能已经达到的程度

| 영역 | 当前实现 | 完成度判断 |
| --- | --- | --- |
| 旧版招聘演示 | 根目录 `index.html` 提供单页流程、候选人、面试、Offer、报表和系统配置交互 | 演示级可用 |
| 旧版状态保存 | `server.mjs`、Pages Functions 和 `/api/state` 支持整体 JSON 状态读写 | 原型级可用，不适合作为正式业务数据层 |
| 旧版 AI 接口 | 支持 OpenAI 兼容接口、默认评分、岗位规格和简历分析入口 | 演示级可用，缺少正式鉴权、审计和异步任务治理 |
| 新版前端 | `web/` 已拆分仪表盘、招聘需求、岗位、候选人、面试、Offer、报表、管理 8 个模块 | 页面骨架完成 |
| 新版数据层 | 各模块 API 仍返回 `DemoRecruitingData` | 尚未接入正式 API |
| 前端 API 边界 | `web/src/shared/api/` 已支持统一 JSON 响应、request id、401/403、网络和协议错误 | 基础能力完成 |
| API 服务 | `apps/api/` 已提供 health、ready、me 未认证响应、统一错误和 request id | Phase 1 骨架完成 |
| 领域契约 | `packages/contracts/` 已定义需求、审批、岗位、候选人、申请、简历、分析、面试、Offer DTO 和状态枚举 | 第一版契约完成，需随业务 API 演进 |
| 数据库 | `db/migrations/0001_initial_schema.sql` 已覆盖用户、权限、需求、审批、岗位、候选人、申请、简历、分析、事件和审计基础表 | 基础模型完成，尚无 Repository 和业务命令 |
| Worker | 已有任务信封、重试分类、幂等边界、简历分析处理器和健康检查 | 运行时骨架完成，尚未连接 Redis/PostgreSQL/MinIO |
| 简历智能 | 已有解析、章节识别、抽取、脱敏、标准化、匹配、评分、规则报告和 Prompt 边界 | 纯能力包完成第一版，尚未接入业务流程 |
| 基础设施 | Compose 已定义 PostgreSQL、Redis、MinIO、ClamAV | 配置完成，当前机器未做真实启动验证 |
| 测试 | API、Worker、简历智能、前端和契约均有独立检查 | 骨架测试完成，业务集成测试未开始 |

### 2.2 与目标设计的差距

当前系统可以展示招聘流程，但不能作为真实招聘平台使用。主要差距如下：

1. 新版前端没有登录、会话、角色权限和数据范围控制。
2. 招聘需求、岗位、候选人、申请、面试和 Offer 页面没有真实读写接口。
3. 所有新模块仍使用本地固定 Demo 数据，刷新后不会产生正式业务记录。
4. API 没有 PostgreSQL Repository、事务、状态机、乐观锁和幂等命令。
5. 简历文件没有上传、隔离存储、病毒扫描、清理和访问审计闭环。
6. Worker 没有 Redis 队列、PostgreSQL 任务状态、租约、心跳和崩溃恢复。
7. AI 结果还没有写入 `analysis_results` 并关联人工复核流程。
8. 面试反馈锁定、Offer 版本、审批记录和入职归档尚未形成真实领域逻辑。
9. 报表目前是演示数据，不是 PostgreSQL 聚合结果。
10. 旧 `/api/state` 与新平台并存，尚未完成数据迁移和正式入口收敛。

## 3. 目标产品边界

### 3.1 V1 必须完成

| 能力域 | V1 验收标准 |
| --- | --- |
| 身份与权限 | 用户可以登录和退出；Session Cookie、CSRF、Origin、RBAC、部门数据范围和审计生效 |
| 招聘需求 | 招聘专员创建需求；需求包含岗位、部门、人数、预算、理由和版本；需求可以提交、审批、驳回、重新提交 |
| 岗位与 JD | 已审批需求可以生成岗位；岗位和 JD 支持版本、草稿、发布、暂停、关闭和归档 |
| 候选人与申请 | Candidate 与 Application 分离；一个候选人可以申请多个岗位；申请状态由后端命令推进 |
| 简历 | 文件进入隔离存储；完成类型、大小、哈希和病毒扫描；只有 clean 文件进入解析 |
| 智能分析 | 解析、脱敏、匹配、评分、证据、风险和面试问题可追溯；结果必须人工复核 |
| 面试 | 支持多轮面试、面试官、评分表、反馈提交和锁定；历史反馈不可覆盖 |
| Offer | Offer 独立建模；版本化、审批、发送、接受、拒绝、过期和取消可追踪 |
| 报表 | 招聘漏斗、渠道转化、招聘周期、岗位填充、反馈完成、Offer 接受率可由后端聚合 |
| 可运维性 | API、Worker、PostgreSQL、Redis、MinIO、ClamAV 有健康检查、日志、备份和恢复验证 |

### 3.2 V1 明确不做

多租户、完整 HRMS、薪酬、考勤、公开招聘门户、OCR、复杂 Agent、向量数据库、复杂通知中心和多供应商模型路由不进入当前 V1。

## 4. 目标架构

```text
Vue 3 前端
  ↓ 统一 API Client
Node.js/TypeScript API
  ↓ Session / RBAC / DataScope / Application Service
Domain State Machine + Repository
  ↓
PostgreSQL ← Outbox Dispatcher → Redis Queue → Worker
    ↑                              ↓
  Audit                       MinIO / ClamAV / resume-intelligence
```

边界约束：

- 页面不直接改变领域状态；状态变更通过后端命令完成。
- PostgreSQL 保存业务事实、任务状态、版本和审计记录。
- Redis 丢失后可以从 PostgreSQL 重建任务投递。
- 原始简历不进入日志，不覆盖，不在未经脱敏前发送给模型。
- AI 结果不得直接改变 Application、Offer 或雇佣状态。
- `Candidate`、`Application`、`Resume`、`AnalysisResult`、`Offer` 和 `OfferVersion` 保持独立建模。
- 旧 `/api/state` 只作为迁移和回滚参考，不能新增正式业务写入逻辑。

## 5. 分阶段实施规划

### 阶段 A：设计冻结与现状基线（当前）

交付：本规划、设计日志、现状矩阵、来源登记、领域实体和状态边界。

完成标志：团队确认 Candidate/Application 分离、AI 人工边界、PostgreSQL 事实来源和新旧入口迁移原则。

### 阶段 B：Phase 1 工程骨架（已完成第一轮）

交付：API 骨架、共享契约、首批 Migration、Compose、Worker 骨架、简历智能包、前端 API Client、独立测试。

完成标志：各包可以独立检查；前端可以本地启动；真实基础设施验证可以转移到 GitHub Actions 或后续部署环境。

### 阶段 C：认证和安全基线（后续执行）

先补齐 Session、密码哈希、登录限流、CSRF、Origin、RBAC、DataScope、审计上下文和权限测试，再开放业务写接口。

### 阶段 D：招聘需求、审批、岗位和 JD

实现 Repository、状态机、应用服务和 API；把 `requisitions`、`jobs` 页面从 Demo API 切换到真实 API；补齐乐观锁、审批记录和越权测试。

### 阶段 E：候选人、申请、简历和智能分析

实现 Candidate/Application/Resume API、文件上传、隔离桶、ClamAV、Outbox、Redis Worker、解析、分析、人工复核和失败恢复。

当前已完成本地第一刀：Candidate/Application API 已存在；Resume 创建会保存隔离文件、哈希和 queued AnalysisTask；本地规则分析可以生成持久化分析结果并更新申请 AI 分数。尚未完成真实 ClamAV、MinIO、Redis Worker、PDF/DOCX 解析和人工复核命令。

### 阶段 F：面试、Offer、入职归档

实现面试轮次、反馈锁定、Offer 版本和审批、发送/接受/拒绝/过期、入职归档及审计。

### 阶段 G：报表、迁移和生产化

实现后端聚合报表、旧 `state.json` 映射迁移、备份恢复、数据清理、日志监控和旧入口下线或只读化。

## 6. 当前代码实施顺序

下一轮实际开发按以下顺序推进：

1. 保持现有页面和 Demo 数据可运行，补齐正式领域 API 的接口清单和响应契约。
2. 建立 Repository、事务边界、状态机和应用服务目录。
3. 完成招聘需求和岗位的最小闭环，再切换两个前端模块。
4. 加入数据库集成测试；基础设施使用 GitHub Actions 或部署环境验证，不要求本机 Docker。
5. 再进入候选人、申请、简历上传和分析任务闭环。

每一步都必须同时更新设计日志、测试和验收条件；未接入真实 API 的页面不得标记为业务完成。

## 7. 验收口径

一个能力只有同时满足以下条件才算完成：

- 有领域 DTO 和状态转换定义；
- 有后端权限检查和数据范围检查；
- 有事务和乐观锁/幂等策略；
- 有 API 集成测试；
- 有前端真实 API 适配；
- 有审计或事件记录；
- 有失败、重试和恢复路径；
- 有设计日志记录实际完成和遗留风险。

## 8. 当前结论

当前平台处于“可演示、骨架已建立、业务闭环尚未接通”的阶段。当前最有价值的工作是把招聘需求、审批、岗位和 JD 做成第一个真实 API 闭环，再逐步接入候选人和申请。当前不把页面数量、Demo 数据量或测试通过数量当作业务完成度。
