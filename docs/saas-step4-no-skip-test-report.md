# API / Worker 无跳过完整复测

日期：2026-10-12。应用户要求，重新执行此前普通全量测试中被跳过的 PostgreSQL 集成场景，最终全量结果如下。

| 范围 | 总项数 | 通过 | 失败 | 跳过 | 取消 |
| --- | ---: | ---: | ---: | ---: | ---: |
| API | 346 | 346 | 0 | 0 | 0 |
| Worker | 65 | 65 | 0 | 0 | 0 |

API 原总数 342 的统计未展开被跳过的平台数据库主测试；启用该测试后增加 4 个子测试，故本次总计 346。未通过删除用例或注释断言达成 0 跳过。

## 隔离环境

- 使用本机现有 PostgreSQL 17.11 二进制新建独立数据目录和实例，仅监听 127.0.0.1:15433，数据库 smartrecruit_test。
- 从迁移脚本建立全新测试数据库（应用 33 个迁移文件），没有复制客户简历、模型密钥或现有业务数据。
- 独立生成测试凭据；仅在测试库创建开发测试账号、角色、部门及平台管理员授权。
- API 和 Worker 分别执行全部编译后测试文件；设置测试数据库连接并关闭 POSTGRES_INTEGRATION_SKIP。包装脚本在结果有跳过、失败或退出非零时返回非零，不篡改测试 skip 条件。
- 测试运行前重新构建 API 和 Worker；测试文件按单文件并发执行以避免共享测试库中的数据互扰。
- 完成后已正常停止该独立 PostgreSQL 实例。Gitignored 的测试库、凭据及日志留在 .codex-logs/postgres-no-skip-20261012；不要发布该目录。

## 首轮失败及修正

首轮 API：340 通过、6 失败、0 跳过；Worker：65 通过、0 失败、0 跳过。定位后仅修正过时测试与测试环境，不降低产品权限：

1. 平台后台测试仍要求 hr_admin 读取全局后台；按第四步规则改为显式平台管理员 200，未授权 HR 管理员 403，校验拒绝错误码。
2. Skill 集成测试仍创建未归属企业的历史规则；改用企业作用域 AdminService，并建立测试企业 owner 成员关系，保留绑定冲突、回滚和历史规则断言。
3. 冲突文案已更新为“岗位已绑定其他评分 Skill”，同步精确错误断言。
4. 数据库连接测试使用 DATABASE_URL 时错误地假定库名 smartrecruit；改为校验 URL 中的真实测试库名。
5. 独立测试账号最初缺部门绑定，导致两项经理部门权限场景拒绝；补齐测试库账号的部门关系，跨部门拒绝断言仍保留。
6. 包装脚本设置的全局文件根覆盖了单元测试独立临时目录，导致文件检查失败；移除该覆盖，各用例继续使用自身隔离路径。

最终再次执行全量：API 346 / Worker 65 全部通过，无跳过。

修改的测试源文件：
- apps/api/tests/admin.integration.test.ts
- apps/api/tests/ai-scoring-skills.postgres.integration.test.ts
- apps/api/tests/postgres.integration.test.ts

本轮未修改业务实现，未 seed/reset 项目正在使用的数据库，未重启现有业务服务，未提交或推送代码，未进入下一步 SaaS 功能。

## 日志与运行态

- API：.codex-logs/no-skip-api-test.log
- Worker：.codex-logs/no-skip-worker-test.log
- 构建：.codex-logs/no-skip-api-build.log、.codex-logs/no-skip-worker-build.log
- 结果摘要：.codex-logs/postgres-no-skip-20261012/api-result.json、worker-result.json
- git diff --check 通过。
- 原服务端口 3100 / 4001 / 5174 保持运行；匿名 API /api/v1/me 返回 401，Worker /ready 返回 200。

API 日志存在 pg 关于同一 client 上并行 query 的弃用警告（独立岗位事务测试），不是失败或跳过；本轮未扩大修复范围。0 跳过仅表示本次 API/Worker 测试集合全部执行，不代表真实第三方模型、钉钉、支付等生产集成均经过验证，不替代人工验收和商业上线安全审计。
