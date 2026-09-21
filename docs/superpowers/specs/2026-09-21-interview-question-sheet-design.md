# 面试问题表设计（每轮一张）

## 目标

把"面试过程中问过什么、候选人怎么答的"沉淀成一张可复核的问题表：面试结束后按该轮实际问答生成题目与三级答案方向，AI 给出默认档位与分数，面试官可改分并提交。表归属于**一场面试（轮次）**，一场面试一张，不做固定名称的分表，也不做跨轮汇总视图。

## 设计原则

- 一表一轮：`interviews` 一行对应一张问题表，标题沿用该场面试自己的标题（例如"技术一面"）。不引入"业务面/HR 面/BOSS 面"这类固定表类型。
- 不新增采集：问题与回答复用实时面试已有的留痕（提问事件、转写片段、回答分析）；线下面试只多一条手工补录入口。
- AI 只给默认值与依据，面试官是最终打分人；AI 不可用时只给三级标准、不打默认分，不伪造分数。
- 打分即保存，提交后汇总回填现有面试反馈，锁定后不可改并进审计。
- 缺失就是缺失：没有回答文本的题目不打默认分，也不参与总分计算。

## 数据来源（全部复用现有表）

- `interview_live_question_events`：每次提问留痕（问题文本、来源 `manual`/`ai_adopted`、操作人、关联片段、时间）
- `interview_live_segments`：逐段转写（说话人角色、置信度、时间轴、音频对象键）
- `interview_live_analyses`：已分析的回答（question、summary、evidence、scores、confidence）

问答配对规则：按提问事件的时间顺序切段，每题的回答 = 该提问之后、下一条提问之前、`role = 'candidate'` 且 `role_confidence >= 0.6` 的段落聚合；同时保存段落 id 列表以便回溯。低于置信度阈值的段落不参与自动打分。

## 数据模型

```sql
CREATE TABLE interview_question_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'generating', 'scoring', 'submitted', 'locked')),
  source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual')),
  generation_model text,
  prompt_version text,
  generation_error text,
  generated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  generated_at timestamptz,
  submitted_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE interview_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id uuid NOT NULL REFERENCES interview_question_sheets(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  question text NOT NULL,
  dimension text,                        -- 考察维度，例如"架构能力/系统设计"
  category text,                         -- 沿用出题的 technical/behavioral/experience/job_specific
  difficulty text,                       -- easy/medium/hard
  source text NOT NULL CHECK (source IN ('live_question', 'ai_generated', 'manual')),
  question_event_id uuid REFERENCES interview_live_question_events(id) ON DELETE SET NULL,
  answer_segment_ids uuid[] NOT NULL DEFAULT '{}',
  answer_text text,
  tiers jsonb NOT NULL DEFAULT '[]',     -- [{tier,min,max,description}] 优秀 90-100 / 合格 70-89 / 待改进 <70
  ai_tier text, ai_score integer, ai_rationale text, ai_evidence jsonb NOT NULL DEFAULT '[]',
  final_tier text, final_score integer, comment text,
  scored_by uuid REFERENCES users(id) ON DELETE SET NULL,
  scored_at timestamptz,
  UNIQUE (sheet_id, seq)
);
```

## 生成流程（异步）

触发方式：面试结束（实时会话 `end`）自动生成草稿；面试详情页提供"生成问题表 / 重新生成"。两种方式都写入 worker 队列（新增任务类型 `interview_question_sheet`），表状态置 `generating`，前端轮询。

生成步骤：

1. 取该轮提问事件与配对回答，形成题目草稿（题干、维度、来源）。
2. 调用 OpenAI 兼容模型，为每题产出三级答案方向描述；若题目有回答文本，再产出默认档位、分数与引用依据。
3. 写回题目并置状态 `scoring`；任一步失败写入 `generation_error` 并回到 `draft`，允许重试。模型未配置时跳过第 2 步的默认打分，只落三级标准，并在表中标记"未配置模型"。

## 打分与状态机

```text
draft -> generating -> scoring -> submitted -> locked
                \-> draft（失败可重试）
```

- `scoring`：面试官点档位即保存（档位给出区间，允许在区间内微调分数），可填评语。每次修改记录原值、新值与操作人。
- `submitted`：总分 = 已打分题目的 `final_score` 算术平均（未打分的题不参与，也不按 0 计）；`ratings` 按维度/题型分组取平均；两者回填 `interview_feedback.overallScore` 与 `ratings`，面试官可在反馈弹窗中覆盖总分。
- `locked`：不可再改，写入流程审计（沿用 `workflow_events`）。
- 完成面试的门槛升级为"本轮问题表已提交"；没有关联问题表的历史面试保持原有行为。

## 接口

- `POST /api/v1/interviews/:id/question-sheet`：生成或重新生成（写队列，返回当前状态）
- `GET /api/v1/interviews/:id/question-sheet`：读取表、题目、状态与进度（已打分题数 / 总题数）
- `PATCH /api/v1/interviews/:id/question-sheet/questions/:questionId`：改档位、分数、评语
- `POST /api/v1/interviews/:id/question-sheet/submit`、`/lock`
- 手工补录：同一 PATCH 支持新增/删除题目（`source = 'manual'`）

## 权限与审计

- 读写：该场面试的参与者（沿用 `interview_feedback` 的口径）
- 提交/锁定：参与者本人，或 `admin` / `hr_admin`
- 候选人与其他部门不可见；所有修改与状态流转保留操作人与时间

## 错误处理与边界

- 模型失败：保留已生成的题目草稿，`generation_error` 记录原因，允许重试，不写入默认分。
- 转写缺失或置信度不足：题目保留但不打默认分，界面提示"缺少可用回答"。
- 线下面试：无提问事件时，表面板支持手工加题与填写回答要点，其余流程一致。
- 并发：同一面试只允许一个生成任务，重复请求返回当前状态。

## 不做的事

- 自定义评分表模板、拖拽权重
- 跨候选人或跨轮次的对比榜
- 音频切片回放（先保存片段 id 以便后续跳转）
- 固定名称的分表（业务面 / HR 面 / BOSS 面）与跨轮 tab 汇总

## 验收标准

1. 面试结束后自动生成该轮问题表草稿；也可手工生成与重新生成。
2. 表中的题干与回答来自该轮真实留痕，可回溯到具体转写片段。
3. 模型可用时每题带三级答案方向与默认档位、分数、依据；模型不可用时只给三级标准且状态可恢复。
4. 面试官点档位即保存，可在区间内微调，改动有留痕。
5. 提交后总分与维度分回填面试反馈；锁定后不可修改。
6. 完成面试要求本轮问题表已提交；没有问题表的历史面试行为不变。
7. 不影响现有反馈提交、锁定、完成面试与流程审计。
