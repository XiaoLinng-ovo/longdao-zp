# 2026-09-17 开发日志

## 今日目标

- 收敛智能招聘平台设计基线，并继续完成简历处理、钉钉接入、安全扫描和对象存储等核心链路。
- 坚持 PostgreSQL 作为权威业务数据库；AI 仅提供辅助分析，不直接执行淘汰、录用或发放 Offer。
- 将“代码已实现”“自动化测试已通过”和“真实外部环境已验收”分开记录。

## 已提交成果

### 1. 设计基线收敛

- 将分散的项目设计、数据库事务、API 契约和实施路线内容合并为统一设计基线：`docs/superpowers/specs/2026-09-17-smartrecruit-platform-final-design.md`。
- 明确当前产品为单组织内部招聘平台，不扩展为多租户 SaaS。
- 明确 AI 统一通过一个可配置的 OpenAI-compatible `BASE_URL` 接入，不建设模型路由平台。

对应提交：`1a526bd docs: consolidate recruiting platform design baseline`。

### 2. OCR 与招聘流程加固

- 接入 PP-StructureV3 OCR 服务边界，为 PDF、扫描件及复杂版式简历提供文字提取能力。
- 增加简历文件安全校验、扫描状态单向约束和 PostgreSQL 持久化任务处理能力。
- 完善钉钉岗位同步：接收钉钉侧的简化岗位信息，在平台创建草稿招聘需求和草稿岗位，由网站继续补全详细内容。
- 增加钉钉事件幂等、冲突检测、用户映射和同步记录。
- 增加前端无权限页面、管理端钉钉同步记录能力及相关测试。
- 增加 OCR 服务 Dockerfile、依赖和 Compose 配置。

对应提交：`a5be5d5 feat: integrate OCR and harden recruiting workflow`，并标记版本 `0.0.8`。

### 3. 钉钉部门审批基础

- 新增钉钉 access token 获取和 `/v1.0/workflow/processInstances` 审批实例发起客户端。
- 新增部门审批策略数据库迁移，支持按部门配置招聘需求审批流程代码。
- 修正 PostgreSQL 岗位同步相关实现并补充协议级测试。

对应提交：`3f7c70a feat: add DingTalk department approval foundation`。

## 工作区待提交成果

### 1. 测试体系修复

- API 测试范围从单个入口扩展到 `dist/src/**/*.test.js` 和 `dist/tests/*.test.js`。
- Worker 测试范围扩展到全部测试文件，并统一 Node.js engines 约束。
- Web 测试命令改为 `vitest run`，避免进入监听模式后持续挂起。
- 修复钉钉过期 processing receipt 重放断言及 DOCX fixture 对当前工作目录的依赖。

### 2. ClamAV 简历病毒扫描闭环

- 新增 clamd TCP `INSTREAM` 客户端和简历扫描循环。
- 使用 PostgreSQL `FOR UPDATE SKIP LOCKED` 原子领取扫描任务。
- 扫描状态按 `quarantined -> scanning -> clean/infected/failed` 推进，扫描异常采用 fail-closed 策略。
- Worker 只分析 `clean` 状态简历；API 手工触发分析也会校验扫描状态，非 clean 返回 `409 RESUME_SCAN_NOT_CLEAN`。
- 被安全门禁拒绝时，分析任务保持 queued，不增加 attempts。

### 3. 钉钉真实审批核心链路

- 按部门审批策略查找流程模板，并将平台用户映射为钉钉用户 ID。
- 发起钉钉审批后保存 `processInstanceId`。
- 新增加密回调入口：`POST /api/v1/integrations/dingtalk/approvals/callback`。
- 实现钉钉官方 SHA1 排序签名、AES-256-CBC 解密、CorpId/AppKey 校验和加密 `success` 响应。
- 实现回调幂等，并同步审批实例、审批步骤、审批记录和招聘需求状态。
- 外部钉钉审批活跃期间，阻止网站本地 approve/reject，避免双轨审批。
- 增加失败补偿：用户映射失败不改变状态；流程策略缺失或发起失败时恢复草稿；钉钉实例已创建但本地 attach 失败时不盲目重试，避免生成重复流程。

### 4. MinIO/S3 对象存储接入

- 新增共享包 `packages/object-storage`，提供统一 `ObjectStorage` 接口。
- 支持 MinIO/S3 path-style、bucket ensure、put/get/delete/health 和对象路径安全校验。
- 未配置 `S3_ENDPOINT` 时保留本地目录存储，便于开发环境运行。
- API 上传简历改为写入对象存储；数据库写入失败时删除已上传对象，形成补偿闭环。
- API 分析、Worker ClamAV 扫描、Worker OCR/简历分析均改为从对象存储读取，不再依赖 API 与 Worker 共享本地磁盘。

### 5. 配置与文档

- 补充钉钉审批、加密回调、部门流程策略和用户映射配置说明。
- 补充 ClamAV、MinIO/S3、Worker PostgreSQL 轮询相关环境变量和运行说明。

## 验证结果

- `pnpm -r build`：今日已完成全项目构建验证，通过。
- `pnpm -r test`：日志生成前已重新执行全仓测试，0 failed。
- 测试明细：Contracts 2、Resume intelligence 3、Object storage 4、Web 53、Worker 22 passed / 2 skipped、API 98 passed / 3 skipped。
- PostgreSQL 相关集成测试因未配置密码或带密码的 `DATABASE_URL` 而跳过；跳过不等同于 PostgreSQL 真实集成验收通过。

## 尚未完成或待真实环境验收

- 尚未使用企业真实钉钉凭据完成招聘需求 submit、approve、reject 和加密回调端到端联调。
- Offer 审批尚未接入钉钉。
- 尚未启动真实 MinIO 服务完成简历上传、读取、扫描、OCR、分析全链路验收。
- 尚未使用 EICAR 测试文件完成 ClamAV 真扫描验收。
- 尚未使用 PP-StructureV3 容器和复杂版式简历 fixture 完成 OCR 效果验收。
- 真实 OpenAI-compatible LLM 简历分析尚未完成。
- 面试出题功能尚未实现。
- PostgreSQL 集成测试仍需在具备有效凭据的环境中执行。
- Compose 仍需补齐 API、Worker、Web、反向代理、migration 和 backup 等生产运行组件。
- `/ready` 尚未对 PostgreSQL、对象存储、ClamAV、OCR 等关键依赖执行真实就绪检查。
- Redis 尚未进入实际业务任务链路，当前 Worker 仍采用 PostgreSQL 租约轮询。

## 下一步计划

1. 整理并提交当前工作区的 ClamAV、钉钉审批、MinIO 和测试发现范围修复。
2. 使用真实 PostgreSQL、MinIO、ClamAV 和 PP-StructureV3 环境完成简历上传到分析的端到端验收。
3. 在钉钉企业应用后台配置审批模板和加密回调，完成招聘需求批准与驳回的真实联调。
4. 实现真实 OpenAI-compatible LLM 简历分析和面试出题，并保持人工最终决策边界。
5. 补齐 Offer 钉钉审批、生产 Compose、依赖就绪检查、迁移和备份恢复流程。

## Git 状态

- 当前分支：`main`。
- 当前已提交 HEAD：`3f7c70a`，与 `origin/main` 同步。
- 今日已有 3 个提交：`1a526bd`、`a5be5d5`、`3f7c70a`。
- ClamAV、完整钉钉审批、MinIO/S3 和测试修复仍位于未提交工作区。
