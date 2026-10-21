# 面试问题表设计（初试 / 复试两阶段）

## 目标

把"面试过程中问过什么、候选人怎么答的"沉淀成可复核的问题表，并按阶段汇总：

- **初试**：人事面试表、用人部门面试表两张表。各表按自己的问题提问并打分，同时依据该阶段录音给出 AI 面试评分；人工表分与 AI 分结合后，由人确认是否进入复试。
- **复试**：业务面试表、HR 面试表、BOSS 面试表三张表。AI 依据三张表的打分与复试录音输出**录取建议**（建议 + 档位 + 引用依据），是否录用仍由人决定。

表挂在**阶段**上而不是单场会面上：初试的人事面与用人部门面若是同一次会面，就是该阶段多张表共用一份录音；若分两次会面，则是该阶段下的两场面试，汇总时合并。两种情况模型都成立。

## 设计原则

- 表按"阶段 + 表类型"定义：初试为 `hr_screen`（人事）、`hiring_department`（用人部门）；复试为 `business`（业务）、`hr`（HR）、`boss`（BOSS）。同一应聘在同一阶段下每种类型最多一张表。
- 不新增采集：问题与回答复用实时面试已有的留痕（提问事件、转写片段、回答分析）；线下面试只多一条手工补录入口。
- AI 只给默认值与依据，面试官是最终打分人；AI 不可用时只给三级标准、不打默认分，不伪造分数。
- 打分即保存，提交后汇总回填现有面试反馈，锁定后不可改并进审计。
- 缺失就是缺失：没有回答文本的题目不打默认分，也不参与总分计算。
- AI 永不自动改变流程状态：能否进复试、是否录用都由人确认，AI 只输出建议与依据。

## 数据来源（全部复用现有表）

- `interview_live_question_events`：每次提问留痕（问题文本、来源 `manual`/`ai_adopted`、操作人、关联片段、时间）
- `interview_live_segments`：逐段转写（说话人角色、置信度、时间轴、音频对象键）
- `interview_live_analyses`：已分析的回答（question、summary、evidence、scores、confidence）

问答配对规则：按提问事件的时间顺序切段，每题的回答 = 该提问之后、下一条提问之前、`role = 'candidate'` 且 `role_confidence >= 0.6` 的段落聚合；同时保存段落 id 列表以便回溯。低于置信度阈值的段落不参与自动打分。

## 数据模型

```sql
CREATE TABLE interview_question_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('initial', 'final')),
  sheet_type text NOT NULL CHECK (sheet_type IN ('hr_screen', 'hiring_department', 'business', 'hr', 'boss')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'generating', 'scoring', 'submitted', 'locked')),
  source text NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'manual')),
  generation_model text,
  prompt_version text,
  generation_error text,
  generation_notice text,
  generated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  generated_at timestamptz,
  submitted_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, stage, sheet_type)
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

-- 阶段汇总：初试总分与是否进复试，复试的 AI 录取建议。AI 只给建议，决定由人落。
CREATE TABLE interview_stage_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('initial', 'final')),
  sheet_scores jsonb NOT NULL DEFAULT '{}',        -- {hr_screen: 82, hiring_department: 76}
  weights jsonb NOT NULL DEFAULT '{}',             -- {sheets: {hr_screen: 0.35, ...}, recording: 0.30}，页面可调
  recording_score integer,                          -- 该阶段录音的 AI 评分
  ai_score integer,                                 -- 阶段综合分（按权重合成）
  ai_recommendation text CHECK (ai_recommendation IS NULL OR (ai_recommendation IN ('strong_yes', 'yes', 'mixed', 'no'))),
  ai_rationale text,
  ai_evidence jsonb NOT NULL DEFAULT '[]',
  decision text CHECK (decision IS NULL OR (decision IN ('advanced', 'rejected', 'hired', 'hold'))),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, stage)
);
```

## 生成流程（异步）

触发方式：面试结束（实时会话 `end`）自动生成该阶段尚未生成的表；面试详情页提供"生成 / 重新生成"。生成任务由后台轮询执行（表状态置 `generating`，前端每 3 秒轮询），轮询器跑在 **API 进程内**（`startQuestionSheetPoll`，`QUESTION_SHEET_POLL=off` 可关），不放进 worker，避免 API 与 worker 各维护一份 SQL 仓储。

生成步骤：

1. 取该阶段的提问事件与配对回答，形成题目草稿（题干、维度、来源）。
2. 调用 OpenAI 兼容模型，为每题产出三级答案方向描述；若题目有回答文本，再产出默认档位、分数与引用依据。
3. 写回题目并置状态 `scoring`；任一步失败写入 `generation_error` 并回到 `draft`，允许重试。模型未配置时跳过第 2 步的默认打分，只落三级标准，并在表中标记"未配置模型"。
4. 阶段内所有表提交后，生成阶段汇总（`interview_stage_reviews`）：初试 = 各表得分 + 录音 AI 评分按权重合成总分；复试 = 依据三张表打分与录音输出录取建议与档位、引用依据。

## 打分与状态机

```text
draft -> generating -> scoring -> submitted -> locked
                \-> draft（失败可重试）
```

- `scoring`：面试官点档位即保存（档位给出区间，允许在区间内微调分数），可填评语。每次修改记录原值、新值与操作人。
- `submitted`：总分 = 已打分题目的 `final_score` 算术平均（未打分的题不参与，也不按 0 计）；`ratings` 按维度/题型分组取平均；两者回填 `interview_feedback.overallScore` 与 `ratings`，面试官可在反馈弹窗中覆盖总分。
- `locked`：不可再改，写入流程审计（沿用 `workflow_events`）。
- 完成面试的门槛升级为"该阶段下本方负责的表已提交"；没有关联问题表的历史面试保持原有行为。

阶段推进（全部由人确认，AI 不自动改状态）：

- 初试：人事表与用人部门表都已提交后，按公式汇总出初试综合分，由 HR 确认"进入复试"或"淘汰"。
- 复试：业务、HR、BOSS 三张表提交后，按同一公式汇总出复试综合分，并由 AI 输出录取建议与档位、引用依据，由决策人确认录用或淘汰。

## 阶段综合分的公式与可调权重

阶段综合分是**可解释的加权公式**，权重由面试官在页面上调整，不写死在代码里：

```text
阶段综合分 = Σ(各表得分 × 表权重) + 录音 AI 评分 × 录音权重

初试默认：人事面试表 0.35 + 用人部门面试表 0.35 + 录音 0.30
复试默认：业务面试表 0.233 + HR 面试表 0.233 + BOSS 面试表 0.234 + 录音 0.30
```

- 权重按阶段保存（`interview_stage_reviews.weights`），页面直接展示公式与代入后的数值，例：`82 × 0.35 + 76 × 0.35 + 78 × 0.30 = 78.5`。
- 面试官可调整任一权重；保存时校验"表权重与录音权重之和为 1"且只允许该阶段已有的表类型，然后立即重算综合分。
- 缺失项不按 0 计算：某张表没有得分或没有录音分时，该项不参与，权重在剩余项之间按比例归一化，并在页面上明确标注"该项缺失，已按剩余权重归一"。
- 权重调整与结论一样留痕（谁、何时、原值 → 新值），并写入流程审计。
- AI 建议与公式分离：公式给出**分数**，AI 给出**建议档位与理由**；调整权重不会改写 AI 已给出的建议文本，页面同时展示两者，避免相互覆盖。

## 页面呈现（面试详情页「面试问题表」）

面板挂在面试详情页，入口是页面标题下方左侧的低调次级入口（`▤ 面试问题表`，灰色小链接样式，不占主操作区），点击以**弹窗**打开：弹窗宽度自适应（最大 1180px）、高度上限 90vh，主体可滚动（`sheet-dialog-body` 独立滚动、`overscroll-behavior: contain`），阶段切换与刷新条在滚动时吸顶；打开时锁定页面滚动，Esc / 点遮罩 / 「关闭」都能收起（内层「确认阶段结论」弹窗打开时 Esc 只关内层）。面板按阶段切换，阶段取 `interviews.stage`（第 1 轮=初试，第 2 轮及以后=复试，也由轮次兜底推导）：

1. **阶段综合分区块**（页面顶部，先看结论再看明细）：标题 + 公式说明 `阶段综合分 = Σ(各表得分 × 表权重) + 录音 AI 评分 × 录音权重`、代入数值的算式、逐项表格（评分项 / 得分 / 权重（可调，按百分比输入）/ 实际权重 / 贡献）、缺失项说明、合计校验（非 100% 不允许保存）、`保存权重` 与 `恢复默认权重`、AI 建议与引用依据、阶段结论按钮。
2. **表卡片**：每张表显示状态、`已打分 x/y`、表内平均分，以及 `生成面试表 / 重新生成`、`提交该表`、`锁定`。
3. **题目行**：题干、考察维度、候选人回答原文、AI 默认分与依据、引用片段、三档按钮（优秀 90-100 / 合格 70-89 / 待改进 0-69，点档位即保存，分数落在区间内则保留否则取区间中值）、分数输入（区间内微调）、`采纳 AI 分`、评语（失焦保存）、删除；线下面试可手工补录题目。
4. 权重在页面上实时预览：改动后算式与综合分立即按新权重重算，保存成功后再以服务端返回的重算结果为准（未保存时用前端同口径计算，保证"改一处、算式跟着变"）。
5. 阶段结论点击后弹窗确认，弹窗内同时给出当前综合分、算式与 AI 建议，确认才落库。

## 接口

- `GET /api/v1/applications/:id/question-sheets`：读取该应聘的全部阶段与表（含状态、进度、阶段汇总）
- `POST /api/v1/applications/:id/question-sheets/:stage/:sheetType`：生成或重新生成（置 `generating`，返回当前状态）
- `PATCH /api/v1/applications/:id/question-sheets/:stage/:sheetType/questions/:questionId`：改档位、分数、评语
- `POST /api/v1/applications/:id/question-sheets/:stage/:sheetType/submit`、`/lock`
- 手工补录：`POST .../questions` 新增题目（`source = 'manual'`），`DELETE .../questions/:questionId` 删除
- `POST /api/v1/applications/:id/stages/:stage/decision`：人确认阶段结论（`advanced` / `rejected` / `hired` / `hold`）
- `PATCH /api/v1/applications/:id/stages/:stage/weights`：调整阶段权重并立即重算综合分（校验求和为 1、只允许该阶段已有的表类型）

## 权限与审计

- 读写：该应聘所属岗位的部门范围（沿用 `assertApplicationInScope` 的口径）
- 提交/锁定：该表的填写角色本人，或 `admin` / `hr_admin`
- 阶段结论：初试由 HR / `hr_admin` 确认；复试由 BOSS 表的填写人或 `admin` 确认
- 候选人与其他部门不可见；所有修改与状态流转保留操作人与时间

## 错误处理与边界

- 模型失败：保留已生成的题目草稿，`generation_error` 记录原因，允许重试，不写入默认分。
- 转写缺失或置信度不足：题目保留但不打默认分，界面提示"缺少可用回答"。
- 线下面试：无提问事件时，表面板支持手工加题与填写回答要点，其余流程一致。
- 阶段缺失：某阶段没有面试记录时，对应表只支持手工补录，不生成 AI 评分。
- 并发：同一张表只允许一个生成任务，重复请求返回当前状态。

## 不做的事

- 自定义评分表模板、拖拽权重
- 跨候选人的对比榜
- 音频切片回放（先保存片段 id 以便后续跳转）
- 初试/复试之外的自定义阶段与表类型

## 验收标准

1. 初试有"人事面试表"和"用人部门面试表"两张表；复试有"业务面试表""HR 面试表""BOSS 面试表"三张表。
2. 面试结束后自动生成对应阶段的问题表草稿；也可手工生成与重新生成。
3. 表中的题干与回答来自该阶段真实留痕，可回溯到具体转写片段。
4. 模型可用时每题带三级答案方向与默认档位、分数、依据；模型不可用时只给三级标准且状态可恢复。
5. 面试官点档位即保存，可在区间内微调，改动有留痕。
6. 初试两张表都提交后给出初试总分与 AI 录音评分，由人确认是否进复试；复试三张表提交后由 AI 输出录取建议，由人确认录用或淘汰。
7. AI 的任何输出都不改变申请状态；完成面试要求该阶段本方负责的表已提交；没有问题表的历史面试行为不变。
8. 不影响现有反馈提交、锁定、完成面试与流程审计。
9. 页面直接展示综合分公式与代入数值，面试官可调整任一权重；合计不为 100% 时不允许保存；保存后综合分立即重算并可恢复默认。

## 已知差距（未实现，明确记录）

- `submitted` 时把表内总分与维度分**回填 `interview_feedback`** 尚未实现：现有数据模型里 `interview_feedback` 是按"面试官"一行，而问题表是按"表类型"（人事/用人部门/业务/HR/BOSS）组织，缺一张"表 → 面试官"的映射表。在补上映射之前不回填，避免把 A 表分数写进 B 面试官的反馈。
- 阶段结论的权限细化（初试限 HR、复试限 BOSS 表填写人）当前沿用 `INTERVIEW_WRITE_ROLES`，未按表类型细分角色。
- 音频切片回放、权重拖拽、自定义模板仍在"不做的事"里。
