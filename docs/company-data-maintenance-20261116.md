# 公司数据差异维护手册

日期：2026-11-16。本手册说明代码能力和执行前置条件，不表示实际业务维护已经获批或完成。

五处冲突现在有独立的正式维护入口，见 [五项业务决策维护手册](./five-decision-maintenance-20261116.md)。后续 reconcile/seal 会将上一阶段不可变回执中精确匹配的时间保留差异单列入计划；未登记或哈希漂移的冲突仍拒绝，不是全局忽略 updated_at。

## 范围与决策

- 本次已审核范围是 23 项单边差异：公司侧 3 条岗位、7 条岗位规格版本、4 条岗位描述版本，共 14 条原样保留；公共侧 9 条工作流事件在逐条检查通过后原样复制到公司表。
- 不删除公司独有数据，不用更新时间推定所有差异的胜负。存在同主键冲突、其他表差异或事件检查失败时停止，不自动扩大维护范围。
- 原来的五项业务决策仍然有效，但本工具不处理它们。实际业务库中的五处冲突及所需不可变依赖必须另按已审核的维护计划处理并验收；副本演练通过不等于业务库已处理。
- 事件导入检查公司归属、公司内业务主体是否存在、历史操作者是否仍存在、两侧是否有除 ID 外完全相同的事件、触发器和规则。操作者为空的原始系统事件可以保留；不会补造操作者。
- 只复制原行，不调用业务动作、不重放工作流、不补发邮件、不创建 outbox。保留原 UUID、微秒时间精度和 JSON。

## 两个独立阶段

1. reconcile：按已审核快照保留公司记录并复制原事件，事务内核对结果，写入不可变执行回执。不登记公司主数据切换。
2. seal：重新生成计划，经数据复核、业务冒烟与额外审批后，单独登记公司为主数据源及旧公共表基线。不再导入事件。

安装 0104 或 reconcile 成功，都不等于已经完成 seal。不得提前伪造业务冒烟证据。

切换前仍严格列出两侧差异。切换后检查旧公共表基线未变、公司数据归属和外键关系正确，不要求公司表永远与旧快照相等。正常新增、修改、删除公司业务数据及主体删除后的历史事件不再因此误报。

## 实际维护前置条件

1. 确认数据库目标、公司 ID、发布候选、配置、对象根目录和原加密密钥。冻结并排空 API、Worker 及其他写入者，核对在途任务；不能仅根据任务状态推定已排空。
2. 对数据库、对象文件和配置/密钥完成当前一致备份并验证恢复。旧备份或只有文件存在性检查不够。维护计划仅绑定备份文件哈希，恢复验证仍须真实证据。
3. 重新审核完整迁移范围。当前代码含 0101–0104；只批准 0101/0102 的旧窗口和旧发布不能覆盖新增迁移。迁移通过独立的迁移维护入口执行，普通启动和本工具均不自动迁移。
4. 使用新构建且校验通过的独立候选目录。实际维护计划必须从同一候选中的命令生成、复核和执行；不要从工作区生成计划后试图换候选执行。
5. 本工具会短暂锁住公司/公共业务表及相关元数据，影响其他公司写入，因此维护窗口必须覆盖该锁范围；5 秒拿不到锁即退出。审批证据须由实际维护负责人提供。

## 命令示例

以下目录和公司 ID 都是示例，必须替换为获批的真实值。计划与备份放在发布目录之外的受保护目录，避免改变发布清单。Windows 上应配置目录 ACL；文件 mode 不是 Windows ACL 的替代。

```powershell
$node = 'D:\NODE\node.exe'
$release = 'D:\approved-runtime\releases\reviewed-candidate'
$tool = Join-Path $release 'scripts\maintenance-company-data.mjs'
$profile = 'D:\approved-runtime\business.env'
$backup = 'D:\protected-maintenance\verified-backup.dump'
$org = '10000000-0000-4000-8000-000000000001'
$plan = 'D:\protected-maintenance\reconcile-plan.json'

& $node $tool plan --profile $profile --backup $backup --organization $org --intent reconcile --release $release --plan $plan
```

plan 是只读操作，使用独占创建，不覆盖已有计划。文件包含逐主键哈希及检查结果，不导出业务正文。新生成计划的 approval 必为 null，不会自动批准。未传 --release 可做只读探索，但该计划不能直接换成候选执行，须从最终候选重建。

复核 snapshot、context、逐条 action/importCheck 后，只填写 approval，不修改快照或重新计算它的摘要：

```json
{
  "reviewedBy": "实际审批人",
  "snapshotSha256": "计划中已有的 snapshotSha256",
  "approvedAt": "实际审批时刻的 ISO 8601 时间",
  "expiresAt": "维护窗口结束的 ISO 8601 时间",
  "evidenceReferences": {
    "writersDrained": "实际排空记录路径或编号",
    "backupRestored": "当前备份恢复验证报告路径或编号",
    "objectsReviewed": "对象与密钥核对报告路径或编号",
    "configReviewed": "API 与 Worker 统一配置审核记录",
    "rehearsalPassed": "本次候选与计划的演练报告路径或编号"
  }
}
```

将上述对象填入 plan.approval。审批窗口最长 4 小时，不接受未来审批、过期审批、缺失证据。证据字段必须指向真实审核记录，非自动校验材料真实性的电子签名系统。计划与备份的访问控制和审批人权限须由运维流程保障。

```powershell
# 审核完成后固定整个文件的 SHA256；复核与 apply 使用同一摘要。
$sha = (Get-FileHash -LiteralPath $plan -Algorithm SHA256).Hash.ToLowerInvariant()
& $node $tool check --profile $profile --backup $backup --organization $org --intent reconcile --release $release --plan $plan --sha256 $sha
& $node $tool apply --profile $profile --backup $backup --organization $org --intent reconcile --release $release --plan $plan --sha256 $sha
```

check 使用只读事务，不改数据。apply 必须指定候选和已审核文件摘要；配置、备份、工具、候选、数据库身份、迁移账本、结构或数据快照变化都会拒绝执行。错误后应重新检查，不能靠修改摘要、替换备份路径或删除回执强行通过。

reconcile 后先核对结果并在受控环境完成业务冒烟。seal 必须使用新的计划文件、--intent seal，重新执行 plan/check/apply，并在 approval.evidenceReferences 额外填写 businessSmokePassed 和 dataReconciled 的真实证据。不得把 reconcile 计划的 intent 直接改成 seal。

执行已有成功计划仅在审批仍有效、结果和快照完全一致时返回 alreadyApplied；有正常后续业务写入时旧计划也会拒绝重试。不要把它用作日常重复命令。

## 故障与边界

| 信号 | 处理 |
| --- | --- |
| DATA_APPROVAL_REQUIRED / DATA_APPROVAL_WINDOW_INVALID / DATA_EVIDENCE_REQUIRED | 补齐真实审批与证据，或在新窗口重建计划；不自动延长审批 |
| DATA_PLAN_CHANGED / DATA_PLAN_FILE_CHANGED / DATA_PLAN_CONTEXT_CHANGED | 停止，复核文件、配置、备份与候选；不现场修补已审核摘要 |
| DATA_PLAN_REVIEW_REQUIRED | 存在范围外差异、冲突或不安全事件；逐项业务复核 |
| DATA_MAINTENANCE_BUSY / lock timeout | 检查其他维护或未排空写入者；不杀外部进程、不无限重试 |
| DATA_SNAPSHOT_CHANGED / DATA_POSTCHECK_FAILED | 本次事务回滚；保留失败证据，重新计划审核 |
| LEGACY_SNAPSHOT_READ_ONLY | 已切换公司仍有旧公共路径写入；修正写入者，不关保护触发器 |
| LEGACY_SNAPSHOT_CHANGED | 旧公共快照被特权操作改动；调查并独立批准后续处理，不自动重置基线 |
| COMPANY_INTEGRITY_FAILED | 公司归属、间接归属或外键异常；查看 issues，先修正具体问题 |
| DATA_CONTROL_ACCESS_UNSAFE / 结构契约不匹配 | 私有控制区权限或结构漂移；停止发布并复核，不自动修库 |

执行使用迁移/维护事务锁、写入阻塞表锁和原子事务。单 SQL 最长 60 秒、等锁 5 秒、事务空闲 30 秒，总执行预算约 10 分钟；超过预算退出，不承诺大库在该预算内可完成。提交前再次校验审批，异常销毁无法回滚的连接。网络在提交响应时中断可能导致提交结果未知，应先查回执和结果，不声称必然回滚。

recovery_control 默认不给 PUBLIC 权限；非所有者额外授权会被发布门禁拒绝。回执及切换记录通过触发器拒绝更新、删除和 TRUNCATE。数据库所有者/超级用户仍可绕过，不能据此宣称能防恶意特权账户。

已切换公司在公共业务表的插入、更新、删除被拒绝；间接归属同时检查新旧父对象。公共表 TRUNCATE 无法按公司划分，存在任意切换时整体拒绝。部门元数据的同公司更新和其他未切换公司的普通写入仍可用，部门迁移归属/删除受保护。

external_entity_mappings、external_event_receipts 是无可靠公司归属的全局旧集成表，未将它们全局冻结，也不声称已解决其公司迁移归属。未来涉及它们须先设计可验证的归属模型。后续 SQL 如果改变冻结旧行的内容哈希，也必须单独审核，不能静默接受新基线。

普通 runtime:start、runtime:status 和 doctor 不修改配置、回执或业务数据。doctor --audit 在 seal 后显示 company-authoritative；报告中的 decisions 为空不代表无阻断，还须看 dataAuditReady 和 auditBlockers。

## 验证与实际状态

单元回归：npm run test:company-maintenance，以及维护审批、运行管理和数据库发布测试。真实 PostgreSQL：npm run test:company-maintenance:isolated -- D:\software\pgsql\bin，只使用随机专用簇和合成数据，结束后停止专用簇。

2026-11-16 最终验证记录：

- 公司维护、迁移审批、运行管理、数据库就绪和发布相关回归共 78 项，全部通过，无跳过。
- 公司维护隔离验证共 14 组场景，完整执行 104 项迁移；覆盖原始事件复制、公司记录保留、并发锁、审批过期回滚、独立 seal、普通启动预检、切换后正常公司增删改、旧公共路径拦截及权限/基线篡改检测。报告：`tmp/closure_verify_a067939f4ef24928b5fbb00c7c52b389/company-maintenance-report.json`。
- 真实历史公司升级及结构契约验证共 21 项，全部通过。报告：`tmp/closure_verify_87515841a16a4588a5188a3a80fa22ab/schema-contract-report.json`。
- 两份隔离数据库报告均确认专用数据库已删除、专用 PostgreSQL 已停止。0104 迁移文件与已生成契约中的 SHA256 一致。

本轮没有对实际业务库执行迁移、恢复或 seal，没有启动业务 API。隔离演练成功不等于当前业务完成恢复，也不构成 24/72 小时稳定运行证明。
