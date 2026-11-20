# 源码部署包范围

此包用于在 Linux 服务器重新构建和部署系统，不是当前 Windows 机器的完整运行环境备份。部署步骤见 [PRODUCTION.md](PRODUCTION.md)，推荐入口为根目录 `Dockerfile` 和 `compose.production.yml`。`deploy/docker-compose.yml` 是旧的本地开发方案，不作为生产入口。

## 保留内容

- `apps/api`、`apps/worker`、`web` 的最新源码、类型定义和测试代码，包括已保存但尚未提交 Git 的新文件。
- `packages` 中全部共享模块，包括数据库结构契约、企业 AI、对象存储和运行生命周期模块。
- `db/migrations` 中全部 SQL 迁移文件，包括本次新增的企业 AI 自助配置和企业管理迁移；迁移文件不是业务数据库备份，不能排除。
- OCR、FunASR、Faster Whisper 的源码、依赖声明及各自 Dockerfile，模型在服务器按需下载。
- 依赖锁文件、构建配置、部署文件、配置模板、运维脚本及项目文档。历史设计草稿、补丁和截图不在部署包内。
- 自动生成的 `SOURCE-MANIFEST.json`，记录每个原始文件的大小及 SHA-256，便于确认传输和构建前的内容。

## 不需要打包的内容

| 类别 | 典型路径或文件 | 原因 |
| --- | --- | --- |
| 本机依赖与虚拟环境 | `node_modules`、`.pnpm-store`、`.venv` | Windows 依赖不适合直接复制到 Linux，由锁文件重新安装 |
| 构建与缓存 | `dist`、`dist-*`、`dist-test`、`.vite`、`__pycache__`、覆盖率 | 从当前源码重建，避免混入旧版本 |
| 真实配置与凭据 | `.env` 及备份、`runtime.env`、证书、私钥、隧道凭据 | 只带示例模板，真实配置通过安全渠道单独配置 |
| 数据与附件 | `data`、上传目录、简历、面试录音、会话状态、数据库转储 | 不属于源码；需要迁移时独立备份、恢复和验证 |
| 模型和下载缓存 | 模型权重、模型缓存目录 | 体积大且依赖运行平台，使用独立持久卷 |
| 日志、报告、旧压缩包 | `logs`、`reports`、`backups`、`artifacts`、`*.log`、`*.zip` | 对编译和启动没有作用，可能含敏感信息 |
| 本地工作痕迹 | `.git`、`.codex-*`、`.tmp-*`、`_tmp_*`、根目录一次性补丁 | 不属于服务器运行代码 |
| 用户文档和测试简历 | 根目录简历 DOCX、PDF 用户手册、截图 | 不影响部署；源码测试中依赖这些外部文档的用例需另外提供对应夹具 |

源码包保留测试代码，但 Docker 构建和生产启动不会执行测试或开发数据种子。静态凭据检查可以拦截已知密钥格式及本地环境文件中的敏感值，不能替代人工安全审查。源码中的 `web/src/shared/data` 是代码，不是运行数据，仍会保留。

## 重新打包与校验

在原始 Git 工作目录中先查看范围，再生成一个不存在的新文件（不会覆盖旧包）：

```bash
node scripts/package-server-source.mjs --dry-run
node scripts/package-server-source.mjs /absolute/path/SmartRecruit-source.zip
```

脚本读取当前磁盘文件，不使用旧提交快照。包内源码可在解压后校验（不需要依赖或数据库）：

```bash
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {createHash} from "node:crypto"; const m=JSON.parse(readFileSync("SOURCE-MANIFEST.json","utf8")); for(const f of m.files) {const b=readFileSync(f.path); if(b.length!==f.bytes || createHash("sha256").update(b).digest("hex")!==f.sha256) throw Error("Checksum mismatch: "+f.path)} console.log("Verified "+m.files.length+" source files")'
```

压缩包旁的 `.sha256` 文件用于上传前后校验 ZIP 本身；在压缩包所在目录执行 `sha256sum -c SmartRecruit-source.zip.sha256`（替换成实际文件名）。校验仅证明内容一致，不代表容器已经在目标服务器完成运行验收。
