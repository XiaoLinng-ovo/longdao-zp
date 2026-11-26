# @smartrecruit-pro/contracts

SmartRecruit Pro 的共享 TypeScript 契约包，供 API、Worker 和 Vue 前端共同使用。

## 设计边界

- `CandidateDTO` 表示候选人主档案。
- `ApplicationDTO` 表示候选人针对某个岗位的一次申请。一个候选人可以拥有多个独立申请，申请状态互不影响。
- `ResumeDTO` 表示原始简历文件及其安全扫描状态。
- `AnalysisTaskDTO` / `AnalysisResultDTO` 表示异步简历智能任务和可追溯的分析结果。AI 结果只提供人工复核依据，不代表系统自动淘汰或录用。
- 所有核心 DTO 都带有 `AuditMetadata` 和 `VersionMetadata`，支持审计、乐观锁和版本快照。
- `ApiResponse<T>` 使用统一的成功/失败结构（`ok: true/false`）；错误字段使用 `ApiError`。

## 目录

```text
src/
├─ api.ts          # API 响应、错误和分页
├─ candidates.ts   # Candidate、Application、Resume、分析契约
├─ common.ts       # ID、审计、版本、文件和时间线
├─ interviews.ts   # 面试、评分表、反馈
├─ offers.ts       # Offer、版本、审批、入职归档
├─ recruitment.ts  # 招聘需求、审批、岗位、JD
├─ status.ts       # 领域状态枚举
└─ index.ts        # 公共导出入口
```

## 本地检查

在本目录执行：

```bash
npm run typecheck
npm test
```

两个命令都只做 TypeScript 编译检查，不引入运行时依赖。`tests/typecheck.ts` 用最小领域样例验证跨实体引用、Candidate/Application 分离、版本字段、审计元数据和统一 API 响应可以被正确赋值。

## 使用约定

业务服务只应通过命令/服务接口改变状态，不应让客户端直接修改状态枚举。数据库实体可以扩展内部字段，但对外 DTO 应保持稳定，并在破坏性变更时提升契约版本。

