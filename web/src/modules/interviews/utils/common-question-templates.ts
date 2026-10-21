export interface CommonQuestionDimension { id: string; title: string; focus: string; maxScore: number; questions: string[]; excellent: string; pass: string; warning: string }
export interface CommonQuestionGroup { id: 'hr' | 'department' | 'boss'; title: string; description: string; maxScore: number; dimensions: CommonQuestionDimension[] }

export const COMMON_QUESTION_GROUPS: CommonQuestionGroup[] = [
  { id: 'hr', title: 'HR 通用提问', description: '五个维度，每个维度的备选题任选其一；了解职业动机、团队适配和职业成熟度。', maxScore: 40, dimensions: [
    { id: 'motivation', title: '职业动机与职业规划', focus: '离职动机、职业规划清晰度、长期稳定性', maxScore: 8, questions: ['你为什么离开上一家公司？', '未来三年你的职业发展路径是什么？', '什么样的机会会让你毫不犹豫地加入我们？'], excellent: '离职原因客观理性，职业规划清晰且与公司方向匹配。', pass: '能说明原因和规划，但略显模糊或理想化。', warning: '频繁抱怨前公司或领导；职业规划空白，只有短期利益。' },
    { id: 'expectation', title: '薪酬期望与市场定位', focus: '自我认知、薪资匹配度、成长与金钱的平衡', maxScore: 8, questions: ['你当前的薪酬结构和预期总年薪是多少？', '如果 Offer 未达薪资预期，你会如何考虑？', '除了薪资，哪些因素对你选择工作影响最大？'], excellent: '期望合理且有市场依据，理解薪资与成长，不只看钱。', pass: '期望略高但可协商，或对市场定位不够清晰。', warning: '期望远超岗位范围且缺乏弹性，完全不了解市场。' },
    { id: 'collaboration', title: '工作风格与团队适配', focus: '协作方式、沟通习惯、对团队角色的自我认知', maxScore: 8, questions: ['你更喜欢独立工作还是团队协作？请举例。', '你遇到过最难配合的同事吗？怎么做的？', '你期望的领导风格是什么样的？'], excellent: '协作方式、沟通习惯及团队角色认知清晰。', pass: '对风格偏好有自我认知，能与团队互补，沟通成熟。', warning: '能描述风格但缺乏案例，或适配性一般，需进一步核实。' },
    { id: 'pressure', title: '抗压能力与职业成熟度', focus: '面对批评、失败和高压时的情绪与行为反应', maxScore: 8, questions: ['请分享一次被严厉批评的经历，你是怎么处理的？', '同时多个紧急任务且资源不足，你会怎么做？', '过去一年最沮丧的工作经历是什么？'], excellent: '能正视压力，主动寻求解决方案，事后复盘，情绪稳定。', pass: '能接受压力但应对方式单一，或偶有情绪化。', warning: '逃避责任、情绪失控、指责他人，或轻描淡写不愿面对。' },
    { id: 'values', title: '价值观与公司文化匹配', focus: '诚信、责任感、公平认知、对规则与文化的认同', maxScore: 8, questions: ['什么样的工作氛围会让你觉得“不想待下去”？', '如果发现同事为业绩走“灰色地带”，你会怎么做？', '你如何看待加班与生活平衡？'], excellent: '价值观清晰正向，与公司文化高度契合，行为一致性高。', pass: '无明显冲突，但表达泛泛或缺少真实案例。', warning: '存在不诚信、极端功利或缺乏职业责任等迹象，需基于证据核实。' },
  ] },
  { id: 'department', title: '用人部门通用提问', description: '五道通用业务题，了解专业能力、问题解决、执行结果与学习速度。', maxScore: 60, dimensions: [
    { id: 'results', title: '专业能力与结果导向', focus: '结构表达、个人贡献、量化成果', maxScore: 12, questions: ['请用三分钟介绍你过去最得意的一个工作或项目成果（不限岗位），并说明你扮演的角色、遇到的难点和最终数据。'], excellent: '按背景、动作、难点、结果清晰表达，有量化数据，角色明确。', pass: '有成果但数据模糊，或角色不清晰、难点轻描淡写。', warning: '无法说明成果或数据，夸大但经不起追问。' },
    { id: 'learning', title: '学习能力与问题拆解', focus: '信息收集、目标拆解、验证闭环与迭代', maxScore: 12, questions: ['假设公司安排你负责一个你完全没做过的任务（比如新系统上线、新渠道开拓），你会如何上手？请说出你的思考步骤。'], excellent: '主动收集信息，拆解目标和技术环节，建立最小闭环并快速迭代。', pass: '有步骤但跳跃，或缺少闭环验证。', warning: '只等人教、等资源，或缺乏具体行动计划。' },
    { id: 'initiative', title: '主动性与业务敏感度', focus: '主动发现低效点、提出方案并推动落地', maxScore: 12, questions: ['请举例说明你曾经主动发现并解决的一个业务或流程中的低效点，当时你做了什么？效果如何？'], excellent: '主动观察、提出方案、推动落地，带来可衡量的改善。', pass: '发现问题但未解决，或效果不明确。', warning: '从未主动发现问题，只按指令完成工作。' },
    { id: 'innovation', title: '创新执行与资源决策', focus: '有限预算下的设计、实验、验证和迭代', maxScore: 12, questions: ['如果让你用极少的预算（比如 500 元）和一周时间，提升一个通用办公场景（如会议效率、文档协作）的效率，你会怎么设计？'], excellent: '先分析痛点，再设计低成本实验，验证效果并迭代方向。', pass: '有想法但缺少验证环节。', warning: '直接要求买工具或软件，不考虑预算等约束。' },
    { id: 'adaptation', title: '适应性与职业成熟度', focus: '对岗位差异的沟通、优先级判断与学习意愿', maxScore: 12, questions: ['如果你入职后，发现实际工作内容与面试时说的有 30% 不一致（比如多了很多琐碎支持工作），你会怎么办？'], excellent: '先理解业务需要，主动沟通优先级，从中找到学习点。', pass: '有条件配合，或选择暂时忍耐。', warning: '直接抱怨、消极怠工或轻率离职。' },
  ] },
  { id: 'boss', title: '老板终面通用提问', description: '复试 / 终面参考模板，独立满分 100 分，不与 HR、部门分值直接相加。', maxScore: 100, dimensions: [
    { id: 'breakthrough', title: '创新、追求卓越与复盘', focus: '从零到一、突破局面、个人贡献与复盘深度', maxScore: 20, questions: ['请用三分钟说出你过去最引以为傲的一次“从 0 到 1”或“扭转局面”的经历。如果让你重来一次，你会做哪一点不同？'], excellent: '有真实突破、清晰描述难点与贡献，复盘能看到深层洞察，体现成长。', pass: '经历有价值但创新性或突破性不足，复盘较浅。', warning: '无独立负责经历，或复盘只是外部归因。' },
    { id: 'strategy', title: '结果导向、资源整合与决策', focus: '目标拆解、优先级、关键风险和成果思维', maxScore: 20, questions: ['假设公司未来半年要在一个新业务方向（与你过往经验不完全相关）上拿到确定性结果，你是负责人，你会如何组建团队、分配资源、确保目标达成？'], excellent: '目标拆解清晰，有优先级判断，能识别关键风险并体现成果思维。', pass: '有基本思路但不够具体，或缺少风险应对。', warning: '思路混乱，或只说“按领导要求做”。' },
    { id: 'alignment', title: '共赢、向上管理与冲突处理', focus: '事实沟通、推进合作、关系和结果的复盘', maxScore: 20, questions: ['请分享一次你与上级或重要合作方在目标上产生严重分歧的经历。最终结果如何？你从中学到了什么？'], excellent: '坚持原则同时寻找共识，推动事情向好发展，不把关系破裂当作成果。', pass: '有沟通但效果一般，或妥协后仍有情绪。', warning: '对抗、回避，或把关系恶化当作主要结果。' },
    { id: 'resilience', title: '保证结果、抗压与韧性', focus: '面对失败、主动复盘和调整策略', maxScore: 20, questions: ['在你的职业经历中，有没有一个阶段你觉得自己“尽力了但结果仍然不理想”？当时你是怎么想的？后来又做了什么？'], excellent: '坦诚面对失败，主动复盘并采取行动扭转或止损，心态成熟。', pass: '能接受但行动不足，或需要较长时间恢复。', warning: '抱怨资源或环境，或一蹶不振，需核实具体情境。' },
    { id: 'vision', title: '战略视野、岗位理解与求成', focus: '对业务方向的独立判断、依据和岗位价值', maxScore: 20, questions: ['你对我们公司所处的行业和未来三年的竞争格局怎么看？你认为我们这个岗位最应该创造的核心价值是什么？'], excellent: '有独立判断和依据，能结合公司实际体现进取心。', pass: '有一定了解但浅表，或理解不够到位。', warning: '完全不了解行业和公司，或回答空泛、与岗位无关。' },
  ] },
]
export function commonGroupsForRound(round: number): CommonQuestionGroup[] { return COMMON_QUESTION_GROUPS.filter(group => group.id !== 'boss' || round >= 2) }
export function isCommonQuestion(question: string): boolean { const normalized=question.replace(/\s+/g,' ').trim(); return COMMON_QUESTION_GROUPS.some(group => group.dimensions.some(dimension => dimension.questions.some(item => item.replace(/\s+/g,' ').trim() === normalized))) }
