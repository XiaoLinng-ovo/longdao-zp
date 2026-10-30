# @smartrecruit-pro/resume-intelligence

SmartRecruit Pro 内置的第一版简历智能能力包，按 CandiSift 的解析、抽取、脱敏、标准化、匹配、评分和报告边界重新组织为 TypeScript 模块。

## 当前能力

- 文本简历格式识别和章节解析；
- 候选人、教育、经历、技能、语言和证书的确定性抽取；
- 邮箱、电话、URL 和姓名脱敏；
- 技能别名标准化；
- 岗位要求匹配和证据输出；
- 确定性规则评分、风险和面试问题建议；
- 统一分析报告和来源版本记录；
- OpenAI 兼容接口所需的脱敏 Prompt 构建。

## 安全边界

所有报告都包含：

```text
advisoryOnly: true
applicationStatusMutation: none
autoReject: false
autoHire: false
autoOffer: false
```

本包只输出分析建议，不直接访问数据库、不改变 Application 状态、不自动淘汰/录用候选人，也不发送 Offer。

## 使用

```ts
import { buildRuleBasedReport } from '@smartrecruit-pro/resume-intelligence'

const report = buildRuleBasedReport({
  resume: { fileName: 'resume.txt', mimeType: 'text/plain', text: '...', source: 'test' },
  job: { title: '后端工程师', requirements: [] },
})
```

后续由 Worker 负责 PDF/DOCX 文件解析、任务幂等、模型调用和结果写入；本包保持纯函数和可测试。
