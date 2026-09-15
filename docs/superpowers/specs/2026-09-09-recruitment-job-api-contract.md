# 招聘需求、审批、岗位与 JD API 契约

> 文档版本：v1.0
> 日期：2026-09-09
> 范围：Phase 1 领域契约与状态机设计
> 实施状态：已完成纯领域规则；HTTP 路由、数据库 Repository 和认证仍未开放

## 1. 目标

本契约把总体设计中的第一个真实业务闭环拆成四个资源：招聘需求、审批实例、岗位和岗位文档。当前只冻结输入、输出、动作和状态边界，不提供可写 HTTP 接口。正式写接口必须在认证、RBAC、DataScope、CSRF、Origin 校验和审计基线完成后开放。

## 2. 资源边界

| 资源 | 权威表 | 说明 |
| --- | --- | --- |
| RecruitmentRequest | `recruitment_requests` | 编制申请、预算、理由和招聘目标；是岗位创建的业务来源 |
| Approval | `approval_instances`、`approval_steps`、`approval_records` | 审批过程和不可变审批记录；重新提交创建新的实例并保留旧历史 |
| Job | `jobs` | 可招聘岗位；一个已批准需求可以创建一个或多个岗位 |
| JobSpecVersion | `job_spec_versions` | 结构化岗位说明书版本，供匹配和审计使用 |
| JobDescriptionVersion | `job_description_versions` | 面向候选人的 JD 版本；确认后才允许发布 |

客户端不能直接提交 `status` 覆盖状态。所有状态变化使用动作型接口，由服务端在事务内锁定资源、重新读取状态、校验版本和写入 `workflow_events`/`audit_logs`。

## 3. 查询与写入接口

所有路径使用 `/api/v1` 前缀。列表接口返回 `ApiResponse` 的分页结构；写操作要求 `Idempotency-Key`，编辑要求 `If-Match: <revision>`。

| 方法 | 路径 | 类型 | 规则 |
| --- | --- | --- | --- |
| GET | `/recruitment-requests` | 查询 | 支持 `status`、`departmentId`、`page`、`pageSize`；按更新时间倒序 |
| POST | `/recruitment-requests` | 创建 | 仅创建 `draft`；服务端生成编号、版本和审计字段 |
| GET | `/recruitment-requests/:id` | 查询 | 返回需求、当前审批摘要和可执行动作 |
| PATCH | `/recruitment-requests/:id` | 编辑 | 仅 `draft` 或 `rejected`；不接受 `status`、审批字段和审计字段 |
| POST | `/recruitment-requests/:id/submit` | 动作 | `draft`/`rejected` -> `pending_approval`；创建或重建审批实例 |
| POST | `/recruitment-requests/:id/approve` | 动作 | 当前审批步骤完成且全部步骤通过后，`pending_approval` -> `approved` |
| POST | `/recruitment-requests/:id/reject` | 动作 | `pending_approval` -> `rejected`；必须填写原因 |
| POST | `/recruitment-requests/:id/withdraw` | 动作 | `draft`/`pending_approval`/`approved` -> `withdrawn`；必须填写原因 |
| POST | `/recruitment-requests/:id/close` | 动作 | `approved`/`converted`/`withdrawn` -> `closed`；必须填写原因 |
| GET | `/recruitment-requests/:id/approval` | 查询 | 返回当前审批实例、步骤和历史记录 |
| POST | `/recruitment-requests/:id/convert` | 动作 | 存在关联岗位后，`approved` -> `converted` |
| GET | `/jobs` | 查询 | 支持 `status`、`departmentId`、`recruitmentRequestId`、分页 |
| POST | `/jobs` | 创建 | 只能从 `approved`/`converted` 需求创建，初始状态 `draft` |
| GET | `/jobs/:id` | 查询 | 返回岗位、当前说明书、JD、发布摘要和可执行动作 |
| PATCH | `/jobs/:id` | 编辑 | 未发布岗位可编辑基础字段；已发布岗位编辑必须产生新版本 |
| POST | `/jobs/:id/spec` | 版本 | 创建新的岗位说明书草稿版本 |
| POST | `/jobs/:id/spec/confirm` | 动作 | 确认当前岗位说明书版本 |
| POST | `/jobs/:id/jd` | 版本 | 创建新的 JD 草稿版本；可标记 `human` 或 `ai_assisted` |
| POST | `/jobs/:id/jd/confirm` | 动作 | 确认当前 JD 版本 |
| POST | `/jobs/:id/publish` | 动作 | `ready` -> `published`；说明书、JD、需求审批和发布配置必须满足 |
| POST | `/jobs/:id/pause` | 动作 | `published` -> `paused`；必须填写原因 |
| POST | `/jobs/:id/resume` | 动作 | `paused` -> `published` |
| POST | `/jobs/:id/close` | 动作 | `ready`/`published`/`paused` -> `closed`；必须填写原因 |

动作请求统一使用以下最小结构：

```json
{
  "reason": "预算周期调整",
  "comment": "审批备注"
}
```

不同动作只允许使用需要的字段；`reason`/`comment` 不得替代权限检查。成功响应返回变更后的 DTO、`requestId` 和领域事件摘要；重复的 `Idempotency-Key` 返回首次成功结果，不重复写事件。

## 4. 招聘需求状态机

| 当前状态 | 动作 | 下一状态 | 硬性条件 |
| --- | --- | --- | --- |
| `draft` | `submit` | `pending_approval` | 必填字段通过校验；审批策略可生成 |
| `rejected` | `resubmit` | `pending_approval` | 新建审批实例，保留旧实例 |
| `pending_approval` | `approve` | `approved` | 当前步骤正确；全部步骤已通过 |
| `pending_approval` | `reject` | `rejected` | 原因必填 |
| `draft`/`pending_approval`/`approved` | `withdraw` | `withdrawn` | 原因必填；撤回权限通过 |
| `approved` | `convert` | `converted` | 至少一个岗位已创建 |
| `approved`/`converted`/`withdrawn` | `close` | `closed` | 原因必填 |
| `draft`/`pending_approval`/`rejected` | `cancel` | `cancelled` | 原因必填 |

终态 `closed`、`cancelled` 不允许再次提交、审批、撤回或编辑。审批人不能审批自己创建的需求，除非管理员策略显式允许并记录原因；这一条属于服务层权限和审批策略检查，纯状态机只负责状态合法性。

## 5. 岗位与文档状态机

岗位状态：`draft`、`ready`、`published`、`paused`、`closed`。

- `confirm_spec` 和 `confirm_jd` 是文档动作，不覆盖历史版本。
- 两个当前版本都确认后，岗位进入 `ready`。
- 发布必须同时满足：岗位来自已批准需求、当前岗位说明书已确认、当前 JD 已确认。
- 已发布岗位编辑必须生成新版本；新版本重新确认后才能再次发布。
- `published` 可以暂停和恢复；`ready`、`published`、`paused` 可以关闭；关闭后不能恢复。

## 6. 统一错误

领域错误映射为统一 API 错误：

| 领域错误 | API 状态 | API 错误码 |
| --- | ---: | --- |
| 参数或字段缺失 | 400 | `VALIDATION_ERROR` |
| 当前状态不允许动作 | 409 | `RECRUITMENT_REQUEST_INVALID_TRANSITION` 或 `JOB_INVALID_TRANSITION` |
| 原因缺失 | 400 | `VALIDATION_ERROR` |
| 需求未通过审批 | 409 | `RECRUITMENT_REQUEST_NOT_APPROVED` |
| JD/说明书未确认 | 409 | `JOB_DOCUMENT_NOT_CONFIRMED` |
| `If-Match` 版本过期 | 409 | `VERSION_CONFLICT` |
| 幂等键复用但请求体不同 | 409 | `IDEMPOTENCY_KEY_REUSED` |
| 无权或超出部门范围 | 403 | `FORBIDDEN` |

错误响应不返回数据库异常、内部审批策略详情、密钥或简历内容。

## 7. 已实现的纯领域验证

实现位置：`packages/contracts/src/workflow.ts`。

当前已测试：

- 需求提交、驳回、重新提交、审批、转换和关闭；
- 驳回/撤回/关闭/取消原因必填；
- 非法需求状态动作拒绝；
- 岗位说明书和 JD 双确认后才可进入 `ready`；
- 岗位发布前必须通过需求审批、说明书确认和 JD 确认；
- 岗位发布、暂停、恢复和关闭；
- 未审批需求不能创建岗位。

共享命令输入契约和基础字段校验也已实现于 `packages/contracts/src/workflow.ts`：创建需求、编辑需求、创建岗位、编辑岗位、创建岗位说明书、创建 JD 和动作请求均不包含客户端可写的状态、审批结果、版本或审计字段。校验覆盖岗位名称、部门、人数、招聘理由、预算上下限和关联需求。

当前未实现：HTTP 路由、Session/RBAC、Repository、事务、乐观锁、审批策略、审计写入和 PostgreSQL 集成测试。
