# 部门管理与招聘需求下拉选择设计

## 目标

管理员可以新增、改名、停用和删除部门；招聘需求新建/编辑页面只从后端读取启用部门并用下拉框选择。部门编码保持稳定，历史招聘数据不因改名或停用而丢失。

## 方案

- PostgreSQL `departments` 继续作为唯一部门事实源，使用已有 `id/code/name/is_active` 字段。
- 登录用户通过 `GET /api/v1/departments` 获取启用部门；管理员通过 `GET /api/v1/admin/departments` 获取全部部门。
- 管理员通过 `POST /api/v1/admin/departments` 新增部门，通过 `PATCH /api/v1/admin/departments/:id` 修改名称或 `isActive`，通过 `DELETE /api/v1/admin/departments/:id` 物理删除部门。
- 部门 `code` 创建后不可修改，避免破坏用户、岗位、招聘需求和数据范围引用；名称可修改。
- 停用是软停用：停用部门从新建需求下拉框移除，但历史记录继续展示。
- 删除是物理删除，仅限「无引用」的部门。仍有用户、招聘需求、岗位或子部门引用时返回 400 并列出引用数量，提示先转移记录或改用停用。这是为了避开外键的隐式副作用：`users.department_id` 与 `departments.parent_id` 是 `ON DELETE SET NULL`，会静默改写历史归属（用户被解除部门后，`hiring_manager` 的部门可见范围会退化成全量）；`jobs.department_id` 与 `recruitment_requests.department_id` 是 `ON DELETE RESTRICT`，会直接报 23503。`department_approval_policies` 属部门自身配置，随删除级联清除，并在响应与审计中回报清除条数。
- 管理员页面增加部门管理表和新增表单；部门行提供「保存名称」「停用/启用」「删除（二次确认）」三类操作，行级失败提示只出现在部门区块内，不替换整页内容；招聘需求新建、编辑页面动态加载下拉选项。

## 错误与权限

- 部门列表要求登录；管理员写操作要求 `admin` 或 `hr_admin`。
- code/name 为空、code 重复、部门不存在分别返回标准校验/冲突/未找到错误；删除仍被引用的部门返回 400 并说明引用明细。
- 创建或编辑招聘需求仍由后端校验部门 code 存在，前端下拉只是可用性提升。

## 验证

- API/管理服务测试覆盖新增、改名、停用、物理删除、删除被引用时拒绝并保留原记录，以及普通用户读取启用部门。
- 前端 API 测试覆盖部门列表请求；页面测试覆盖下拉选项、管理员部门区块的停用/启用与删除二次确认、以及删除被拒时行内提示。
- 执行全量 workspace 测试、前端 typecheck、前端生产构建和 `git diff --check`。
