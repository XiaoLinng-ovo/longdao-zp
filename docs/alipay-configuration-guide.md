# 支付宝配置操作手册

核对日期：2026-11-10。范围：企业套餐、沙箱联调、电脑与手机网站支付、退款和自动账单对账。本轮只查阅官方资料、检查当前代码并新增本说明，不执行迁移、不生成密钥、不发起支付或退款。

当前上线范围：本站支付宝新订单只开放电脑网站跳转支付，正式与沙箱一致。手机网站支付与本站扫码支付的资料仅供将来重新启用时参考；历史订单仍按原模式处理，查单、退款与账单对账不变。

## 1. 四份文档的适用范围

| 用户提供的文档 | 阅读结果 | 本项目如何使用 |
| --- | --- | --- |
| [旧版电脑快速接入](https://developer.alibaba.com/docs/doc.htm?articleId=105899&docType=1&treeId=193#s5) | 更新于 2017-09-01 | 理解支付、查单、退款、关单、账单及沙箱流程；菜单、示例需要与新版交叉核对 |
| [沙箱快速接入](https://opendocs.alipay.com/common/02kkv7) | 更新于 2026-03-26 | 当前沙箱应用、密钥、网关和测试账号的配置依据 |
| [交易收款](https://opendocs.alipay.com/open/01n2xg) | 更新于 2026-06-02；属于互联网平台直付通 | 二级商户进件、结算和分账场景，不直接适用于平台销售自有套餐 |
| [电脑网站支付 API](https://opendocs.alipay.com/open/028r8t?scene=common) | 更新于 2026-09-13 | 当前电脑跳转付款参数、产品码及错误码依据 |

业务假设：招聘平台运营公司销售自己的软件套餐，客户企业向平台付款，钱进入平台商家账号。因此采用“自研商家 + 网页/移动应用 + 平台自营收款”。客户企业不是支付宝二级商户，不需要各自配置支付宝商户。如果实际是代其他商家收款，应先重新设计授权、进件和结算，不能套用本手册。

补充总指南：[新版电脑快速接入](https://opendocs.alipay.com/open/270/105899)、[手机接入准备](https://opendocs.alipay.com/open/203/107084)、[手机快速接入](https://opendocs.alipay.com/open/203/105285)。控制台菜单可能调整，以当前账号实际界面为准。

## 2. 需要哪些官方接口

先完成产品签约、应用关联与权限检查，再使用同一环境的 AppID 和密钥调用；不是为每个 API 注册一个账号。

| 功能 | API / 官方文档 | 当前实现 |
| --- | --- | --- |
| 电脑网页付款 | [alipay.trade.page.pay](https://opendocs.alipay.com/open/028r8t?scene=common) | mode=redirect；FAST_INSTANT_TRADE_PAY |
| 手机浏览器付款（本站新订单停用） | [alipay.trade.wap.pay](https://opendocs.alipay.com/open/02ivbs?scene=21) | mode=wap；QUICK_WAP_WAY |
| 本站二维码付款（本站新订单停用） | [alipay.trade.precreate](https://opendocs.alipay.com/open/02ekfg) | mode=qrcode；须另确认当面付产品权限 |
| 主动查询 | [alipay.trade.query](https://opendocs.alipay.com/open/bff76748_alipay.trade.query?scene=23) | 通知丢失、状态未知时查询 |
| 关闭未付交易 | [alipay.trade.close](https://opendocs.alipay.com/open/8dc9ebb3_alipay.trade.close?scene=common) | 不能代替已付订单退款 |
| 管理员退款 | [alipay.trade.refund](https://opendocs.alipay.com/open/f60979b3_alipay.trade.refund?scene=common) | 当前业务流程为整单退款，不等于已实现多次部分退款 |
| 退款查询 | [alipay.trade.fastpay.refund.query](https://opendocs.alipay.com/open/357441a2_alipay.trade.fastpay.refund.query?scene=common) | 使用原退款请求号 |
| 官方账单地址 | [alipay.data.dataservice.bill.downloadurl.query](https://opendocs.alipay.com/open/02ivbw) | bill_type=trade，后端立即下载 |
| 支付异步通知 | [手机通知](https://opendocs.alipay.com/open/203/105286)、[电脑通知](https://opendocs.alipay.com/open/270/105902) | 支付宝 POST 本站 notify_url，不是本站额外调用一个 API |

电脑收银台自己显示的二维码仍属于电脑网站支付页面流程，不等于本站直接调用 precreate。企业选择支付宝后，付款方式固定为“跳转支付”。

## 3. 正式商家与应用准备

1. 确认平台运营公司的支付宝商家账号、实名主体与实际收款方。按当前审核要求准备经营材料、网站/移动网站地址等，准入与费用以签约为准。
2. 登录[开放平台](https://open.alipay.com/)，按自研商家创建“网页/移动应用”，记录正式 AppID。不是小程序或服务商第三方应用。
3. 按[手机接入准备](https://opendocs.alipay.com/open/203/107084)完成开发设置、必要的商家账号绑定/关联和应用上线审核。应用上线不代表支付产品已开通。
4. 在商家平台产品中心开通“电脑网站支付”，核对应用关联及产品生效状态。已开通产品不必重复申请。
5. 当前不需要开通“手机网站支付”或“当面付”。将来确有本站二维码需求时再评估当面付准入，不应为测试申请不符合真实经营场景的产品。
6. 记录签约收款商家的 UID/PID，供 sellerId 使用。它不是 AppID，不是买家 UID，也不是登录手机号。

沙箱可先于正式签约联调，但不能替代商业审核。[官方沙箱说明](https://opendocs.alipay.com/common/02kkv7)

## 4. 加签配置与密钥填写

依据：[接口加签方式](https://opendocs.alipay.com/common/02mriz)、[设置密钥](https://opendocs.alipay.com/common/02kdnc)。当前系统只实现“公钥/密钥模式 + RSA2”，要求至少 2048 位 RSA 和 PEM 格式。

1. 在应用开发设置中选择密钥加签，使用官方工具生成 RSA2 密钥对，按官方指引配置；沙箱也可从对应应用获取系统分配的密钥。
2. 应用公钥交给支付宝验签。应用私钥保存在平台受保护的后端配置，不能放前端、代码仓库、日志或聊天中。
3. 获取该环境的支付宝公钥，供本站验证支付宝响应和通知。不要把应用公钥填进“支付宝公钥”。
4. 保留 PEM 头尾和换行，通常私钥为 BEGIN PRIVATE KEY，公钥为 BEGIN PUBLIC KEY。控制台如仅提供 Base64 正文，按官方格式说明转换为对应 PEM，不要把证书内容当公钥正文填写。
5. 当前不支持接口内容 AES 加解密，不要启用该选项。本站 PAYMENT_ENCRYPTION_KEY 是数据库配置保护主密钥，不是支付宝 AES 密钥或 RSA 私钥。
6. 当前未实现证书模式的序列号、证书链及更新管理；已有证书应用不能仅粘贴 crt 就用。须补充证书支持或另行评估应用方案，不能擅自切换正在收款的应用。

官方规定同一 AppID 只能使用一种加签模式，转账和红包等资金支出产品要求证书。本项目是订单原路退款，不是向成员转账，不需顺带开通转账产品。[加签适用范围](https://opendocs.alipay.com/common/02mriz)

## 5. 服务器与公网域名

下面 pay.example.com 是占位域名，必须替换为实际受控的公网 HTTPS 域名。当前要求根地址、标准 443 端口，不支持 localhost、IP 或子路径。

```dotenv
PAYMENT_ENCRYPTION_KEY=<32字节随机值的Base64编码，妥善备份>
PAYMENT_PUBLIC_BASE_URL=https://pay.example.com
PAYMENT_BILL_AUTO_ENABLED=true
PAYMENT_TRUSTED_PROXY_IPS=
```

代理列表仅填可信、会清洗并追加转发头的反向代理 IP，不使用时留空。进程变量优先于环境文件；之后是 ENV_FILE_PATH 指定文件及应用/仓库候选 .env，需确认实际服务读取位置。前后端分域还须满足现有会话、CORS_ORIGIN、Origin 和 CSRF 策略。

部署人员完成 API 构建后可用项目脚本生成或保留主密钥，脚本写入服务端环境文件、不打印值；先确认目标环境并备份：

```powershell
pnpm --filter @smartrecruit-pro/api build
node scripts/provision-payment-encryption-key.mjs
```

以上是待执行说明，本次未运行。不要每次发布重生成主密钥，否则历史渠道无法解密。保护环境文件并离线备份主密钥及数据库。

反向代理同时满足：

- /api/v1/payments/webhook/<渠道UUID> 到 API，允许公网表单 POST；不要求用户登录、CSRF 或交互验证码，但必须通过业务验签。
- 其他支付与管理 API 保留身份、企业成员、管理员、Origin 和 CSRF 检查，不可豁免整个 /api。
- /enterprise/payments/<订单UUID> 到前端 SPA，深链接刷新不能 404，不能错误转到 API。
- 不改写通知正文、不强制回调跳转登录页；有效通知处理后响应纯文本 success，不是通用 JSON。

## 6. 数据库与发布

新增 0086_alipay_bills_wap.sql 只在隔离测试库验收过，不能认为业务库已经执行。

1. 备份目标库，确认可恢复；发布包包含匹配的 SQL、API 和前端构建。
2. 已构建 API 后运行 npm run db:status，只读核对目标库及全部待迁移文件。
3. 审核实际升级范围；db:migrate 或 deploy:api 会执行全部待迁移文件，不仅 0086。
4. 选择 db:migrate、db:check 后由既有进程管理器发布，或选择 deploy:api 在迁移成功后启动 API；不必重复两条发布路径。
5. 发布前端并复查域名与会话。普通重启不会自动迁移。

详细流程见 [database-upgrades.md](database-upgrades.md)。本次没有连接或迁移业务库、发布或重启服务。

## 7. 沙箱配置与联调

先看[新版沙箱升级说明](https://opendocs.alipay.com/common/097l48)：新旧沙箱独立，旧 AppID、旧账号和旧钱包不能与新版网关混用。

1. 登录[沙箱控制台](https://open.alipay.com/develop/sandbox/app)，如仍为旧版，按官方指引升级。选择网页/移动应用，记录当前沙箱 AppID。
2. 从当前沙箱应用公钥模式的配置中获取应用私钥、支付宝公钥和网关；使用自定义密钥时先完成对应公钥配置。不混用正式环境密钥。
3. 从账号区域读取沙箱商家 UID/PID，以及沙箱买家账号、登录和支付资料。sellerId 填商家 UID，不是买家 UID。不得把账号密码或私钥发进聊天。
4. 当前新版沙箱网关固定为 https://openapi-sandbox.dl.alipaydev.com/gateway.do，正式网关为 https://openapi.alipay.com/gateway.do。系统按环境选择，不需要后台输入网关。
5. 以系统管理员登录本站，打开 /platform/payments，展开“新增收款渠道”，按下表填写并记录操作原因；保存后显式启用渠道。

| 本站字段 | 沙箱填写 | 正式填写 |
| --- | --- | --- |
| 渠道名称 | 支付宝沙箱联调 | 支付宝正式收款 |
| 接口类型 | 支付宝官方 | 支付宝官方 |
| 支付宝环境 | 沙箱测试 / sandbox | 正式收款 / production |
| appId：应用 App ID | 当前新版沙箱 AppID | 正式应用 AppID |
| sellerId：收款方 seller_id | 新版沙箱商家 UID/PID | 关联签约的实际收款商家 UID/PID |
| privateKey：应用 RSA 私钥 | 与沙箱应用公钥匹配的 PEM 私钥 | 与正式应用公钥匹配的 PEM 私钥 |
| publicKey：支付宝公钥 | 当前沙箱支付宝公钥 PEM | 当前正式支付宝公钥 PEM |
| 操作原因 | 本次联调目的 | 正式上线或渠道变更原因 |

6. 管理员发布测试套餐，设置名称、金额、期限、席位和岗位等权益。使用隔离测试企业；启用沙箱渠道后企业付款页可能看见它，不要无控制地暴露给真实客户。
7. 有效普通成员打开 /enterprise/payments，选择企业、测试商品和支付宝沙箱渠道。下单后点“前往支付平台付款”，在支付宝电脑收银台验证。
8. 使用沙箱买家付款。需要扫码/唤端时使用当前沙箱控制台提供的匹配沙箱 App，不用真实支付宝扫码。
9. 核对服务端通知验签、订单号、金额、AppID、sellerId，以及主动查询结果。当前沙箱已付款进入 review，注明不发放正式套餐；不要将“未开套餐”误认为支付失败。
10. 受控验证重复通知、断网后查询、重复点击、同企业另一成员继续既有待付单、跨企业越权拒绝。正式权益开通需隔离自动化测试与正式小额验收补充，沙箱不会发放正式权益。
11. 仅对受控测试单验证退款与关单，退款操作由系统管理员执行并保持原请求号。沙箱 review 不保证能直接走正式 paid 订单的后台退款路径；如被状态校验拒绝，应补充受控测试设计，不能直接修改业务库状态绕过。

[官方设备限制](https://opendocs.alipay.com/common/097oft)当前列明：沙箱 App 不支持 iOS、Android 6 及以下、Android 14 及以上和模拟器；鸿蒙默认浏览器手机网站支付无法唤起沙箱 App。唤端联调用受支持真机。这不意味着正式手机网站支付不支持 iPhone。[支持的产品范围](https://opendocs.alipay.com/common/097jyi)明确包含电脑网站支付和手机网站支付。

## 8. 回调地址如何配置

以下域名及 UUID 为占位符，不可照抄。系统创建订单时自动生成，无需管理员为每笔订单手填：

```text
notify_url = https://pay.example.com/api/v1/payments/webhook/<渠道UUID>
return_url = https://pay.example.com/enterprise/payments/<订单UUID>?workspace=<企业UUID>
quit_url   = 与该订单 return_url 相同（当前手机支付实现）
```

- notify_url 是支付宝服务端推送结果的地址，后端在支付请求中传入，必须公网可达。
- return_url 是前台付款返回入口；quit_url 是中途退出入口。页面参数不代表已付款，最终以验签通知或签名查单为准。[手机快速接入](https://opendocs.alipay.com/open/203/105285)
- 控制台“应用网关”用于部分产品/订阅消息，不是支付通知地址的同义配置。[应用网关官方说明](https://opendocs.alipay.com/common/02qibh)明确支付结果按支付 API 的 notify_url 推送。
- “授权回调地址”用于 OAuth 或商家授权，本项目自营收款不必为买家额外接 OAuth，也不需 app_auth_token。
- 小程序服务器域名、H5 域名、openURL 配置不是普通浏览器手机网站支付的通用必填步骤，不应照搬。
- 银行卡冲退完成属于单独 From 消息，当前 webhook 不是通用消息网关，不要直接填写为全部订阅消息的接收地址。退款处理成功与银行卡最终到账是不同状态，后者需另接通知或查询字段。

## 9. 手机网站支付专项验收（重新启用时参考）

依据：[手机快速接入](https://opendocs.alipay.com/open/203/105285)和[WAP API](https://opendocs.alipay.com/open/02ivbs?scene=21)。

1. 正式商家已开通手机网站支付、应用关联及加签检查通过；沙箱成功不证明正式权限已生效。
2. 普通手机浏览器打开本站，登录并选择企业、商品、官方支付宝渠道和手机网站支付；不需要另建小程序或原生 App。
3. 后端生成 WAP 支付请求，使用 QUICK_WAP_WAY，成员通过付款按钮跳转。金额由服务端商品快照决定，不能信任前端改价。
4. 分别验收已安装/未安装支付宝、付款成功、中断、切回浏览器、登录过期后重新登录、网络异常和重复点击。
5. iOS 正式付款后可能需要用户手动切回浏览器，不应因此重建订单；始终能继续查看原单。
6. 微信内置浏览器或任意 App WebView 不等同于普通手机浏览器；嵌入式场景按官方对应方案另行验收。

当前官方支付 API 列有 ACQ.RISK_MERCHANT_IP_NOT_EXIST。代码虽获取 clientIP，但支付宝 create 分支尚未向 business_params 传递该字段；如果商户风控要求，需要按产品文档补代码和可信代理来源校验，不能加个环境变量或填固定假 IP 代替。此项属于待验证/待完善，不因本次查文档自动完成。

## 10. 官方账单自动对账

依据：[账单 API](https://opendocs.alipay.com/open/02ivbw)、[对账说明](https://opendocs.alipay.com/open/204/106262)。

1. 正式商家完成相应支付产品签约，并有实际流水；未签约、无流水或日期错误时不保证能取得 trade 账单。不要求额外开通直付通。
2. 使用正式渠道的 AppID、收款关系和签名配置，bill_type=trade；自营收款不填 smid，不使用 trade_zft_merchant。
3. PAYMENT_BILL_AUTO_ENABLED=true，正式 API 常驻并运行支付轮询。仅托管静态前端不会自动对账；NODE_ENV=test 时本项目不启动轮询。
4. 本站规则：北京时间 10 点后先查昨天，再补最近 7 天，每轮最多两张，失败/未生成至少一小时重试。已一致或已有差异报告的日期自动跳过，管理员可手动重跑。这不是支付宝强制频率。
5. 管理员在 /platform/payments 底部“支付宝官方账单对账”选择正式渠道、已结束日期，填写原因，下载并核对。
6. 首次选含收款的日期，再选含退款的日期，与商家平台手工下载的原始账单复核。只测空账单不能证明金额和退款匹配正确。
7. 例如 2026-11-10 通常先查 2026-11-09。官方日账单为 T+1，一般次日 9 点前生成，特殊情况可能延迟；不能下载当天账单。
8. bill_download_url 有效期仅 30 秒，后端取得后立即下载，不将临时地址当作永久附件或交给普通成员。
9. 比较订单号、支付宝交易号、金额、退款请求号及本地状态，同 sellerId 和环境聚合历史配置。商户其他系统产生的订单可能报“账单有、本地无”，由管理员判断归属。
10. 差异只生成报告，不自动开套餐、改订单或退款。先签名查单核实，再人工处理并重跑。

trade 是交易业务账单；signcustomer 是账户资金变动账单。当前只实现 trade 收款与退款比较，没有完整实现手续费、账户余额、提现或银行到账对账。官方可提供近 6 年日/月账单，本地手动入口限过去 366 天已结束日期、自动仅补 7 天，不能将二者说成相同范围。

官方现支持 secure="true" 返回 HTTPS 地址、NO_BILL_DATA 及 EMPTY_DATA_WITH_BILL_FILE 等结果。当前代码未传 secure，而是把限定官方主机的 HTTP 地址升级到 HTTPS；NO_BILL_DATA 记为失败待重试，不误报一致。需首轮真实账单确认并建议完善，不能关闭下载域名、私网或解压安全校验来强行调通。

## 11. 退款与企业权限验收

管理员从本站原订单发起整单退款并填写原因；不得由普通成员任意填写金额。不要本站、商家后台与 API Explorer 同时对同笔订单重复退款。

[退款 API](https://opendocs.alipay.com/open/f60979b3_alipay.trade.refund?scene=common)要求同一次退款重试沿用原请求号。code=10000 不等于退款成功，fund_change=Y 才直接表示成功，N 或缺少则查询。[退款查询](https://opendocs.alipay.com/open/357441a2_alipay.trade.fastpay.refund.query?scene=common)需检查 REFUND_SUCCESS，建议发起退款至少 10 秒后查询。TRADE_FINISHED 不可退款，期限以实际协议为准。

企业业务验收：

- 有效普通成员可购买、续费、查看本企业订单；订单属于企业，付款人只是操作记录。
- 同企业仅一张有效待付订单，其他成员继续原单，不并发重建；取消、过期等状态按真实渠道结果确认。
- 正式付款确认后，有效成员共享席位、岗位与有效期；退出企业失去访问权但不影响套餐。
- 超席位限制新增成员，既有成员不受影响；套餐到期统一禁止付费业务写操作，保留既定续费/受限访问入口。
- 商户配置、商品管理、退款及异常核对仅系统管理员；非成员与跨企业访问拒绝。
- 通知重复、查单与通知并发不得重复发权益；退款后按业务政策验证套餐回收或审查及次日账单。

## 12. 代码文件与尚需完成事项

| 仓库文件 | 负责内容 |
| --- | --- |
| apps/api/src/payments/providers.ts | 网关、签名验签和支付宝 API 调用 |
| apps/api/src/payments/security.ts | 配置校验、公网地址、商户配置加密 |
| apps/api/src/payments/service.ts | 企业订单、权限、固定回调地址、套餐权益 |
| apps/api/src/payments/routes.ts | 本站 API、webhook、管理员对账 |
| apps/api/src/payments/bills.ts、bill-format.ts | 自动调度、ZIP/CSV 解析及双向比较 |
| apps/api/src/server.ts | 每 60 秒检查支付任务，测试环境不启动 |
| web/src/modules/platform/pages/PlatformPaymentsPage.vue | 商户渠道与商品管理 |
| web/src/modules/platform/pages/EnterprisePaymentsPage.vue | 企业购买及支付模式 |
| web/src/modules/platform/components/AlipayBillPanel.vue | 管理员对账报告 |
| db/migrations/0086_alipay_bills_wap.sql | 环境、wap 模式及报告表 |

上线前必须区分已写代码和真实验收：

1. 账号持有人仍需完成真实应用、产品、收款账号、公钥和公网域名配置；本次没有登录控制台代填。
2. 业务库迁移和版本发布仍需执行正式发布流程；本次未执行。
3. 手机真机、异步通知、主动查单、关单、退款查询和沙箱 review 对退款入口的影响需实际联调。
4. 实际商户账单 ZIP/CSV 尚需验证；当前解析器要求支付宝交易号、商户订单号、业务类型、订单金额和退款请求号等列，未知格式失败，不误报一致。
5. 支付宝用户 IP 风控入参未传，按商户要求补充；商品标题也须遵守官方长度及特殊字符限制。
6. 建议账单显式传 secure=true 并细化无数据结果及监控。本轮仅列出，不修改实现。
7. 本地 refunded_at 可能为本地确认时间，尚未统一使用官方查询可返回的 gmt_refund_pay；午夜附近退款应复核相邻日账单。
8. 证书模式、银行卡最终到账消息、多次部分退款、代收分账、资金/手续费对账需扩展，不是填写现有字段即可启用。

建议顺序：核对收款主体和产品，确认公钥模式，部署公网路由及数据库版本，沙箱受控联调，新建正式渠道做最小可接受金额的真实收款与退款验收，账单生成后核对。停用测试渠道，保留历史配置，不换加密主密钥，不给历史订单改绑新渠道。

## 13. 常见错误排查

| 现象/错误 | 优先检查 |
| --- | --- |
| ACQ.ACCESS_FORBIDDEN/无权限 | 产品签约、期限、应用关联；是否误选需要当面付的本站二维码 |
| AppID/应用错误 | 正式/沙箱、新旧沙箱的 AppID 与网关是否配套，应用是否上线 |
| 验签失败 | 是否混用应用公钥和支付宝公钥、环境、PEM 换行或证书模式 |
| 买卖家不能相同 | 用沙箱买家付款，不用商家账号 |
| ACQ.RISK_MERCHANT_IP_NOT_EXIST | business_params 用户 IP，当前需要代码支持，不是只配环境变量 |
| 已付款本站未确认 | 回调公网 POST、WAF、验签与主动查单，不凭回跳手工开套餐 |
| 沙箱未开套餐 | 有意进入 review，不发正式权益，先核对验签和查单 |
| 沙箱 App 无法唤起 | 官方系统限制、匹配的新钱包及账号，不用正式 App 扫沙箱码 |
| BILL_NOT_EXIST/NO_BILL_DATA | 日期、生成时间、真实交易及产品权限，不当作一致 |
| 账单下载失效 | 超过 30 秒则重新取得地址，后端立即下载 |
| CSV/ZIP 解析失败 | 对照原始账单，补明确格式支持，保留安全失败 |
| 无自动对账 | API 常驻、NODE_ENV、开关、北京时间、已有报告跳过逻辑 |
| 历史渠道无法解密 | 恢复正确主密钥备份，不新生成值覆盖旧值 |

后端对部分上游错误会统一为安全错误，前端不一定显示上表子错误码。排查仅用受控脱敏诊断，不记录私钥、完整签名或含买家敏感信息的原始通知。
