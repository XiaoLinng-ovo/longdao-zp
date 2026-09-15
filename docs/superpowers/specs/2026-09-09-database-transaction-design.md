# 招聘需求与岗位数据库、事务设计

> 版本：v1.0
> 范围：第一阶段业务闭环

## 1. 数据事实

PostgreSQL 是正式业务事实来源。`recruitment_requests` 保存招聘编制申请，`approval_instances`/`approval_steps`/`approval_records` 保存审批历史，`jobs` 保存岗位，`job_spec_versions` 和 `job_description_versions` 保存不可覆盖的说明书与 JD 版本，`workflow_events` 保存状态变化，`audit_logs` 保存操作审计。

当前本机没有 PostgreSQL，因此 API 使用 `LocalRecruitingStore` 作为可替换适配器：内存状态复制、单进程串行事务、临时文件写入后 `rename` 原子替换。它只用于本地功能开发，不改变 PostgreSQL 作为正式事实来源的设计。

## 2. 需求创建事务

```text
BEGIN
  校验字段和预算范围
  生成 request_no
  INSERT recruitment_requests(status=draft, version=1)
  INSERT workflow_events(request_created)
COMMIT
```

提交审批事务锁定需求行并创建审批实例；重新提交创建新审批实例，旧审批记录只读保留。

## 3. 审批/状态命令事务

每个动作都遵循：

```text
BEGIN
  SELECT resource FOR UPDATE
  SELECT 当前版本和当前状态
  校验动作、前置条件、操作者范围和 If-Match 版本
  UPDATE resource SET status=?, version=version+1
  INSERT approval_records/workflow_events/audit_logs
  INSERT idempotency_records（写命令）
COMMIT
```

并发审批、撤回或发布时，第二个事务在行锁释放后重新检查状态，返回状态冲突，不产生第二条合法状态事件。重复 `Idempotency-Key` 返回第一次响应；同一键不同请求摘要返回冲突。

## 4. 岗位发布事务

岗位创建必须锁定来源需求，并要求需求为 `approved` 或 `converted`。说明书和 JD 以版本行追加保存，确认写入对应版本的 `confirmed_at`、`confirmed_by`。发布时锁定岗位、需求和当前文档版本，检查三者状态后更新 `jobs.status=published` 并写入工作流事件。

## 5. 迁移与本地实现对应关系

| 本地适配器 | PostgreSQL 正式实现 |
| --- | --- |
| `LocalRecruitingStore.transaction()` | PostgreSQL `BEGIN/COMMIT/ROLLBACK` |
| 状态深拷贝 | `SELECT ... FOR UPDATE` 后的事务快照 |
| 临时文件 + 原子替换 | 数据库 WAL/提交原子性 |
| `workflowEvents` 数组 | `workflow_events` 追加表 |
| `version` 自增 | 行版本/乐观锁字段 |

本地适配器不得被解释为生产数据库，也不承载多进程并发；切换 PostgreSQL 时保持 `RecruitingService` 的命令边界不变，仅替换 Repository/Transaction 实现。

## 6. Candidate 与 Application

候选人主档案和岗位申请分开保存。创建申请时在同一事务中锁定候选人与岗位，检查 `(candidate_id, job_id)` 唯一关系，新增 `applications(status=new)`；一个候选人可以拥有多个岗位申请，任一申请进入 `rejected` 不会修改候选人或其他申请。

当前本地 API 已提供：

- `GET/POST /api/v1/candidates`
- `GET/POST /api/v1/applications`
- `POST /api/v1/applications/:id/status`

申请状态只允许按领域动作推进，淘汰必须提供原因。简历上传、ClamAV 扫描、分析任务和人工复核仍接在申请数据链路之后。

## 8. PostgreSQL 本地运行模式

Windows 原生 PostgreSQL 17 可用后，API 默认使用 `PostgresRecruitingStore`。每次写命令都执行真实 `BEGIN`、事务级 advisory lock、`SELECT ... FOR UPDATE`、状态操作、JSONB 持久化和 `COMMIT`；异常执行 `ROLLBACK`。测试只有在 `NODE_ENV=test` 或显式设置 `RECRUITING_STORE_PATH` 时才使用本地 Store。

当前阶段增加 `recruiting_state` 作为业务服务迁移桥接表，用于在不重写现有应用服务的情况下把完整状态落到 PostgreSQL。规范化表仍由 `0001` 至 `0005` 迁移建立，后续逐步将桥接状态拆为各领域 Repository；桥接表不是文件缓存，API 默认不会写 `data/api-state.json`。

## 7. Resume 与 AnalysisTask

简历上传和分析任务使用两个明确的事务边界：

```text
BEGIN
  锁定 candidate；如有关联 application，同时校验 application.candidate_id
  计算 content_hash，生成 storage_key
  INSERT resumes(scan_status=quarantined)
  INSERT analysis_tasks(status=queued, idempotency_key=resume-analysis:<resume>:<hash>)
COMMIT
```

文件先写入本地 `data/resumes/quarantine`，正式 PostgreSQL 实现中应由对象存储写入隔离桶，并通过 Outbox 投递扫描/分析任务。当前本地实现明确使用 `local_unscanned` 降级状态，不伪造 ClamAV clean。

执行分析任务时锁定任务并校验状态，成功后在同一事务内追加 `analysis_results`，更新任务为 `completed`，并仅更新申请的 `score` 与 `ai_status`。分析结果带有 `advisoryOnly=true` 和 `applicationStatusMutation=none`，不会自动推进、淘汰或录用申请。
