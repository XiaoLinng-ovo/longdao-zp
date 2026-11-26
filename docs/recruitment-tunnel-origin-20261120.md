# 招聘公网入口与简历导入来源同步

## 问题

临时 Cloudflare 隧道重建后会更换域名。原隧道脚本只验证健康接口，不更新运行中 API 的 `ALLOWED_ORIGINS`，因此健康正常不代表登录后的企业选择、批次创建或文件上传可以提交。

过去的 `RESUME_UPLOAD_RELAX_ORIGIN=true` 仅放宽部分上传 POST 接口，不能覆盖完整简历导入流程，也不应当用作任意临时域名的通用放行方式。

## 启动方式

先启动完整的受管招聘服务，再在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-recruitment-tunnel.ps1
```

脚本从当前受管进程获取 Web 端口，不再假定是 5174。显式传入错误端口会失败，不会停止或修改占用该端口的其他项目。

隧道保留公网 Host，不再使用 `--http-host-header localhost`。带旧 Host 覆盖参数的连接器不会被复用，脚本会新建隧道，但不停止旧连接器或其他服务。

无论复用已有隧道还是新建隧道，都会在报告可用前执行：

1. 核对当前进程身份、受管发布版本以及本地和公网 API 身份。
2. 新版 API 在健康响应中声明 `originPolicy=same-origin`。本地及公网均确认新版且未启用旧上传放宽开关时，不修改配置、不添加白名单、不重启服务，直接验证新域名的写接口。
3. 仅对尚未升级的封存发布或仍启用 `RESUME_UPLOAD_RELAX_ORIGIN=true` 的环境，兼容旧同步流程：合并精确域名并设置 `RESUME_UPLOAD_RELAX_ORIGIN=false`，保留 CSRF、认证及企业权限检查。
4. 旧同步流程如需修改有效配置，预检当前已发布版本，保留原有数据库、密钥、存储和端口配置后重新加载；不构建源码、不执行迁移、不修改封存发布目录。
5. 检查企业写入、候选人、申请、简历、上传批次、文件内容及取消批次共七类接口，每类检查有效来源、缺少令牌、陌生来源三个条件。
6. 新版检查失败时不改配置、不重启，也不自动回退旧同步流程。旧流程检查成功后原子保存配置；重载或接口检查失败时尝试恢复原服务，不报告隧道可用。

检查只使用随机 CSRF 测试令牌和空 JSON，不携带用户登录会话。正确来源应通过来源校验并停在 `401 AUTHENTICATION_REQUIRED`；缺少令牌和陌生来源分别应返回 `403 CSRF_TOKEN_INVALID` 和 `403 CSRF_ORIGIN_MISMATCH`。这不是实际简历上传、解析或 AI 计费测试。

## 边界

- 新版部署支持任意同域网站入口，不依赖此脚本同步白名单。脚本另外提供运行身份和接口安全检查；尚未升级的旧版仍需脚本同步配置。
- 新域名不会继承旧域名的浏览器登录 Cookie，需要重新登录。
- 新版域名轮换不会重载服务。兼容旧版或关闭旧放宽开关时可能短暂重载；未输出 ready 前请勿重复启动。
- 运行期同步锁位于 `logs/runtime/tunnel-origin.lock`。中断后如遇锁冲突，应核对记录的 PID 和服务状态，不能未经核对直接删除锁。
- 未开放 `*.trycloudflare.com`，也未关闭 CSRF。非受管或不完整的服务会被拒绝，需先恢复完整受管运行环境。

## 回归测试

```powershell
node --test scripts/tests/runtime-tunnel-origin.test.mjs
```

涵盖新版域名轮换无配置写入及无重启、旧版兼容、幂等复用、端口与进程隔离、保留环境覆盖、失败恢复、并发配置保护及完整简历生命周期来源探测。

## 2026-11-24 发布回归防护

此次排查发现源码已支持同域校验，但实际运行的 `business-20261123-required-todos-r1` 封存发布未包含该修复，健康响应也未声明 `originPolicy=same-origin`。不能仅凭工作区源码或健康接口 HTTP 200 判断修复已部署。

- 新候选版本构建完成后，执行隔离的来源安全验收；切换到不同发布目录时，`runtime:doctor` 和 `runtime:start` 同样执行该验收。原发布的普通重启和失败回滚仍可使用原配置。
- 验收加载候选版本自身的编译 API 和网关，在随机本地端口和临时内存环境中模拟两个新网站域名，覆盖七类写接口，共 42 次请求；测试进程不继承数据库、存储、配置文件、会话或 Node 注入参数。
- 即使配置仍为旧域名，新域名的同域请求也必须通过来源校验并停在未登录；缺少 CSRF 令牌与跨站请求仍须被拒绝。健康能力声明存在但实际行为错误，也不能通过验收。
- 显式停止受管服务后，核验 PM2 状态；若晚到的退出事件留下 `waiting restart` 状态，再次停止该受管角色，不能把未确认停止的实例直接交给配置切换流程。其他项目不受影响。
- `scripts/tests/deployment-origin.test.mjs` 支持用 `SMARTRECRUIT_ORIGIN_TEST_RELEASE` 指定封存候选目录，避免只测工作区却漏测真正部署的产物。

```powershell
node --test scripts/tests/runtime-origin-check.test.mjs scripts/tests/runtime-management.test.mjs scripts/tests/runtime-tunnel-origin.test.mjs
```

### 本次实际验收与发布状态

- 候选版本：`business-20261124-tunnel-origin-r2`，从当前封存发布复制后仅补齐同域安全校验、代理地址识别、网关及相关启动检查；其他业务源码、前端资源和依赖已逐文件核验保持不变。
- 网关、运行管理、来源发布门禁和隧道测试共 46 项通过；直接针对候选发布包的域名轮换、认证、CSRF 及合成简历上传集成测试另 1 项通过。隔离发布门禁覆盖 42 次请求。
- 首次正式只读预检被 `companyDataConsistency` 的 `DATA_PATH_CONFLICT` 拦截，未切换服务。复核确认企业 `00000000-0000-4000-8000-000000000028` 的 `audit_logs` 仅缺少 1 条原始记录，`company-only=0`、`conflicting=0`。随后用户明确授权先备份、补齐此记录再发布。
- **已完成备份及恢复演练**：最终冻结备份位于 `C:\Users\小刘LLL\AppData\Local\SmartRecruit\tunnel-origin-audit-backup-2026-11-24T01-56-13-117Z`，使用仅当前账户可访问的 ACL；保留完整数据库 dump、无密码角色定义、有效配置、原始审计事件及校验记录。dump SHA256 为 `c75bacbaf96ae8d6bd7a69b8e662f530d523cb55c351a68a34e56afbbccc9067`。独立 PostgreSQL 恢复后，所有表数据指纹、结构、所有者和权限均匹配；补齐演练及候选版本预检通过，独立实例已停止。
- 在线备份的第一次尝试因后台正常更新其他表而触发全表指纹保护，未写生产数据。未降低校验标准；改为停止本项目三个受管角色并在同一冻结事务内备份、演练和正式补齐。旧版本重启同样受缺失日志门禁阻挡，因此维护期间保持停写，不绕过发布保护。
- **只补齐 1 条审计记录**：从 `public.audit_logs` 原样复制 ID `51a51a27-588d-442f-b364-d87bd5f059b1` 到对应企业表，原始行 SHA256 为 `9c107ea2fba0ce29ec0b8f9c59e5bcba34077800e427443d3c815efa22539001`。事务中核验来源和目标完全相同；去除新插入 ID 后企业日志指纹与备份一致，其他所有表指纹不变。没有删除、覆盖已有日志或执行数据库迁移。修复摘要位于 `logs/runtime/audit-repair-tunnel-origin-20261124.json`。
- **已正式上线**：`business-20261124-tunnel-origin-r2` 于北京时间 2026-11-24 10:02 激活。发布预检全部通过，本地及公网健康响应均确认 `originPolicy=same-origin`，公网七类写路径的 21 次安全探测通过。数据库、密钥、存储、端口等业务环境和有效配置文件保持不变。发布结果位于 `logs/runtime/deployment-tunnel-origin-20261124.json`。
- **真实公网域名轮换验收通过**：原入口 `https://twist-brook-sterling-dictionary.trycloudflare.com` 及临时第二入口 `https://reflections-pressure-attempting-balloon.trycloudflare.com` 均未列入 `ALLOWED_ORIGINS`，均通过七类写路径检查，`reloaded=false`；配置文件、活动版本状态和三个角色的启动计数文件完全不变。临时测试连接器已关闭，原入口保留。验收结果位于 `logs/runtime/tunnel-rotation-verification-20261124.json`。
- 浏览器验收确认原公网入口正常显示登录页。线上安全探测不携带登录会话，不冒充真实用户的完整上传或 AI 解析验收；合成简历生命周期已在实际发布包的隔离集成测试中验证。CSRF、认证和陌生来源拒绝仍然生效，没有开放域名通配符。

## 固定正式域名预配置（2026-11-24）

- 用户指定正式域名为 `https://zhaopin.longdaoec.com`。已备份本机 `.env` 后，仅向其 `ALLOWED_ORIGINS` 追加此精确 HTTPS 来源，原有配置和来源全部保留；根配置示例、Linux 生产模板及旧 Compose 入口同步保留该域名。没有修改活动封存发布或为此重启业务服务，当前已上线的同域策略无需此项重启即可接受正式域名。
- 后续候选发布的来源门禁增加正式域名，共检查三个来源、七类写路径、三类安全条件，合计 63 次请求；生产 Docker 镜像构建也执行隔离门禁。实际发布包的合成候选人、申请、简历上传测试使用正式域名，未向正式域名服务器写入测试数据。
- DNS 与服务器入口是另一个部署前置条件。本次实测该域名已解析到 `60.204.216.128`，但 HTTPS `/api/v1/health` 返回 Nginx 404，不是招聘 API；本轮没有可用的目标服务器连接配置，未修改其 DNS、TLS 或 Nginx。应用侧准备完成不等于公网固定入口已上线。正式接入步骤见 `deploy/PRODUCTION.md` 的“固定正式域名”。
- 当前线上网关以正式域名 Host/Origin 模拟请求的 21 次安全检查通过，候选发布隔离门禁的 63 次检查及实际封存版本的合成上传集成测试通过；48 项网关、运行管理和来源门禁回归通过。服务未重启，未写业务数据，配置核验只改变 `ALLOWED_ORIGINS`。证据位于 `logs/runtime/formal-domain-preconfiguration-20261124.json`。本机 Docker daemon 未运行，尚未执行完整镜像构建，不能以静态 Dockerfile 检查冒充镜像已构建成功。
