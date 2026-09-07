import { createRequire } from 'node:module';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('C:/Users/dm245/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/docx');

const resume = new Document({
  sections: [{ children: [
    new Paragraph({ text: '张伟', heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun('电话：138-0000-1234  |  邮箱：zhangwei.test@example.com  |  所在地：杭州')]}),
    new Paragraph({ text: '求职意向', heading: HeadingLevel.HEADING_1 }),
    new Paragraph('高级 Java 后端工程师 | 期望薪资：30K-40K'),
    new Paragraph({ text: '教育背景', heading: HeadingLevel.HEADING_1 }),
    new Paragraph('浙江大学 · 计算机科学与技术 · 硕士 · 2015-2018'),
    new Paragraph({ text: '工作经历', heading: HeadingLevel.HEADING_1 }),
    new Paragraph('杭州云启科技有限公司 · 高级 Java 后端工程师 · 2021-至今'),
    new Paragraph('负责订单与支付平台架构设计，带领 6 人团队完成核心服务拆分和稳定性建设。'),
    new Paragraph('通过 Redis、Kafka 和分库分表优化，将订单峰值吞吐提升 2.4 倍，接口 P99 延迟降低 38%。'),
    new Paragraph('上海星河网络有限公司 · Java 后端工程师 · 2018-2021'),
    new Paragraph('参与电商中台、用户和库存服务开发，负责 Spring Cloud 微服务、MySQL 性能优化及线上故障排查。'),
    new Paragraph({ text: '项目经历', heading: HeadingLevel.HEADING_1 }),
    new Paragraph('统一订单平台：设计订单状态机和幂等机制，支持日均 500 万订单，保障大促期间稳定运行。'),
    new Paragraph('智能库存服务：使用 Redis + Lua 实现库存预扣，结合 Kafka 异步削峰，库存准确率达到 99.99%。'),
    new Paragraph({ text: '技能', heading: HeadingLevel.HEADING_1 }),
    new Paragraph('Java、Spring Boot、Spring Cloud、MySQL、Redis、Kafka、Docker、Kubernetes、微服务架构、性能优化、团队协作'),
    new Paragraph({ text: '自我评价', heading: HeadingLevel.HEADING_1 }),
    new Paragraph('8 年后端开发经验，熟悉高并发和分布式系统，能够从业务目标出发推进架构落地，重视代码质量与团队协作。')
  ]}]
});

const output = '测试简历-张伟.docx';
await fs.writeFile(output, await Packer.toBuffer(resume));
console.log(output);
