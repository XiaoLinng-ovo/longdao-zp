import test from 'node:test'
import assert from 'node:assert/strict'
import { orderResumePdfPage, resumeBodyCharacterCount, resumePdfImageRegions, resumePdfPageNeedsOcr, resumeTextHasEncodingDamage, isResumeNameWithAppendedFields } from '../src/index.js'
import { assessSemanticResume, anonymizeText, buildJobAnalysisContext, buildJobRequirements, buildResumeAnalysisPrompt, buildRuleBasedReport, cleanResumeFieldValues, cleanResumeText, extractResume, inferRequirementKind, minYearsFromLabel, parseLlmResumeSuggestion, parseResume, scoreResumeMatch } from '../src/index.js'

const pdfWatermark = '56ac1a7c4269df3f1HFy3N25FlNTxo66UPOcWOejn_TYPxJi'

test('detects sustained font decoding damage without rejecting icon headings or other languages', () => {
  for (const text of ['Python ' + '\uFFFD'.repeat(30), 'John Smith\n' + '\uE001'.repeat(30), 'Python (cid:12) (cid:23) (cid:34)']) {
    assert.equal(resumeTextHasEncodingDamage(text), true)
    assert.throws(() => buildRuleBasedReport({ resume: { fileName: 'damaged.pdf', text }, job: { title: 'Engineer', requirements: [] } }), /乱码/u)
  }
  for (const text of ['\uE001 教育背景\n江城大学 计算机科学 本科 2022-2026\n专业技能 Python FastAPI',
    'John Smith\nSoftware Engineer\nBuilt Python data pipelines', '山田太郎\nソフトウェアエンジニア', 'Иван Иванов\nРазработка программ']) {
    assert.equal(resumeTextHasEncodingDamage(text), false)
  }
})

test('checks raster body coverage instead of trusting a readable header', () => {
  const header = { str: 'Sample Candidate Software Engineer Python FastAPI', x: 30, y: 40, width: 420, height: 12 }
  const page = { text: header.str, items: [header], width: 600, height: 800, images: [{ x: 20, y: 90, width: 550, height: 680 }] }
  assert.equal(resumePdfPageNeedsOcr(page), true)
  assert.equal(resumePdfPageNeedsOcr({ ...page, images: [{ x: 500, y: 20, width: 60, height: 80 }] }), false)
  assert.equal(resumePdfPageNeedsOcr({ ...page, images: [] }), false)
  assert.equal(resumePdfPageNeedsOcr({ ...page, text: '', items: [], images: [] }), false)
  const body = Array.from({ length: 12 }, (_, index) => ({ ...header, str: `Work experience details and project evidence ${index}`, y: 120 + index * 40 }))
  assert.equal(resumePdfPageNeedsOcr({ ...page, text: body.map((item) => item.str).join('\n'), items: body }), false)
  assert.equal(resumePdfPageNeedsOcr({ ...page, text: 'Python ' + '\uFFFD'.repeat(20), images: [] }), true)
})

test('tracks PDF image transformations, restore, repeated images and rotated viewports', () => {
  const ops = { save: 1, restore: 2, transform: 3, paintImageXObject: 4, paintInlineImageXObject: 5, paintImageXObjectRepeat: 6, paintInlineImageXObjectGroup: 7 }
  const operators = { fnArray: [1, 3, 4, 2, 6, 7], argsArray: [[], [500, 0, 0, 700, 20, 30], ['image'], [], ['image', 60, 80, new Float32Array([500, 700])], ['image', [{ transform: [30, 0, 0, 40, 10, 20] }]]] }
  assert.deepEqual(resumePdfImageRegions(operators, ops, [1, 0, 0, -1, 0, 800]), [
    { x: 20, y: 70, width: 500, height: 700 }, { x: 500, y: 20, width: 60, height: 80 }, { x: 10, y: 740, width: 30, height: 40 },
  ])
  assert.deepEqual(resumePdfImageRegions({ fnArray: [3, 5], argsArray: [[500, 0, 0, 700, 20, 30], []] }, ops, [0, 1, 1, 0, 0, 0]), [
    { x: 30, y: 20, width: 700, height: 500 },
  ])
})

test('tracks raster content nested inside PDF forms and monochrome image masks', () => {
  const ops = { save: 1, restore: 2, transform: 3, paintImageXObject: 4, paintInlineImageXObject: 5, paintImageXObjectRepeat: 6, paintInlineImageXObjectGroup: 7,
    paintFormXObjectBegin: 8, paintFormXObjectEnd: 9, paintImageMaskXObject: 10, paintImageMaskXObjectRepeat: 11, paintImageMaskXObjectGroup: 12 }
  const operators = { fnArray: [8, 10, 9, 11, 12], argsArray: [
    [[500, 0, 0, 700, 20, 30]], ['mask'], [], ['mask', 500, 0, 0, 700, new Float32Array([20, 30])],
    [[{ transform: [500, 0, 0, 700, 20, 30] }]],
  ] }
  assert.deepEqual(resumePdfImageRegions(operators, ops, [1, 0, 0, -1, 0, 800]), Array.from({ length: 3 }, () => ({ x: 20, y: 70, width: 500, height: 700 })))
})

test('requires real body text rather than watermarks, page numbers or isolated glyphs', () => {
  for (const text of [pdfWatermark, `${pdfWatermark}\nh\n${pdfWatermark}\ni`, '-- 1 of 2 --\n \t']) {
    assert.equal(resumeBodyCharacterCount(text), 0)
    assert.throws(() => buildRuleBasedReport({ resume: { text, fileName: 'scan.pdf' }, job: { title: '工程师', requirements: [] } }), /有效简历正文/u)
  }
  assert.ok(resumeBodyCharacterCount(`${pdfWatermark}\n张三\n使用 Python 实现数据分析。`) > 10)
})

test('recognizes combined internship headings and stops at campus honours', () => {
  const extraction = extractResume(parseResume({ fileName: 'scan.pdf', text: `王小明
教育背景
江城大学 机械工程 本科 2022.09-2026.06
实习工作经历
星河科技有限公司 2025.06-2025.08
实习生：使用 Python 处理实验数据。
校园经历与荣誉
学生会成员，组织校园活动。
专业技能
Python、MATLAB` }))
  assert.equal(extraction.candidate.fullName, '王小明')
  assert.equal(extraction.education.length, 1)
  assert.equal(extraction.experience.length, 1)
  assert.match(extraction.experience[0]!.evidence, /实验数据/u)
  assert.doesNotMatch(extraction.experience[0]!.evidence, /学生会/u)
})

test('groups OCR-separated employer, role and location/date lines and based-on project names', () => {
  const extraction = extractResume(parseResume({ fileName: 'scan.pdf', text: `王小明
专业技能
编程与数据：C++、Python、MATLAB
自动化与机器人视觉：PLC/TIA Portal、ABB RobotStudio
工程软件：AutoCAD、SolidWorks
语言与证书：IELTS7.0；计算机等级证书
AI工具：Codex、Claude、Google Gemini
实习工作经历
星河机器人科技有限公司
机器视觉工程师
中国温州2024.07-2024.09
●基于相机SDK进行二次开发。
云图科技有限公司
自动化机械工程师
中国杭州|2022.12-2023.04
●完成机械臂和PLC设备调试。
项目经历
基于机器视觉的零件识别与分拣系统
硕士毕业设计
●设计图像采集与分类流程。
基于3D视觉的食品自动化加工系统
示例食品有限公司
●完成视觉系统与机械臂标定。
制药厂区系统集成项目
示例制药有限公司
●编写PLC核心控制逻辑。` }))
  assert.equal(extraction.experience.length, 5)
  assert.deepEqual(extraction.experience.slice(0, 2).map((item) => [item.employer, item.title, item.startDate]), [
    ['星河机器人科技有限公司', '机器视觉工程师', '2024.07'], ['云图科技有限公司', '自动化机械工程师', '2022.12'],
  ])
  assert.match(extraction.experience[2]!.title!, /零件识别/u)
  assert.match(extraction.experience[3]!.title!, /食品自动化/u)
  const skills = extraction.skills.map((item) => item.canonical.toLowerCase())
  for (const skill of ['python', 'matlab', 'solidworks', 'claude', 'google gemini']) assert.ok(skills.includes(skill), skill)
  assert.ok(!skills.some((item) => /证书|编程与数据|工程软件/u.test(item)))
  assert.deepEqual(extraction.languages, ['IELTS7.0'])
  assert.deepEqual(extraction.certifications, ['计算机等级证书'])
})

test('reads sustained sidebar columns independently after a full-width header', () => {
  const item = (str: string, x: number, y: number, width = 120) => ({ str, x, y, width, height: 10 })
  const items = [item('胡 俊 杰', 30, 30), item('联系方式：example@example.test', 30, 60, 350),
    item('教 育 背 景', 30, 100, 60), item('项 目 经 历', 195, 100, 60)]
  for (let i = 0; i < 12; i++) {
    items.push(item(`左栏学校和技能${i}`, 30, 125 + i * 15), item(`右栏项目独立证据${i}`, 195, 125 + i * 15, 300))
  }
  items.push(item('全宽页脚完整内容', 30, 330, 450))
  const result = orderResumePdfPage(items.reverse())
  assert.ok(result.indexOf('联系方式') < result.indexOf('教 育 背 景'))
  assert.ok(result.indexOf('左栏学校和技能11') < result.indexOf('项 目 经 历'))
  assert.ok(result.indexOf('右栏项目独立证据11') < result.indexOf('全宽页脚'))
  assert.doesNotMatch(result, /左栏[^\n]*右栏/u)
})

test('does not turn ordinary date-aligned rows into columns or mutate source geometry', () => {
  const items = Array.from({ length: 12 }, (_, index) => [
    { str: `公司名称及职责${index}`, x: 30, y: 100 + index * 20, width: 200, height: 10 },
    { str: '2024.09–2026.01', x: 400, y: 100 + index * 20, width: 100, height: 10 },
  ]).flat()
  const original = structuredClone(items)
  const result = orderResumePdfPage(items)
  assert.match(result, /^公司名称及职责0 2024.09–2026.01\n公司名称及职责1/u)
  assert.deepEqual(items, original)
})

test('reads columns with offset headings and font-icon prefixes independently', () => {
  const item = (str: string, x: number, y: number, width = 120) => ({ str, x, y, width, height: 10 })
  const items = [item('王小明', 30, 30), item('\uE001 教 育 背 景', 30, 100, 70), item('项目经历', 220, 145, 70)]
  for (let i = 0; i < 12; i++) {
    items.push(item(`左栏学校和技能${i}`, 30, 125 + i * 20), item(`右栏项目独立证据${i}`, 220, 170 + i * 20, 300))
  }
  const result = orderResumePdfPage(items.reverse())
  assert.ok(result.indexOf('左栏学校和技能11') < result.indexOf('项目经历'))
  assert.doesNotMatch(result, /左栏[^\n]*右栏/u)
})

test('extracts spaced header names, sidebar education and wrapped skills without category tags', () => {
  const text = `胡 俊 杰
邮箱：test@example.test
教 育 背 景
图像分析和机器学习
硕士｜乌普萨拉大学（QS 87）
2024.09–2026.11｜瑞典
计算机科学与技术
学士｜浙大城市学院
2020.09–2024.07｜杭州
核 心 技 能
Agent 系统
LangGraph、状态机编排、多轮对
话、Function Calling、MCP、
HITL、Prompt Engineering、
Harness
后端与数据
Java, Python, C++, FastAPI、Spring
Boot、Flask、PostgreSQL、
MySQL、Redis、MyBatis
荣 誉 与 成 果
优秀毕业生
校 园 经 历
班长 2020.09–2024.07
岗 位 关 键 词
全栈开发
项 目 经 历
对话式音乐系统 2026.04–2026.07
项目描述：实现音乐检索。
宠物问答系统 2025.02–2025.06
项目描述：实现知识问答。
实 习 经 历
星河科技有限公司 算法工程师 2025.09–2026.01
负责模型评测。
云图科技有限公司 开发工程师 2023.07–2023.10
负责接口开发。`
  const parsed = parseResume({ fileName: 'sidebar.pdf', text })
  const extraction = extractResume(parsed)
  assert.equal(extraction.candidate.fullName, '胡俊杰')
  assert.deepEqual(extraction.education.map((r) => [r.institution, r.degree, r.fieldOfStudy, r.startDate, r.endDate]), [
    ['乌普萨拉大学', '硕士', '图像分析和机器学习', '2024.09', '2026.11'],
    ['浙大城市学院', '学士', '计算机科学与技术', '2020.09', '2024.07'],
  ])
  assert.equal(extraction.experience.length, 4)
  const skills = extraction.skills.map((s) => s.value)
  for (const skill of ['Spring Boot', '多轮对话', 'LangGraph', 'MCP', 'Harness', 'PostgreSQL']) assert.ok(skills.includes(skill), skill)
  for (const noise of ['Agent 系统', '后端与数据', 'Spring', 'Boot', '优秀毕业生', '全栈开发']) assert.ok(!skills.includes(noise), noise)
  const anonymous = anonymizeText(parsed.normalizedText, { name: extraction.candidate.fullName!, replaceNames: true })
  assert.match(anonymous.text, /^\[NAME\]/u)
  assert.doesNotMatch(anonymous.text, /胡|test@example/u)
  const name = anonymous.replacements.find((r) => r.kind === 'name')!
  assert.equal(parsed.normalizedText.slice(name.start, name.end), '胡 俊 杰')
})

test('preserves multiword employer names when separated from the title by a fullwidth pipe', () => {
  const extraction = extractResume(parseResume({ fileName: 'internship.pdf', text: '实习经历\nExample AB｜图像算法工程师 2025.09–2026.01\n负责模型评测。' }))
  assert.equal(extraction.experience[0]!.employer, 'Example AB')
  assert.equal(extraction.experience[0]!.title, '图像算法工程师')
})

test('restores visible PDF order including headings drawn after body text', () => {
  const item = (str: string, x: number, y: number, width = 80) => ({ str, x, y, width, height: 12 })
  const result = orderResumePdfPage([
    item('Python, FastAPI', 50, 200), item('项目描述：开发问答系统。', 50, 300),
    item('李明', 120, 50), item('姓 名：', 50, 50),
    item('相 关 技 能', 50, 170), item('项 目 经 历', 50, 260),
  ])
  assert.ok(result.indexOf('姓 名：') < result.indexOf('李明'))
  assert.ok(result.indexOf('相 关 技 能') < result.indexOf('Python'))
  assert.ok(result.indexOf('项 目 经 历') < result.indexOf('项目描述'))
})

test('extracts spaced PDF identity labels and keeps project prose out of skills', () => {
  const text = `PERSONAL RESUME
基 本 信 息
姓 名：李明 学 历：硕 士
性 别：男 年 龄：26 岁
电子邮箱：liming@example.test 联系方式：13800000001
教 育 背 景
2023.09-2026.06 江城大学 计算机科学 / 硕士
研究方向：推荐系统
主修课程：机器学习、Python
相 关 技 能
⚫ LangChain/LangGraph（掌握）：熟悉工具调用、记忆管理，
可结合外部数据源构建问答系统。
⚫ Python（掌握）：独立开发接口。
⚫ 未掌握 Kubernetes：尚无相关经验。
项 目 经 历
企业知识库系统 | 2025.06-2026.06
项目描述：开发文档检索系统。
技术栈：Python, FastAPI, Milvus,
MCP
核心职责：实现文档导入、检索与引用展示。
主要工作：
相 关 技 能
⚫ 设计双图协同训练框架：处理会话推荐的稀疏问题。
⚫ 构建对比学习流程：完成模型评估。
项目亮点：在验证集上比较准确率。`
  const extraction = extractResume(parseResume({ fileName: 'template.pdf', text }))
  assert.equal(extraction.candidate.fullName, '李明')
  assert.equal(extraction.candidate.phone, '13800000001')
  assert.equal(extraction.candidate.email, 'liming@example.test')
  assert.equal(extraction.education.length, 1)
  assert.equal(extraction.education[0]?.institution, '江城大学')
  assert.equal(extraction.education[0]?.fieldOfStudy, '计算机科学')
  assert.match(extraction.education[0]!.evidence, /主修课程/u)
  assert.deepEqual(extraction.skills.map((skill) => skill.value), ['LangChain/LangGraph', 'Python', 'FastAPI', 'Milvus', 'MCP'])
  assert.equal(extraction.experience.length, 1)
  assert.equal(extraction.experience[0]?.title, '企业知识库系统')
  assert.match(extraction.experience[0]!.evidence, /构建对比学习流程/u)
  assert.doesNotMatch(extraction.skills.map((skill) => skill.value).join(' '), /Kubernetes|独立开发|核心职责|设计双图/u)
})

test('filters repeated PDF watermarks before merging text without stripping real identifiers', () => {
  const item = (str: string, x: number, y: number) => ({ str, x, y, width: 100, height: 12 })
  const result = orderResumePdfPage([
    item(pdfWatermark, 50, 100), item(pdfWatermark, 100, 200),
    item('h', -4, 10), item('Python', 50, 100), item('研究方向：推荐系统', 50, 200),
    item('C', 50, 250), item('i', 50, 280), item('a1b2c3d4e5f6ProjectUniqueHash000001', 50, 300),
  ])
  assert.doesNotMatch(result, new RegExp(pdfWatermark))
  assert.doesNotMatch(result, /^h$/mu)
  assert.match(result, /Python\n研究方向/u)
  assert.match(result, /C\ni/u)
  assert.match(result, /ProjectUniqueHash/u)
})

test('keeps project highlights together and recognizes dated research project titles', () => {
  const extraction = extractResume(parseResume({ fileName: 'projects.pdf', text: `项目经历
企业知识库系统 2025.01-2025.06
项目描述：搭建检索服务。
项目亮点
配置驱动：业务流程由 YAML 声明。
健壮性设计：校验模型输出并处理异常。
基于图神经网络的会话推荐算法研究 2023.9-2026.6
项目描述：实现推荐模型并比较基线。
技术栈：Python, PyTorch
主要工作：比较准确率。
项目亮点：报告实验结果。` }))
  assert.equal(extraction.experience.length, 2)
  assert.equal(extraction.experience[1]?.title, '基于图神经网络的会话推荐算法研究')
  assert.match(extraction.experience[0]!.description!, /配置驱动/u)
  assert.match(extraction.experience[0]!.description!, /健壮性设计/u)
  assert.match(extraction.experience[1]!.description!, /比较准确率/u)
})

test('groups unbulleted skill labels and wrapped school details without creating prose tags', () => {
  const extraction = extractResume(parseResume({ fileName: 'wrapped.pdf', text: `姓名：李明
教育经历
江城大学 2023.09-2026.06
应用统计学 硕士 全日制
主修课程：多元统计分析、
机器学习
荣誉奖励：统计竞赛二
等奖
海城大学 2019.09-2023.07
统计学 本科 全日制
荣誉奖励：全国大学生数学竞赛奖
相关技能
RAG（掌握）：熟悉检索流程，擅长通过
Prompt 增强与检索优化提升生成准确度，缓解大模型幻觉。
Python（熟悉）：为后端服务编写所
需代码。
框架与编排：LangGraph、FastAPI；状态图、任务规划
项目经历
售后客服引擎 2025.09-2026.01
项目描述：实现客服接口。
流程引擎：业务能力由 YAML 声明。
状态管理：保存会话状态。
技术栈：Python · FastAPI ·
LangGraph
基于嵌入式平台的轻量化交通标志检测算法| 2023.09-2026.06
项目描述：比较检测模型。` }))
  assert.equal(extraction.education.length, 2)
  assert.equal(extraction.education[0]?.degree, '硕士')
  assert.equal(extraction.education[0]?.fieldOfStudy, '应用统计学')
  assert.match(extraction.education[0]!.evidence, /荣誉奖励/u)
  assert.deepEqual(extraction.skills.map((skill) => skill.value), ['RAG', 'Python', 'LangGraph', 'FastAPI'])
  assert.equal(extraction.experience.length, 2)
  assert.match(extraction.experience[0]!.description!, /流程引擎/u)
  assert.equal(extraction.experience[1]?.title, '基于嵌入式平台的轻量化交通标志检测算法')
})

test('separates personal fields sharing the name row, including spaced and flattened labels', () => {
  for (const field of ['政治面貌', '政治面目', '民族', '籍贯', '户籍所在地', '婚姻状况', '工作年限', '最高学历', '毕业院校', '联系电话']) {
    for (const separator of ['', ' ', ' ｜ ', '，']) {
      const text = `个人简历\n基本信息\n姓 名：张 惠 亭${separator}${[...field].join(' ')}：测试\n专业技能\nPython`
      assert.equal(extractResume(parseResume({ fileName: 'name.pdf', text })).candidate.fullName, '张惠亭', text)
    }
  }
  for (const name of ['张惠亭', '张 惠 亭', '欧阳娜娜', '阿卜杜拉·阿不都热依木', 'Mary Jane Watson', 'Jean-Luc Picard', 'O’Connor', 'Alice']) {
    const text = `姓名：${name} 政治面貌：群众\n技能\nPython`
    assert.equal(extractResume(parseResume({ fileName: 'name.pdf', text })).candidate.fullName, name.replace(/(?<=\p{Script=Han}) +(?=\p{Script=Han})/gu, ''))
  }
  for (const row of ['张惠亭政治面貌：共青团员', '张 惠 亭 ｜ 民族：汉', 'Mary Jane Watson 籍贯：杭州']) {
    const name = row.startsWith('Mary') ? 'Mary Jane Watson' : '张惠亭'
    assert.equal(extractResume(parseResume({ fileName: 'name.pdf', text: `${row}\n专业技能\nPython` })).candidate.fullName, name)
  }
  for (const row of ['姓名：政治面貌：群众', '姓名：待解析候选人', '姓名：张惠亭 未知字段：内容']) {
    assert.equal(extractResume(parseResume({ fileName: 'name.pdf', text: `${row}\n专业技能\nPython` })).candidate.fullName, undefined)
  }
})

test('repairs only an appended personal field whose name prefix agrees with the source', () => {
  assert.equal(isResumeNameWithAppendedFields('张惠亭 政治面貌：共青团员', '张惠亭'), true)
  assert.equal(isResumeNameWithAppendedFields('张 惠 亭｜民 族：汉', '张惠亭'), true)
  assert.equal(isResumeNameWithAppendedFields('Mary Jane Watson 籍贯：杭州', 'Mary Jane Watson'), true)
  for (const name of ['张惠亭', '张惠亭（人工确认）', '王思远 政治面貌：群众', '张惠亭未知字段：内容']) {
    assert.equal(isResumeNameWithAppendedFields(name, '张惠亭'), false, name)
  }
})

test('extracts names joined to document titles without guessing identity from filenames', () => {
  for (const title of ['林测试个人简历', '林测试的个人简历', '林 测 试个人简历']) {
    const result = extractResume(parseResume({ fileName: 'unrelated-name.pdf', text: `${title}\n邮箱：sample@example.test\n教育背景\n示例大学 本科` }))
    assert.equal(result.candidate.fullName, '林测试', title)
  }
  assert.equal(extractResume(parseResume({ fileName: '林测试.pdf', text: '个人简历\n教育背景\n示例大学 本科' })).candidate.fullName, undefined)
})

test('normalizes Unicode compatibility glyphs in extracted names', () => {
  assert.equal(extractResume(parseResume({ fileName: 'name.pdf', text: '姓名：林北⾠\n专业技能\nPython' })).candidate.fullName, '林北辰')
})

test('does not mistake employment dates, identifiers or invalid labeled fields for telephone numbers', () => {
  for (const date of ['2024.06 - 2024.09', '2022-2025', '2022-09 - 2025-06', '2022/09 至 2025/06', '2022年09月到2025年06月']) {
    const text = `林测试个人简历\n联系方式：sample@example.test\n工作经历\n示例公司 - 工程师（${date}）\n处理任务10000000条。`
    assert.equal(extractResume(parseResume({ fileName: 'sample.pdf', text })).candidate.phone, undefined, date)
    assert.equal(extractResume(parseResume({ fileName: 'sample.pdf', text: `${text}\n手机号码：138-0000-0001` })).candidate.phone, '138-0000-0001', date)
  }
  for (const phone of ['13800000001', '+86 138 0000 0001', '0571-88888888', '+1 (415) 555-0123']) {
    assert.equal(extractResume(parseResume({ fileName: 'sample.txt', text: `林测试\n电话：${phone}\n技能\nGo` })).candidate.phone, phone)
  }
  assert.equal(extractResume(parseResume({ fileName: 'sample.txt', text: '林测试\n电话：88888888\n技能\nGo' })).candidate.phone, '88888888')
})

test('parses spaced Chinese dates and keeps metrics, awards, and wrapped project tokens out of structured fields', () => {
  const text = `个人简历
基本信息
姓 名：徐晴光
电 话：13362181699
邮 箱：1074726581@qq.com
教育背景
2017 年 9 月-2020 年 6 月 杭州科技职业技术学院（专科） 建筑工程技术
2020 年 9 月-2022 年 6 月 宁波财经学院（本科） 计算机科学与技术
参与竞赛：
2019 年全国大学生数学建模竞赛(省赛三等奖)
实习经历
2022 年 1 月-2022 年 5 月 台州世通网络技术有限公司 网络管理员
负责网络接入调试，推理吞吐量达 1500-2000 样本/s。
项目经历
2024 年 10 月-2025 年 4 月 项目名称：多模态预测框架
项目背景：完成模型设计。
2026 年 8 月-2026 年 10 月 AI 跑团物语 | 个人项目 | Python · GLM-
4
独立设计并开发桌面游戏。`
  const extraction = extractResume(parseResume({ fileName: '【AI应用工程师】徐晴光 26年应届生.pdf', mimeType: 'application/pdf', text }))

  assert.equal(extraction.candidate.fullName, '徐晴光')
  assert.equal(extraction.candidate.phone, '13362181699')
  assert.deepEqual(extraction.education.map(({ institution, degree, startDate, endDate }) => ({ institution, degree, startDate, endDate })), [
    { institution: '杭州科技职业技术学院', degree: '专科', startDate: '2017.09', endDate: '2020.06' },
    { institution: '宁波财经学院', degree: '本科', startDate: '2020.09', endDate: '2022.06' },
  ])
  assert.deepEqual(extraction.experience.map(({ employer, title, startDate, endDate }) => ({ employer, title, startDate, endDate })), [
    { employer: '台州世通网络技术有限公司', title: '网络管理员', startDate: '2022.01', endDate: '2022.05' },
    { employer: undefined, title: '多模态预测框架', startDate: '2024.10', endDate: '2025.04' },
    { employer: undefined, title: 'AI 跑团物语', startDate: '2026.08', endDate: '2026.10' },
  ])
  assert.ok((extraction.profile.totalExperienceYears ?? 0) < 10)
  assert.match(extraction.experience[2]!.evidence, /GLM-4/u)
})

test('filters repeated diagonal PDF watermarks and their clipped fragments, preserving real text', () => {
  const item = (str: string, y: number, rotation = 0, height = 12) => ({ str, x: 30, y, rotation, height, width: 180 })
  const text = orderResumePdfPage([
    item('林测试个人简历', 30), item('工作经历', 70), item('示例公司 工程师', 100), item('负责后端开发。', 125),
    ...[60, 100, 140].map((y) => item('平台简历水印', y, Math.PI / 4, 30)),
    item('简历水印', 90, Math.PI / 4, 30), item('印', 120, Math.PI / 4, 30),
    item('平台简历水印', 180), item('独立旋转内容', 200, Math.PI / 4, 30),
  ])
  assert.equal(text, '林测试个人简历\n工作经历\n示例公司 工程师\n负责后端开发。\n平台简历水印\n独立旋转内容')
})

test('keeps programming skills separate from inline languages in combined skills/certificates blocks', () => {
  const parsed = parseResume({ fileName: 'sample.pdf', text: `林测试个人简历
技能证书/其他
语言：英语（CET4）
编程语言：熟练Go语言，熟悉并发模型。
后端开发：熟悉gRPC、Gin框架。
容器化与编排：使用Docker和Kubernetes。
证书：软件设计师
个人荣誉
示例比赛一等奖` })
  const extraction = extractResume(parsed)
  assert.equal(extraction.candidate.fullName, '林测试')
  assert.deepEqual(extraction.languages, ['英语（CET4）'])
  assert.deepEqual(extraction.certifications, ['软件设计师'])
  assert.ok(extraction.skills.some((skill) => skill.evidence.some((value) => value.includes('Go'))))
  assert.ok(extraction.skills.some((skill) => skill.evidence.some((value) => value.includes('Docker'))))
  assert.equal(extraction.skills.some((skill) => /CET4|一等奖/.test(skill.evidence.join(' '))), false)
})

test('parses hyphen-separated education and parenthesized employment dates without leftover delimiters', () => {
  const extraction = extractResume(parseResume({ fileName: 'sample.pdf', text: `林测试个人简历
教育背景
示例大学 - 硕士 - 软件工程专业（2022.09-2025.06）
工作经历
示例科技有限公司 - 全栈开发实习生 -（2024.06 - 2024.09）
负责接口开发。
第二示例科技有限公司 - 研发工程师 - (2025.06 - 2026.07)
负责后端服务。` }))
  assert.equal(extraction.education[0]?.institution, '示例大学')
  assert.equal(extraction.education[0]?.degree, '硕士')
  assert.equal(extraction.education[0]?.fieldOfStudy, '软件工程专业')
  assert.equal(extraction.education[0]?.startDate, '2022.09')
  assert.equal(extraction.education[0]?.endDate, '2025.06')
  assert.equal(extraction.experience.length, 2)
  assert.deepEqual(extraction.experience.map(({ title, startDate, endDate }) => ({ title, startDate, endDate })), [
    { title: '全栈开发实习生', startDate: '2024.06', endDate: '2024.09' },
    { title: '研发工程师', startDate: '2025.06', endDate: '2026.07' },
  ])
  assert.match(extraction.experience[0]!.evidence, /（2024.06 - 2024.09）/u)
})

test('keeps consecutive projects distinct when a bare title precedes a role and date row', () => {
  const extraction = extractResume(parseResume({ fileName: 'sample.pdf', text: `项目经验
Cloud Agent - 多云服务器统一管理代理服务
独立负责 | Go 后端开发 | 2025.11 - 2026.03
独立设计并实现多云服务器代理。
完成容器化部署。
智能技术支持客服开发
独立负责 | Go 后端开发 | 2026.03 - 2026.06
项目简介：结合知识库辅助排障。
技术栈：Go、RAG、Milvus
• 工具集成：接入日志查询。
• RAG 知识库：实现检索。` }))
  assert.equal(extraction.experience.length, 2)
  assert.equal(extraction.experience[0]?.title, 'Cloud Agent - 多云服务器统一管理代理服务')
  assert.equal(extraction.experience[0]?.startDate, '2025.11')
  assert.equal(extraction.experience[0]?.endDate, '2026.03')
  assert.equal(extraction.experience[1]?.title, '智能技术支持客服开发')
  assert.equal(extraction.experience[1]?.startDate, '2026.03')
  assert.equal(extraction.experience[1]?.endDate, '2026.06')
  assert.doesNotMatch(extraction.experience[0]!.evidence, /知识库/u)
  assert.match(extraction.experience[1]!.description!, /日志查询/u)
})

test('does not invent names from resume titles or contact labels', () => {
  assert.equal(extractResume(parseResume({ fileName: 'skills-only.txt', text: '技能\nPython\nMicrosoft Office' })).candidate.fullName, undefined)
  for (const title of ['PERSONAL RESUME', '个人简历', '现居', '应用统计学']) {
    const extraction = extractResume(parseResume({ fileName: 'r.pdf', text: `${title}\n技能\nPython` }))
    assert.equal(extraction.candidate.fullName, undefined, title)
  }
  const extraction = extractResume(parseResume({ fileName: 'r.pdf', text: 'JOHN SMITH\n技能\nPython' }))
  assert.equal(extraction.candidate.fullName, 'JOHN SMITH')
})

test('filters repeated PDF watermark blocks before extraction while preserving the original source', () => {
  const text = `技能\n${pdfWatermark}\ni\n-- 1 of 2 --\nPython：熟练：5 年以上\nC/C++、R、Go、AI、Microsoft Office\n语言能力\n英语：读写能力-精通、6 级-580 分、雅思-6.5-2023.03 获得\n${pdfWatermark}\ni\ni\n${pdfWatermark}\n-- 2 of 2 --`
  const parsed = parseResume({ fileName: 'watermarked.pdf', text })
  const extracted = extractResume(parsed)
  assert.equal(parsed.originalText, text)
  assert.equal(parsed.normalizedText.includes(pdfWatermark), false)
  assert.equal(parsed.normalizedText.includes('-- 1 of 2 --'), false)
  assert.equal(extracted.skills.some(skill => skill.value === 'i'), false)
  assert.deepEqual(extracted.skills.map(skill => skill.value), ['Python', 'C/C++', 'R', 'Go', 'AI', 'Microsoft Office'])
  assert.match(extracted.skills[0]!.evidence.join(' '), /5 年以上/u)
  assert.deepEqual(extracted.languages, ['英语：读写能力-精通', '6 级-580 分', '雅思-6.5-2023.03 获得'])
  assert.equal(cleanResumeText(parsed.normalizedText), parsed.normalizedText)
})

test('does not strip labelled hashes, links, standalone skills or a one-off identifier', () => {
  const values = ['C', 'R', 'Go', 'AI', 'i', pdfWatermark, `项目标识：${pdfWatermark}`, 'SHA256: 56ac1a7c4269df3f01234567890123456789abcdef', `https://example.com/${pdfWatermark}`]
  const text = values.join('\n')
  assert.equal(cleanResumeText(text), text)
  assert.equal(cleanResumeFieldValues(values, text), values)
  assert.equal(cleanResumeText('i\n-- 1 of 2 --\nR'), 'i\nR')
})

test('cleans legacy field noise only with repeated watermark evidence', () => {
  const fields = [pdfWatermark, 'i', '-- 1 of 2 --', 'Python', 'C/C++', 'R']
  assert.deepEqual(cleanResumeFieldValues(fields, `${pdfWatermark}\n${pdfWatermark}`), ['Python', 'C/C++', 'R'])
  assert.deepEqual(cleanResumeFieldValues([pdfWatermark, pdfWatermark, 'i', '雅思 6.5']), ['雅思 6.5'])
  assert.deepEqual(cleanResumeFieldValues(['R', '-- 1 of 2 --', 'C']), ['R', 'C'])
})

const resume = `张三
zhangsan@example.com
138-1234-5678

工作经历
2021-2024 后端工程师
使用 TypeScript、Node.js 和 PostgreSQL

技能
TypeScript, Node.js, PostgreSQL

教育经历
本科 计算机科学`

const flattenedDocxResume = `姓名：张伟性别：男出生年月：1992.05电话：138-0000-0001 | 邮箱：zhangwei.test@example.com | 现居地：上海求职意向：高级 Java 后端工程师 / 后端架构师期望薪资：30-40K到岗时间：一个月内

教育背景2010.09-2014.06 江城大学 计算机科学与技术 本科

工作经历2020.03-至今 星河科技有限公司 高级 Java 工程师

负责订单中心微服务重构，QPS 从 2k 提升至 8k，P99 延迟降低 40%。
主导 Spring Cloud Alibaba 技术落地，使用 Nacos、Sentinel、Seata。
搭建 Jenkins + Docker + Kubernetes CI/CD 流程。

2016.07-2020.02 云图信息技术有限公司 Java 工程师
参与 CRM 系统开发，技术栈为 Spring MVC、MyBatis、MySQL。
优化慢 SQL 与索引，核心接口响应时间降低 60%。

2014.07-2016.06 蓝海网络科技有限公司 初级 Java 工程师
开发报表导出、权限管理、日志监控模块。

项目经历XX 电商订单中台：负责订单创建、支付回调、库存锁定等核心链路，支持日均 50 万订单。

技能标签Java、Spring Boot、Spring Cloud、MySQL、Redis、Kafka、Elasticsearch、Docker、Kubernetes、Linux、Git

自我评价具备高并发系统设计与微服务治理经验，熟悉后端性能优化和团队协作。
`;
const job = {
  title: '后端工程师',
  requirements: [
    { id: 'skill-ts', label: 'TypeScript', kind: 'skill' as const, keywords: ['typescript'], hard: true },
    { id: 'skill-pg', label: 'PostgreSQL', kind: 'skill' as const, keywords: ['postgresql'] },
    { id: 'exp', label: '3 年经验', kind: 'experience' as const, minYears: 3, hard: true },
  ],
}

test('parses and anonymizes resume text', () => {
  const parsed = parseResume({ fileName: 'resume.txt', mimeType: 'text/plain', text: resume, source: 'test' })
  assert.equal(parsed.format, 'txt')
  assert.ok(parsed.sections.length > 0)
  const anonymized = anonymizeText(parsed.normalizedText, { name: '张三', replaceNames: true })
  assert.equal(anonymized.text.includes('zhangsan@example.com'), false)
  assert.equal(anonymized.text.includes('[EMAIL]'), true)
  assert.equal(anonymized.text.includes('[NAME]'), true)
})

test('builds an advisory report without changing application state', () => {
  const report = buildRuleBasedReport({
    resume: { fileName: 'resume.txt', mimeType: 'text/plain', text: resume, source: 'test' },
    job,
    subject: { applicationId: 'app-1', candidateId: 'candidate-1', jobId: 'job-1' },
  })
  assert.ok(report.assessment.score !== null && report.assessment.score > 0)
  assert.equal(report.safety.advisoryOnly, true)
  assert.equal(report.safety.applicationStatusMutation, 'none')
  assert.equal(report.safety.autoReject, false)
  assert.equal(report.humanReview.status, 'pending')
})

test('builds a privacy-aware LLM prompt', () => {
  const prompt = buildResumeAnalysisPrompt({ anonymizedResumeText: '[NAME] [EMAIL]', job })
  assert.equal(prompt.includes('不得自动淘汰'), true)
  assert.equal(prompt.includes('[EMAIL]'), true)
})

test('classifies Chinese resume section headings and extracts content', () => {
  const parsed = parseResume({ fileName: 'resume.txt', mimeType: 'text/plain', text: resume, source: 'test' })
  const kinds = parsed.sections.map((section) => section.kind)
  assert.ok(kinds.includes('experience'), '工作经历 should map to experience')
  assert.ok(kinds.includes('education'), '教育经历 should map to education')
  assert.ok(kinds.includes('skills'), '技能 should map to skills')
  const extraction = extractResume(parsed)
  assert.ok(extraction.experience.length > 0)
  assert.ok(extraction.education.length > 0)
  assert.ok(extraction.skills.length > 0)
  assert.equal(extraction.skills.some((skill) => skill.canonical === 'typescript'), true)
})

test('parses flattened DOCX paragraphs, inline headings, and labeled contact fields', () => {
  const parsed = parseResume({
    fileName: '测试简历2-张伟.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    text: flattenedDocxResume,
    source: 'test',
  })
  const extraction = extractResume(parsed)

  assert.equal(extraction.candidate.fullName, '张伟')
  assert.equal(extraction.candidate.email, 'zhangwei.test@example.com')
  assert.equal(extraction.candidate.phone, '138-0000-0001')
  assert.equal(extraction.candidate.location, '上海')
  assert.equal(extraction.candidate.headline, '高级 Java 后端工程师 / 后端架构师')
  const education = extraction.education.find((item) => item.evidence.includes('江城大学'))
  assert.equal(education?.institution, '江城大学')
  assert.equal(education?.degree, '本科')
  assert.equal(education?.fieldOfStudy, '计算机科学与技术')
  assert.equal(education?.startDate, '2010.09')
  assert.equal(education?.endDate, '2014.06')
  const currentRole = extraction.experience.find((item) => item.employer === '星河科技有限公司')
  assert.ok(currentRole)
  assert.equal(currentRole?.title, '高级 Java 工程师')
  assert.equal(currentRole?.startDate, '2020.03')
  assert.equal(currentRole?.endDate, '至今')
  assert.ok(currentRole?.description?.includes('QPS 从 2k 提升至 8k'))
  const project = extraction.experience.find((item) => item.evidence.includes('XX 电商订单中台'))
  assert.equal(project?.title, 'XX 电商订单中台')
  assert.equal(project?.employer, undefined)
  assert.match(project?.description ?? '', /库存锁定/u)
  assert.ok(extraction.skills.some((skill) => skill.canonical === 'java'))
  assert.ok(extraction.skills.some((skill) => skill.canonical === 'spring cloud'))
  assert.match(extraction.profile.summary ?? '', /高并发系统设计/u)
  assert.ok((extraction.profile.totalExperienceYears ?? 0) >= 10)

  const sectionKinds = parsed.sections.map((section) => section.kind)
  assert.ok(sectionKinds.includes('contact'))
  assert.ok(sectionKinds.includes('education'))
  assert.ok(sectionKinds.includes('experience'))
  assert.ok(sectionKinds.includes('skills'))
  assert.ok(sectionKinds.includes('summary'))
})
test('validates the structured LLM suggestion contract', () => {
  const suggestion = parseLlmResumeSuggestion({
    summary: '建议人工复核', score: 82, strengths: ['TypeScript'], risks: [],
    matchedRequirements: [], conflicts: [], interviewQuestions: ['请介绍项目'], confidence: 0.8,
  })
  assert.equal(suggestion.score, 82)
  assert.equal(suggestion.confidence, 0.8)
  assert.throws(() => parseLlmResumeSuggestion({ summary: 42 }), /summary/u)
  assert.throws(() => parseLlmResumeSuggestion({
    summary: 'x', score: 80, strengths: [], risks: [], matchedRequirements: [], conflicts: [], interviewQuestions: [], confidence: 2,
  }), /confidence/u)
})

test('infers requirement kinds so each scoring dimension can be evaluated', () => {
  assert.equal(inferRequirementKind('5 年以上后端开发经验'), 'experience')
  assert.equal(inferRequirementKind('本科及以上学历，计算机相关专业'), 'education')
  assert.equal(inferRequirementKind('熟悉 Java、Spring Boot'), 'skill')
  assert.equal(inferRequirementKind('有良好的沟通能力'), 'other')
  assert.equal(minYearsFromLabel('5 年以上后端开发经验'), 5)
  assert.equal(minYearsFromLabel('经验不限'), undefined)

  const requirements = buildJobRequirements({
    jobId: 'job-1',
    requirementLabels: ['5 年以上后端开发经验', '本科及以上学历', '熟悉 Java、Spring Boot', '熟悉数据库与分布式系统基础：能够处理性能、并发和稳定性问题'],
    skills: ['Java/Spring Boot', 'PostgreSQL'],
  })
  assert.deepEqual(requirements.map((item) => item.kind), ['skill', 'skill', 'experience', 'education', 'skill', 'other'])
  assert.deepEqual(requirements.map((item) => item.hard), [false, false, true, false, false, false])
  assert.equal(requirements[2]?.minYears, 5)
  assert.deepEqual(requirements[0]?.keywords, ['Java', 'Spring Boot'])
  assert.deepEqual(requirements[4]?.keywords, ['Java', 'Spring Boot'])
  assert.deepEqual(requirements[5]?.keywords, ['数据库', '分布式系统'])
})

test('scores only the dimensions the job actually asks for', () => {
  const parsed = parseResume({ fileName: 'resume.txt', mimeType: 'text/plain', text: resume, source: 'test' })
  const extraction = extractResume(parsed)

  const partial = scoreResumeMatch({ extraction, job: { title: '后端工程师', requirements: [job.requirements[0]!] } })
  assert.equal(typeof partial.dimensions.skills, 'number')
  assert.equal(partial.dimensions.experience, null)
  assert.equal(partial.dimensions.education, null)

  // 岗位没有任何要求时不能伪造出 0 分维度，也不能给出匹配结论。
  const emptyJob = scoreResumeMatch({ extraction, job: { title: '后端工程师', requirements: [] } })
  assert.equal(emptyJob.dimensions.hardRequirement, null)
  assert.equal(emptyJob.dimensions.experience, null)
  assert.equal(emptyJob.dimensions.skills, null)
  assert.equal(emptyJob.dimensions.education, null)
  assert.equal(typeof emptyJob.dimensions.potential, 'number')
  assert.equal(emptyJob.score, null, 'completeness must not masquerade as job match score')
  assert.equal(emptyJob.recommendation, 'needs_review')
  assert.match(emptyJob.risks[0] ?? '', /岗位未提供任职要求/u)
})

test('counts every job requirement, including ones outside the four dimensions', () => {
  const parsed = parseResume({ fileName: 'resume.txt', mimeType: 'text/plain', text: resume, source: 'test' })
  const extraction = extractResume(parsed)
  const scored = scoreResumeMatch({
    extraction,
    job: {
      title: '后端工程师',
      requirements: [
        { id: 'r1', label: '熟悉 TypeScript、Node.js', kind: 'skill', keywords: ['typescript', 'node.js'], hard: false },
        // 无法在简历中找到证据的通用要求，必须同样把总分拉下来，否则会出现「一半要求没证据却是强匹配」。
        { id: 'r2', label: '具备良好的跨部门沟通与协调能力', kind: 'other', keywords: ['具备良好的跨部门沟通与协调能力'], hard: false },
      ],
    },
  })
  assert.equal(scored.dimensions.skills, 100)
  assert.ok(scored.score !== null && scored.score <= 60, `expected a review-worthy score, received ${scored.score}`)
  assert.notEqual(scored.recommendation, 'strong_match')
  assert.equal(scored.missingRequirements.length, 1)
})


function reportFor(text: string, requirements: Parameters<typeof buildRuleBasedReport>[0]['job']['requirements']) {
  return buildRuleBasedReport({ resume: { fileName: 'synthetic.txt', text, source: 'test' }, job: { title: '算法工程师', requirements }, subject: {} })
}

test('negated lists and suffix denials do not become supporting skill evidence', () => {
  const requirements = buildJobRequirements({ skills: ['机器学习', '深度学习', '特征工程', '算法工程化', 'Python'] })
  const report = reportFor(`测试候选人
技能
Python（基础）
未掌握：机器学习、深度学习、特征工程、算法工程化
工作经历
2020-2024 数据分析师
与算法无关：未涉及模型训练、特征工程或算法工程化。
自我评价
熟悉SQL，但对机器学习、深度学习、算法工程化缺乏实际项目经验。
目前正在学习Python，但对特征工程尚缺乏实际经验。`, requirements)
  assert.equal(report.extraction.skills.some((skill) => skill.value.includes('深度学习')), false)
  for (const label of ['机器学习', '深度学习', '特征工程', '算法工程化']) {
    assert.equal(report.assessment.missingRequirements.find((item) => item.label === label)?.score, 0, label)
  }
  assert.equal(report.assessment.matchedRequirements.find((item) => item.label === 'Python')?.score, 100)
})

test('positive project evidence can prove skills without a verbatim skills field', () => {
  const report = reportFor(`测试候选人
工作经历
2021-2024 算法工程师
使用Python完成数据处理、特征构建、模型训练与效果评估。
设计实验方案，完成结果分析与技术文档。`, buildJobRequirements({ skills: ['Python或其他编程语言', '数据分析与处理', '模型训练与评估', '实验设计与结果分析', '技术文档编写'] }))
  const byLabel = new Map(report.assessment.matchedRequirements.map((item) => [item.label, item]))
  assert.equal(byLabel.get('Python或其他编程语言')?.score, 100)
  assert.equal(byLabel.get('模型训练与评估')?.score, 100)
  assert.equal(byLabel.get('数据分析与处理')?.score, 50)
  assert.equal(byLabel.get('实验设计与结果分析')?.score, 100)
  assert.match(byLabel.get('Python或其他编程语言')?.evidence[0]?.sourceText ?? '', /使用Python完成/u)
})

test('major alternatives match education records and combine with degree constraints', () => {
  const requirements = buildJobRequirements({ requirementLabels: ['学历背景：本科及以上，计算机、数学、统计学或人工智能相关专业。'], requirementRequired: [true] })
  const strong = reportFor('测试候选人\n教育经历\n测试大学 | 计算机科学与技术 | 硕士', requirements)
  const weak = reportFor('测试候选人\n教育经历\n测试大学 | 信息管理与信息系统 | 本科', requirements)
  const degreeTooLow = reportFor('测试候选人\n教育经历\n测试大学 | 计算机科学与技术 | 专科', requirements)
  assert.equal(strong.assessment.score, 100)
  assert.equal(weak.assessment.score, 50)
  assert.equal(degreeTooLow.assessment.score, 50)
  assert.equal(weak.assessment.conflicts.length, 1)
  assert.equal(degreeTooLow.assessment.conflicts.length, 1)
})

test('honors explicit keyword atoms and does not match Java inside JavaScript', () => {
  const requirements = [{ id: 'java', label: 'Java', kind: 'skill' as const }, { id: 'ts', label: '熟练使用 TypeScript 开发大型系统', kind: 'skill' as const, keywords: ['TypeScript'] }]
  const report = reportFor('测试候选人\n技能\nJavaScript、TypeScript', requirements)
  assert.equal(report.assessment.missingRequirements.find((item) => item.label === 'Java')?.score, 0)
  assert.equal(report.assessment.matchedRequirements.find((item) => item.requirementId === 'ts')?.score, 100)
})

test('persisted hard requirement flags are independent of their position', () => {
  const requirements = buildJobRequirements({ requirementLabels: ['本科及以上学历', '3年以上经验'], requirementRequired: [false, true] })
  assert.deepEqual(requirements.map((item) => item.hard), [false, true])
  assert.equal(requirements[1]?.minYears, 3)
})

test('strong and unrelated resumes no longer receive the same algorithm-job score', () => {
  const requirements = buildJobRequirements({
    skills: ['机器学习', '深度学习', '特征工程', '模型训练与评估', 'Python或其他编程语言'],
    requirementLabels: ['学历背景：具备计算机、数学、统计学、人工智能或相关专业背景。', '项目经验：具备机器学习、深度学习或相关项目经验。'],
    requirementRequired: [false, true],
  })
  const strong = reportFor('测试候选人\n教育经历\n测试大学 | 计算机科学与技术 | 硕士\n工作经历\n2021-2024 算法工程师\n使用Python、机器学习和深度学习完成特征工程、模型训练与效果评估。', requirements)
  const weak = reportFor('测试候选人\n教育经历\n测试大学 | 信息管理与信息系统 | 本科\n技能\nPython（基础）\n未掌握：机器学习、深度学习、特征工程\n自我评价\n对模型训练、机器学习、深度学习缺乏实际项目经验。', requirements)
  assert.ok(strong.assessment.score !== null && strong.assessment.score >= 85)
  assert.ok(weak.assessment.score !== null && weak.assessment.score <= 30)
  assert.ok(strong.assessment.score !== null && weak.assessment.score !== null && strong.assessment.score - weak.assessment.score >= 50)
  assert.equal(strong.safety.applicationStatusMutation, 'none')
  assert.equal(weak.safety.applicationStatusMutation, 'none')
})


test('confirmed job context preserves structured flags and ignores duplicate JD requirements', () => {
  const context = buildJobAnalysisContext({ title: '后端', specContent: { requirements: [null, { label: ' ', required: true }, { label: '学历', description: '本科', required: false }, { label: '经验', description: '3年', required: true }, { label: '经验', description: '3年', required: false }, '掌握Python'], skills: [' Python ', 'Python', null] }, jdContent: '任职要求\n博士\n技能要求\nJava\n福利待遇\n五险一金' })
  assert.deepEqual(context.requirements, ['学历：本科', '经验：3年', '掌握Python'])
  assert.deepEqual(context.requirementRequired, [false, true, false])
  assert.deepEqual(context.skills, ['Python'])
})

test('JD fallback reads qualification and skill sections, not duties or benefits', () => {
  const context = buildJobAnalysisContext({ title: '后端', specContent: { requirements: [], skills: [] }, jdContent: '岗位职责\n开发服务\n## 任职要求\n1. 本科以上\n2. 3年以上经验\n**技能要求**\n- Python\n- PostgreSQL\n福利待遇\n五险一金\n## 其他说明\n请投递简历' })
  assert.deepEqual(context.requirements, ['本科以上', '3年以上经验'])
  assert.deepEqual(context.requirementRequired, [false, false])
  assert.deepEqual(context.skills, ['Python', 'PostgreSQL'])
})

test('overview-only documents do not invent a scoring baseline', () => {
  const context = buildJobAnalysisContext({ title: '后端', specContent: { summary: 'Python服务开发', responsibilities: ['维护服务'] }, jdContent: '岗位概述\nPython服务开发\n福利待遇\n五险一金' })
  assert.deepEqual(context.requirements, [])
  assert.deepEqual(context.skills, [])
})

const hrText = '协助办理员工入职、离职手续。统计每月出勤数据，核对请假与加班记录。提交薪资核算基础表格。维护员工档案。未从事招聘工作。'
const hrJob = { title: '人事专员', requirements: [
  { id: 'onboarding', label: '独立负责人事入离职管理', kind: 'other' as const, hard: true },
  { id: 'attendance', label: '考勤管理', kind: 'other' as const, hard: false },
  { id: 'payroll', label: '独立核算薪酬', kind: 'other' as const, hard: true },
  { id: 'confidentiality', label: '执行保密制度', kind: 'other' as const, hard: true },
  { id: 'hiring', label: '招聘经验', kind: 'other' as const, hard: false },
] }
function hrInput() {
  return {
    job: hrJob, extraction: extractResume(parseResume({ text: hrText, fileName: 'hr.txt' })), anonymizedResumeText: hrText,
    response: { score: 99, requirementAssessments: [
      { requirementId: 'onboarding', status: 'partial', score: 50, sourceTexts: ['协助办理员工入职、离职手续。'], rationale: '可证明协助参与，不能证明独立负责。' },
      { requirementId: 'attendance', status: 'met', score: 100, sourceTexts: ['统计每月出勤数据，核对请假与加班记录。'], rationale: '出勤统计与考勤管理语义对应。' },
      { requirementId: 'payroll', status: 'not_mentioned', score: 0, sourceTexts: [], rationale: '基础表格不证明独立核算。' },
      { requirementId: 'confidentiality', status: 'not_mentioned', score: 0, sourceTexts: [], rationale: '维护档案不证明执行保密制度。' },
      { requirementId: 'hiring', status: 'contradicted', score: 0, sourceTexts: ['未从事招聘工作。'], rationale: '明确否认招聘工作经历。' },
    ] },
  }
}
test('semantic scoring uses synonymous evidence but never converts missing hard requirements into conflicts', () => {
  const { assessment, summary } = assessSemanticResume(hrInput())
  assert.equal(assessment.score, 24) // (50*2.5 + 100) / 9.5
  assert.equal(assessment.matchedRequirements.find(item => item.requirementId === 'attendance')?.score, 100)
  assert.equal(assessment.matchedRequirements.find(item => item.requirementId === 'onboarding')?.status, 'partial')
  assert.deepEqual(assessment.missingRequirements.map(item => item.requirementId), ['payroll', 'confidentiality'])
  assert.deepEqual(assessment.conflicts.map(item => item.requirementId), ['hiring'])
  assert.match(summary, /统计每月出勤数据/u)
  assert.match(summary, /待核实/u)
  assert.equal(assessment.applicationStatusMutation, 'none')
})
test('semantic scoring rejects invented citations, unsupported points, duplicate and missing requirements', () => {
  for (const mutate of [
    (input: ReturnType<typeof hrInput>) => { input.response.requirementAssessments[0]!.sourceTexts = ['独立负责全公司人事管理'] },
    (input: ReturnType<typeof hrInput>) => { input.response.requirementAssessments[2]!.score = 100 },
    (input: ReturnType<typeof hrInput>) => { input.response.requirementAssessments[2]!.sourceTexts = ['维护员工档案。'] },
    (input: ReturnType<typeof hrInput>) => { input.response.requirementAssessments[1]!.requirementId = 'onboarding' },
    (input: ReturnType<typeof hrInput>) => { input.response.requirementAssessments.pop() },
    (input: ReturnType<typeof hrInput>) => { input.response.requirementAssessments[0]!.score = 100 },
    (input: ReturnType<typeof hrInput>) => { input.response.requirementAssessments[4]!.score = 10 },
  ]) {
    const input = hrInput(); mutate(input); assert.throws(() => assessSemanticResume(input), TypeError)
  }
})
test('semantic quotations must originate in the exact anonymized input, not job instructions', () => {
  const input = hrInput(); input.response.requirementAssessments[0]!.sourceTexts = ['独立负责人事入离职管理']
  assert.throws(() => assessSemanticResume(input), /简历原文/u)
})
test('semantic prompt includes full text and prohibits capability extrapolation and negation slicing', () => {
  const longText = '简历内容。'.repeat(6000) + '最后一行明确经历'
  const prompt = buildResumeAnalysisPrompt({ anonymizedResumeText: longText, job: hrJob })
  assert.ok(prompt.includes('最后一行明确经历'))
  assert.match(prompt, /维护员工档案不等于具备保密制度/u)
  assert.match(prompt, /不能截取否定句/u)
  assert.match(prompt, /not_mentioned/u)
})

test('semantic prompt explicitly enforces zero points for contradictions in requirements and Skill dimensions', () => {
 const prompt=buildResumeAnalysisPrompt({anonymizedResumeText:hrText,job:hrJob})
 assert.match(prompt,/contradicted 必须 score=0/u)
 assert.match(prompt,/requirementAssessments 和 scoringDimensions 均适用/u)
 assert.match(prompt,/明确不满足不得给部分分/u)
 const invalid=hrInput();invalid.response.requirementAssessments[4]!.score=10
 assert.throws(()=>assessSemanticResume(invalid),/明确不满足的项目不能得分/u)
})

test('groups wrapped project descriptions, role labels and achievements into one project', () => {
  const text = `项目经历
高考志愿推荐系统
项目描述
职员为项目负责人
领带团队设计并制作了一个高考志愿推荐程序。通过爬虫在网络上爬取学校的招生信息、专业排名，再通过机
器学习评估这些志愿的优先度，生成咨询表格推荐给用户
项目成果：完成推荐程序上线。`
  const extraction = extractResume(parseResume({ fileName: 'wrapped.txt', text }))
  assert.equal(extraction.experience.length, 1)
  const project = extraction.experience[0]!
  assert.equal(project.title, '高考志愿推荐系统')
  assert.equal(project.employer, undefined)
  assert.match(project.description!, /项目负责人/u)
  assert.match(project.description!, /爬取学校/u)
  assert.match(project.description!, /器学习评估/u)
  assert.match(project.description!, /完成推荐程序上线/u)
  for (const line of text.split('\n').slice(1)) assert.ok(project.evidence.includes(line))
})

test('groups an unnamed 项目描述 block without promoting sentences to titles', () => {
  const extraction = extractResume(parseResume({ fileName: 'no-name.txt', text: `项目经历
项目描述
职员为项目负责人
领导团队设计并制作了一个高考志愿推荐程序。
通过机器学习评估志愿的优先度，生成咨询表格推荐给用户` }))
  assert.equal(extraction.experience.length, 1)
  assert.equal(extraction.experience[0]!.title, '项目经历')
  assert.match(extraction.experience[0]!.description!, /领导团队/u)
  assert.match(extraction.experience[0]!.description!, /机器学习/u)
})

test('keeps multiple colon-named projects distinct while attaching all following bullets', () => {
  const extraction = extractResume(parseResume({ fileName: 'projects.txt', text: `项目经验
订单中台：负责订单创建及支付回调。
• 使用 TypeScript 实现业务接口。
• 技术栈：PostgreSQL、Redis。
项目成果：日均处理 50 万订单。
推荐引擎：实现商品推荐。
- 项目职责：完成训练与部署。
- 使用 Python 处理特征。` }))
  assert.equal(extraction.experience.length, 2)
  assert.deepEqual(extraction.experience.map((item) => item.title), ['订单中台', '推荐引擎'])
  assert.match(extraction.experience[0]!.description!, /50 万订单/u)
  assert.doesNotMatch(extraction.experience[0]!.evidence, /推荐引擎/u)
  assert.match(extraction.experience[1]!.description!, /训练与部署/u)
})

test('recognizes labeled project names and short names followed by detail labels', () => {
  const extraction = extractResume(parseResume({ fileName: 'names.txt', text: `项目实践
项目名称：高考志愿推荐
项目角色：负责人
项目描述：开发推荐程序。
1. 电商订单服务
项目职责：完成支付回调。
项目成果：完成上线。` }))
  assert.equal(extraction.experience.length, 2)
  assert.deepEqual(extraction.experience.map((item) => item.title), ['高考志愿推荐', '电商订单服务'])
  assert.equal(extraction.experience[0]!.employer, undefined)
})

test('combines separate date/name paragraphs and does not split dates inside descriptions', () => {
  const extraction = extractResume(parseResume({ fileName: 'dates.txt', text: `项目经历
2021.01-2022.06
高考志愿推荐系统
项目描述：开发推荐程序。
负责 2021.03-2021.08 的模型训练。
数据管理平台
2023.01-2024.06
项目描述：开发数据接口。` }))
  assert.equal(extraction.experience.length, 2)
  assert.equal(extraction.experience[0]!.title, '高考志愿推荐系统')
  assert.equal(extraction.experience[0]!.startDate, '2021.01')
  assert.equal(extraction.experience[0]!.endDate, '2022.06')
  assert.match(extraction.experience[0]!.description!, /模型训练/u)
  assert.equal(extraction.experience[1]!.title, '数据管理平台')
  assert.equal(extraction.experience[1]!.startDate, '2023.01')
  assert.equal(extraction.experience[1]!.endDate, '2024.06')
})

test('does not split narrative colons, bullet points or paragraph gaps into projects', () => {
  const extraction = extractResume(parseResume({ fileName: 'continuation.txt', text: `项目经历
智能招聘平台
负责模块：岗位管理和面试评估。

通过机器学习模型：完成候选人推荐。

项目成果
完成招聘流程上线。
项目背景：企业招聘需求。` }))
  assert.equal(extraction.experience.length, 1)
  assert.equal(extraction.experience[0]!.title, '智能招聘平台')
  assert.match(extraction.experience[0]!.description!, /岗位管理/u)
  assert.match(extraction.experience[0]!.description!, /招聘需求/u)
})

test('groups undated employer responsibilities while preserving distinct employers and sections', () => {
  const extraction = extractResume(parseResume({ fileName: 'undated.txt', text: `工作经历
星河科技有限公司 Java 工程师
负责支付系统研发。
工作职责：实现回调及对账。
云图信息技术有限公司 后端工程师
负责数据接口开发。
项目经历
数据管理平台：实现业务看板。
项目职责：完成指标统计。
教育背景
2020-2024 江城大学 计算机科学 本科
技能
Java、TypeScript` }))
  assert.equal(extraction.experience.length, 3)
  assert.deepEqual(extraction.experience.map((item) => item.employer), ['星河科技有限公司', '云图信息技术有限公司', undefined])
  assert.match(extraction.experience[0]!.description!, /实现回调及对账/u)
  assert.equal(extraction.education.length, 1)
  assert.doesNotMatch(extraction.experience[2]!.evidence, /江城大学/u)
})

test('recognizes icon-prefixed PDF headings and keeps work, projects and qualifications distinct', () => {
  const parsed = parseResume({ fileName: 'cjk-icons.pdf', text: `张三
zhang@example.com
ŵ 教育背景
星河大学｜计算机技术｜硕士 2023.09–2026.07
研究课题：基于 RT-DETR 的目标检测（PyTorch）。
云图大学｜软件工程｜本科 2018.09–2022.07
Ĳ 专业技能
Python 后端与模型服务：熟悉 Python、FastAPI、PostgreSQL。
ë 工作经验
星河科技有限公司 2025.03–2026.06
AI 应用开发工程师
参与客服 Agent 与知识检索建设。
͛ 项目经历
智能客服——多模态 Agent 2025.03–2026.06
项目背景：建设客服辅助系统。
• 使用向量混合检索与 Cross-Encoder 重排。
内容生产——剪辑 Agent 2025.07–2026.06
项目背景：生成直播剪辑素材。
• 使用 FFmpeg.wasm 处理音视频。
Ô 奖励与证书
• 竞赛与奖学金：蓝桥杯国赛优秀奖；研究生二等奖学金。
• 资格证书：软件设计师；大学英语四级。` })
  const extraction = extractResume(parsed)
  assert.equal(extraction.candidate.fullName, '张三')
  assert.equal(extraction.education.length, 2)
  assert.equal(extraction.experience.length, 3)
  assert.equal(extraction.experience[0]!.employer, '星河科技有限公司')
  assert.equal(extraction.experience[0]!.title, 'AI 应用开发工程师')
  assert.equal(extraction.experience[1]!.title, '智能客服——多模态 Agent')
  assert.match(extraction.experience[2]!.description!, /FFmpeg/u)
  assert.doesNotMatch(extraction.experience[2]!.evidence, /奖学金|证书/u)
  assert.ok(extraction.skills.some((item) => item.canonical.toLowerCase() === 'python'))
  assert.deepEqual(extraction.certifications, ['软件设计师'])
  assert.deepEqual(extraction.languages, ['大学英语四级'])
})
