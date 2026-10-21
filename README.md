# 龙道招聘系统

这是一个面向单组织内部招聘团队的招聘流程平台。当前唯一运行主线是 `web/` + `apps/api/` + `apps/worker/`，共享契约位于 `packages/`。

当前状态是“API/Web + PostgreSQL 可运行闭环”：需求、岗位、候选人、申请、简历、面试和 Offer 主流程已有实现，认证已支持 PostgreSQL Session、scrypt、CSRF、Origin 校验和登录限流。角色包含 `admin`、`hr_admin`、`recruiter`、`hiring_manager`、`approver`、`interviewer`。

当前最终总设计请参阅 [`docs/superpowers/specs/2026-09-17-smartrecruit-platform-final-design.md`](docs/superpowers/specs/2026-09-17-smartrecruit-platform-final-design.md)；最初产品设计基线请参阅 [`docs/superpowers/specs/2026-09-08-commercial-recruiting-platform-detailed-design.md`](docs/superpowers/specs/2026-09-08-commercial-recruiting-platform-detailed-design.md)。

## 需要安装什么

必须安装：

| 依赖 | 版本要求 | 作用 | 获取方式 |
| --- | --- | --- | --- |
| Node.js | `>=20.16 <21` 或 `>=22.3` | 运行 API / Worker、构建前端 | <https://nodejs.org/>（选 LTS 版） |
| pnpm | 9 及以上 | 安装依赖、执行脚本 | `corepack enable pnpm`，或 `npm install -g pnpm` |
| Docker Desktop | 最新稳定版 | 提供 PostgreSQL 与 MinIO（简历对象存储） | <https://www.docker.com/products/docker-desktop/> |
| Git | 任意 | 拉取 / 推送代码 | <https://git-scm.com/> |

按需安装（不装也能跑通主流程）：

- **OCR 服务（PP-StructureV3）**：只有扫描版 PDF、图片简历需要。`deploy/docker-compose.yml` 已内置 `ocr` 服务，首次启动会下载 Paddle 模型，体积较大、耗时较长。
- **ClamAV**：只有把 `RESUME_VIRUS_SCAN_ENABLED` 设为 `true`、需要简历病毒隔离时才用，默认关闭。
- **大模型服务**：只有启用 AI 简历分析时才需要，准备一个 OpenAI 兼容服务的 Base URL 与 API Key（DeepSeek、通义千问、OpenAI 等均可）。密钥只保存在服务端。

如果只用 Docker 部署，本机可以不装 Node 与 pnpm，见下方「Docker 部署」。

## 首次运行

不要把真实密钥提交到 Git，先复制环境变量模板再启动：

```powershell
pnpm install
Copy-Item .env.example .env
docker compose -f deploy/docker-compose.yml up -d postgres minio
pnpm run start:dev
```

`pnpm run start:dev` 仅用于已确认目标数据库的本地开发，会构建、执行已有 migration 并启动 API，默认不运行开发种子。默认 API 地址为 `http://127.0.0.1:3100`。另开终端启动前端：

生产入口 `npm start` / `npm run start:production` 只运行已构建的 API，并设置 `NODE_ENV=production`；不会构建、迁移或执行开发种子。API 容器同样只启动已构建程序，Worker 入口不变。数据库初始化或迁移必须另行审查、授权并执行，不能靠重启生产服务完成。

如需初始化虚构本地开发数据，须同时显式设置 `NODE_ENV=development` 和 `ALLOW_DEV_SEED=true`，再运行 `node scripts/seed-dev-postgres.mjs`。该脚本只插入缺失的部门、角色和开发账号，已有账号及其角色不会被重置；不用于正式管理员初始化。`start:dev` 仅在 `ALLOW_DEV_SEED=true` 时调用种子。不要对生产目标使用开发入口。

```powershell
npm --prefix web run dev
```

浏览器访问 `http://127.0.0.1:5174`。Web 开发服务器会把 `/api` 代理到 `http://127.0.0.1:3100`，API 不在默认地址时用 `VITE_API_PROXY_TARGET` 覆盖。如果 PostgreSQL 不在本机，请在 `.env` 中设置 `DATABASE_URL`，或设置 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`。`DATABASE_URL` 优先。

Windows 源码环境可以直接双击仓库根目录的 `一键启动.bat`，或者运行：

```powershell
.\start-all.bat
```

该脚本会检查并尝试启动本机 PostgreSQL、准备 `.env`、启动 API/Worker/Web，然后打开浏览器。若 `.env` 将 `FUNASR_BASE_URL` 配置为本机 `http://127.0.0.1:10095/transcribe`，一键启动也会自动启动本地 FunASR；如果服务已运行则复用。若同时配置本机 `FASTER_WHISPER_BASE_URL=http://127.0.0.1:10096/transcribe`，一键启动也会按需启动 faster-whisper 后备服务。两个服务都采用懒加载，模型在第一次实际转写时加载。源码模式下如果未配置 MinIO，会自动使用本地 `data/resumes/quarantine` 目录保存简历文件。
如果 `3100`、`4001` 或 `5174` 已被其他项目占用，启动脚本会校验服务身份，并为龙道招聘系统自动选择后续可用端口，避免误打开其他应用。

## Docker 部署

生产部署统一使用 `deploy/docker-compose.yml`，由 PostgreSQL、Redis、MinIO、API、Worker 和 Web 组成（API/Worker 用 `deploy/Dockerfile.api` 构建，Web 用 `deploy/Dockerfile.web`）：

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

默认通过 `http://127.0.0.1:5174` 访问 Web，API 在 `http://127.0.0.1:3100`。对外暴露时建议在前面配置 Nginx/Caddy 的 HTTPS 反向代理，并用 `ALLOWED_ORIGINS` 显式声明允许的前端来源。ClamAV/OCR 服务可按需启动；当前默认简历主流程不依赖 ClamAV。

## 简历上传与病毒扫描说明

当前默认业务线路已关闭 ClamAV 简历扫描门禁，简历上传后状态为 `clean`，可以立即进入解析和分析；不会再因为 `quarantined`、`scanning` 或 `failed` 阻塞简历分析。明确被标记为 `infected` 的文件仍会被拒绝。上传格式、大小、扩展名、MIME 匹配、路径安全和对象存储校验仍然保留。

历史 migration `0016`、`0017` 包含扫描状态及默认值变更；连接已有 PostgreSQL 前必须核对实际迁移台账与数据影响。生产启动不会自动执行迁移，不应通过重启服务修复历史状态。

## 配置

所有配置都通过服务端环境变量提供：本地开发把 `.env.example` 复制成 `.env` 再改；容器部署用 `.env` 或编排文件里的环境变量覆盖。**不要把 `.env` 提交到 Git。**

### 数据库（必需）

- `DATABASE_URL`：完整连接串，优先级最高，例如 `postgresql://smartrecruit:change-me-in-development@127.0.0.1:15432/smartrecruit`
- 也可以分开设置 `PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`

### 简历对象存储（必需）

- `S3_ENDPOINT`：MinIO 地址，本地为 `http://127.0.0.1:19000`
- `S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`：访问密钥，本地默认 `smartrecruit` / `change-me-in-development`
- `S3_QUARANTINE_BUCKET`：存放简历的桶，默认 `resume-quarantine`，首次使用时自动创建
- `S3_REGION`（默认 `us-east-1`）、`S3_FORCE_PATH_STYLE`（默认 `true`）
- 不配置 `S3_ENDPOINT` 时回退到本地目录，可用 `RECRUITING_QUARANTINE_ROOT` 指定路径

> 简历上传依赖对象存储可用。只启动 API 而没启动 MinIO 时，上传会失败并提示「简历存储不可用」。

### 服务与安全

- `PORT`：API 监听端口，默认 `3100`
- `HOST`：API 监听地址，默认 `127.0.0.1`
- `ALLOWED_ORIGINS`：跨域部署时允许的前端来源白名单（逗号分隔）；仅在配置白名单后对写请求做 Origin 校验
- `REQUIRE_CSRF`：设为 `false` 可关闭 CSRF 校验，默认开启
- `WORKER_DB_POLL`：Worker 是否轮询数据库任务，默认关闭
- `RESUME_VIRUS_SCAN_ENABLED`：是否启用 ClamAV 隔离门禁，默认 `false`

### 面试语音转写

- `FUNASR_BASE_URL`、`FUNASR_TIMEOUT_MS`、`FUNASR_TOKEN`：面试实时 WebSocket 和音频分段的主转写服务配置。实时页面仍由 FunASR WebSocket 提供流式结果。
- `FASTER_WHISPER_BASE_URL`、`FASTER_WHISPER_TIMEOUT_MS`、`FASTER_WHISPER_TOKEN`：可选的本地 faster-whisper HTTP 后备服务。API 先调用 FunASR；FunASR 未配置或分段请求失败时才调用 faster-whisper。

安装并启动后备服务：

```powershell
Set-Location faster-whisper-service
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\start-faster-whisper.ps1
```

然后在根目录 `.env` 中配置 `FASTER_WHISPER_BASE_URL=http://127.0.0.1:10096/transcribe`，重启 API。`pnpm run start:all` 在发现该地址为本机服务且虚拟环境已存在时会自动启动它；未配置时不会增加任何启动步骤。faster-whisper 首次实际转写会下载/加载模型，默认模型为 `small`，可用 `FASTER_WHISPER_MODEL`、`FASTER_WHISPER_DEVICE`、`FASTER_WHISPER_COMPUTE_TYPE`、`FASTER_WHISPER_LANGUAGE` 调整。本机已验证 `base + cpu + int8` 的后备组合，详细参数和验证命令见 `faster-whisper-service/README.md`。

后备服务不做说话人分离，返回的音频片段会标记为 `speaker_0`、未验证且可能混合说话人。因此它适合作为 FunASR 故障回退，不会替代当前实时转录和已有面试评分、角色确认逻辑。

### 招聘渠道接入

管理后台的「招聘渠道接入」支持分别配置 BOSS直聘、猎聘、前程无忧和公司官网。配置写入服务端 `.env`，密钥只保存原文，读取接口只返回掩码。

当前一期已经提供渠道定义、配置校验、连接测试、公司官网 Webhook HMAC 验签，以及数据库中的渠道连接、岗位发布、简历回流和同步运行预留表。BOSS直聘、猎聘和前程无忧在取得企业开放平台接口文档前，测试会返回「适配器尚未接入」，不会伪造连接成功。拿到官方文档后，只需在对应适配器内补签名算法、请求路径、响应映射和状态回传。

环境变量统一使用 `CHANNEL_<PROVIDER>_<FIELD>` 命名，完整键名见 `.env.example`。

## API

新版 API 使用 `/api/v1`，业务数据要求 PostgreSQL；不再提供整体状态 JSON 的读写接口。

## 大模型简历分析

默认不配置模型时使用内置规则评分，不会向任何第三方发送简历内容。要启用模型分析，在管理后台「AI 模型」填写并保存，或直接设置服务端环境变量：

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=你的模型密钥
OPENAI_MODEL=deepseek-chat
OPENAI_TIMEOUT_MS=30000
```

四项齐全才会启用。管理后台保存后写入 `.env`（`ENV_FILE_PATH` 优先，其次 `apps/api/.env`、仓库根 `.env`）并立即对当前进程生效，无需重启；读取接口只返回掩码，不回显密钥原文。

服务使用 OpenAI 兼容的 `chat/completions` 接口（连通性自检走 `/models`），可替换为 DeepSeek、通义千问、OpenAI 等兼容服务。密钥只保存在 API/Worker 服务器上。

启用后，在「简历库」上传 PDF/DOCX/图片简历即可获得模型生成的匹配评分、优势、风险和建议面试题；模型未配置、请求失败或返回格式不符时自动退回规则评分，招聘流程不会中断。

## 常见问题

- 页面仍显示旧的 `quarantined`：确认访问的是当前 API（默认 `3100`），只读核对数据库迁移台账与文件扫描状态；不要通过生产重启或开发种子尝试修复数据。
- 上传简历失败并提示对象存储不可用：确认 MinIO 容器在运行（`docker compose -f deploy/docker-compose.yml up -d minio`）且 `S3_ENDPOINT` 指向的地址可达；`.\start-local.ps1` 会在启动 API 前自动完成这步检查。
- 简历库没有数据：确认 API 与前端使用同一个 PostgreSQL 数据库，且 Web 的 `/api` 代理指向实际 API；不要只启动 Web。
- API 返回 502：通常是代理目标的 API 没有启动或端口不一致。检查 `http://127.0.0.1:3100/api/v1/health`，再检查 Web 的 `VITE_API_PROXY_TARGET`。
- 面试分段转写失败：先检查 `http://127.0.0.1:3100/api/v1/ready` 中 `externalServices.funasr` 和 `externalServices.fasterWhisper`；后备服务未配置时，FunASR 仍是唯一分段转写来源。
- 数据库连接失败：检查 PostgreSQL 是否启动、端口和账号是否正确；可先执行 `node scripts/check-postgres-ready.mjs`。
