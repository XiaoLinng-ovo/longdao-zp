# 模型配置修复与维护记录

日期：2026-11-27（北京时间）。仅针对本地运行环境，未部署公网。

## 实际修复

- 本地业务库为 smartrecruit；配置原本在系统管理员企业的历史表，平台表为空。企业选择平台来源时不能读到历史密钥。
- 历史接口域名不在当前运行环境白名单内；在显式计划中改为已允许的 https://ai.longdaoec.com/v1，不放宽白名单。
- 使用数据库中已有密钥完成真实生成后，将其以平台用途重新加密写入 public.platform_ai_settings；保留历史企业行和授权标志。
- 管理后台新增“模型生效诊断”，将配置持久化、企业来源、密钥读取、真实生成区分展示。新增接口全部要求当前系统管理员身份。
- 迁移使用计划指纹、数据库身份核对、并发锁、提交前版本校验、事务审计以及受保护的加密快照。没有环境凭据兜底。

## 运维步骤

在工作区根目录执行；使用已有部署配置，不输出密钥。以下为命令格式，不应重复导入已有平台配置。

```powershell
node scripts/ai-configuration-maintenance.mjs preview --organization <企业UUID> --base-url https://ai.longdaoec.com/v1 --output <受保护目录中的新绝对路径-plan.json>
node scripts/ai-configuration-maintenance.mjs apply --plan <plan.json绝对路径> --actor <系统管理员UUID> --output <新receipt.json绝对路径>
node scripts/ai-configuration-maintenance.mjs rollback --receipt <receipt.json绝对路径> --actor <系统管理员UUID> --output <新rollback.json绝对路径>
```

计划有效期为 4 小时。接口地址修改后必须重新预览与确认；不允许静默覆盖平台现有配置。回滚仅撤销未被后续修改的本次导入，不删除历史企业配置。备份包含敏感加密材料，不应上传公共仓库或公开分发。

本次成功使用 plan-reviewed.json；早期 plan.json 因日期序列化指纹校验失败而未写入，作为失败证据保留。成功回执为 backups/ai-configuration-20261127/receipt.json，修改前快照为同目录 receipt.json.before.json。

## 验证边界

- 本地业务配置迁移、正式企业解析与真实生成已通过。
- PostgreSQL 迁移隔离测试 7 项、平台配置隔离测试 9 项通过，包括重复导入、并发、事务回滚、密钥解密错误和版本冲突等场景。
- 前端相关 5 个文件共 215 项测试通过；API 新增权限与配置测试 14 项通过。
- 生产 API 源码、前端类型检查与生产构建通过。API 全量测试编译仍有原有 configurable-billing.postgres.integration.test.ts 的两个 TS2339，不能宣称全量编译通过。
- 整场录音、断线恢复、上下文角色复核、自动总结和浏览器诊断页的最终一轮结果以 interview-local-acceptance-20261127.md 及对应独立报告为准。
- 公网是独立环境，本地验证不表示公网已更新。

## 本地运行与残余风险

15:24 已启用本地不可变版本 business-20261127-ai-config-r4。API、Worker、Web 受管状态均 online/ready，网页入口为 http://127.0.0.1:5175。回滚版本 business-20261126-single-enterprise-r3 保留未修改；发布代码回滚与数据库配置回滚是不同操作，不应因代码回滚就删除已验证的平台配置。

完整浏览器轮次完成了自动总结，但审计发现两次回答分析证据校验 502。已在新版本中增加具体校验反馈的单次重试、空关联问题时的明确引用约束，不接受编造或改写的证据；真实转录回放与模型调用通过。浏览器脚本新增业务请求错误断言，防止总结成功掩盖局部错误。

本地 PostgreSQL 日志明确记录内存不足及后续恢复，旧 API/Worker 因连续数据库探测失败退出；恢复数据库后已重新启用受管服务。机器资源风险尚未根除。重型验收加入内存门槛，当前余量不足时拒绝启动，因而新版本未再跑一轮完整高负载录音端到端测试。未停止其他项目或更改机器分页文件。真实物理麦克风、桌面会议软件共享音频和长时多人会议也不在本次通过范围内。
