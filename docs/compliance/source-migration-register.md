# SmartRecruit Pro 来源迁移登记与合规清单

> 文档版本：v0.1
> 登记日期：2026-09-09
> 状态：实施前登记模板，正式发布前必须补齐授权和许可证证据

## 1. 目的

本文件记录 SmartRecruit Pro 对 `CandiSift` 与 `Frappe HR` 的参考、迁移和再实现边界。用户已说明相关作者同意迁移使用；在代码进入生产分支或对外分发前，仍需要把书面授权、来源版本、许可证和第三方依赖信息归档到项目受控位置。

## 2. 来源登记

| 来源 | 仓库 | 使用方式 | 当前边界 | 必须归档 |
| --- | --- | --- | --- | --- |
| CandiSift | https://github.com/confused-ai/candisift | 迁移/重写简历解析、抽取、脱敏、标准化、匹配、评分和报告思路 | 只进入 `packages/resume-intelligence`；不迁移其用户体系、页面和公开 API；AI 仅提供建议 | 授权主体、授权范围、来源 commit/tag、许可证、第三方依赖清单 |
| Frappe HR | https://github.com/frappe/hrms | 借鉴招聘需求、候选人、面试、反馈、Offer、审批和报表业务经验；必要时迁移获得授权的独立代码片段 | 不引入完整 Frappe Framework/HRMS；不复制薪酬、考勤、品牌页面和无关模块 | 授权主体、授权范围、来源 commit/tag、许可证、署名/分发义务 |

## 3. 迁移矩阵

### 3.1 CandiSift → `packages/resume-intelligence`

| 能力 | 目标模块 | 处理方式 | 验收证据 |
| --- | --- | --- | --- |
| 文件/文本格式识别 | `src/parser` | TypeScript 原生实现或适配器 | 格式识别测试 |
| 简历章节解析 | `src/parser` | 保留领域输出，不保留原 UI/API | 章节 Golden Dataset |
| 联系方式和经历抽取 | `src/extractor` | 明确字段来源和置信度 | 抽取单元测试 |
| PII 脱敏 | `src/anonymizer` | 发送模型前执行；原始简历不被覆盖 | 脱敏测试和日志检查 |
| 技能/经验匹配 | `src/matcher` | 与岗位要求 DTO 对齐 | 硬性要求冲突测试 |
| 评分/报告 | `src/scorer`、`src/report` | 规则结果可解释；人工复核状态必填 | 分数归一化和安全字段测试 |
| Prompt 构建 | `src/prompts` | 只使用脱敏文本；禁止自动淘汰/录用/Offer | Prompt 安全断言 |

### 3.2 Frappe HR → SmartRecruit Pro 领域模型

| 业务经验 | SmartRecruit Pro 模型 | 处理方式 |
| --- | --- | --- |
| 招聘需求和岗位 | `recruitment_requests`、`jobs`、版本表 | 重新建模，保留审批和版本语义 |
| 候选人与职位申请 | `candidates`、`applications` | 明确拆分，支持一名候选人多次申请 |
| 面试轮次和反馈 | 后续 `interviews`、`interview_feedback` | 反馈锁定，不覆盖历史评分 |
| Offer 与审批 | 后续 `offers`、`offer_versions` | 版本化、审批后发送 |
| 招聘统计 | 后端聚合查询 | 不直接复制页面统计实现 |

## 4. 发布前必查清单

- [ ] 书面授权文件已存档，包含授权主体、日期、范围、地域和分发权限。
- [ ] CandiSift 和 Frappe HR 的实际来源 commit/tag 已固定，不能只记录 `main`。
- [ ] 每个迁移文件有来源路径、来源版本、改写说明和目标文件记录。
- [ ] 原项目许可证及所有新增第三方依赖许可证已审核。
- [ ] 需要保留的版权声明、NOTICE 和署名已加入发布包。
- [ ] 迁移代码没有带入来源项目的密钥、测试个人信息、数据库数据或内部配置。
- [ ] 测试简历和其他含个人信息的文件不进入 Git；当前仓库根目录的 `测试简历-张伟.docx` 仅用于本地测试。
- [ ] 安全评审确认 AI 结果不会自动改变 `Application`、Offer 或雇佣状态。

## 5. 代码登记模板

每次迁移或受授权复制都应新增一行记录：

```text
目标文件：
来源项目：CandiSift / Frappe HR
来源路径：
来源 commit/tag：
授权文件：
许可证：
改写/适配说明：
测试覆盖：
评审人：
登记日期：
```

## 6. 当前结论

当前实现优先采用“能力迁移 + 本项目接口重写”的方式，避免把来源项目的完整框架、页面和运行时耦合带入 SmartRecruit Pro。直到第 4 节清单完成，不能把来源代码标记为已完成生产合规。
