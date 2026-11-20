# 开放注册与平台用户管理

## 注册结果

开放注册会在同一事务中创建：

- 个人登录账号
- 企业工作空间
- 企业所有者成员关系
- 初始招聘专员业务角色
- 14 天试用服务状态
- 企业创建和平台注册审计

注册者登录后成为该企业 `owner`，可以进入企业工作空间并邀请其他成员。

## 试用功能额度

14 天试用期内有两个独立额度：

- 简历上传：最多 3 份
- 真实面试：最多 3 场

简历额度在创建 `resumes` 记录时扣减。面试额度只在真实面试开始时扣减：创建实时面试会话，或者提交/锁定面试反馈。创建、修改和改期面试记录不消耗额度。前端隐藏按钮不能绕过。删除已创建的简历或面试不会恢复额度。企业转为正式启用后不再受试用额度限制。

达到上限时接口返回：

- `TRIAL_RESUME_LIMIT_REACHED`
- `TRIAL_INTERVIEW_LIMIT_REACHED`

工作空间页面会显示当前已用次数和剩余次数。

## 注册表单

- 企业名称，必填，2 至 120 个字符
- 管理员姓名，必填，2 至 80 个字符
- 工作邮箱，必填
- 手机号，可选，用于账号支持
- 密码与确认密码

企业名称允许重复。系统使用企业内部 UUID 区分企业，不依赖企业名称唯一性。

## 平台用户管理

平台管理员和只读运营人员可以访问：

`/platform/users`

旧入口 `/administration?module=users` 会重定向到新页面。

查看范围：

- 姓名、邮箱、脱敏手机号
- 账号状态、注册来源、注册和最后登录时间
- 所属企业、企业身份、业务角色和部门
- 活跃会话的 IP、User-Agent、最近活动时间
- 与该账号有关的平台和企业审计

不展示：

- 密码哈希、Session Token、CSRF Token
- 简历正文或附件
- 面试验音、转写、评价
- Offer、薪资或入职材料

## 平台操作权限

平台 `viewer` 只读。

平台 `admin` 可以：

- 停用或启用账号
- 强制退出全部会话
- 重置密码
- 修改姓名和手机号

所有写操作必须填写 2 至 500 字原因，并记录到 `platform_audit_logs`。

保护规则：

- 平台管理员不能停用自己
- 不能停用最后一位有效平台管理员
- 停用账号立即撤销有效会话
- 重置密码立即撤销有效会话，临时密码只显示一次

## 部署

先备份并核对当前数据库迁移台账，再应用：

```powershell
node scripts/migrate-postgres.mjs
```

迁移文件：

`db/migrations/0052_open_registration_user_management.sql`

`db/migrations/0053_resume_import_batches.sql`

`db/migrations/0054_trial_feature_quotas.sql`

本次组合合并保留本地已使用的 `0050_live_audio_transcription_queue.sql` 和 `0051_candidate_manual_name.sql`，将上游三个迁移顺延为 0052–0054。若数据库已应用上游原编号版本，请先人工核对迁移台账，不要直接运行迁移或重写既有记录。

迁移不会重置既有用户、企业、成员或招聘数据。既有账号的 `registration_source` 会回填为 `legacy`。

构建：

```powershell
npm --prefix apps/api run build
npm --prefix web run typecheck
npm --prefix web run build
```

## 验证

聚焦测试：

```powershell
npm --prefix web test -- src/modules/auth/api/index.test.ts src/modules/platform/users/pages/PlatformUsersPage.test.ts src/app/router.test.ts

node --test apps/api/dist/src/auth/workspaces.test.js apps/api/dist/src/auth/session-repository.test.js apps/api/dist/src/admin/account-creation.test.js apps/api/dist/src/platform/service.test.js apps/api/dist/src/platform/users/service.test.js apps/api/dist/tests/admin.integration.test.js
```

真实 PostgreSQL 验收必须另用测试数据库，不要直接对生产数据执行注册或迁移验证。
