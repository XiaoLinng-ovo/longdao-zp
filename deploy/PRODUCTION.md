# Linux 服务器部署

本包是源码和部署配置，不含 PostgreSQL 数据、用户账号、简历附件、面试录音、真实密钥或模型缓存。API、Worker、Web 在服务器构建；OCR 和语音服务可按需启用。建议先在测试库完成部署和恢复验收，再切正式域名。

## 配置

在解压目录执行以下命令，新建仅部署用户可读的配置文件（如果已有文件，不覆盖）：

```bash
umask 077
test -e deploy/runtime.production.env || cp deploy/runtime.production.env.example deploy/runtime.production.env
```

- 空库新装：设置 `PGPASSWORD`；用 `openssl rand -hex 32` 分别生成两项认证密钥。先配置 SMTP，再走产品注册流程。`SYSTEM_ADMIN_USER_NO` 绑定实际用户编号，不是邮箱；拿到编号后更新该值并重建 API 容器。不使用开发种子创建正式账号。
- 企业 AI 和支付配置分别使用 `AI_CONFIG_ENCRYPTION_KEY`、`PAYMENT_ENCRYPTION_KEY`，各用 `openssl rand -base64 32` 单独生成并妥善备份。迁移旧库时必须保留原值，否则无法解密已保存的配置。完整可选配置参考根目录 `.env.example`，但不要将其中开发用的 S3、数据库默认值直接用于生产。
- 迁移现有系统：先备份并在隔离环境验证恢复 PostgreSQL、对象文件和原运行配置。保留原有认证、加密和外部服务密钥；保留对象键和登记位置。若旧记录登记的是 Windows 本地存储路径，不要只复制附件并硬改路径。应先核对存储位置登记及历史读写映射并验证回放，否则就绪检查可能拒绝启动，或历史附件无法读取。
- 网页与 `/api` 通过同一个网站入口访问时，来源自动校验，无需填写网址白名单。正式域名或临时域名变化，不需要为此修改配置、重建容器。`ALLOWED_ORIGINS` 仅用于额外允许的跨域前端来源，默认留空；其中旧域名不会妨碍当前网站的同域请求。按业务配置 SMTP、AI、钉钉、支付、Turnstile 或对象存储。不要直接使用 Windows `.env`，也不要将真实配置写入镜像。
- 容器由环境文件注入配置。在服务器修改配置后重建容器生效，不依赖后台修改容器内的 `.env`。使用宿主机反代到 `127.0.0.1:5174`，传递 Host 和 HTTPS 协议信息，并支持 `/funasr-stream` 的 WebSocket 升级；不要把数据库、API 或模型服务直接暴露在公网。

来源判断同时核对协议、域名和端口，不使用 `Sec-Fetch-Site` 作为放行依据。Web 网关覆盖客户端传入的 `X-Forwarded-Host`；API 仅接受回环地址或可信代理传入的来源转发头。生产 Compose 已配置私有 Docker 网段的 `ORIGIN_TRUSTED_PROXY_IPS`，不要把公网地址加入此项。外层 HTTPS 反代须保留浏览器访问的 Host（含非默认端口），并覆盖 `X-Forwarded-Proto` 为实际协议；HTTP 与 WebSocket 均需如此。登录、企业权限及 CSRF Token 校验保持启用；更换域名后需要重新登录。

## 构建、检查、启动

需要 Linux Docker Engine、Docker Compose v2，以及访问基础镜像和依赖仓库的网络。以下 Bash 命令从解压目录运行：

```bash
dc() { docker compose --env-file deploy/runtime.production.env -f compose.production.yml "$@"; }
dc config --quiet
# 使用本机 PostgreSQL 容器时执行；若使用外部 PostgreSQL，跳过此行。
dc --profile local-db up -d --wait postgres
dc build api web
dc run --rm --no-deps api node scripts/migrate-postgres.mjs --status
```

仅在**新建空库**时，用以下命令初始化结构。已有业务库如有待迁移项，应先完成已批准的备份、恢复验证和维护流程，不要靠启动服务自动迁移。

```bash
dc run --rm --no-deps api node scripts/migrate-postgres.mjs
```

确认数据库结构已就绪，再启动应用并检查：

```bash
dc run --rm --no-deps api node scripts/migrate-postgres.mjs --check
dc up -d --wait api worker web
dc ps
curl -fsS http://127.0.0.1:5174/api/v1/ready
```

生产配置默认只发布 Web 的回环端口，PostgreSQL 和对象数据保存在独立卷。停止使用 `dc stop`，不要执行 `down -v` 删除卷。

## OCR 和语音

按需在配置文件中启用对应内网 URL，并启动需要的容器。模型由服务自行下载到独立卷，第一次启动较慢，取决于网络和服务器资源；先确认镜像依赖支持目标架构。也可配置已有的私有 OCR 或语音服务地址。

```bash
dc --profile ocr up -d --build ocr
dc --profile funasr up -d --build funasr
dc --profile whisper up -d --build faster-whisper
dc up -d --wait api worker
```

FunASR 离线地址为 `http://funasr:10095/transcribe`，实时流地址为 `ws://funasr:10095`；OCR 地址为 `http://ocr:8090`。只启动容器并不会自动启用对应功能，还须在运行配置中取消这些地址的注释，再重建 API 和 Worker。

新建环境至少验证登录、发验证码、简历上传和面试入口。迁移环境额外验证旧附件、面试录音、邀请、企业隔离和历史记录。实际启用了哪个语音服务，就走一遍对应的实时或离线转写。
