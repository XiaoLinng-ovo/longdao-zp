# SmartRecruit Pro 商业化内部招聘平台详细设计

> 文档状态：设计基线 v1.0
> 适用版本：从当前 `0.0.2` 继续演进
> 正式部署主线：自有服务器 Docker Compose
> 首期用户：单组织内部招聘团队
> AI 集成：平台内部能力 + 单一 OpenAI 兼容接口，可配置 `BASE_URL`
> 重要边界：本文件是设计规格，不代表所有模块已经实现。

## 1. 决策摘要

本项目从当前的单页招聘演示，演进为面向公司内部招聘团队的单组织招聘管理系统。第一阶段重点是建立真实业务基础，而不是继续扩展演示页面：真实用户登录、角色权限、招聘需求审批、岗位、候选人及职位申请、简历文件、AI 分析、面试、Offer、审计和可恢复的异步任务。

生产环境使用自有服务器上的 Docker Compose。Vue 前端编译为静态文件，由 Nginx 或 Caddy 提供；Node.js/TypeScript API 负责所有业务请求；Worker 负责简历解析和 AI 分析；PostgreSQL 保存权威业务数据；Redis 保存队列和缓存；MinIO 保存简历和业务附件。浏览器不直接调用 OpenAI、对象存储或任何内部 AI 模块。

已授权的 `CandiSift` 不作为独立产品或独立服务保留。其有价值的解析、抽取、匹配、评分和报告流程拆入本仓库的简历智能能力包，由平台自己的 API、Worker、数据库和审计机制统一控制。`Frappe HR` 不直接复制代码或页面，只借鉴其成熟的人事主数据、招聘流程、评分表、审批、活动时间线和权限设计。

## 2. 当前仓库基线

### 2.1 当前可运行内容

| 路径 | 当前内容 | 设计定位 |
|---|---|---|
| `web/` | Vue 3 + TypeScript + Vite 模块化前端，8 个只读路由 | 新正式前端的基础，保留并继续接入 API |
| `web/src/app/` | 应用壳、路由、导航和布局 | 直接保留结构，后续增加认证守卫和权限状态 |
| `web/src/modules/*` | 仪表盘、需求、岗位、候选人、面试、Offer、报表、管理后台 | 直接保留领域拆分，逐模块替换演示 API |
| `web/src/shared/` | DTO、演示数据、共享表格、状态标签、指标卡、样式 | 共享组件直接保留；演示数据改为测试种子或删除 |
| `index.html` | 旧的单文件招聘演示，包含页面、状态、AI 调用和弹窗 | 暂时只读保留，作为迁移参考；不再增加业务功能 |
| `server.mjs` | Node 原生 HTTP、整体状态文件、AI 兼容调用 | 兼容入口和迁移参考；正式 API 逐步替换 |
| `functions/api/*` | Cloudflare Pages Functions 的健康、状态和 AI 兼容接口 | 非正式主线，保留可运行性；不作为新业务实现位置 |
| `worker.mjs` | Cloudflare AI 代理 | 非正式主线，保留兼容能力；新 Worker 使用自有服务器进程 |
| `data/state.json` | Node 兼容入口在收到旧 `/api/state` 写入后才会生成的单对象状态文件 | 不是仓库内置数据；仅在实际存在且完成导出校验时作为迁移输入，不作为生产事实来源 |
| `Dockerfile` | 当前单容器 Node 服务镜像 | 保留历史部署能力；正式环境改为 Compose 多服务镜像 |
| `wrangler*.toml` | Cloudflare Pages/Worker 配置 | 保留兼容部署，不阻塞自有服务器主线 |
| `README.md` | 旧 Node、Cloudflare 和 AI 配置说明 | 改写为主线部署文档，并单列兼容方案 |

### 2.2 当前版本的明确限制

- 新 `web/` 仅使用只读演示 DTO，不写入真实业务数据。
- 旧 `PUT/POST /api/state` 可以整体覆盖状态，没有认证、权限、状态机和审计，不得作为正式业务写入接口。
- `server.mjs` 将 HTTP 路由、文件读写、状态迁移和 AI 调用混在一个文件中，必须逐步下沉到分层模块。
- 当前没有正式数据库迁移、用户账号、Session、RBAC、文件权限、任务租约、审计日志和恢复测试。

## 3. 目标与非目标

### 3.1 V1 目标

V1 必须支持一名内部招聘成员从招聘需求开始，经过审批、岗位确认、候选人导入、简历分析、人工筛选、面试、Offer 审批和入职归档完成闭环。所有关键动作可追溯，失败任务可恢复，权限由服务端强制执行。

具体目标：

1. 支持单组织、多部门和内部账号，不实现租户切换。
2. 支持招聘需求、多级审批、岗位/JD、候选人主档案和职位申请关系。
3. 支持 PDF、DOCX 和纯文本简历导入，原文件进入 MinIO，文本提取和分析结果可追溯。
4. 将 `CandiSift` 的简历智能能力内置为 `packages/resume-intelligence`，通过 Worker 异步执行。
5. 仅通过一个 OpenAI 兼容客户端调用模型；地址由服务器配置的 `OPENAI_BASE_URL` 决定，默认官方地址。
6. 支持面试轮次、面试官反馈、评分表、Offer 审批、Offer 文档和入职归档。
7. 提供管理员配置、密钥状态、任务失败列表、审计查询和健康检查。
8. 支持 Docker Compose、HTTPS 反向代理、数据库备份、附件备份和恢复演练。

### 3.2 V1 不目标

- 不实现完整 HRMS 的薪酬、考勤、绩效、工资核算和员工自助。
- 不实现多租户、租户计费、客户自助开通和客户级品牌配置。
- 不实现模型供应商路由、模型市场、供应商竞价或多模型自动切换。
- 不让 AI 自动淘汰、录用或发送 Offer；AI 只提供建议，最终动作必须人工确认。
- 不直接复制 `CandiSift` 或 `Frappe HR` 的品牌、页面、数据库结构或不可授权代码。
- 不继续把完整业务状态作为一个 JSON 对象由浏览器整体读写。

## 4. 来源复用与改造规则

每项能力只能归入以下四类之一：

- **直接保留**：当前仓库已有结构稳定、与目标边界一致，只增加接口或权限接入。
- **改造后采用**：当前或参考项目已有可用思路/实现，但需要换数据模型、接口、安全边界或 UI 后才能进入正式版本。
- **仅借鉴思路**：只吸收流程、字段、交互或工程经验，不迁移代码和原页面。
- **暂不采用**：与当前单组织招聘重点无关，或会显著扩大 V1 风险的功能。

### 4.1 当前仓库的复用清单

| 当前部分 | 结论 | 后续用途和明确改造 |
|---|---|---|
| `web/src/app/layout/AppShell.vue` | 直接保留 | 作为正式应用壳；加入当前用户、全局错误提示、加载态和登出入口。 |
| `web/src/app/navigation.ts` | 改造后采用 | 保留 8 个导航项；增加权限元数据，隐藏只是体验优化，服务端仍强制校验。 |
| `web/src/app/router.ts`、`routes.ts` | 改造后采用 | 保留路由命名；加入登录守卫、权限守卫、详情嵌套路由和 401/403 页面。 |
| `web/src/modules/dashboard` | 改造后采用 | 保留指标和漏斗展示；数据改为 `/api/dashboard/summary`，增加待审批、待反馈和失败任务待办。 |
| `web/src/modules/requisitions` | 改造后采用 | 复用列表、状态标签和表格；新增创建、编辑、提交审批、撤回、驳回、重新提交和审批详情。 |
| `web/src/modules/jobs` | 改造后采用 | 复用岗位展示；拆出岗位说明书版本、JD 确认、渠道发布和岗位生命周期。 |
| `web/src/modules/candidates` | 改造后采用 | 复用候选人表格；拆分 Candidate 与 Application，增加简历上传、去重、AI 任务、人工结论和人才库。 |
| `web/src/modules/interviews` | 改造后采用 | 保留面试列表；增加轮次、时区、面试官分配、评分表和反馈锁定。 |
| `web/src/modules/offers` | 改造后采用 | 保留状态摘要；增加薪资快照、审批链、模板版本、文档生成、发送、接受/拒绝和入职归档。 |
| `web/src/modules/reports` | 改造后采用 | 保留指标卡；查询后端聚合结果，不在浏览器从全量候选人数据自行计算。 |
| `web/src/modules/administration` | 改造后采用 | 由安全提示页扩展为用户、角色、审批链、模型配置、任务和审计管理；绝不显示密钥原文。 |
| `web/src/shared/components` | 直接保留 | `DataTable`、`StatusTag`、`MetricCard`、`PageHeader`、`EmptyState` 作为无业务规则组件。 |
| `web/src/shared/data/demo-recruiting-data.ts` | 改造后采用 | 仅用于本地开发和测试种子；正式环境不打包为权威数据。 |
| `web/src/shared/types/recruiting.ts` | 改造后采用 | 拆为 API DTO、页面 ViewModel 和领域状态枚举，禁止直接暴露数据库行。 |
| `index.html` 旧页面 | 仅借鉴思路 | 提取原有业务文案、流程顺序和交互原型；不继续在其中添加正式能力。 |
| `server.mjs` | 改造后采用 | 分阶段提取配置、HTTP、认证、服务、仓储和 AI 客户端；最终只保留启动兼容层。 |
| `/api/state` | 暂不采用为正式写入 | 迁移期间只允许管理员/脚本受控读取；正式业务使用领域 API。 |
| `functions/api/health.js` | 直接保留思路 | 自有服务器 API/Worker 均提供 `/health` 和 `/ready`。 |
| `functions/api/ai/*`、`worker.mjs` | 改造后采用思路 | 保留响应结构和降级经验；调用实现迁移到内部 `openai-client` 和 `resume-intelligence`。 |
| `Dockerfile` | 改造后采用 | 拆为 web、api、worker 镜像或多阶段构建，不再让单容器承担全部职责。 |
| `wrangler*.toml` | 暂不采用为主线部署 | 保留 Cloudflare 兼容路径，但不为其设计新的核心业务数据模型。 |

### 4.2 `CandiSift` 能力拆分清单

在取得授权代码和依赖清单后，必须先做一次逐文件来源审计，再按下表迁移。下表中的“目标模块”是本项目的归宿，不允许把 `CandiSift` 作为黑盒服务继续存在。

| 能力 | 结论 | 目标模块 | 迁移要求 |
|---|---|---|---|
| PDF/DOCX/文本读取 | 改造后采用 | `packages/resume-intelligence/parser` | 统一输出纯文本、页数、解析器版本和警告；限制大小、MIME、页数和字符数。 |
| 简历字段抽取 | 改造后采用 | `packages/resume-intelligence/extractor` | 输出 Candidate/Resume 草稿，不直接写数据库；保留原文证据位置或字段置信度。 |
| 简历脱敏 | 改造后采用 | `packages/resume-intelligence/anonymizer` | 在发送 OpenAI 前执行；手机号、邮箱、身份证、地址等敏感字段按策略替换。 |
| 岗位匹配 | 改造后采用 | `packages/resume-intelligence/matcher` | 使用岗位快照和候选人标准化字段，产出可解释的匹配项，不直接改变流程状态。 |
| 多维评分 | 改造后采用 | `packages/resume-intelligence/scorer` | 固定 V1 维度：硬性要求、经验、技能、潜力；保存规则版本和输入快照。 |
| 分析报告 | 改造后采用 | `packages/resume-intelligence/report` | 统一输出摘要、优势、风险、建议面试问题、技能和候选人档案。 |
| OpenAI 调用提示词 | 改造后采用 | `apps/worker/src/ai`、`packages/resume-intelligence/prompts` | 只通过平台客户端调用；结构化 JSON 校验、超时、重试和敏感日志过滤。 |
| 模型供应商抽象 | 暂不采用 | 无 | V1 只实现一个 OpenAI 兼容客户端，不建立供应商路由层。 |
| CandiSift 独立 API/端口 | 暂不采用 | 无 | 不部署独立容器，不暴露内部分析端口，不保留独立主业务状态。 |
| CandiSift 自有用户/租户/计费 | 暂不采用 | 无 | 统一使用本平台账号、权限和审计。 |
| 自动淘汰规则 | 暂不采用 | 无 | AI 只能给建议；人工确认后才发生状态变化。 |
| CandiSift 页面和品牌 | 暂不采用 | 无 | 使用本平台 Vue 模块和视觉系统。 |

迁移验收：相同的简历和岗位固定输入，内置能力的字段抽取、评分维度、报告字段和失败语义必须有回归快照；迁移后不得把授权项目的私有依赖、品牌标识或未审计网络调用带入生产镜像。

### 4.3 `Frappe HR` 功能借鉴清单

`Frappe HR` 在本项目中是产品设计参考，不是运行时依赖。采用其成熟的业务思想，但按当前内部招聘范围重新建模。

| `Frappe HR` 方向 | 结论 | 在本项目中的落地 |
|---|---|---|
| Employee/部门/岗位主数据 | 改造后采用 | 建立 Department、User、Job 和负责人关系；不引入完整员工档案。 |
| Job Opening/职位空缺 | 改造后采用 | 对应 RecruitmentRequest + Job，要求需求审批通过后才可创建招聘岗位。 |
| Candidate/Job Applicant 分离 | 改造后采用 | 明确 Candidate 主档案与 Application 职位申请分离，一个候选人可申请多个岗位。 |
| Interview Round/Interview Feedback | 改造后采用 | 建立多轮面试、面试官分配、评分表版本和反馈锁定。 |
| Offer Letter | 改造后采用 | 建立 Offer、OfferVersion、模板和生成文件；发送前走审批。 |
| Recruitment pipeline | 改造后采用 | 使用后端状态机和不可变 WorkflowEvent，前端只展示可执行动作。 |
| Activities/时间线 | 改造后采用 | 候选人、申请、需求和 Offer 均有事件时间线，敏感内容按权限过滤。 |
| Role/User Permission | 改造后采用 | 参考角色和文档权限，按本公司岗位归属、部门范围和动作权限重写。 |
| HRMS 薪资、考勤、休假 | 暂不采用 | 超出 V1 招聘范围，不建立对应表和页面。 |
| ERP、工资单、员工自助 | 暂不采用 | 不引入 Frappe Framework 或 ERP 依赖。 |
| Frappe 页面、主题和前端组件 | 仅借鉴思路 | 使用当前 Vue 组件和本项目视觉规范重新实现。 |
| Frappe 数据库表和字段一比一复制 | 暂不采用 | 以当前需求和 PostgreSQL 约束为准，避免无意义兼容负担。 |

## 5. 总体架构

### 5.1 运行拓扑

```text
Internet / 公司内网
        |
   Nginx 或 Caddy
        |
   +----+--------------------+
   |                         |
静态 Vue web              Node API
                              |
             +----------------+----------------+
             |                |                |
        PostgreSQL          Redis             MinIO
             |                |                |
             +--------+-------+----------------+
                      |
                 内部 Worker
                      |
              OpenAI 兼容 API
```

### 5.2 服务职责

| 服务 | 职责 | 禁止事项 |
|---|---|---|
| `web` | 页面、表单、筛选、详情和任务状态展示 | 不保存权威业务状态，不持有 OpenAI Key，不直接访问 MinIO/OpenAI |
| `api` | 认证、授权、领域用例、查询、流式上传接收、受权文件下载、审计 | 不在路由文件中写复杂业务规则，不整体覆盖状态 |
| `worker` | 领取分析任务、解析简历、调用内部智能模块和 OpenAI、写回结果 | 不接受浏览器直接调用，不绕过 API 改流程状态 |
| `postgres` | 权威业务数据、任务状态、审计、版本和约束 | 不存储明文 OpenAI Key，不依赖 Redis 作为唯一事实来源 |
| `redis` | 队列、租约、缓存、限流 | 不保存不可恢复的唯一业务记录 |
| `minio` | 原始简历、解析附件、Offer 文件 | 不公开桶，不给浏览器长期凭证 |
| `clamav` | 仅扫描隔离桶中的待处理文件 | 不向公网暴露端口，不解析或转发简历内容 |
| `proxy` | HTTPS、上传大小、速率限制、静态文件和 API 转发 | 不绕过 API 认证 |

### 5.3 推荐目录

```text
apps/
  api/
    src/{config,http,auth,permissions,domain,application-services,repositories,audit,modules}
  worker/
    src/{queue,processors,ai,storage,observability}
packages/
  resume-intelligence/
    src/{parser,extractor,anonymizer,matcher,scorer,report,prompts,contracts}
  contracts/
    src/{api,events,states}
  openai-client/
    src/{client,schemas,errors,redaction}
web/
  src/{app,modules,shared}
db/
  migrations/
  seeds/
  README.md
deploy/
  docker-compose.yml
  docker-compose.prod.yml
  nginx.conf
  Caddyfile
scripts/
  migrate-state-to-postgres.mjs
  verify-migration.mjs
  backup-verify.ps1
tests/
  unit/
  integration/
  contract/
  e2e/
```

## 6. 领域模块设计

### 6.1 身份与权限

角色固定为：系统管理员、HR 管理员、招聘专员、用人部门负责人、面试官。权限分为资源动作和数据范围两层，例如 `candidate.read` + `department:own`。后端每次请求构造 `AuthContext`，检查用户状态、角色、资源归属、当前流程节点和动作权限。

Session 使用服务器端随机令牌，浏览器只保存 `__Host-` 前缀、HttpOnly、Secure、SameSite=Lax Cookie。密码使用 Argon2id 或同等安全散列；登录失败限流；禁用用户立即失效。V1 不使用前端自行解码 JWT 决定权限。

所有改变服务端状态的 Cookie 请求必须同时通过同源 `Origin` 校验和同步器 CSRF Token 校验：登录后 `GET /api/v1/auth/csrf` 返回短期 Token，前端以 `X-CSRF-Token` 请求头提交。API 不对跨域凭证请求开启 CORS；反向代理只接受正式站点 Host。Token 校验、Session 校验和权限校验都在路由进入领域服务前完成。

### 6.2 招聘需求与审批

`RecruitmentRequest` 包含部门、岗位名称、人数、预算区间、目标到岗日期、原因、负责人和版本号。审批实例由审批策略生成，审批记录不可修改。状态：`draft`、`pending_approval`、`rejected`、`approved`、`withdrawn`、`closed`。

合法动作由 `recruitment-request-state-machine` 统一定义。审批人不能审批自己创建的需求，除非管理员策略明确允许并留下原因。驳回必须填写原因；重新提交生成新的审批实例但保留历史。

### 6.3 岗位与 JD

通过审批的需求可创建一个或多个岗位版本。岗位包含岗位说明书、JD、负责人、发布渠道、目标人数和招聘状态。说明书和 JD 均是版本化文档，确认记录包括确认人、时间和版本。未确认 JD 不得发布；已发布岗位编辑必须生成新版本并重新确认。

### 6.4 Candidate 与 Application

`Candidate` 是跨岗位的人才主档案；`Application` 是候选人对某个 Job 的申请。候选人去重依据为规范化邮箱、手机号和人工确认的弱匹配线索；自动合并只生成建议，不删除原始记录。

Application 状态：`pending_analysis`、`analysis_queued`、`human_review`、`interviewing`、`offer_approval`、`offer_sent`、`offer_accepted`、`onboarding_archived`、`rejected`、`offer_declined`、`offer_cancelled`、`offer_expired`。候选人申请多个岗位时，各 Application 独立流转；AI 分析失败不自动淘汰申请，保持在 `analysis_queued` 并显示可重试或人工复核动作。

| 动作 | 允许来源状态 | 目标状态 | 执行者与硬性前提 |
|---|---|---|---|
| 创建申请/上传清洁简历 | 新建 | `pending_analysis` | 招聘专员；Candidate、Job、清洁文件均存在 |
| 请求分析 | `pending_analysis` | `analysis_queued` | 招聘专员；创建唯一有效任务 |
| 分析成功或人工跳过分析 | `analysis_queued` / `pending_analysis` | `human_review` | Worker 成功写入结果，或有权限人员填写跳过原因 |
| 确认进入面试 | `human_review` | `interviewing` | 招聘专员；至少有一次人工筛选结论 |
| 发起 Offer 审批 | `interviewing` | `offer_approval` | HR 管理员；面试结论为通过且 Offer 草稿已完整 |
| 审批完成并发送 | `offer_approval` | `offer_sent` | HR 管理员；全部审批通过、文件版本已冻结 |
| 候选人接受 | `offer_sent` | `offer_accepted` | 招聘专员记录可验证的接受证据 |
| 入职归档完成 | `offer_accepted` | `onboarding_archived` | HR 管理员；入职归档待办完成 |
| 人工淘汰 | `pending_analysis` / `human_review` / `interviewing` / `offer_approval` | `rejected` | 有权限人员；必须填写原因 |
| Offer 拒绝、取消、过期 | `offer_sent` | 对应终态 | 候选人证据、审批取消原因或有效期任务触发 |

Offer 另有独立状态 `draft`、`pending_approval`、`approved`、`sent`、`accepted`、`declined`、`cancelled`、`expired`。任何命令同时校验 Application 与 Offer 的允许组合，不允许只更新其中一个状态。

### 6.5 简历智能

上传采用可恢复的 Saga，不假设 MinIO 与 PostgreSQL 能共享事务。API 以流式方式接收单文件（V1 上限 20 MiB），先校验扩展名、声明 MIME、文件头和权限，并写入私有 `quarantine` 桶，使用不可变对象键 `upload/{uploadId}/{sha256}`。对象写入成功后才创建 `resumes(status=quarantined)` 与清理任务；数据库写入失败则由定时清理器删除无引用对象。

ClamAV 扫描 Worker 从隔离桶读取文件，写入 `clean`、`infected` 或 `scan_failed` 状态和扫描器版本。只有 `clean` 文件会复制到正式私有桶、创建 Resume 可用版本，并允许创建 Application、AnalysisTask 和 OutboxEvent；感染或扫描失败的文件不会进入解析和 OpenAI 调用，且仅限管理员查看安全摘要。解析 Worker 在受限容器中处理 PDF、DOCX 和纯文本，不执行宏或嵌入脚本，并限制页数、解压后大小、文本字符数和处理时间。

Worker 领取分析任务后执行：文本解析 -> 脱敏 -> 岗位快照匹配 -> OpenAI 结构化分析 -> schema 校验 -> 写入结果 -> 生成审计事件。

AI 结果必须保存：模型名、请求版本、提示词版本、输入摘要哈希、生成时间、耗时、Token 用量（若接口提供）、错误类型和人工复核状态。结果不能自动改变 Application 最终状态。

### 6.6 面试

一个 Application 可有多轮 InterviewRound。每轮包含时间、时区、地点/会议链接、面试官和评分表版本。面试官只能看到被分配的申请和必要材料；提交后反馈默认锁定，修改必须走追加更正记录。面试结论由招聘专员或 HR 管理员确认，不由单个面试官直接录用。

### 6.7 Offer 与入职归档

Offer 以薪资、职级、部门、入职日期和有效期快照保存。生成、修改、审批、发送、接受、拒绝、取消和过期均是明确动作。Offer 文件使用模板版本生成并存入 MinIO，下载必须经过 API 权限校验并由 API 流式返回，不向浏览器发放对象存储 URL。接受后创建 `OnboardingRecord`，记录待办和归档状态，不扩展为完整 HRMS。

### 6.8 报表和审计

报表查询使用 PostgreSQL 聚合或预计算视图，至少包括招聘漏斗、渠道转化、平均招聘周期、岗位填充率、面试反馈完成率、Offer 接受率和 AI 调用量/成本。审计记录操作者、动作、资源、旧状态摘要、新状态摘要、原因、请求 ID 和时间；不记录简历全文、密钥和完整敏感字段。

## 7. 数据库设计

### 7.1 核心表

| 领域 | 表 |
|---|---|
| 身份 | `users`、`roles`、`permissions`、`user_roles`、`departments`、`sessions`、`csrf_tokens` |
| 需求 | `recruitment_requests`、`recruitment_request_versions`、`approval_instances`、`approval_steps`、`approval_records` |
| 岗位 | `jobs`、`job_spec_versions`、`job_description_versions`、`publish_channels`、`job_channel_publications` |
| 候选人 | `candidates`、`resumes`、`candidate_tags`、`candidate_sources`、`applications`、`application_events` |
| AI | `analysis_tasks`、`analysis_results`、`model_invocations`、`outbox_events` |
| 面试 | `interview_plans`、`interview_rounds`、`interview_feedback`、`scorecard_versions` |
| Offer | `offers`、`offer_versions`、`offer_approvals`、`offer_templates`、`offer_documents`、`onboarding_records` |
| 系统 | `audit_logs`、`notifications`、`system_settings`、`idempotency_records`、`retention_deletions` |

所有主表使用 UUID、`created_at`、`updated_at`、`created_by` 和 `version`。状态变更表只追加不覆盖。对 `applications(job_id, candidate_id)`、`resumes(candidate_id, content_hash)`、`analysis_results(analysis_task_id)`、`approval_records(step_id)` 建立唯一约束或条件唯一约束。邮箱和手机号的去重索引保存带服务器密钥的 HMAC 规范化值，而非明文检索键；原始联系信息仅保存在受权限控制的字段中。

字段编辑使用 `If-Match: <version>` 进行乐观锁校验；所有状态命令在 PostgreSQL 事务内按资源 ID `SELECT ... FOR UPDATE`，再次校验当前状态与版本，写入领域事件和审计记录后提交。`Idempotency-Key` 与操作者、路由和请求摘要一起保存到 `idempotency_records`，重复命令返回首次结果，不能再次审批、发送或生成文件。

### 7.2 `state.json` 映射

| 旧字段 | 新表 | 处理 |
|---|---|---|
| `state.jobs` | `recruitment_requests` + `jobs` | 根据是否存在需求审批、岗位说明书和发布字段拆分；无法判断的记录进入迁移异常表。 |
| `state.cands` | `candidates` + `applications` + `resumes` | 候选人基本资料进入主档案，岗位关系进入申请；评分进入分析结果草稿。 |
| `state.forms` | `interview_feedback` 或业务表单扩展 | 依据候选人、面试和表单键映射；无法匹配的内容只保留迁移报告。 |
| `state.scores` | `analysis_results` / `interview_feedback` | 标注来源为 `legacy_import`，不伪装成新 AI 结果。 |
| `state.interviews` | `interview_plans` + `interview_rounds` | 将旧的平面数组拆为申请、轮次和面试官。 |
| `state.offers` | `offers` + `offer_versions` | 保存旧状态和导入时间，缺少审批历史的字段明确为空。 |
| `state.approvalHistory` | `approval_instances` + `approval_records` | 保留原时间和操作者字符串，无法匹配用户时标记外部操作者。 |
| `state.talentTags` | `candidate_tags` | 去重后写入标签关系。 |
| `state.onboarding` | `onboarding_records` | 仅迁移招聘相关入职归档字段。 |
| `state.chatLog`、`state.seq` | 不迁移 | 聊天演示记录和本地序号不属于正式业务事实，导出报告只记录其存在与数量。 |

迁移开始前必须识别唯一实际来源：Node 部署的数据卷 `DATA_DIR/state.json`、Cloudflare KV 中键 `smartrecruit-state`，或经管理员导出的演示状态文件。对每个来源生成只读快照、SHA-256、记录数和导出时间；没有有效快照时跳过迁移而不是生成虚构历史。导入完成后必须对 jobs、candidates、interviews、offers、onboarding 的记录数与异常记录逐项对账并签字确认。

## 8. API 设计

所有接口使用 `/api/v1` 前缀、统一错误结构和分页。写操作支持 `Idempotency-Key`；状态动作使用动作型 URL，不允许客户端提交任意目标状态。

### 8.1 接口分组

```text
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
GET    /api/v1/auth/me
GET    /api/v1/auth/csrf

GET/POST/PATCH  /api/v1/recruitment-requests
POST   /api/v1/recruitment-requests/:id/submit
POST   /api/v1/recruitment-requests/:id/approve
POST   /api/v1/recruitment-requests/:id/reject
POST   /api/v1/recruitment-requests/:id/withdraw

GET/POST/PATCH  /api/v1/jobs
POST   /api/v1/jobs/:id/spec/confirm
POST   /api/v1/jobs/:id/jd/confirm
POST   /api/v1/jobs/:id/publish
POST   /api/v1/jobs/:id/pause
POST   /api/v1/jobs/:id/close

GET/POST/PATCH  /api/v1/candidates
POST   /api/v1/candidates/:id/resumes
GET    /api/v1/candidates/:id/timeline
GET/POST        /api/v1/applications
POST   /api/v1/applications/:id/analyze
POST   /api/v1/applications/:id/human-review
POST   /api/v1/applications/:id/reject
POST   /api/v1/candidates/:id/erase

GET/POST/PATCH  /api/v1/interviews
POST   /api/v1/interviews/:id/feedback
POST   /api/v1/interviews/:id/conclude

GET/POST/PATCH  /api/v1/offers
POST   /api/v1/offers/:id/submit-approval
POST   /api/v1/offers/:id/approve
POST   /api/v1/offers/:id/send
POST   /api/v1/offers/:id/accept
POST   /api/v1/offers/:id/decline

GET    /api/v1/reports/funnel
GET    /api/v1/reports/channels
GET    /api/v1/reports/cycle-time

GET/PATCH       /api/v1/admin/users
GET/PATCH       /api/v1/admin/roles
GET/PATCH       /api/v1/admin/settings
GET             /api/v1/admin/analysis-tasks
GET             /api/v1/admin/audit-logs
```

### 8.2 统一响应和错误

成功响应包含 `data`、必要的 `meta` 和 `requestId`。错误响应固定为：

```json
{
  "error": {
    "code": "APPLICATION_INVALID_TRANSITION",
    "message": "当前申请状态不允许执行该操作",
    "fields": [],
    "requestId": "req_..."
  }
}
```

客户端只根据错误码展示可理解文案，不把数据库错误、OpenAI 原始响应或密钥相关信息返回给用户。

## 9. OpenAI 集成设计

### 9.1 配置

V1 只有一个逻辑模型配置，不做供应商路由。接口地址与密钥是一个不可拆分的部署级连接，由服务器运维人员一起配置；管理员后台不能输入或覆盖地址、密钥、超时或重试次数。这样仍支持任意 OpenAI 兼容服务，但避免低权限管理员把现有密钥和简历导向任意 URL。服务器环境变量为：

```text
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini
OPENAI_TIMEOUT_MS=30000
OPENAI_MAX_RETRIES=3
OPENAI_ALLOWED_HOSTS=api.openai.com
OPENAI_ALLOWED_PRIVATE_CIDRS=
```

部署时可将 `OPENAI_BASE_URL` 设置为 OpenAI 官方地址或公司批准的兼容地址；其值必须为 HTTPS、不得包含用户名/密码，且主机必须匹配运维配置的 `OPENAI_ALLOWED_HOSTS`。客户端在每次解析 DNS 后拒绝 loopback、link-local、metadata 和未批准的私有网段；如公司确需内网模型服务，只能由运维在 `OPENAI_ALLOWED_PRIVATE_CIDRS` 明确声明。产品界面不展示供应商市场或路由概念，只显示当前连接的脱敏主机、模型、健康状态与配置版本。`OPENAI_API_KEY` 只在 API/Worker 进程读取，绝不提供查看、录入或导出接口；“测试连接”只能测试当前有效连接，不能接受前端传入 URL 或 Key。

### 9.2 调用约束

- 所有调用集中在 `packages/openai-client`，不允许业务模块直接 `fetch`。
- 简历正文先经过脱敏；岗位上下文只发送完成任务必需字段。
- 使用结构化 JSON 输出和 Zod/JSON Schema 校验；校验失败进入可重试错误。
- 对 429、408、网络超时和 5xx 使用指数退避；4xx 参数错误不无限重试。
- 记录模型、请求 ID、耗时和用量，不记录 API Key、简历正文和完整 prompt。
- OpenAI 不可用时任务进入 `failed`，前端显示可重试；不得伪造成功评分。

## 10. 异步任务与可靠性

分析任务创建与 OutboxEvent 在同一数据库事务中写入。Dispatcher 将未投递事件写入 Redis，成功后标记 `published_at`。Worker 使用租约领取任务，定时更新 heartbeat；租约过期后可被重新领取。`analysis_results.analysis_task_id` 唯一保证重复投递最多产生一份有效结果。

任务状态：`queued`、`running`、`succeeded`、`failed`、`cancelled`。失败保存分类原因、重试次数、下次重试时间和最后安全错误摘要。Redis 重启后，Dispatcher 和 Worker 根据 PostgreSQL 状态重扫任务，不能依赖 Redis 永久保存任务。

## 11. 管理、安全与隐私

### 11.1 管理后台

管理后台包含用户/角色、部门、审批链、面试评分表、Offer 模板、OpenAI 连接状态、任务失败列表、文件策略、通知配置和审计日志。管理员可查看当前模型、脱敏主机、健康状态和配置版本，并测试当前有效连接；任何测试都不得接受 URL、Key 或简历正文。接口地址、模型、超时、重试次数和密钥均由服务器运维通过部署环境变量成组变更和轮换，成功响应只返回状态、更新时间、脱敏主机和配置版本。

### 11.2 文件安全

上传限制扩展名、MIME、文件大小、页数和内容扫描；对象存储桶私有。下载通过 API 权限校验并由 API 流式返回，日志不记录完整 URL 或简历内容。原始文件、提取文本和分析结果按留存策略清除；法律保全需要明确负责人、原因和到期复核时间。

### 11.3 数据隐私

候选人导出需要权限、用途和审计。管理员通过 `POST /api/v1/candidates/:id/erase` 发起删除，必须填写法定/业务原因；系统先创建 `retention_deletions` 记录，再清除原文件、提取文本、AI 结果、搜索索引和该候选人的邮箱/手机号 HMAC 去重键，并保留不含身份信息的审计摘要。后续同一候选人重新导入时作为全新资料处理，不自动恢复已清除资料。

常规数据库和对象存储备份不做单条记录原位删除。生产备份必须加密、隔离访问，并有明确最长保留期；被删除的候选人可能只会在备份自然到期后彻底消失。恢复流程先加载 `retention_deletions`，在恢复库开放前重放尚未处理的清除记录。统计报表只保留无法反推身份的聚合数据。

## 12. Docker Compose 部署

生产服务建议：`proxy`、`web`、`api`、`worker`、`clamav`、`postgres`、`redis`、`minio`。仅 `proxy` 暴露公网端口；数据库、Redis、MinIO、ClamAV 和 Worker 使用内部网络。持久卷包括 PostgreSQL、MinIO 和备份目录；Redis 不作为业务备份。

部署顺序：准备 `.env` 和密钥 -> 启动 PostgreSQL/Redis/MinIO/ClamAV -> 执行 migration -> 创建首个管理员 -> 启动 API/Worker/Web -> 运行健康检查 -> 配置 HTTPS -> 执行备份验证。每个服务必须有健康检查和资源限制。生产日志使用 JSON，带 request ID、user ID、实体 ID 和 task ID。

## 13. 分阶段实施顺序

### Phase 0：基线和来源审计

冻结旧单页业务扩展；核对 `CandiSift` 授权范围、依赖、许可证、输入输出和网络行为；为其每个能力建立迁移快照。确认当前 `0.0.2` 可回滚。

### Phase 1：工程和数据库基础

创建 `apps/`、`packages/`、`db/` 和 Compose 骨架；建立用户、部门、需求、岗位、候选人、申请、任务和审计表；加入 migration、seed、健康检查和统一配置。

### Phase 2：认证、RBAC 和审计

实现登录、Session、角色、权限、数据范围、统一错误和审计中间件；先保护所有写接口，再开放业务页面。

### Phase 3：需求、审批和岗位

实现需求状态机、审批实例、岗位说明书/JD 版本、确认和发布；将 `web` 的需求/岗位模块改为真实 API。

### Phase 4：候选人、简历和内置智能能力

实现 MinIO 上传、病毒扫描、解析器、脱敏、`packages/resume-intelligence`、OpenAI 客户端、Outbox、Redis Worker 和人工复核；将候选人模块改为真实 API。

### Phase 5：面试、Offer 和入职归档

实现评分表、反馈锁定、Offer 审批、模板版本、文件生成、发送和入职归档。

### Phase 6：报表、迁移和生产运维

实现聚合报表、旧 `state.json` 迁移脚本、备份恢复演练、Compose 生产配置、HTTPS、监控和下线整体状态写入。

每个 Phase 必须有独立测试和可回滚提交，不允许跨阶段直接把旧页面全量替换。

## 14. 测试与验收

### 14.1 测试层级

- 单元测试：状态机、权限策略、CSRF/Origin 校验、字段校验、脱敏、评分归一化、OpenAI 响应解析和连接地址校验。
- 集成测试：API + PostgreSQL、API + MinIO + ClamAV 隔离/转正、Outbox + Redis、任务租约、幂等和并发状态命令。
- 合约测试：前端 API 适配层与后端 OpenAPI/DTO 一致。
- E2E：登录 -> 需求审批 -> 岗位发布 -> 简历上传 -> AI 分析 -> 面试 -> Offer -> 入职归档。
- 运维测试：容器重启、Redis 丢失、Worker 重启、数据库备份恢复、清除任务在开放恢复库前重放，以及 OpenAI 出站主机限制。

### 14.2 V1 验收标准

1. 五类角色不能访问或操作超出范围的页面和 API。
2. 需求、岗位、申请、面试和 Offer 的每次状态变更都能追溯操作者、时间、原因和版本。
3. 候选人申请多个岗位时，任何一个申请的淘汰不会改变其他申请状态。
4. 简历先进入隔离桶，经 ClamAV 扫描合格后才能解析和分析；分析任务在 API、Redis 或 Worker 重启后可恢复。
5. 重复投递同一任务最多写入一份有效分析结果。
6. OpenAI 连接可由服务器环境变量自定义；浏览器、日志和管理员 API 中不存在 API Key，且不得将请求发送至未批准的主机。
7. AI 结果显示模型、版本、生成时间和“人工复核后使用”提示，不能自动淘汰或录用。
8. 面试反馈提交后可追溯，Offer 发放前必须通过审批。
9. 报表由后端聚合生成，权限过滤后才返回数据。
10. 并发提交审批、Offer 发送和重复动作命令时，只产生一条合法状态变更和一份可重放响应。
11. 所有 Cookie 写请求缺失有效 CSRF Token、来源不匹配或跨域携带凭证时均被拒绝。
12. 干净服务器执行 Compose 启动、migration、健康检查、HTTPS 和备份恢复流程成功；恢复库在开放前已重放删除记录。
13. 旧 `index.html`、`server.mjs` 和 Cloudflare 兼容入口在迁移期间仍可回滚，但 `/api/state` 不再是正式业务写入路径。

## 15. 实施时的文件使用顺序

| 顺序 | 主要文件/目录 | 用途 |
|---:|---|---|
| 1 | `docs/superpowers/specs/`、`docs/superpowers/plans/` | 先冻结设计和任务边界 |
| 2 | `web/src/app/`、`web/src/shared/` | 保持前端壳和通用组件稳定 |
| 3 | `web/src/modules/requisitions`、`jobs` | 先接需求审批和岗位 API |
| 4 | `db/migrations/`、`apps/api/src/auth`、`permissions` | 建立真实数据和安全边界 |
| 5 | `apps/api/src/modules`、`apps/worker/src` | 按领域实现后端用例和异步任务 |
| 6 | `packages/resume-intelligence`、`packages/openai-client` | 内置 `CandiSift` 能力并统一 OpenAI 调用 |
| 7 | `web/src/modules/candidates`、`interviews`、`offers` | 接入真实业务闭环 |
| 8 | `scripts/`、`deploy/`、`tests/` | 数据迁移、部署和生产验收 |
| 9 | `index.html`、`server.mjs`、`functions/` | 最后降级为兼容/迁移入口，不再扩展 |

## 16. 关键工程原则

1. 前端显示权限，后端执行权限。
2. 页面调用领域 API，不能整体读写状态。
3. Candidate 与 Application 分离，Offer 与 OfferVersion 分离。
4. 状态机集中在领域层，路由只做参数和响应。
5. Redis 可丢失，PostgreSQL 必须可恢复。
6. AI 结果可解释、可重试、可审计，但不取代人工决定。
7. OpenAI Key 只在服务器侧存在，`BASE_URL` 可配置但 V1 不做路由平台。
8. 所有来源代码先审计许可证、依赖和数据流，再决定是否迁移。
9. 每个阶段都必须有测试、迁移记录和回滚方案。
