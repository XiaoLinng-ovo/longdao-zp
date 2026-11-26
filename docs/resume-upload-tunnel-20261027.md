# 公网简历上传超时：Cloudflare 隧道恢复

日期：2026-10-27，Asia/Shanghai。

## 根因定位

旧入口 `https://vaccine-size-lucia-childhood.trycloudflare.com/candidates` 指向本机 5174，连接器 PID 10216 使用 QUIC。小请求可以完成，但需要完整读取请求体的大请求在隧道中阻塞。前端文件发送完毕后等待响应，后端尚未读完请求体，批次项因此保持 `pending_upload / attempts=0`。

使用没有真实账号的合成诊断请求，通过 `/api/v1/auth/login` 验证请求体是否被完整解析。预期结果为 `401 INVALID_CREDENTIALS`，不是测试账号登录成功；该接口只有读完合法 JSON 才能进行凭证校验。没有传输真实简历、用户凭证或调用 AI。

| 链路 | 内容 | 结果 |
| --- | --- | --- |
| 本地 API 3100 / 前端代理 5174 | 454 KiB 请求体 | 约 10 ms 返回正常校验结果 |
| 旧公网入口 | 小请求 | 约 1.5 秒返回正常校验结果 |
| 旧公网入口 | 454 KiB 请求体 | 15 秒仍不返回，探针超时 |
| 旧公网入口 | 3 路并发，每路 454 KiB 文件等效的 base64 JSON | 3 路全部超过 12 秒探针截止时间 |
| 新 HTTP/2 入口，同一个本地服务 | 同样 3 路并发请求 | 分别 921 / 1048 / 1053 ms 返回完整校验结果 |
| 新 HTTP/2 入口 | 700 KiB 文件等效的 base64 JSON | 约 1328 ms 返回完整校验结果 |
| 新 HTTP/2 入口，真实浏览器 XHR | 454 KiB 文件等效内容，JSON 实际发送 619959 字节 | 790 ms 返回完整校验结果 |

旧连接器 metrics 显示 QUIC 丢包、StreamDataBlocked，以及采样时 congestion window 为 0；新连接器日志确认 `protocol=http2`，同轮采样隧道请求错误为 0。结论限于本次旧 QUIC 连接异常，不声称 QUIC 协议在所有环境都不可用，也未对丢包的网络设备来源作无依据判断。

## 恢复措施

- 新增使用 **HTTP/2** 的招聘连接器，仍代理 `http://127.0.0.1:5174`，不改业务 API、数据库、文件安全策略或并发参数。
- 已验证的新入口为 `https://suzuki-arrested-avi-projected.trycloudflare.com/candidates`。临时隧道更换连接器后生成不同随机地址，旧地址不会自动迁移。
- 不停止旧连接器，避免影响尚未迁移的面试页和其他操作；其他项目 5173 的隧道不受影响。
- 新入口是不同 origin，浏览器可能需要重新登录。数据仍是同一个数据库，不是新环境。
- 新脚本 `scripts/start-recruitment-tunnel.ps1` 固定 `--protocol http2`、验证招聘 API 身份、隐藏启动、保存日志，并复用它已记录且验证正常的连接器。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-recruitment-tunnel.ps1
```

脚本运行状态保存到忽略提交的 `tmp/recruitment-http2-tunnel.json`。连接器退出后重新启动可能产生新地址，以脚本输出为准。没有修改系统 VPN、代理或防火墙。

脚本已在本机实际执行，成功验证并复用 PID 40456 的 HTTP/2 连接器，没有额外创建重复隧道。

## 与前一轮修复的关系

前一轮解决了错误隐藏、99% 封顶提示和响应丢失后错误重传，保留这些修复。此次提供实际公网 URL 后，成功复现了本地测试没有覆盖的隧道请求体阻塞。上述公网探针证明传输恢复，不等同于执行真实简历的付费 AI 解析；本地真实浏览器入库及响应丢失恢复测试见 `docs/resume-upload-99-percent-20261027.md`。
