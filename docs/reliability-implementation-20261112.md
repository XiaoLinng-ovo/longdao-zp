# 四阶段可靠性实施与验收

日期：2026-11-12。本次只修改源码、构建并使用本机随机临时数据库回归；没有对业务数据库执行迁移、没有修改现有模型或 SMTP 配置、没有真实收付款或外发邮件。临时 Tunnel/公网方案保持不变。

## 第一阶段：支付与管理员边界

- 续费根据同一套餐/目录及权益容量判定，不再因价格、描述或有效期调整被错误视为换购；席位、岗位、模块和额度配置不同仍视为权益变化。无历史订单快照时才兼容历史 plan ID 判定。
- 结算与展示共用续费规则；同权益续费从尚未到期的服务截止时间延长，不吞掉剩余服务期。
- refund_pending 历史退款不再被近七天订单窗口漏掉；优先轮询久未检查的记录，保留查单节流和并发认领。未实现退款指数退避和自动报警。
- 唯一系统管理员由部署端 SYSTEM_ADMIN_USER_NO 绑定不可变账号编号；请求实时核验账号启用状态，不接受企业角色或历史 platform_operators 表提权。
- 历史平台授权目录只读，授权写接口返回 410；provision-platform-operator 脚本停用。企业内普通成员平权，旧角色/审批字段仅为历史兼容，不恢复审批入口。
- API、计费流式接口和生产 Web 代理对异常 URL 返回错误，不因 URL 构造异常崩溃。

## 第二阶段：隔离、事务与恢复

### 公司数据

这是同一 PostgreSQL 实例内按公司 UUID 分配 company_<32位十六进制> Schema，不是每公司单独的物理数据库。账号、企业成员、订阅、支付、投递记录及清理队列保留在 public。姓名不是主键；同名企业、用户、候选人不据此合并。

- API 的企业上下文来自已认证会话；X-Workspace-Id 仅断言当前页面企业，不允许客户端选择任意 Schema。
- API 和 Worker 使用同一 TENANT_SCHEMA_ROUTING=on 开关；未精确设为 on 时保持旧路径，不允许一边切换一边继续写另一条路径。
- API 请求和后台发现检查公司业务表、字段类型和可空性；不完整的公司拒绝处理，避免缺表沿 search_path 回退 public。仍不把本功能当作独立数据库账号级隔离；数据库管理员和应用数据库凭据仍是受信任边界。
- 0093 同步已有公司缺失的简历导入历史字段。后续新增业务表/字段时，应同步公司 Schema 和完整性清单。
- Worker 在一个进程内共享 FIFO 总并发预算和控制连接池；不是跨多个 Worker 进程的全局分布式限流。连接归还前 RESET search_path；失败销毁连接。

### 入职材料

锁定当前公司的父入职记录后再检查状态、修改材料并写入审计，均在同一事务内。跨公司返回 404，手工重复 code 返回 409，取消/未到岗记录拒绝更新，已完成记录允许补充。初始化保留必要的 upsert，不混用手工覆盖逻辑。

### 文件清理

候选人数据库删除事务只登记 public.object_cleanup_tasks，不在提交前删除物理文件。API 后台认领清理任务，失败保留并重试，仍有引用的文件不删除。当前实现使用五分钟可重试租约；保留引用的任务继续待查，不宣称已经物理清除。完成记录可用于审计，不自动清空。

### Offer 邮件

- 发送前持久化版本预留和固定 Message-ID，发送中阻止 Offer 变更；多个请求不能同时发同一业务版本。
- 状态为 sending、accepted、unknown、completed 或 not_sent；SMTP 结果不确定时不自动重发，避免重复投递。
- SMTP 连接/握手和 socket 都有超时，检查 accepted/rejected。SMTP 接收成功不等于最终进入收件箱。
- 唯一系统管理员 GET /api/v1/admin/email-deliveries 查看未决记录；POST /api/v1/admin/email-deliveries/:id/resolve 提交 status 与 note。需合法会话、CSRF 及至少五字核对说明。此轮提供的是管理 API，并未增加专门核对页面。
- 先依据 Message-ID 查询 SMTP 服务商日志或人工核实：确认未发出填 not_sent，之后可重新发送；确认已被接收填 completed，将投递、Offer、申请状态和业务审计一起提交。
- 活跃 sending/accepted 十分钟内不允许人工认定；旧版本、错误公司路径、未就绪公司及隔离开关不匹配时拒绝恢复。不得只改数据库投递状态而遗漏业务记录。
- 网络超时和数据库失败之间无法在 SMTP 协议上保证严格的恰好一次；本实现选择阻断重试并人工核实。此持久化流程针对 Offer，不承诺所有其他类型邮件都有相同恢复能力。

## 第三阶段：流程和语音验收

数据库验证包含两家同名公司、同名用户、48 份并发简历及后台处理、跨公司访问、候选人删除、材料更新与审计回滚、8 个同时发信预留仅一个成功、邮件恢复事务回滚及文件清理失败重试。简历内容和模型均为测试夹具；不代表真实 OCR/模型吞吐压测或多进程容量结论。

SMTP 使用本机协议服务器验证认证、信封、正文、PDF 附件与拒收；没有向真实邮箱发送测试邮件。真实环境需另行确认服务商授权码、TLS、发件域认证、配额、垃圾邮件策略与实际收件情况。

语音离线测试覆盖转写客户端、PCM 处理、片段合并、角色处理、重试与回退等，但没有标准答案的真实面试录音，不能宣称已解决实际准确率。没有改用户现有模型配置。

增加离线中文字符错误率工具：

~~~powershell
node scripts/evaluate-transcription.mjs --input D:/验收/语音样本.json --max-cer 0.15
~~~

输入为 JSON 数组，形如 [{"id":"场景1","reference":"人工逐字校对文本","hypothesis":"同一音频的识别输出"}]。标点、空白、大小写和全角格式归一化后计算编辑距离；总 CER 按参考字符数加权。完全识别失败也必须纳入，不能只选成功片段。报告不回显文本。每段最多 5000 字；长录音先按一致边界切分。

0.15 仅为演示阈值，不是通用质量标准；CER 可能超过 1，不能机械换算为准确率。应分别验收近讲、远场、多人抢话、方言/口音、专业词，并人工检查说话人和时间戳。CER 不衡量角色归属，也不能证明转写没有语义错误。

## 第四阶段：工程与安全

- 默认 API/Worker 单元测试仅根据现存源文件寻找编译产物，不再误跑孤儿 dist 或需要业务库的集成测试。
- 全局类型检查包含 API、Worker、Web 与共享类型包。独立数据库测试显式校验随机库名和本机地址，失败也销毁临时库。
- source-map-js 升级到 1.2.2；前端构建/测试工具及相关传递依赖更新后重新审计与回归。精确版本以 pnpm-lock.yaml 为准。
- .env 不受 Git 跟踪；定向检查未发现新增模型调试开关、原始模型结果日志或明显内嵌私钥。扫描不是完整渗透测试，不能作为绝无后门、无恶意依赖或无数据外传的数学证明。
- 配置模型、OCR、SMTP、支付和招聘渠道后会发生对应业务外连；须按实际配置审核接收方。未配置模型不等于所有外部服务都被禁用。
- 未删除用户既有日志、备份、未提交变更或业务数据；未提交 Git。

## 本轮自动化验收证据

以下是 2026-11-12 本地执行结果，不等同于已对业务实例部署或完成真实服务验收：

| 验证范围 | 结果 | 证据路径（项目根目录下） |
| --- | --- | --- |
| API 单元/HTTP/协议测试 | 1177 项通过 | tmp/reliability-api-verified.log |
| Worker 单元测试 | 102 项通过 | tmp/reliability-worker-verified.log |
| 前端测试 | 148 个文件、1410 项通过 | tmp/reliability-web-final.log |
| 共享包测试 | 109 项通过（23 + 2 + 79 + 5） | tmp/reliability-packages-verified.log |
| 工程脚本和语音评估工具 | 36 项通过 | tmp/reliability-scripts-verified.log |
| 类型检查 | API、Worker、Web、contracts、resume-intelligence 全部通过 | tmp/reliability-typecheck-final.log |
| 全量构建 | 通过 | tmp/reliability-build-verified.log |
| 生产/全依赖审计 | 均未报告已知漏洞 | tmp/reliability-audit-prod-final.log、tmp/reliability-audit-all-final.log |

公司隔离报告：tmp/schema_verify_00d3c3bec1e446b9a660ce8b9dd526b0/report.json。独立随机库执行全部 92 份迁移（编号至 0093），两公司共 48 次并发上传和 48 项后台处理完成；缺表/缺字段拒绝、跨公司访问、材料审计回滚、邮件竞争/人工恢复、文件重试清理均通过。测试使用本机替身模型，不是 48 路真实模型或 OCR 压力测试。

支付与迁移报告：tmp/payment_verify_9c137a3c2ae04bcead0214ba2d6a4773/report.json。payments、payments.http、payment-product-versions、configurable-billing、enterprise-continuity、alipay-bills、payment-cancellation、payment-order-environment、migrations 共九组独立随机库测试全部通过；包括 90 天历史退款恢复、调价续费保留剩余时间、并发下单、重复通知、取消与迁移修复。

以上数据库报告均记录 scratchDatabaseRemoved=true。最终检查本轮 PostgreSQL 实例仅余 postgres/template0/template1，已正常关闭端口 15439 的本轮临时服务；未停止用户既有服务。

构建工具更新为 Vite 6.4.5、Vitest 4.1.12；依赖安全覆盖固定 source-map-js 1.2.2 和相关 minimatch 补丁。前端旧测试曾把共享额度表误当调用记录表，现按表格无障碍名称限定选择器，未删除权限或隐私断言。音频测试替身显式声明 Promise<void>，兼容新版 mock 类型；导航首次加载测试放宽到 15 秒，业务断言保持不变。

依赖命令仍有包管理器 url.parse() 弃用提示、whatwg-encoding 弃用提示，以及构建时 npm 对 recursive 环境变量的兼容性警告；这些不影响本轮通过，但不应将“审计无已知漏洞”理解成没有维护事项。git diff --check 通过，Git 仅提示部分文件将按本机规则转换行尾。

## 安全上线与回退

1. 备份 PostgreSQL、对象存储以及 AI/支付加密主密钥和运行配置，验证恢复能力。禁止输出密钥到日志。
2. 先在独立环境构建并回归，核对目标数据库。停止 API 写入口与 Worker/后台消费者；停止所有仍写旧 public 的实例。
3. 只读执行 npm run db:status 核对待迁移清单，经人工确认后再执行 npm run db:migrate。0093 是新增迁移，不应手工修改历史台账冒充已执行。
4. 保持写入暂停，执行 npm run db:schemas:check；计划从旧 public 切换时再执行 npm run db:schemas:check -- --compare-legacy。检查仅开启只读事务；不自动建表、覆盖或删除业务数据。
5. initialize_organization_schema 对 ready 公司会直接返回，不会重新同步历史 public 快照。若逐行对比不一致，禁止直接切换：先保留备份，在独立副本设计并验证增量迁移，核实关联数据后再实施。对比为不含业务正文的差异计数，可能耗时，单条语句六十秒超时。
6. 处理未决 Offer 邮件和其他跨路径任务，保证所有实例使用相同数据路径；同步设置 API 与 Worker 开关，再启动消费者、写入口并做冒烟检查。
7. 若已在公司路径产生新写入，回退不能只把开关关掉，否则会读回过时 public。先暂停写入，根据备份、审计与新写入量选择迁移回合或恢复，核实后再恢复服务。

代码已准备不等于业务实例已升级。本轮没有替用户执行以上正式切换和迁移步骤。

## 复测命令

~~~powershell
pnpm typecheck
pnpm build
npm --prefix apps/api test
npm --prefix apps/worker test
pnpm --prefix web test
pnpm --filter './packages/*' test
node --test scripts/tests/*.test.mjs scripts/serve-web-production.test.mjs
pnpm audit --prod
pnpm audit
~~~

数据库验收须显式提供本机独立 PostgreSQL 的 PGHOST、PGPORT、PGUSER、PGPASSWORD，清除 DATABASE_URL 覆盖；账号需能创建和删除临时库。不要使用业务实例权限做日常自动测试。

~~~powershell
npm run test:company-isolation
npm run test:postgres:reliability
~~~

测试脚本每次生成随机库、运行全部迁移并最终删除；进程被操作系统强制终止时可能留下临时库，须先核对报告和连接后人工处理，不能按模糊前缀批量删除。日志与报告保存在 tmp，默认不入 Git。

## 尚需真实环境验收

- 真实面试音频的识别错误率、角色归属和专业词。
- 已配置 SMTP 的真实授权、TLS、实际收件和垃圾邮件情况。
- 正式商户低金额支付、回调、退款与服务商账单核对。
- 业务历史 public 与公司 Schema 的一致性、备份恢复及实际切换。
- 多 Worker 进程、真实模型/OCR 服务压力和长期恢复演练。

整段音频后台任务仍采用当前进程调度及对象存储任务记录，不是跨进程数据库任务队列；本轮不能据此承诺进程重启后所有在途音频任务都会自动接续。
