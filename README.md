# SmartRecruit Pro

这是一个单页招聘流程演示。项目现在包含一个不依赖第三方包的 Node.js 后端，可直接部署到支持 Node.js 18+ 的服务器。

## 本地运行

```powershell
pnpm start
```

然后打开 <http://localhost:3000>。也可以使用 `node server.mjs` 启动。

## Docker 部署

```bash
docker build -t smartrecruit-pro .
docker run -d --name smartrecruit-pro -p 3000:3000 -v smartrecruit-data:/app/data smartrecruit-pro
```

服务器放行 TCP `3000` 端口后，通过 `http://服务器地址:3000` 访问。生产环境建议在前面配置 Nginx/Caddy 的 HTTPS 反向代理，并将 `/app/data` 挂载到可靠磁盘或改接数据库。

## 配置

- `PORT`：监听端口，默认 `3000`
- `HOST`：监听地址，默认 `0.0.0.0`
- `DATA_DIR`：状态数据目录，默认项目下的 `data/`
- `CORS_ORIGIN`：跨域部署时显式设置允许的前端源；同源部署无需设置

## API

- `GET /api/health`：健康检查
- `GET /api/state`：读取招聘系统状态；首次运行返回 404，前端会使用本地种子数据初始化
- `PUT /api/state`：保存完整状态 JSON

状态文件会以临时文件写入后原子替换，服务器重启后数据仍保留。当前 API 是单租户原型接口，尚未包含登录、权限、审计和数据库迁移，正式上线前需要补齐这些能力。

## 可选：接入大模型简历分析

默认不配置模型时，系统继续使用内置演示评分，不会向任何第三方发送简历内容。要启用真实分析，请将前端与本 Node 服务部署在同一域名，并在服务器环境变量中配置：

```bash
LLM_API_KEY=你的模型密钥
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
```

服务使用 OpenAI 兼容的 `chat/completions` 接口，可替换为通义千问、OpenAI 等兼容服务。正式部署时密钥只保存在服务器环境变量，禁止写入 `index.html`。Demo 也可从右上角「系统配置」临时输入 Key；该 Key 仅保存在当前页面会话内，刷新后自动清除。

启用后，在「简历库」中选择「导入简历并分析」，上传 PDF/DOCX 或粘贴简历文本即可获得模型生成的匹配评分、优势、风险和建议面试题。

Demo 也支持在右上角「系统配置」选择「直接访问 OpenAI/DeepSeek 兼容服务」，填写 `https://api.deepseek.com/v1`、`https://api.openai.com/v1` 或其他兼容地址，再输入 Key 测试模型列表。该模式会将简历文本从浏览器直接发送到你指定的服务商，仅建议用于演示；生产环境应使用后端代理模式。PDF/DOCX 会在浏览器本地提取文字，原始文件不会上传；老式 DOC 请先转换为 DOCX 或 PDF。模型未配置、请求失败或返回不符合格式时，系统自动退回默认评分，招聘流程不会中断。

如果前端部署在 Cloudflare Pages、后端部署在其他域名：可以直接点击页面右上角头像进入「系统配置」，填写后端地址并测试连接；也可以在 `index.html` 顶部配置行填写 `window.SMARTRECRUIT_API_BASE="https://你的后端域名"`。后端同时设置 `CORS_ORIGIN=https://longdao1.pages.dev`。未填写时，前端默认按同源后端工作。测试连接成功后会自动读取服务商支持的模型，选择后保存即可。

## Cloudflare Pages 部署

本项目已配置为 Cloudflare Pages 直传部署，不需要构建插件或 Node.js 运行时。PDF/DOCX 解析依赖按需从 CDN 加载，并在浏览器本地完成。部署命令如下：

```powershell
npx wrangler@latest pages deploy . --project-name longdao1 --branch main
```

`wrangler.toml` 中的 `pages_build_output_dir="."` 指向当前目录，`functions/` 会作为 Pages Functions 一起发布。当前已接入：

- `/api/health`：Pages 健康检查；
- `/api/state`：使用 Cloudflare KV 保存招聘流程状态；
- `/api/ai/*`、`/api/job-spec`、`/api/demo-resume`、`/api/resume-analysis`：AI 相关 Pages Functions。

当前 Cloudflare Pages 项目名是 `longdao1`，公共地址为 `https://longdao1.pages.dev`。

`server.mjs` 仍保留为支持 Node.js 的独立部署方案；使用 Pages 部署时，状态存储由 `functions/api/state.js` 和 KV 提供。

### Cloudflare Worker 代理

项目同时提供 `worker.mjs` 和 `wrangler.worker.toml` 作为独立 Worker 代理方案。部署 Worker 后，在 Cloudflare Worker 的 Variables 中配置 LLM_BASE_URL、LLM_MODEL，并用 Secret 配置 LLM_API_KEY。LLM_BASE_URL 可填写任意 OpenAI 兼容地址，例如 https://api.deepseek.com/v1 或 https://api.openai.com/v1，不会写死在代码中。前端「招聘后端代理」模式填写 Worker 地址，例如 https://longdao-ai-proxy.<你的子域>.workers.dev。

### AI API

- `GET /api/ai/status`：返回当前是 `default` 还是 `model` 模式，不暴露 API Key。
- `GET /api/ai/models`：使用后端 API Key 从 OpenAI 兼容服务读取模型列表；服务商不支持列表接口时返回后端默认模型。
- `POST /api/resume-analysis`：传入岗位信息和简历文本，返回结构化简历分析；未配置或模型不可用时返回默认模式。

# longdao-jianli
