# 恢复方案执行记录

日期：2026-11-16。本记录是本次实际执行结果，不代表业务恢复或启动验收通过。

## 本次已落地

- `scripts/private-recovery-files.mjs` 统一恢复目录和证据文件权限。Windows 使用 icacls 设置权限、独立 .NET ACL 查询验证，要求仅当前用户具有完整控制，目录权限可传递给子项。拒绝继承的宽泛权限、额外主体授权和校验失败；不依赖 PowerShell.Security 模块自动加载。写入前校验目录，独占创建文件，写入后再次保护并验证文件。
- `scripts/recovery-snapshot.mjs` 固定本次 0101–0104 的文件名、顺序和 SQL SHA256。拒绝只执行旧范围、增加未审迁移或 SQL 字节变化。
- `scripts/runtime-recovery-rehearsal.mjs` 先验证恢复后全部表的行数和哈希，再在副本执行四项迁移。迁移后只对已核实新增的 manual_transcript_roles 字段做投影，逐表验证所有旧字段的内容和数量不变；另外验证角色选择均为真实空数组、两个维护控制表为空、完整公共/公司/控制区结构契约通过。不是仅排除迁移账本就跳过数据验证。
- `scripts/rehearse-approved-five-decisions.mjs` 的副本演练已升级到 0101–0104，并执行相同的迁移数据和结构验证。该命令仍无业务源库连接入口，不是正式业务写入工具。
- `scripts/runtime-recovery-audit.mjs` 输出受保护的审计文件，区分 tableGroups、rowDifferences、byKind、nonRowBlockers。已有输出目录必须通过权限验证，不会自动更改任意已有目录权限。父目录须已存在。
- 发布候选的脚本清单增加了审计所依赖的权限工具，并在构建前验证审计入口可导入。没有替换或修改任何已运行发布。
- 新增 scripts/company-conflict-repair.mjs 和 scripts/maintenance-five-decisions.mjs 正式 plan/check/apply：固定五行及其真实主键、不可变依赖、全库行哈希、维护锁、有效期审批和不可变回执。全部命令必须从同一已验证候选执行，计划与配置/备份在候选外的受保护目录。
- 修复公司时间比公共表更新时的验收误判：仅把与计划精确匹配的主键、两侧哈希和 updated_at 单字段差异登记为已保留。后续 23 项 reconcile/seal 通过不可变回执验证同一差异，不放宽其他冲突。详见五项维护手册。
- 候选构建在创建目录前检查目标卷可用空间，低于 2 GiB 拒绝；支持显式跨卷 pnpm 离线缓存。这个门槛不是业务磁盘监控，也不是运行容量保证。

## 实际验证

本轮两组 Node 回归共 150 项全部通过，无跳过，分别为 123 项维护/运行回归和 27 项隔离/启动安全/静态代理回归：

```powershell
& 'D:\NODE\node.exe' --test scripts/tests/maintenance-recovery.test.mjs scripts/tests/runtime-management.test.mjs scripts/tests/company-data-maintenance.test.mjs scripts/tests/database-release.test.mjs scripts/tests/company-conflict-repair.test.mjs
& 'D:\NODE\node.exe' --test scripts/tests/isolated-environment.test.mjs scripts/tests/production-safety.test.mjs scripts/serve-web-production.test.mjs
```

新增覆盖包括权限模块不可用、显式额外主体授权、拒绝覆盖证据、SQL 范围/字节变化、缺失或多余表、旧字段变化、新字段默认值错误及未登记 Schema 的意外变更。

当前数据库的只读快照及四迁移演练：

- 证据：`tmp/business-recovery-20261116-four-migrations-1/rehearsal-report.json`。
- 925 张表恢复后行数、内容哈希完全一致。
- 0101–0104 全部在专用副本执行成功；16 张面试会话表的新人工角色字段为空，所有旧字段数据保持不变，维护表为空，完整结构契约通过。
- 专用连接已关闭，专用 PostgreSQL 已停止。备份、配置副本和报告位于受保护目录。
- `writersDrained=false`、`frozenObjectBackupVerified=false`、`businessRecoveryVerified=false`。它不是排空写入者后的数据库与文件原子备份，也未验证全部数据库角色和系统级权限的恢复。

五项业务取舍及完整迁移副本演练：

- 证据：`tmp/business-recovery-20261116-2/five-decisions-clone-c659e184-96a8-4da8-b561-9c1d2cb35ab6.json`。
- 校验原备份、925 张表和审核行哈希后，只修正公司侧五条已确认记录，精确补齐六条不可变依赖；未选中行保持不变。
- 保留纠正结果和总结、最新时间、Offer 正文 v1–v6/current v6，以及导入批次解绑；未将并发令牌当作正文版本。
- 历史已完成面试仍为完成，真实 69 条待确认不被伪造确认或强制重开。新结束流程的 30 条门槛不追溯覆盖历史。
- 剩余 23 项单边差异，冲突为零；没有在该副本重放事件或发送邮件。
- 0101–0104 及完整迁移验证通过；专用 PostgreSQL 已停止。该副本没有被提升为业务实例。

正式五项核心的真实备份故障演练：

- 证据：tmp/business-recovery-20261116-four-migrations-1/formal-five-decisions-clone-3fec50e0-03bc-45bc-a933-50d96607b8a9.json，10 组检查通过。
- 核对原备份和全部 925 张表，先执行 0101–0104，再验证完整旧字段不变。只在专用副本将公司模板时间加 1 微秒，验证保留较新公司时间且不丢精度。
- 实测快照漂移拒绝、第三条更新失败全事务回滚、维护锁和未排空写入者拒绝、回执插入后审批到期时连同回执一起回滚、成功提交及重复执行拒绝、回执不可修改。
- 五条修复和六条依赖通过；历史完成面试保留 69 条真实待确认，不补造角色。连接已关闭，专用 PostgreSQL 已停止。模拟审批仅用于副本，未审批业务维护。
- 增加后续衔接后，11 组检查全部通过：tmp/business-recovery-20261116-four-migrations-1/formal-five-decisions-clone-ea8a6b16-8212-41f4-b390-f8ecff816e66.json。继续保留已批准的较新公司时间、14 条公司记录并复制 9 条原事件，不重放业务动作；没有登记 seal，历史角色状态仍正确，专用簇已停止。
- 最终候选内部 CLI 全链路与 11 组真实备份副本检查全部通过：tmp/business-recovery-20261116-four-migrations-1/formal-five-decisions-clone-d281738c-1f74-478f-8a86-36d86bc2e906.json。候选内执行 plan/check/apply，精确文件哈希错误被拒绝，重复 apply 返回 REPAIR_ALREADY_RECORDED；再执行 23 项衔接验证。报告 candidateCli 全部通过，syntheticApprovalOnly=true、businessDatabaseWritten=false、businessRecoveryVerified=false；所有专用连接已关闭、专用 PostgreSQL 已停止。

独立发布候选：

- C:/Temp/smartrecruit-recovery-20261116-b10cc6/release-candidate-4，API、Worker、静态 Web 及依赖包生产构建通过，19942 个文件/链接。
- 清单 SHA256：d8f9f8e765b1ea9e502e6c0bb1d162e37c93b86f56ceb6720fc2f469d5e3b467。
- 构建后另行全量 verifyRelease 通过；四个核心脚本与当前工作区逐文件 SHA256 相同。没有在已生成候选中修补代码或重写清单。
- 未激活；候选位于临时目录，不把它当作最终长期部署目录。较早候选保留，不能与最终证据混用。

## 磁盘阻断

- D 盘当前可用空间约 43 MiB。首次在 D 盘生成候选时发生 ERR_PNPM_ENOSPC；该失败目录保留，未替换任何活动版本。
- 对本次新生成失败候选 node_modules 的清理被环境策略拒绝，没有换工具绕过删除。需由维护负责人处理空间，不能删除业务库、对象原件、恢复备份或密钥。
- 后续隔离簇和构建放在已保护的 C:/Temp/smartrecruit-recovery-20261116-b10cc6，使用既有 D:/.pnpm-store/v3 离线缓存，不新增网络下载。
- 新候选的 2 GiB 构建检查只保护目标卷；本轮没有增加业务卷持续监控，也没有验证长期日志/数据库增长容量。

## 当前业务状态

最新只读审计：`tmp/business-recovery-20261116-execution-audit-1/current-audit.json`。

- 原库仍待 0101–0104，15 个公司中涉及 11 个表分组，共 34 项行差异：5 项冲突、14 项仅公司侧、15 项仅旧公共表。不是只剩 23 项；23 是五项取舍在副本修正后的数量。
- 207 个简历引用中 203 个在已检查根目录找到；5340 个录音引用均找到。存在性检查不等于当前完整文件备份已完成。
- 尚未找到的四个简历原文件：`9f30bd8f-9119-4233-9a6b-3883cc4e54d9.txt`、`97ee7b61-ef57-4295-8325-864ad70cbd35.txt`、`5380f05e-2390-4412-879b-d5916f263986.txt`、`94c0cff5-1ef3-424b-a71c-b5ef849ac410.txt`。没有据此认定永久丢失，没有制造替代原件或批准缺失例外。
- 两项认证密钥已在此前获准首次生成并备份，本轮未重新生成。备份位置为 `backups/auth-keys-2026-11-16T08-34-46-065Z`；密钥明文不进入本记录。
- 本轮没有修改业务配置、写业务库、迁移业务库、执行 reconcile/seal 或启动 API/Worker/Web。检查时 3100、4001、5174 未监听，没有停止其他项目的 5173 进程。

## 后续执行门槛

1. 先补齐四个原文件的真实备份来源；如确需例外，逐对象明确批准降级范围并实现相应拒绝/降级行为，不使用全局忽略开关。当前“开始执行”不视为此类授权。
2. 核对并排空全部写入者，保留在途任务；建立当前数据库、全部对象与配置/密钥的一致备份，验证恢复。此次只读快照不能替代该步骤。
3. 正式五项入口、最终候选内部 CLI 全链路及后续 23 项衔接演练已完成并保留报告。业务执行仍须依据冻结后的当前备份和真实维护窗口重新生成审核计划；不能把副本模拟审批用于业务，也不得以临时 SQL 替代正式维护。
4. 从最终独立候选统一配置、备份哈希和证据，在有效维护窗口重建并审核 0101–0104、五项取舍和 23 项单边差异的具体维护计划。当前没有替用户填写审批人或伪造证据。
5. 正式维护、受控业务冒烟、独立 seal 后，才进行 API3100、Worker4001、静态 Web5174 的完整托管启动验收。之后完成故障恢复演练及 24/72 小时持续观察，不能以短时副本成功替代稳定运行证明。
