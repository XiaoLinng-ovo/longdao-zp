# 龙道招聘系统 Web

Vue 3 + TypeScript + Vite 招聘工作台前端。页面数据全部来自后端 `/api/v1`（PostgreSQL），由各业务模块的 API 适配层统一封装，不再有演示数据回退。

## 本地开发

在仓库根目录执行：

```bash
pnpm --dir web install
pnpm --dir web dev
```

开发服务器默认运行在 `http://127.0.0.1:5174`，并把 `/api` 代理到 `http://127.0.0.1:3100`；后端不在默认地址时用 `VITE_API_PROXY_TARGET` 覆盖。

常用校验命令：

```bash
pnpm --dir web build
pnpm --dir web typecheck
pnpm --dir web test -- --run
```

前端入口是 `web/index.html`，由 Vite 构建并由生产 Web 服务托管。
