// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import Page from "./PlatformPaymentsPage.vue";
import { ApiResponseError } from "../../../shared/api/errors";
import {
  getPaymentAdmin,
  getPaymentBills,
  reconcilePaymentBill,
  publishPaymentProduct,
  revisePaymentProduct,
  getPaymentProductHistory,
  mergePaymentProducts,
  addPaymentProvider,
  adminPaymentAction,
  getServiceThread,
  replyServiceThread,
  type PaymentAdmin,
} from "../api/payments";
import { authSession } from "../../auth/session";
vi.mock("../api/payments", async (original) => ({
  ...(await original<typeof import("../api/payments")>()),
  getPaymentAdmin: vi.fn(),
  getPaymentBills: vi.fn(async()=>[]),
  reconcilePaymentBill: vi.fn(async()=>[]),
  getBillingPolicy: vi.fn(async () => { throw Error('后台规则面板单独验证') }),
  publishPaymentProduct: vi.fn(),
  revisePaymentProduct: vi.fn(),
  getPaymentProductHistory: vi.fn(),
  mergePaymentProducts: vi.fn(),
  addPaymentProvider: vi.fn(),
  togglePaymentItem: vi.fn(),
  adminPaymentAction: vi.fn(),
  getServiceThread: vi.fn(),
  replyServiceThread: vi.fn(),
}));
vi.mock("../api/entitlements", () => ({
  listPlans: vi.fn(async () => [
    {
      id: "plan",
      name: "团队版",
      version: 1,
      code: "team",
      seatLimit: 20,
      jobLimit: 200,
    },
  ]),
}));
vi.mock("../../auth/session", () => ({
  authSession: { user: { platformRole: "admin", isSystemAdmin: true } },
}));
const report: PaymentAdmin = {
  productVersioning: true,
  plans: [{ id: "plan", name: "团队版", version: 1, code: "team", seatLimit: 20, jobLimit: 200 }],
  products: [],
  providers: [],
  orders: [],
  keyConfigured: true,
  publicBaseURL: "https://recruit.example.com",
};
let app: App, root: HTMLDivElement;
const flush = async () => {
  await Promise.resolve();
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
};
async function mount(module = "products") {
  vi.mocked(getPaymentAdmin).mockResolvedValue(report);
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(Page);
  app.mount(root);
  root.querySelector<HTMLButtonElement>(`[role=tab][data-module="${module}"]`)!.click();
  await flush();
}
async function selectModule(module: string) {
  root.querySelector<HTMLButtonElement>(`[role=tab][data-module="${module}"]`)!.click();
  await nextTick();
}
afterEach(() => {
  app?.unmount();
  root?.remove();
  vi.clearAllMocks();
  authSession.user!.platformRole = "admin";
  authSession.user!.isSystemAdmin = true;
});
describe("platform payment management", () => {
  it("shows an explicit Alipay environment selector and submits an audited bill download",async()=>{
    report.providers=[{id:'alipay',name:'支付宝正式',kind:'alipay',environment:'production'},{id:'sandbox',name:'支付宝沙箱',kind:'alipay',environment:'sandbox'}];
    try {
      await mount("reconciliation");
      await selectModule('channels');
      expect(root.querySelector('.channel-form')?.textContent).toContain('沙箱测试');
      expect(root.textContent).toContain('alipay · 沙箱测试');
      await selectModule('reconciliation');
      const form=root.querySelector<HTMLFormElement>('.bill-panel form')!, select=form.querySelector('select')!;
      expect(select.textContent).toContain('支付宝正式');expect(select.textContent).not.toContain('支付宝沙箱');
      select.value='alipay';select.dispatchEvent(new Event('change'));
      const inputs=form.querySelectorAll('input');inputs[0]!.value='2026-11-09';inputs[0]!.dispatchEvent(new Event('input'));inputs[1]!.value='核对昨日账单';inputs[1]!.dispatchEvent(new Event('input'));await nextTick();
      form.dispatchEvent(new Event('submit'));await flush();
      expect(reconcilePaymentBill).toHaveBeenCalledWith({providerId:'alipay',billDate:'2026-11-09',reason:'核对昨日账单'});
      expect(getPaymentBills).toHaveBeenCalled();
    } finally {report.providers=[];}
  });
  it('lets the system administrator reply to an enterprise support request', async () => {
    report.serviceRequests = [{id:'request',organizationId:'org',organizationName:'到期企业',message:'续费需要帮助',status:'open',response:null,createdAt:'2026-11-10',resolvedAt:null}];
    const thread = {request:report.serviceRequests[0]!,messages:[],hasMore:false,nextBefore:null};
    vi.mocked(getServiceThread).mockResolvedValue(thread);
    vi.mocked(replyServiceThread).mockResolvedValue({...thread,request:{...thread.request,status:'resolved'}});
    try {
      await mount("service");
      [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('查看会话'))!.click();
      await flush();
      const text = root.querySelector('textarea')!; text.value='请重新打开付款页续费';text.dispatchEvent(new Event('input'));await nextTick();
      [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('回复并完成工单'))!.click();
      await flush();
      expect(replyServiceThread).toHaveBeenCalledWith('request',{message:'请重新打开付款页续费',attachments:[],resolve:true},undefined);
    } finally { delete report.serviceRequests; vi.restoreAllMocks(); }
  });
  it('shows duplicate pending orders and requires a reason before explicit closure', async () => {
    report.duplicatePendingOrders = [{organizationId:'org',organizationName:'重复订单企业',orders:[{id:'duplicate',outTradeNo:'DUPLICATE-1',status:'pending',amountFen:100} as any]}];
    const prompt = vi.spyOn(window,'prompt').mockReturnValue(null);
    try {
      await mount("duplicates");
      expect(root.textContent).toContain('DUPLICATE-1');
      const close = [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('核对并关闭重复订单'))!;
      close.click(); await flush(); expect(adminPaymentAction).not.toHaveBeenCalled();
      prompt.mockReturnValue('保留另一张待付订单'); close.click(); await flush();
      expect(adminPaymentAction).toHaveBeenCalledWith('duplicate','cancel','保留另一张待付订单');
    } finally { delete report.duplicatePendingOrders; vi.restoreAllMocks(); }
  });
  it("publishes immutable prices with administrator-defined capacity and quotas", async () => {
    await mount();
    const form = root.querySelector<HTMLFormElement>(".product-form")!;
    for (const [label, value] of Object.entries({'商品名称':'团队版月付','售价（元）':'299.01','席位数':'30','岗位数':'250','有效天数':'30','AI 点数':'500','转写分钟数':'10','OCR 页数':'20','发布原因':'测试定价'})) {
      const input=[...form.querySelectorAll('label')].find(l=>l.firstChild?.textContent?.trim()===label)!.querySelector('input')!;
      input.value=value; input.dispatchEvent(new Event('input'));
    }
    form.dispatchEvent(new Event("submit"));
    await flush();
    expect(publishPaymentProduct).toHaveBeenCalledWith({
      seatLimit: 30,
      jobLimit: 250,
      name: "团队版月付",
      description: '', sortOrder: 0,
      requestId: expect.any(String),
      amountFen: 29901,
      durationDays: 30,
      durationMonths: null,
      billingKind: 'subscription',
      billingEntitlements: {quotas:{ai_points:500,interview_seconds:600,ocr_pages:20},grantPeriod:'monthly',rollover:false},
      reason: "测试定价",
    });
    expect(root.textContent).toContain("新商品已创建，确认后可上架");
  });
  it("non-system operators cannot load or edit payment management", async () => {
    authSession.user!.platformRole = "viewer";
    authSession.user!.isSystemAdmin = false;
    await mount();
    expect(root.querySelector(".product-form")).toBeNull();
    expect(root.querySelector(".channel-form")).toBeNull();
    expect(getPaymentAdmin).not.toHaveBeenCalled();
  });
  it("a system administrator needs no legacy platform grant to manage payments", async () => {
    authSession.user!.platformRole = undefined;
    await mount();
    expect(root.querySelector(".product-form")).not.toBeNull();
    expect(root.querySelector(".channel-form")).toBeNull();
    await selectModule('channels');
    expect(root.querySelector(".channel-form")).not.toBeNull();
  });
  it("shows only the selected module and keeps an empty duplicate-orders state accessible", async () => {
    await mount();
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role=tab]')];
    expect(tabs.map(tab => tab.dataset.module)).toEqual([
      "billing", "service", "duplicates", "products", "channels", "orders", "reconciliation",
    ]);
    expect(root.querySelector("select[aria-label='选择管理模块']")).toBeNull();
    expect(tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').map(tab => tab.dataset.module)).toEqual(['products']);
    expect(root.querySelector(".product-form")).not.toBeNull();
    expect(root.querySelector(".channel-form")).toBeNull();
    await selectModule('duplicates');
    expect(root.querySelector('[role=tabpanel]')?.getAttribute('aria-labelledby')).toBe('payment-tab-duplicates');
    expect(root.querySelector("[aria-label='重复待支付订单']")?.textContent).toContain("暂无重复待支付订单");
    expect(root.querySelector(".product-form")).toBeNull();
  });
  it('supports keyboard navigation and keeps only the selected tab in the tab sequence', async () => {
    await mount();
    const tab = (module: string) => root.querySelector<HTMLButtonElement>(`[role=tab][data-module="${module}"]`)!;
    tab('products').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await nextTick();
    expect(tab('channels').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('channels'));
    expect(tab('products').tabIndex).toBe(-1);
    tab('channels').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await nextTick();
    expect(tab('reconciliation').tabIndex).toBe(0);
    tab('reconciliation').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(tab('billing'));
    tab('billing').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(tab('reconciliation'));
    tab('reconciliation').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await nextTick();
    expect(document.activeElement).toBe(tab('billing'));
  });
  it("publishes a calendar-month package without a module scope option", async () => {
    await mount();
    const form = root.querySelector<HTMLFormElement>(".product-form")!;
    const selects = form.querySelectorAll("select");
    selects[0]!.value = "subscription";
    selects[0]!.dispatchEvent(new Event("change"));
    selects[1]!.value = "months";
    selects[1]!.dispatchEvent(new Event("change"));
    await nextTick();
    for (const [label,value] of Object.entries({'商品名称':'全功能年付套餐','售价（元）':'2500','席位数':'12','岗位数':'300','有效月数':'12','AI 点数':'3000','转写分钟数':'60','OCR 页数':'100','发布原因':'发布正式年付价格'})) {
      const input=[...form.querySelectorAll('label')].find(l=>l.firstChild?.textContent?.trim()===label)!.querySelector('input')!;
      input.value=value;input.dispatchEvent(new Event('input'));
    }
    expect(form.textContent).not.toContain("全部模块功能");
    expect(form.querySelectorAll("[type=checkbox]")).toHaveLength(1);
    expect(form.querySelector("[type=checkbox]")?.closest("label")?.textContent).toContain("未用额度结转");
    form.dispatchEvent(new Event("submit"));
    await flush();
    expect(publishPaymentProduct).toHaveBeenCalledWith({
      seatLimit:12,jobLimit:300,name: "全功能年付套餐", amountFen: 250000,
      description: '', sortOrder: 0,
      requestId: expect.any(String),
      durationDays: null, durationMonths: 12,
      billingKind:'subscription',billingEntitlements:{quotas:{ai_points:3000,interview_seconds:3600,ocr_pages:100},grantPeriod:'monthly',rollover:false},reason: "发布正式年付价格",
    });
  });
  it("does not treat three-decimal prices as valid currency", async () => {
    await mount();
    const input = root.querySelectorAll<HTMLInputElement>(
      ".product-form input",
    )[1]!;
    input.value = "1.001";
    input.dispatchEvent(new Event("input"));
    root.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flush();
    expect(publishPaymentProduct).not.toHaveBeenCalled();
    expect(root.querySelector("[role=alert]")?.textContent).toContain(
      "两位小数",
    );
  });
});

it('复制历史商品时按分钟回填，再次发布保持原额度和非整分钟余量',async()=>{
 const item={id:'legacy-minutes',name:'历史分钟套餐',amountFen:100,seatLimit:10,jobLimit:100,durationDays:30,durationMonths:null,active:false,billingKind:'subscription',billingEntitlements:{quotas:{ai_points:100,interview_seconds:601,ocr_pages:3},grantPeriod:'monthly',rollover:false}} as PaymentAdmin['products'][number];report.products=[item];
 try{await mount();expect(root.textContent).toContain('≈10.016667 分钟');[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.includes('复制为新商品'))!.click();await nextTick();
 const form=root.querySelector<HTMLFormElement>('.product-form')!;const field=(label:string)=>[...form.querySelectorAll('label')].find(l=>l.firstChild?.textContent?.trim()===label)!.querySelector('input')!;expect(Number(field('转写分钟数').value)).toBe(601/60);field('发布原因').value='保留历史额度';field('发布原因').dispatchEvent(new Event('input'));await nextTick();form.dispatchEvent(new Event('submit'));await flush();expect(vi.mocked(publishPaymentProduct).mock.calls[0]![0].billingEntitlements!.quotas.interview_seconds).toBe(601);
 }finally{report.products=[]}
});


const versionProduct={id:'version-2',catalogId:'catalog',versionNumber:2,name:'算力包1',planVersionId:'plan',currency:'CNY',amountFen:28800,durationDays:null,durationMonths:null,active:true,seatLimit:0,jobLimit:0,billingKind:'addon',billingEntitlements:{quotas:{ai_points:1000,interview_seconds:601,ocr_pages:0},grantPeriod:'once',rollover:false}} as PaymentAdmin['products'][number];
const button=(text:string,scope:ParentNode=root)=>[...scope.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===text)!;
async function fillProductField(label:string,value:string){
 const input=[...root.querySelectorAll('.product-form label')].find(l=>l.firstChild?.textContent?.trim()===label)!.querySelector('input')!;
 input.value=value;input.dispatchEvent(new Event('input'));await nextTick();
}
describe('商品多版本管理',()=>{
 afterEach(()=>{report.products=[];report.productVersioning=true});
 it('编辑显示差异确认，再更新原商品；取消不保存',async()=>{
  report.products=[versionProduct];await mount();button('编辑并上架').click();await nextTick();
  expect(root.textContent).toContain('编辑商品：算力包1');expect(root.querySelector('.product-form select')?.hasAttribute('disabled')).toBe(true);
  await fillProductField('AI 点数','2000');await fillProductField('发布原因','调整算力额度');
  root.querySelector('.product-form')!.dispatchEvent(new Event('submit'));await flush();
  expect(revisePaymentProduct).not.toHaveBeenCalled();
  let dialog=document.querySelector('dialog')!;expect(dialog.textContent).toContain('1000');expect(dialog.textContent).toContain('2000');expect(dialog.textContent).toContain('历史订单及已到账权益保持不变');
  button('返回编辑',dialog).click();await nextTick();expect(document.querySelector('dialog')).toBeNull();
  root.querySelector('.product-form')!.dispatchEvent(new Event('submit'));await flush();dialog=document.querySelector('dialog')!;
  button('确认修改并上架',dialog).click();await flush();
  expect(revisePaymentProduct).toHaveBeenCalledWith('version-2',expect.objectContaining({expectedVersionId:'version-2',requestId:expect.any(String),billingEntitlements:expect.objectContaining({quotas:{ai_points:2000,interview_seconds:601,ocr_pages:0}})}));
  expect(publishPaymentProduct).not.toHaveBeenCalled();expect(document.querySelector('dialog')).toBeNull();expect(root.textContent).toContain('新建商品');
 });
 it('版本冲突保留表单，错误出现在确认窗口内',async()=>{
  report.products=[versionProduct];await mount();button('编辑并上架').click();await nextTick();await fillProductField('发布原因','测试冲突保护');
  root.querySelector('.product-form')!.dispatchEvent(new Event('submit'));await flush();
  vi.mocked(revisePaymentProduct).mockRejectedValueOnce(new ApiResponseError('商品已有新版本，请刷新后重新编辑',{code:'VERSION_CONFLICT',status:409}));
  button('确认修改并上架',document.querySelector('dialog')!).click();await flush();
  expect(document.querySelector('dialog [role=alert]')?.textContent).toContain('商品已有新版本');expect(root.textContent).toContain('编辑商品：算力包1');
 });
 it('历史版本不能直接上架，恢复旧配置需要再次确认新版本',async()=>{
  report.products=[versionProduct];const old={...versionProduct,id:'version-1',versionNumber:1,active:false,billingEntitlements:{...versionProduct.billingEntitlements!,quotas:{ai_points:100,interview_seconds:601,ocr_pages:0}},versionReason:'首次发布',operatorName:'测试管理员'};
  vi.mocked(getPaymentProductHistory).mockResolvedValue({catalogId:'catalog',currentVersionId:versionProduct.id,versions:[versionProduct,old]});
  await mount();button('历史版本').click();await flush();const dialog=document.querySelector('dialog')!;
  expect(dialog.textContent).toContain('首次发布');expect(dialog.textContent).toContain('测试管理员');expect(button('上架',dialog)).toBeUndefined();
  button('以此版本恢复',dialog).click();await flush();expect(document.querySelector('dialog')).toBeNull();
  const input=[...root.querySelectorAll('.product-form label')].find(l=>l.firstChild?.textContent?.trim()==='AI 点数')!.querySelector('input')!;expect(input.value).toBe('100');
  expect(revisePaymentProduct).not.toHaveBeenCalled();root.querySelector('.product-form')!.dispatchEvent(new Event('submit'));await flush();expect(document.querySelector('dialog')?.textContent).toContain('第 3 版');
 });
 it('归并必须明确选择当前版本和状态，不按同名自动操作',async()=>{
  report.products=[versionProduct,{...versionProduct,id:'separate',catalogId:'separate',active:false,versionNumber:1}];await mount();expect(mergePaymentProducts).not.toHaveBeenCalled();
  const boxes=root.querySelectorAll<HTMLInputElement>('input[aria-label^="选择归并"]');for(const b of boxes){b.checked=true;b.dispatchEvent(new Event('change'));await nextTick()}button('归并所选商品').click();await nextTick();
  const dialog=document.querySelector('dialog')!;expect(button('确认归并',dialog).disabled).toBe(true);expect(dialog.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
  const radio=dialog.querySelector<HTMLInputElement>('input[type=radio]')!;radio.checked=true;radio.dispatchEvent(new Event('change'));
  const reason=dialog.querySelector<HTMLInputElement>('input[maxlength="500"]')!;reason.value='确认归并同一商品';reason.dispatchEvent(new Event('input'));await nextTick();
  dialog.querySelector('form')!.dispatchEvent(new Event('submit'));await flush();
  expect(mergePaymentProducts).toHaveBeenCalledWith({versionIds:['version-2','separate'],keepVersionId:'version-2',active:false,reason:'确认归并同一商品',requestId:expect.any(String)});expect(document.querySelector('dialog')).toBeNull();
 });
 it('旧 API 未升级时不允许版本操作',async()=>{
  report.productVersioning=false;report.products=[versionProduct];await mount();expect(root.querySelector('.product-form')).toBeNull();expect(button('编辑并上架')).toBeUndefined();expect(root.textContent).toContain('等待服务更新');
 });
});

const channelFixture = {
  name: "支付宝测试渠道", appId: "test-app-id", sellerId: "test-seller-id",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfixture-private-key\n-----END PRIVATE KEY-----",
  publicKey: "-----BEGIN PUBLIC KEY-----\nfixture-public-key\n-----END PUBLIC KEY-----",
  reason: "配置测试收款渠道",
};
async function fillChannel() {
  const form = root.querySelector<HTMLFormElement>(".channel-form")!;
  form.closest("details")!.open = true;
  const labels = {name:"渠道名称",appId:"应用 App ID",sellerId:"收款方 seller_id",privateKey:"应用 RSA 私钥（PEM）",publicKey:"支付宝公钥（PEM）",reason:"操作原因"};
  for (const [key, label] of Object.entries(labels)) {
    const input = form.querySelector<HTMLInputElement>("input[aria-label='" + label + "']")!;
    if (key === "privateKey" || key === "publicKey") {
      const paste = new Event("paste", {bubbles:true, cancelable:true});
      Object.defineProperty(paste, "clipboardData", {value:{getData:()=>channelFixture[key]}});
      input.dispatchEvent(paste);
    } else {
      input.value = channelFixture[key as keyof typeof channelFixture];
      input.dispatchEvent(new Event("input", {bubbles:true}));
    }
  }
  await nextTick();
  return form;
}
describe("payment channel submission and secret visibility", () => {
  it("masks both PEM keys by default and preserves multiline paste when toggled", async () => {
    await mount("channels");
    const form = await fillChannel();
    expect(form.querySelectorAll("input[type=password]")).toHaveLength(2);
    expect(form.querySelector("textarea")).toBeNull();
    const toggle = form.querySelector<HTMLButtonElement>("button[aria-label='显示应用 RSA 私钥（PEM）']")!;
    toggle.click(); await nextTick();
    expect(form.querySelector("textarea")!.value).toBe(channelFixture.privateKey);
    expect(form.querySelector("button[aria-pressed=true]")).not.toBeNull();
    toggle.click(); await nextTick();
    expect(form.querySelector("textarea")).toBeNull();
    expect(addPaymentProvider).not.toHaveBeenCalled();
    form.requestSubmit(); await flush();
    expect(addPaymentProvider).toHaveBeenCalledWith(expect.objectContaining({config:expect.objectContaining({privateKey:channelFixture.privateKey,publicKey:channelFixture.publicKey})}));
  });
  it("shows missing fields next to save and sends no incomplete request", async () => {
    await mount("channels"); const form = await fillChannel();
    const reason = form.querySelector<HTMLInputElement>("[aria-label='操作原因']")!;
    reason.value = "   "; reason.dispatchEvent(new Event("input")); await nextTick();
    form.requestSubmit(); await flush();
    expect(addPaymentProvider).not.toHaveBeenCalled();
    expect(form.querySelector("[data-channel-error]")?.textContent).toContain("请填写「操作原因」");
    expect(document.activeElement).toBe(reason);
  });
  it("shows why saving is disabled when the server encryption key is missing", async () => {
    report.keyConfigured = false;
    try {
      await mount("channels"); const form = root.querySelector<HTMLFormElement>(".channel-form")!;
      expect(form.querySelector("button[type=submit]")?.hasAttribute("disabled")).toBe(true);
      expect(form.querySelector("[role=alert]")?.textContent).toContain("服务器尚未配置支付加密主密钥");
      expect(addPaymentProvider).not.toHaveBeenCalled();
    } finally {report.keyConfigured = true;}
  });
  it("submits sandbox configuration then clears secrets and restores a valid environment", async () => {
    await mount("channels"); const form = await fillChannel();
    const environment = form.querySelectorAll("select")[1]!;
    environment.value = "sandbox"; environment.dispatchEvent(new Event("change")); await nextTick();
    form.requestSubmit(); await flush();
    expect(addPaymentProvider).toHaveBeenCalledWith({name:channelFixture.name,kind:"alipay",reason:channelFixture.reason,config:{environment:"sandbox",appId:channelFixture.appId,sellerId:channelFixture.sellerId,privateKey:channelFixture.privateKey,publicKey:channelFixture.publicKey}});
    expect(form.querySelector("[data-channel-notice]")?.textContent).toContain("收款渠道已加密保存");
    expect([...form.querySelectorAll<HTMLInputElement>("input")].every(input=>input.value === "")).toBe(true);
    expect(form.querySelectorAll("select")[1]!.value).toBe("production");
    expect(getPaymentAdmin).toHaveBeenCalledTimes(2);
  });
  it("keeps entered keys for retry and displays backend errors next to save", async () => {
    vi.mocked(addPaymentProvider).mockRejectedValueOnce(new ApiResponseError("密钥格式无效，请按页面要求填写至少 2048 位的完整密钥，包含起止标记及换行", {code:"VALIDATION_ERROR",status:400}));
    await mount("channels"); const form = await fillChannel();
    form.querySelector<HTMLButtonElement>("button[aria-label='显示支付宝公钥（PEM）']")!.click(); await nextTick();
    form.requestSubmit(); await flush();
    expect(form.querySelector("[data-channel-error]")?.textContent).toContain("密钥格式无效，请按页面要求填写至少 2048 位的完整密钥，包含起止标记及换行");
    expect(form.querySelector("[data-channel-notice]")).toBeNull();
    expect(form.querySelector("textarea")).toBeNull();
    form.querySelector<HTMLButtonElement>("button[aria-label='显示应用 RSA 私钥（PEM）']")!.click(); await nextTick();
    expect(form.querySelector("textarea")!.value).toBe(channelFixture.privateKey);
    form.requestSubmit(); await flush();
    expect(addPaymentProvider).toHaveBeenCalledTimes(2);
  });
  it("shows a safe request reference for unexpected server failures", async () => {
    vi.mocked(addPaymentProvider).mockRejectedValueOnce(new ApiResponseError("Internal Server Error", {code:"INTERNAL_ERROR",status:500,requestId:"req_fixture-42"}));
    await mount("channels"); const form = await fillChannel();
    form.requestSubmit(); await flush();
    expect(form.querySelector("[data-channel-error]")?.textContent).toContain("保存收款渠道失败，请稍后重试（错误编号：req_fixture-42）");
    expect(form.querySelector("[data-channel-error]")?.textContent).not.toContain(channelFixture.privateKey);
  });
  it("shows progress and prevents duplicate submissions while saving", async () => {
    let finish!: (value:never) => void;
    vi.mocked(addPaymentProvider).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
    await mount("channels"); const form = await fillChannel();
    form.requestSubmit(); await nextTick();
    expect(form.querySelector("button[type=submit]")?.textContent).toContain("正在保存");
    expect(form.getAttribute("aria-busy")).toBe("true");
    form.dispatchEvent(new Event("submit", {cancelable:true})); await nextTick();
    expect(addPaymentProvider).toHaveBeenCalledTimes(1);
    finish(undefined as never); await flush();
    expect(form.getAttribute("aria-busy")).toBe("false");
    expect(form.querySelector("button[type=submit]")?.hasAttribute("disabled")).toBe(false);
  });
  it("clears keys and their visible state when switching provider types", async () => {
    await mount("channels"); const form = await fillChannel();
    form.querySelector<HTMLButtonElement>("button[aria-label='显示应用 RSA 私钥（PEM）']")!.click(); await nextTick();
    const kind = form.querySelector("select")!;
    kind.value = "wxpay"; kind.dispatchEvent(new Event("change")); await nextTick();
    expect(form.querySelector("textarea")).toBeNull();
    expect(form.querySelector<HTMLInputElement>("[aria-label='商户 RSA 私钥（PEM）']")!.value).toBe("");
    expect(form.querySelectorAll("input[type=password]")).toHaveLength(3);
  });
});
