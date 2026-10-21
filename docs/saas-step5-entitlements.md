# SaaS 第 5 步：版本化套餐及企业权益

交付日期：2026-10-12。状态：已实施及自动验收，等待用户测试确认；不自动开始第 6 步。

## 本步范围

企业成员在「企业工作空间 → 套餐权益」查看本企业套餐、席位、岗位容量；独立平台运营人员在「企业客户管理 → 套餐权益」查看客户权益，平台管理员可以发布版本及分配客户。

不实现价格、订单、支付、自动续费或 AI 计费额度。需求申请审批仍停用；录用审批与 Offer 保留。

## 初始套餐与计量语义

| 编码 / 版本 | 名称 | 成员席位 | 岗位容量 |
|---|---|---:|---:|
| legacy / 1 | 历史兼容权益 | 不限 | 不限 |
| trial / 1 | 试用版 | 5 | 20 |
| team / 1 | 团队版 | 20 | 200 |
| growth / 1 | 成长版 | 100 | 2000 |

这些是初始容量配置，不是价格承诺。只有 legacy 可以不限；其他套餐容量为 1～1000000 的整数。

- 所有企业成员（含所有者）都占席位，未接受邀请不占；实际加入时强制校验。
- 所有状态岗位均占容量，含草稿、发布、暂停、关闭；编辑不重复占用，删除释放。不是每月新增数或 AI 调用额度。
- 发布套餐版本后不可修改或删除。容量调整需发布新版本，再显式分配客户；旧客户不会自动升级。
- 分配套餐不启用暂停企业、不延长试用、不恢复归档企业。目标容量低于实际用量时拒绝降级，不自动删除客户数据。
- 原企业保留 legacy；新企业默认 trial v1，并保留第四步默认 14 天试用的服务生命周期。

## 后端、数据库与授权

0035_subscription_entitlements.sql 增加不可变套餐版本表和企业的套餐外键、权益版本、席位/岗位用量。
迁移事务先设置 10 秒锁等待上限，再锁定企业、成员、岗位表回填与安装触发器，避免并发回填漏计。

成员和岗位插入/删除/企业归属转移由数据库 AFTER 触发器维护用量。用量与业务写入同事务提交或回滚，ON CONFLICT DO NOTHING 不重复计数；企业行 FOR NO KEY UPDATE 锁串行获取容量与套餐变更，跨企业转移按企业 ID 顺序锁定。

| 接口 | 授权 |
|---|---|
| GET /api/v1/platform/plans | platform admin/viewer |
| POST /api/v1/platform/plans | platform admin |
| GET /api/v1/platform/customers/:id/entitlements | platform admin/viewer |
| PATCH /api/v1/platform/customers/:id/entitlements | platform admin |
| GET /api/v1/workspaces/:id/entitlements | 实际企业成员 |

平台授权实时读取数据库，不从企业 owner/admin 或业务角色推导；权限在幂等回放前检查。平台写操作始终要求可信 Origin 和 CSRF，即使旧开发接口关闭了 CSRF。成员读取无全局角色回退，也不把平台身份当企业成员。

发布、分配均需 2～500 字原因；分配携带 expectedVersion，并在事务中记录独立平台审计。版本冲突返回 409，超容量降级返回 PLAN_CAPACITY_BELOW_USAGE。

数据库 P5501 / P5502 最终映射为 409 / SEAT_LIMIT_EXCEEDED 或 JOB_LIMIT_EXCEEDED，并给出中文提示。
实际 HTTP 验收曾发现招聘路由把 PG 错误包装为 HttpError(500)，绕过原映射；已把容量归一放到通用 HttpError 分支之前，并新增两条包装错误回归与真实 HTTP 集成测试。

## 原业务库升级及服务

- 原业务目标 127.0.0.1:5432/smartrecruit，升级前 pg_dump 完整备份到 .codex-logs/step5-before-upgrade.dump（379414 字节；含敏感业务数据，Gitignored，禁止提交）。本次未做恢复演练。
- 0035 已应用。迁移前后核对四家原企业：服务状态、成员与岗位数不变，全部保留 legacy。
- 未 seed/reset、不改原密码、不自动删除客户数据、不试改真实企业套餐。
- 最终 API 已重新构建并启动于 3100；Worker 4001、Web 5174 保持运行。临时测试 PostgreSQL 15433 在验收结束后停止，原数据库不停止。

## 测试证据

| 测试 | 结果 |
|---|---|
| API 全量（含真实 PG 集成） | 357 通过 / 0 失败 / 0 跳过 |
| Worker 全量 | 65 通过 / 0 失败 / 0 跳过 |
| Web 全量 | 419 通过 / 0 失败 / 0 跳过，70 个文件 |
| 真实 development HTTP 专项 | 13 项检查通过，计入 API 中 1 个集成用例，不重复相加 |
| 原运行态检查 | 9 项通过 |
| API / Worker build、Web typecheck/build、git diff --check | 通过 |

全量 PG 测试在独立 127.0.0.1:15433/smartrecruit_test 上运行，无跳过。HTTP 专项明确使用 NODE_ENV=development 子进程，使岗位走真实 PG repository 而非 NODE_ENV=test 内存替身；测试目标硬校验为本机测试库，fixture 清理，已发布不可变测试套餐留在独立测试库。

覆盖企业越权、viewer 写拒绝、不可变/重复版本、过期版本、降级拒绝、发布不自动改变客户、并发席位/岗位、失败邀请可重用、删除释放、no-op upsert、审计、撤销授权，以及真实 HTTP 的 401/403/409、Origin/CSRF。

运行态实际输出：

```text
PASS running API /me: HTTP 401
PASS Worker /ready: HTTP 200
PASS Web /: HTTP 200
PASS running API plan catalog: HTTP 200; four initial plan versions
PASS running enterprise rights: HTTP 200; legacy, 6 seats / 10 jobs
PASS running API invalid reason rejected: HTTP 400; no entitlement mutation
PASS running API missing CSRF: HTTP 403; no entitlement mutation
PASS running API untrusted Origin: HTTP 403; no entitlement mutation
```

企业和平台页面已用既有管理员会话真实读取，浏览器采集的 error/warn 日志为空；发布表单展示正常。未在原业务库实际发布新版本或变更客户权益；有副作用的容量操作在独立测试库验证。

日志：.codex-logs/step5-api-test.log、step5-worker-test.log、step5-web-test.log、step5-running-verification.log、step5-migration.log；页面截图 reports/saas-step5/。

API 全量仍有既有 pg 并发 client.query 弃用告警，不是失败；本步没有宣称真实模型/钉钉/支付外部联调通过。

## 用户验收建议

1. 刷新企业工作空间，点「套餐权益」，确认本企业显示历史兼容权益及正确数量。
2. 平台管理员进入「企业客户管理 → 套餐权益」，确认套餐选择、变更原因、新版本发布入口；普通企业成员不可分配。
3. 仅用无真实业务数据的测试企业尝试分配有限套餐；操作原因必填。不要把已有 6 名成员的龙道测试企业降为 5 席位试用版，系统应拒绝。
4. 如需发布新版本，请使用独立测试编码并明确原因：发布后不可撤销修改，不会自动分配客户。
5. 检查企业招聘及保留的「录用审批与 Offer」入口正常。

## 边界及下一步

还未做 AI 预占/结算/释放、消费明细、异常对账、收费支付，也未限制简历存储或转写时长。这些需分别定义计量与产品规则。

第二步风险（历史角色回退、全局部门、钉钉/渠道租户配置、完整审批任务授权、文件/缓存/回调链路、历史业务归属）仍需上线前解决。本步不是完整商业上线安全认证。

用户确认本步后才启动第六步；本次未提交或推送 Git。
