# 2026-09-15 维护日志

## 继续批次：招聘需求 / 岗位详情流程审计时间线

- 将流程审计读取能力下沉到共享 API 边界：
  - 新增 `web/src/shared/api/workflow-events.ts`。
  - 定义 `WorkflowEvent`、`WorkflowEventSubjectType` 和 `loadWorkflowEvents`。
  - `web/src/modules/administration/api/index.ts` 复用共享能力，保留原有导出以兼容已有管理后台测试。
- 招聘需求详情页 `RequisitionDetailPage.vue` 新增「流程审计」区块：
  - 读取 `recruitment_request` 类型流程事件，并按当前需求 `subjectId` 过滤。
  - 展示时间、动作、状态流转、操作人、原因。
  - 更新需求状态、执行审批 / 关闭 / 转岗位等动作后刷新审计记录。
- 岗位详情页 `JobDetailPage.vue` 新增「流程审计」区块：
  - 读取 `job` 类型流程事件，并按当前岗位 `subjectId` 过滤。
  - 展示时间、动作、状态流转、操作人、原因。
  - 岗位刷新和详情读取时同步加载审计记录。
- 新增共享审计表格组件 `web/src/shared/components/workflow/WorkflowEventTable.vue`：
  - 统一渲染流程审计时间、对象、动作、状态流转、操作人、原因。
  - 候选、面试、Offer 等详情页复用同一展示口径。
- 候选人详情页 `CandidateDetailPage.vue` 新增「流程审计」区块：
  - 以候选人 `id` 加其全部申请 `applicationId` 作为过滤范围。
  - 展示该候选人在申请、面试、Offer 等全链路中的动作与状态流转。
- 面试详情页 `InterviewDetailPage.vue` 新增「流程审计」区块：
  - 读取 `interview` 类型流程事件并按当前面试 `subjectId` 过滤。
- Offer 详情页 `OfferDetailPage.vue` 新增「流程审计」区块：
  - 读取 `offer` 类型流程事件并按当前 Offer `subjectId` 过滤。
- 设计意图：
  - 不改变原有页面结构，在招聘需求、岗位、候选人、面试、Offer 详情中补齐可追溯审计视图。
  - 使「设计文档要求关键动作可追溯、审计可查」从管理后台扩展到全链路业务对象详情上下文。

## 验证结果

- `npm --prefix web run typecheck`：通过。
- `npm --prefix web test -- --run`：45/45 通过（`window.scrollTo` 为 jsdom 已知噪音，非失败）。
- `npm --prefix web run build`：通过（133 modules transformed）。
- `npm --prefix apps/api run build`：通过。
- `npm --prefix apps/api test`：15/15 通过。

## 运行状态

- API：`http://127.0.0.1:3100`，已经重启加载本批次前端无关的后端既有能力。
- Web：`http://localhost:5174`，开发服务器运行中。

## 继续批次：后端最小 RBAC 规则与审计补强

- 补齐此前已实现但日志未记录的服务层审计修复：
  - Offer 操作记录统一携带 `actorId`，避免审计事件操作人丢失。
  - 招聘需求 `PATCH`、岗位 `PATCH` 从路由层传入当前登录人 `auth.user.id`，并生成对应审计事件。
- `apps/api/src/routes.ts` 增加最小写权限矩阵：
  - 招聘需求创建 / 编辑、岗位创建 / 编辑 / 岗位说明 / JD / 岗位动作：`recruiter`、`admin`。
  - 招聘需求审批 / 驳回：`approver`、`hiring_manager`、`admin`。
  - 候选人、简历、AI 分析、申请、Offer、入职：`recruiter`、`admin`。
  - 面试创建与反馈锁定 / 完成：`recruiter`、`hiring_manager`、`admin`。
- 新增 `requireRole` 边界校验，保留统一认证错误口径，403 返回仍沿用 `FORBIDDEN`。
- API 测试新增不同角色登录能力，并在招聘需求审批链路中验证：
  - 招聘专员不能直接审批招聘需求（403）。
  - 审批人登录后可正常审批。
  - 审批后切换回招聘专员继续岗位创建流程。
- 前端页面的既有审计视图不受 RBAC 调整影响。

## 验证结果

- `npm --prefix apps/api run build`：通过。
- `npm --prefix apps/api test`：15/15 通过。

## 继续批次：部门数据范围（DataScope）基础接入

- `apps/api/src/routes.ts` 增加部门负责人数据范围基础能力：
  - `departmentScope(auth)`：仅 `hiring_manager` 按当前账号 `departmentId` 限定数据范围；其他角色不受限。
  - `filterByDepartment`：对列表结果在路由边界进行部门过滤。
  - `assertDepartmentScope`：对详情读取、需求编辑 / 动作、岗位详情 / 编辑 / 岗位动作做越权访问校验，越权返回 403。
- 招聘需求、岗位列表现按部门负责人数据范围过滤。
- 招聘需求详情、编辑和审批动作前读取记录并校验部门范围。
- 岗位详情、编辑、说明 / JD、岗位动作前读取岗位并校验部门范围。
- 结合上一批写权限矩阵，形成最小可运行的后端 RBAC + DataScope 防护。

## 验证结果

- `npm --prefix apps/api run build`：通过。
- `npm --prefix apps/api test`：15/15 通过。

## 继续批次：招聘需求 / 岗位查询参数补强

- `apps/api/src/recruiting/service.ts` 为需求与岗位列查询增加可选 `departmentId` 过滤参数。
- `apps/api/src/routes.ts` 的 GET 接口同步透传：
  - `/api/v1/recruitment-requests?departmentId=`。
  - `/api/v1/jobs?departmentId=`。
- 与上一批 DataScope 组合：显式 `departmentId` 先由服务层过滤，再由部门负责人范围二次收紧。

## 验证结果

- `npm --prefix apps/api run build`：通过。
- `npm --prefix apps/api test`：15/15 通过。
