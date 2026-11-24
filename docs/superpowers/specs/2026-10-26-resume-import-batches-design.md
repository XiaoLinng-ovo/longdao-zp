# 简历批次导入设计

## 目标

把当前“前端串行创建候选人、申请、上传简历”的流程改为持久化批次导入。用户可以一次选择大量简历，浏览器最多同时上传三份；单个文件失败或超时不会阻塞其他文件。服务端负责候选人和申请建档、简历入队分析，并提供可恢复的批次进度。

## 范围

- 同一批次只关联一个岗位。
- 单份文件沿用现有格式和 10 MB 限制。
- 浏览器最多同时上传三份，其余文件排队。
- 每个上传请求独立超时、取消和失败重试。
- 批次、文件状态和关联结果持久化到 PostgreSQL。
- 关闭浏览器后，已上传成功的文件继续由 Worker 分析。
- 取消批次只取消尚未开始上传的文件；已上传成功、正在分析或已完成的文件保留。

## 数据模型

### resume_import_batches

- `id uuid primary key`
- `organization_id uuid not null`
- `job_id uuid not null`
- `created_by uuid null`
- `status text not null`，取值 `uploading`、`completed`、`cancelled`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`
- `cancelled_at timestamptz null`

### resume_import_items

- `id uuid primary key`
- `batch_id uuid not null`
- `organization_id uuid not null`
- `ordinal integer not null`
- `client_file_id text not null`
- `original_filename text not null`
- `mime_type text not null`
- `size_bytes bigint not null`
- `status text not null`，取值 `pending_upload`、`uploading`、`queued`、`failed`、`cancelled`
- `candidate_id uuid null`
- `application_id uuid null`
- `resume_id uuid null`
- `analysis_task_id uuid null`
- `attempts integer not null default 0`
- `error text null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`
- 唯一约束：`batch_id + ordinal`、`batch_id + client_file_id`

分析展示状态由 `analysis_tasks.status` 动态覆盖：

- 导入项 `queued` + 任务 `queued`：显示“等待分析”
- 导入项 `queued` + 任务 `processing`：显示“分析中”
- 导入项 `queued` + 任务 `completed`：显示“已完成”
- 导入项 `queued` + 任务 `failed`：显示“分析失败”

## API

- `POST /api/v1/resume-import-batches`
  - 请求：`jobId` 和文件元数据清单
  - 返回：批次及每个文件的服务器 ID
- `POST /api/v1/resume-import-batches/:batchId/items/:itemId/content`
  - 接收单个文件 base64
  - 服务端内部创建候选人、申请、简历和分析任务
  - 重复提交同一项时返回已有结果
- `GET /api/v1/resume-import-batches/:batchId`
  - 返回批次汇总和每项状态
- `GET /api/v1/resume-import-batches?pageSize=20`
  - 返回当前企业最近批次
- `POST /api/v1/resume-import-batches/:batchId/cancel`
  - 只取消 `pending_upload` 和 `failed` 项
  - `uploading` 项允许完成，`queued` 及以上状态继续分析

## 前端调度

- 创建批次后，把服务器返回的 item ID 映射回本地文件。
- 使用固定并发数 3 的调度器。
- 每份文件单独读取 base64、上传并在完成后释放内容。
- 上传请求使用 `XMLHttpRequest.upload.onprogress` 显示百分比。
- 单请求 60 秒超时；网络错误或 5xx 自动重试一次。
- 批次 ID 存入 `localStorage`，页面重新进入时恢复最近批次。
- 页面轮询批次详情：上传中每 2 秒，后台分析中每 5 秒。
- 用户取消时先调用服务端取消接口，再中止尚未完成的本地上传。

## 错误处理

- 文件格式、大小和 MIME 在创建批次和上传正文时分别校验。
- 单个文件失败只更新该文件状态，不影响其他通道。
- 服务端在创建候选人后立即保存 candidate ID；申请、简历、任务完成后逐步保存，允许失败项继续。
- 上传接口如果发现批次已取消且该项尚未开始上传，返回冲突，不创建任何业务记录。
- 已上传文件的分析失败沿用现有 Worker 重试和失败展示。

## 权限与隔离

- 所有批次接口要求现有候选人写权限。
- 批次和明细必须带 `organization_id`，所有查询强制按当前工作区过滤。
- 岗位、候选人、申请、简历和分析任务继续使用现有企业数据范围。

## 测试

- 纯并发调度器：最大并发 3、单个失败不中断其他任务、取消后不再启动新任务。
- 批次服务：创建批次、单项上传、幂等重试、失败隔离、取消边界。
- API 路由：上传正文大小限制、权限、企业隔离、批次查询和取消。
- 页面：进度行映射、3 路并发、取消按钮、恢复最近批次、错误项重试。
- 构建验证：Web 测试与类型检查、API 构建与测试。
