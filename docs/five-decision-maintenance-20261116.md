# 五项业务决策维护手册

日期：2026-11-16。正式工具已实现；隔离副本中的模拟审批不构成业务维护审批。本手册不表示业务库已经恢复。

## 执行边界

- 只处理已确认的五条公司记录和缺失的六条不可变依赖。保留纠正后的面试内容、总结、最新更新时间、Offer 正文 v1 至最新版本及导入批次解绑。
- Offer 的并发控制字段不等于正文版本号。历史已完成面试保留真实待确认状态，不补造人工角色选择；新结束流程最多允许 30 条未明确说话人。
- 对 updated_at 使用数据库 GREATEST，保留微秒精度。若公司时间较新，回执单列精确主键、两侧哈希及字段名；不是按时间自动选择其他字段。
- 后续 23 项维护只承认不可变五项回执中完全匹配的时间差异，任何其他字段、主键或哈希变化仍拒绝。后续计划继续绑定全量业务基线。
- 五项工具不重放事件、不发邮件、不执行迁移、不登记 seal、不启动服务。

## 必备条件

1. 先解决业务卷空间不足，检查数据库、对象、备份和日志所在卷。候选构建前最低 2 GiB 检查仅是构建门槛，不是业务容量评估或持续磁盘监控；本次 D 盘约 44 MiB 不适合继续维护。
2. 核对并排空全部写入者及在途任务，建立数据库、对象、配置和原密钥的一致备份并实际验证恢复。四个尚未找到的简历原件须补齐，或逐对象另行审核降级方案，不可全局忽略。
3. 核准 0101–0104 全部迁移并从独立维护入口执行。不能沿用仅覆盖旧迁移范围的批准。
4. 使用最终独立候选；plan、check、apply 均必须从该候选内部执行，并传入该候选的绝对路径。配置、备份和计划必须在候选之外的当前用户专用 ACL 目录，不在发布目录现场编辑。
5. 五项计划绑定整个数据库的持久表哈希，执行时使用数据库级全部持久表的写阻塞锁；维护窗口必须覆盖其他公司的写入暂停。等锁最多 5 秒，不杀外部写入者。

## 计划与审批

以下是示例路径，不能直接作为业务配置或审批使用：

~~~powershell
$node = 'D:\NODE\node.exe'
$release = 'C:\approved-runtime\releases\reviewed-candidate'
$tool = Join-Path $release 'scripts\maintenance-five-decisions.mjs'
$profile = 'C:\protected-maintenance\business.env'
$backup = 'C:\protected-maintenance\database.dump'
$org = 'abb8445c-d068-47ee-b2f0-45010a886629'
$plan = 'C:\protected-maintenance\five-decisions-plan.json'
& $node $tool plan --release $release --profile $profile --backup $backup --organization $org --plan $plan
~~~

plan 只读且独占创建，approval 必为 null。复核数据库身份、迁移账本、五条记录、六条依赖、正文版本、剩余差异和备份/配置/工具/候选哈希。不可修改 snapshot/context 或重算摘要来掩盖漂移。

由实际审核人填写 approval：reviewedBy、已有 snapshotSha256、实际 approvedAt 和 expiresAt，以及 evidenceReferences 中 writersDrained、backupRestored、objectsReviewed、configReviewed、rehearsalPassed 的真实报告路径或编号。窗口最长四小时，过期不自动延长，不能使用演练中的 synthetic 审批替代。

填写审批会改变文件字节，须重新取得文件 SHA256 并复核：

~~~powershell
$sha = (Get-FileHash -LiteralPath $plan -Algorithm SHA256).Hash.ToLowerInvariant()
& $node $tool check --release $release --profile $profile --backup $backup --organization $org --plan $plan --sha256 $sha
& $node $tool apply --release $release --profile $profile --backup $backup --organization $org --plan $plan --sha256 $sha
~~~

check 只读。apply 在事务内补依赖、更新五行、核对全部表及剩余差异、恢复已审时间触发器并写不可变回执。业务保护触发器不会关闭。单 SQL 60 秒、等锁 5 秒、事务空闲 30 秒、总查询预算约十分钟；异常回滚，无法回滚的连接销毁。

## 故障处理

- REPAIR_PLAN_FILE_CHANGED / REPAIR_PLAN_CONTEXT_CHANGED / REPAIR_SNAPSHOT_CHANGED：停止并复查，不覆盖旧证据或现场修补摘要。
- REPAIR_APPROVAL_REQUIRED / REPAIR_APPROVAL_WINDOW_INVALID：补充真实审批或新窗口重新计划，不自动批准。
- REPAIR_MAINTENANCE_BUSY / lock timeout：核对并发维护和未排空写入者，不无限重试。
- REPAIR_REMAINING_REVIEW_REQUIRED / REPAIR_UNEXPECTED_ROW_CHANGE：事务拒绝，逐项检查范围外变化。
- REPAIR_ALREADY_RECORDED：已经有该计划的不可变回执，先核对回执和当前结果，不自动重放。提交响应断连时也必须先核查，不能假定必然回滚或删除回执重试。

成功后重新生成 23 项 reconcile 计划，保留 14 条公司记录、复制 9 条原工作流事件，再做受控业务冒烟并独立审批 seal。最后才进行统一配置、三角色托管及 3100/4001/5174 验收；24/72 小时观察不能用短时隔离演练代替。

维护回执防止普通写入修改，不能防止数据库所有者或超级用户主动绕过；审批证据真实性仍需操作负责人核实。
