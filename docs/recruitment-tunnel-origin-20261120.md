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
