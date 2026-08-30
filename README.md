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
