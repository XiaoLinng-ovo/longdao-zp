# SmartRecruit Pro

这是一个面向单组织内部招聘团队的招聘流程平台。当前唯一运行主线是 `web/` + `apps/api/` + `apps/worker/`，共享契约位于 `packages/`。

当前状态是“API/Web + PostgreSQL 可运行闭环”：需求、岗位、候选人、申请、简历、面试和 Offer 主流程已有实现，认证已支持 PostgreSQL Session、scrypt、CSRF、Origin 校验和登录限流。角色包含 `admin`、`hr_admin`、`recruiter`、`hiring_manager`、`approver`、`interviewer`。

当前最终总设计请参阅 [`docs/superpowers/specs/2026-09-17-smartrecruit-platform-final-design.md`](docs/superpowers/specs/2026-09-17-smartrecruit-platform-final-design.md)；最初产品设计基线请参阅 [`docs/superpowers/specs/2026-09-08-commercial-recruiting-platform-detailed-design.md`](docs/superpowers/specs/2026-09-08-commercial-recruiting-platform-detailed-design.md)。

## 换一台电脑的首次运行

要求：Node.js 20.16+（或 22.3+）、pnpm、Docker Desktop，以及可访问的 PostgreSQL。先复制环境变量模板，不要把真实密钥提交到 Git：

```powershell
Copy-Item .env.example .env
pnpm install
docker compose -f deploy/docker-compose.yml up -d postgres minio
pnpm start
```

`pnpm start` 会按顺序完成 API 构建、PostgreSQL migration、开发数据初始化，然后启动 API。默认 API 地址为 `http://127.0.0.1:3100`。另开终端启动前端：

```powershell
$env:VITE_API_BASE_URL = 'http://127.0.0.1:3100'
pnpm --dir web dev --host 127.0.0.1 --port 5174
```

浏览器访问 `http://127.0.0.1:5174`。如果 PostgreSQL 不在本机，请在 `.env` 中设置 `DATABASE_URL`，或设置 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`。`DATABASE_URL` 优先。

也可以直接运行仓库自带的 Windows 启动脚本（它使用本地开发端口并启动 API、Worker、Web）：

```powershell
.\start-local.ps1
```

## 本地运行

```powershell
pnpm start
```

API 启动会先执行 PostgreSQL migration；另开终端启动 Web：

```powershell
pnpm --dir web dev
```

## Docker 部署

```bash
docker build -t smartrecruit-pro .
docker run -d --name smartrecruit-pro -p 3000:3000 -v smartrecruit-data:/app/data smartrecruit-pro
```

服务器放行 TCP `3000` 端口后，通过 `http://服务器地址:3000` 访问。生产环境建议在前面配置 Nginx/Caddy 的 HTTPS 反向代理，并将 `/app/data` 挂载到可靠磁盘或改接数据库。

## 简历上传与病毒扫描说明

当前默认业务线路已关闭 ClamAV 简历扫描门禁，简历上传后状态为 `clean`，可以立即进入解析和分析；不会再因为 `quarantined`、`scanning` 或 `failed` 阻塞简历分析。明确被标记为 `infected` 的文件仍会被拒绝。上传格式、大小、扩展名、MIME 匹配、路径安全和对象存储校验仍然保留。

新电脑首次连接已有 PostgreSQL 时，migration `0016` 会把历史扫描遗留状态统一修复，migration `0017` 会把数据库默认状态设为 `clean`。不要直接启动旧的 `apps/api/dist`，应使用 `pnpm start`，确保源码和 migration 一起更新。

## 配置

- `PORT`：监听端口，默认 `3000`
- `HOST`：监听地址，默认 `0.0.0.0`
- `DATA_DIR`：状态数据目录，默认项目下的 `data/`
- `CORS_ORIGIN`：跨域部署时显式设置允许的前端源；同源部署无需设置

## API

新版 API 使用 `/api/v1`，业务数据要求 PostgreSQL；不再提供整体状态 JSON 的读写接口。

## 可选：接入大模型简历分析

默认不配置模型时，系统继续使用内置演示评分，不会向任何第三方发送简历内容。要启用真实分析，请将前端与本 Node 服务部署在同一域名，并在服务器环境变量中配置：

```bash
LLM_API_KEY=你的模型密钥
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
```

服务使用 OpenAI 兼容的 `chat/completions` 接口，可替换为通义千问、OpenAI 等兼容服务。正式部署时密钥只保存在 API/Worker 服务器环境变量。

启用后，在「简历库」中选择「导入简历并分析」，上传 PDF/DOCX 或粘贴简历文本即可获得模型生成的匹配评分、优势、风险和建议面试题。

Demo 也支持在右上角「系统配置」选择「直接访问 OpenAI/DeepSeek 兼容服务」，填写 `https://api.deepseek.com/v1`、`https://api.openai.com/v1` 或其他兼容地址，再输入 Key 测试模型列表。该模式会将简历文本从浏览器直接发送到你指定的服务商，仅建议用于演示；生产环境应使用后端代理模式。PDF/DOCX 会在浏览器本地提取文字，原始文件不会上传；老式 DOC 请先转换为 DOCX 或 PDF。模型未配置、请求失败或返回不符合格式时，系统自动退回默认评分，招聘流程不会中断。

Web 与 API 通过同一部署编排运行；跨域场景通过服务器端 `ALLOWED_ORIGINS` 显式配置。未配置时，前端默认按同源 API 工作。

## 部署

生产部署统一使用 `deploy/docker-compose.yml`，由 PostgreSQL、Redis、MinIO、API、Worker 和 Web 组成。ClamAV/OCR 服务可以按需启动；当前默认简历主流程不依赖 ClamAV。整体状态 KV 和旧单页入口已移除。

## 常见问题

- 页面仍显示旧的 `quarantined`：确认访问的是当前 API（默认 `3100`），停止旧 API 进程后重新执行 `pnpm start`，并确认数据库 migration 已执行。
- 简历库没有数据：确认前端的 `VITE_API_BASE_URL` 指向实际 API，且 API 与前端使用同一个 PostgreSQL 数据库；不要只启动 Web。
- API 返回 502：通常是前端代理目标的 API 没有启动或端口不一致。检查 `http://127.0.0.1:3100/health`，再检查 Web 的 `VITE_API_BASE_URL`。
- 数据库连接失败：检查 PostgreSQL 是否启动、端口和账号是否正确；可先执行 `node scripts/check-postgres-ready.mjs`。

# longdao-jianli
