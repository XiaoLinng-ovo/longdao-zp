# SmartRecruit Pro Web

独立的 Vue 3 + TypeScript + Vite 招聘工作台前端。当前页面使用只读演示数据，通过各业务模块的 API 适配层提供数据，便于后续接入真实服务。

## 本地开发

在仓库根目录执行：

```bash
pnpm --dir web install
pnpm --dir web dev
```

常用校验命令：

```bash
pnpm --dir web build
pnpm --dir web typecheck
pnpm --dir web test -- --run
```

前端入口是 `web/index.html`，由 Vite 构建并由生产 Web 服务托管。
