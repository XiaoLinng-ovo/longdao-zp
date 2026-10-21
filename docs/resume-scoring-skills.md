# 简历 AI 评分 Skill

## 使用入口

管理员进入「系统配置 → AI 模型配置 → 简历 AI 评分 Skill」。该模块与「岗位文档生成 Skill」分开管理，原有 `both` 仅表示岗位说明书与 JD，不用于评分。

1. 输入规则名称，例如「后端工程师 · 技术与项目优先」。
2. 勾选适用岗位，可关联多个岗位。同一个岗位只能关联一个评分 Skill，包括已停用的 Skill；更换规则需先在原 Skill 中解除关联。
3. 填写评分维度、权重、证据要求和扣分条件，也可以先填入评分模板，再调整规则。
4. 保存后启用。上传关联该岗位的简历，或对已有简历重新解析，Worker 自动匹配当前启用规则。

名称最多 80 字，规则最多 8000 字，单个 Skill 最多关联 200 个岗位。未关联岗位的规则可保存为草稿，不参与评分。

## 评分与历史

- 评分总分为 0–100 分，模型必须根据简历证据解释各维度及总分计算。
- 每次结果保存 Skill 的 ID、名称、完整内容与更新时间快照，候选人的简历复核面板展示评分来源、当次规则和 AI 说明。
- 编辑、停用、删除规则均不改写历史分析或人工复核结果。新的规则应用于后续分析；已有简历需重新解析。
- 没有关联启用 Skill 的岗位保持默认规则。停用不会解除岗位关联；删除 Skill 会解除关联。
- 最终得分保持 AI 40% + 人工 60%，规则不自动淘汰、录用或更改申请状态。

## 运行要求

先执行数据库迁移 `0030_resume_scoring_skills.sql`，并更新/重启 API 与 Worker。使用项目已有迁移脚本与服务启动方式：

```powershell
npm --prefix apps/api run build
node scripts/migrate-postgres.mjs
npm --prefix apps/worker run build
npm --prefix web run build
```

AI 模型配置仍使用现有 OpenAI-compatible 配置。Worker 启动时读取配置，修改配置后需重启 Worker。专属规则不能用内联默认评分替代：

- Worker 没有 AI 模型时给出 `SCORING_SKILL_AI_REQUIRED`。
- API 内联处理遇到专属规则时返回 409 / `SCORING_SKILL_WORKER_REQUIRED`，保留任务给 Worker。
- 模型没有返回有效分数时给出 `MODEL_RESPONSE_INVALID`，不会默认兜底。

## 数据与权限

评分规则保存在 `ai_prompt_skills`（`target_type = resume_score`），岗位关联保存在 `ai_resume_scoring_skill_jobs`。规则、岗位绑定与审计日志同事务写入，唯一岗位约束防止重复绑定；API 新建/更新绑定时检查岗位的工作区与部门访问权限。

## 验证

新增测试覆盖管理 CRUD、岗位冲突与回滚、启停、规则快照、Worker 按申请岗位选择规则、模型调用与无效分数保护，以及前端创建/编辑/删除确认。

真实 PostgreSQL 测试使用独立组织、岗位、规则、候选人等测试数据，结束后只清理测试数据。模型请求使用模拟响应，不向外部模型发送真实简历。
