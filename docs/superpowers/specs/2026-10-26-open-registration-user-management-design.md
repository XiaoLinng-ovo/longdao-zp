# 开放注册与平台用户管理设计

日期：2026-10-26

状态：待用户评审

## 1. 目标

开放企业自助注册。用户完成注册时，系统在同一事务中创建：

1. 个人登录账号。
2. 所属企业工作空间。
3. 企业所有者成员关系。
4. 企业内初始业务角色。
5. 注册与企业创建审计记录。

注册成功的企业默认进入 14 天试用。平台管理员通过独立的平台用户管理页面查看账号、企业归属、登录安全状态和操作记录，并可执行必要的账号支持操作。

本设计延续现有平台运营、企业成员和招聘业务权限的分层，不新增含义模糊的 `super_admin` 角色。

## 2. 权限边界

### 2.1 身份层级

| 层级 | 身份 | 作用范围 | 主要职责 |
| --- | --- | --- | --- |
| 平台层 | `platform admin` | 全平台 | 查看账号、企业归属、服务状态；执行账号支持和安全处置 |
| 平台层 | `platform viewer` | 全平台 | 只读查看用户和企业信息 |
| 企业层 | `owner` | 单个企业 | 管理本企业成员、邀请码、企业设置 |
| 企业层 | `admin` | 单个企业 | 协助管理本企业成员和企业设置 |
| 企业层 | `member` | 单个企业 | 使用被授权的招聘业务功能 |
| 业务层 | `recruiter`、`hiring_manager`、`approver`、`interviewer`、`hr_admin`、`admin` | 单个企业 | 控制招聘业务流程权限 |

平台身份不从企业身份或业务角色推导。企业身份也不因用户拥有平台身份而提升。

### 2.2 平台管理员可以查看

- 账号姓名、邮箱、可选手机号。
- 账号启用状态、注册来源、注册时间、最后登录时间。
- 当前平台身份。
- 所属企业列表，包括企业名称、企业状态、服务状态、企业身份、业务角色、部门、加入时间。
- 最近活跃会话的创建时间、最后活动时间、IP 地址和 User-Agent 摘要。
- 最近 30 条与该账号有关的平台审计和企业审计记录。

### 2.3 平台管理员不可以查看

- 密码哈希、Session Token、CSRF Token。
- 候选人简历正文、附件内容、解析结果。
- 面试录音、转写正文、面试评价。
- Offer、薪资、入职材料正文。
- 企业 AI 密钥或第三方集成密钥。

平台用户管理只处理账号与企业归属，不成为招聘业务数据的旁路入口。

### 2.4 平台管理员可以执行

- 停用账号。
- 启用账号。
- 强制退出所有会话。
- 重置为一次性临时密码，并撤销现有会话。
- 编辑基础账号资料，例如姓名和可选手机号。
- 查看所属企业并跳转到企业客户详情。

平台管理员不能直接在用户详情页修改企业内业务角色、部门或企业成员身份。此类操作由企业所有者或企业管理员完成。

所有写操作必须填写原因，并写入 `platform_audit_logs`。平台 `viewer` 只能读取。

### 2.5 保护规则

- 平台管理员不能停用自己。
- 不能停用、撤销最后一位有效平台管理员。
- 停用用户时必须撤销该用户全部有效会话。
- 重置密码时必须撤销该用户全部有效会话。
- 用户被停用后，现有 Session 在下一次鉴权时立即失效。
- 所有平台写接口要求可信 Origin 和 CSRF。

## 3. 注册流程

### 3.1 注册表单

开放注册表单包含：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| 企业名称 | 是 | 2 至 120 个字符，去除首尾空格 |
| 管理员姓名 | 是 | 2 至 80 个字符 |
| 工作邮箱 | 是 | 有效邮箱，保存前转为小写 |
| 手机号 | 否 | 允许中国手机号或国际 E.164 格式 |
| 密码 | 是 | 8 至 128 个字符 |
| 确认密码 | 是 | 必须与密码一致，仅前端校验 |

企业名称不要求全平台唯一。相同企业名称可能属于不同组织，用户通过企业 ID 区分。

### 3.2 服务状态

新注册企业使用以下初始值：

- `organizations.kind = 'production'`
- `organizations.status = 'active'`
- `organizations.service_status = 'trial'`
- `organizations.trial_ends_at = now() + interval '14 days'`

平台管理员可以继续使用现有企业客户管理能力延长试用、暂停或恢复企业。

### 3.3 原子创建

服务端在单个 PostgreSQL 事务中执行：

1. 校验企业名称、姓名、邮箱、手机号和密码。
2. 检查邮箱是否已存在。
3. 创建 `users` 记录，`registration_source = 'open_registration'`。
4. 创建 `organizations` 记录。
5. 创建 `organization_members` 记录，`role = 'owner'`，`business_role = 'recruiter'`。
6. 创建 `user_roles` 记录，初始全局角色为 `recruiter`。
7. 写入企业审计：企业创建、所有者创建。
8. 写入平台审计：开放注册事件。
9. 提交事务。

任一步失败时全部回滚，不留下只有账号没有企业、或者只有企业没有所有者的半成品数据。

### 3.4 注册后体验

注册接口返回：

```json
{
  "user": {
    "id": "uuid",
    "name": "管理员姓名",
    "email": "owner@example.com",
    "role": "recruiter"
  },
  "workspace": {
    "id": "uuid",
    "name": "企业名称",
    "kind": "production",
    "role": "owner",
    "serviceStatus": "trial",
    "trialEndsAt": "2026-11-09T00:00:00.000Z"
  }
}
```

前端注册成功后自动登录，并在只有一个企业时自动选择该企业，直接进入招聘工作台。若用户已有多个企业，则进入企业选择页。

### 3.5 防滥用

开放注册至少采用以下限制：

- 同一邮箱每小时最多 3 次注册尝试。
- 同一 IP 每小时最多 10 次注册尝试。
- 成功注册后清除该邮箱的失败计数。
- 被限流时返回 `429 REGISTRATION_RATE_LIMITED`。
- 注册写请求在配置了 `ALLOWED_ORIGINS` 时执行来源校验。

注册尝试记录不包含密码或密码哈希。

## 4. 数据模型

新增迁移：`db/migrations/0050_open_registration_user_management.sql`

### 4.1 `users` 扩展

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_source text;

UPDATE users
SET registration_source = 'legacy'
WHERE registration_source IS NULL;

ALTER TABLE users ALTER COLUMN registration_source SET DEFAULT 'legacy';
ALTER TABLE users ALTER COLUMN registration_source SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_registration_source_check
  CHECK (registration_source IN ('legacy', 'open_registration', 'platform_created'));
```

`phone` 可为空。展示时列表默认脱敏，详情页由平台管理员查看完整值。

### 4.2 注册尝试

```sql
CREATE TABLE IF NOT EXISTS registration_attempts (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  ip_address inet,
  succeeded boolean NOT NULL DEFAULT false,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registration_attempts_email_time_idx
  ON registration_attempts(lower(email), attempted_at DESC);
CREATE INDEX IF NOT EXISTS registration_attempts_ip_time_idx
  ON registration_attempts(ip_address, attempted_at DESC);
```

### 4.3 查询索引

```sql
CREATE INDEX IF NOT EXISTS users_created_at_idx ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS users_active_created_idx ON users(is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_user_last_seen_idx
  ON sessions(user_id, last_seen_at DESC)
  WHERE revoked_at IS NULL;
```

### 4.4 现有表复用

- `organizations`、`organization_members`、`organization_invitations` 保持现有职责。
- `sessions` 复用现有 `ip_address`、`user_agent`、`last_seen_at`、`revoked_at`。
- `platform_audit_logs` 记录平台级用户操作。
- `audit_logs` 记录企业级成员和权限变化。
- `login_attempts` 继续只记录登录行为，不混入注册尝试。

## 5. API 设计

### 5.1 开放注册

`POST /api/v1/auth/register`

请求：

```json
{
  "name": "陈婉清",
  "email": "chen@example.com",
  "phone": "13800000000",
  "password": "secret-password",
  "companyName": "龙道科技"
}
```

响应：`201 Created`，返回 `{ user, workspace }`。

错误：

- `VALIDATION_ERROR`：字段格式无效。
- `EMAIL_ALREADY_EXISTS`：邮箱已注册。
- `REGISTRATION_RATE_LIMITED`：尝试过于频繁。
- `REGISTRATION_UNAVAILABLE`：企业创建失败或数据库不可用。

### 5.2 平台用户列表

`GET /api/v1/platform/users`

查询参数：

- `q`：匹配姓名、邮箱、手机号或用户 ID。
- `status`：`active` 或 `disabled`。
- `workspaceId`：按企业过滤。
- `platformRole`：`admin`、`viewer` 或 `none`。
- `page`：从 1 开始，默认 1。
- `pageSize`：默认 20，最大 100。

响应：

```json
{
  "items": [
    {
      "id": "uuid",
      "displayName": "陈婉清",
      "email": "chen@example.com",
      "phoneMasked": "138****0000",
      "isActive": true,
      "platformRole": null,
      "registrationSource": "open_registration",
      "createdAt": "2026-10-26T01:00:00.000Z",
      "lastLoginAt": "2026-10-26T02:00:00.000Z",
      "workspaceCount": 1,
      "primaryWorkspace": {
        "id": "uuid",
        "name": "龙道科技",
        "kind": "production",
        "serviceStatus": "trial",
        "membershipRole": "owner",
        "businessRole": "recruiter"
      }
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

### 5.3 平台用户详情

`GET /api/v1/platform/users/:id`

响应：

```json
{
  "user": {
    "id": "uuid",
    "displayName": "陈婉清",
    "email": "chen@example.com",
    "phone": "13800000000",
    "isActive": true,
    "platformRole": null,
    "registrationSource": "open_registration",
    "createdAt": "2026-10-26T01:00:00.000Z",
    "lastLoginAt": "2026-10-26T02:00:00.000Z"
  },
  "workspaces": [],
  "activeSessions": [],
  "recentAudit": []
}
```

`workspaces` 每项包含企业状态、服务状态、企业身份、业务角色、部门和加入时间。

`activeSessions` 每项包含会话 ID、创建时间、最后活动时间、IP 地址、User-Agent 摘要，不返回 Token。

`recentAudit` 合并平台审计和企业审计，按时间倒序最多 30 条。

### 5.4 账号状态

`PATCH /api/v1/platform/users/:id/status`

请求：

```json
{
  "isActive": false,
  "reason": "用户申请停用账号"
}
```

停用账号时同时撤销全部有效会话。启用账号不恢复旧会话。

### 5.5 强制退出

`POST /api/v1/platform/users/:id/revoke-sessions`

请求：

```json
{
  "reason": "异常登录排查"
}
```

响应返回撤销的会话数。

### 5.6 重置密码

`POST /api/v1/platform/users/:id/reset-password`

请求：

```json
{
  "reason": "用户无法登录，经身份核验"
}
```

响应包含一次性临时密码：

```json
{
  "temporaryPassword": "generated-password",
  "revokedSessions": 2
}
```

响应头必须包含 `Cache-Control: no-store`。临时密码只返回一次，不写日志，不写审计元数据。

### 5.7 基础资料

`PATCH /api/v1/platform/users/:id/profile`

允许字段：`displayName`、`phone`。

不允许通过此接口修改：企业成员身份、业务角色、部门、平台身份。

## 6. 后端结构

新增模块：

```text
apps/api/src/platform/users/
  service.ts
  types.ts
  validation.ts
```

职责：

- `service.ts`：用户列表、详情、状态变更、会话撤销、密码重置、资料更新。
- `validation.ts`：分页、筛选、手机号、原因和资料字段校验。
- `types.ts`：服务层记录与响应类型。

路由继续位于 `apps/api/src/routes.ts`，平台权限继续由 `createPlatformAccessMiddleware` 处理。

注册流程修改：

- `RegisterInput` 增加 `companyName` 和可选 `phone`。
- `PostgresSessionRepository.registerUser` 改为原子事务并返回 `{ user, workspace }`。
- `LocalAuthSessionStore.registerUser` 同步创建本地企业和企业所有者关系，保证开发环境行为一致。
- `AuthService.register` 透传新返回值。

## 7. 前端设计

新增页面：

```text
web/src/modules/platform/users/
  pages/PlatformUsersPage.vue
  components/UserDetailDrawer.vue
  components/UserStatusDialog.vue
  api/index.ts
```

### 7.1 路由与导航

- 新路由：`/platform/users`
- 新导航：平台运营 / 用户管理
- 权限：`platformAdminOnly`
- 旧 `/administration?module=users` 重定向到 `/platform/users`
- 旧账号创建入口保留在平台系统配置中，但新建账号写入 `registration_source = 'platform_created'`

平台管理员通过“账号创建”选择初始企业和初始业务角色属于开户支持操作，不等同于在用户详情页持续修改企业权限。开户完成后，业务角色和部门变更由企业所有者或企业管理员维护。

### 7.2 列表

列表列：

- 用户：姓名、邮箱、脱敏手机号、用户 ID。
- 所属企业。
- 企业身份和业务角色。
- 账号状态。
- 最近登录与注册时间。
- 操作入口。

桌面端右侧固定详情抽屉。移动端详情改为整页或底部全屏面板。

### 7.3 详情

详情分区：

1. 账号概览。
2. 企业归属。
3. 登录安全。
4. 操作记录。

固定提示：

> 平台视图仅用于账号支持和安全处置，不包含该用户的简历、面试录音、面试评价或 Offer 内容。

### 7.4 注册页

注册页增加“企业名称”和可选“手机号”，更新说明为：

> 注册后将自动创建企业，你将成为企业所有者。

注册成功后：

1. 自动登录。
2. 若只有一个可用企业，自动选择并进入工作台。
3. 若存在多个企业，进入企业选择页。

## 8. 错误处理

- 表单字段错误：字段旁显示具体提示，保留已输入内容。
- 邮箱重复：提示直接登录，不暴露其他账号信息。
- 注册事务失败：提示稍后重试，不创建部分数据。
- 平台详情加载失败：保留列表并显示详情错误，不关闭整个页面。
- 会话失效：跳转登录页，保留原页面地址。
- 权限撤销：下一次请求立即返回 `403`，不使用缓存中的平台身份。
- 版本或并发冲突：返回 `409`，要求刷新后重试。

## 9. 审计

平台用户操作写入 `platform_audit_logs`：

- `platform.user.status`
- `platform.user.profile`
- `platform.user.sessions_revoked`
- `platform.user.password_reset`
- `platform.user.registered`

审计元数据只记录目标用户、企业、变更字段、请求 ID 和操作原因，不记录密码、Token、简历或面试内容。

## 10. 测试

### 10.1 API 单元和 PostgreSQL 集成测试

- 开放注册成功创建用户、企业、所有者成员和业务角色。
- 任意写入失败时完整回滚。
- 重复邮箱返回 409，不创建企业。
- 注册限流按邮箱和 IP 生效。
- 平台 `viewer` 可读用户和详情，但不能写。
- 普通企业所有者不能访问平台用户接口。
- 平台管理员停用用户后，旧 Session 立即失效。
- 强制退出撤销全部有效会话。
- 重置密码撤销会话且不记录临时密码。
- 不能停用自己或最后一位有效平台管理员。
- 列表和详情不返回密码哈希、Token 或招聘业务内容。
- 所有写操作要求原因并生成平台审计。

### 10.2 Web 测试

- 注册表单校验企业名称、手机号和密码。
- 注册成功后自动登录并进入唯一企业。
- 平台用户列表搜索、筛选、分页。
- 点击用户打开详情抽屉。
- 详情标签切换和错误状态。
- 停用、强制退出、重置密码确认流程。
- 非平台管理员不能看到导航或访问路由。

### 10.3 运行态验收

- 使用真实 PostgreSQL 迁移，不重置已有数据。
- 新注册账号出现在平台用户列表。
- 新注册企业显示为 14 天试用。
- 注册者登录后为 `owner`，可以邀请成员。
- 平台管理员看到详情，但无法打开该用户的简历和面试正文。
- 停用和重置密码后现有浏览器会话失效。

## 11. 发布步骤

1. 应用迁移 `0050_open_registration_user_management.sql`。
2. 构建 API 和 Web。
3. 使用隔离测试账号验证注册、登录、企业所有者权限和平台用户详情。
4. 确认平台 `viewer` 只读。
5. 检查平台审计和会话撤销。
6. 不执行开发种子或重置已有企业。

既有用户的 `registration_source` 回填为 `legacy`，不改变角色、企业归属或服务状态。

## 12. 不在本设计范围

- 企业自助注销。
- 套餐购买、支付和自动续费。
- 邮件验证码和企业域名验证。
- 用户手机号短信验证。
- 平台管理员查看候选人、简历、面试、Offer 等招聘正文。
- 企业内职位级 ACL 重构。
- 多租户数据库物理隔离。

## 13. 验收标准

- 新用户注册一次即可获得账号、企业和企业所有者身份。
- 注册失败不会留下账号或空企业。
- 新注册用户自动出现在平台用户管理列表。
- 平台管理员能查看账号、企业归属、登录安全和操作记录。
- 平台管理员不能看到招聘业务正文。
- 平台管理员不能直接修改企业内业务角色。
- 停用、重置密码、强制退出都立即撤销会话并留下审计。
- 既有用户、企业和招聘数据不受迁移影响。
