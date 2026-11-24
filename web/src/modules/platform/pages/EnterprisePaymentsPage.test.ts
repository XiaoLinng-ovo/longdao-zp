// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createRouter, createMemoryHistory } from "vue-router";
import { refreshAuthSession } from "../../auth/session";
import Page from "./EnterprisePaymentsPage.vue";
import {
  getCheckout,
  getPaymentOrder,
  createPaymentOrder,
  paymentOrderAction,
  type Checkout,
  type PaymentOrder,
} from "../api/payments";
vi.mock("../api/payments", async (original) => ({
  ...(await original<typeof import("../api/payments")>()),
  getCheckout: vi.fn(),
  getPaymentOrder: vi.fn(),
  createPaymentOrder: vi.fn(),
  paymentOrderAction: vi.fn(),
}));
vi.mock("../../auth/session", () => ({
  authSession: { user: { workspaceId: "org" } },
  refreshAuthSession: vi.fn(),
}));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,qr") },
}));
const order: PaymentOrder = {
  id: "order",
  outTradeNo: "sr_order",
  organizationId: "org",
  name: "团队版",
  amountFen: 29900,
  currency: "CNY",
  durationDays: 30,
  method: "alipay",
  mode: "qrcode",
  status: "pending",
  payURL: null,
  qrCode: "https://pay.example.com/qr",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 1800000).toISOString(),
  paidAt: null,
  refundedAt: null,
  reviewReason: null,
};
const report: Checkout = {
  products: [
    {
      id: "product",
      planVersionId: "plan",
      name: "团队版",
      amountFen: 29900,
      currency: "CNY",
      durationDays: 30,
      active: true,
      seatLimit: 20,
      jobLimit: 200,
    },
  ],
  providers: [
    { id: "ali", name: "支付宝官方", kind: "alipay" },
    { id: "wx", name: "微信官方", kind: "wxpay" },
  ],
  orders: [],
  pendingOrder: null,
  organization: {
    id: "org",
    name: "测试企业",
    entitlementVersion: 3,
    expiresAt: null,
    seatUsage: 2,
    jobUsage: 5,
  },
  canPurchase: true,
};
let app: App, root: HTMLDivElement;
const flush = async () => {
  await Promise.resolve();
  await nextTick();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((r) => setTimeout(r, 0));
  await nextTick();
};
async function mount(
  path = "/enterprise/payments",
  data = report,
  current = order,
) {
  vi.mocked(getCheckout).mockResolvedValue(data);
  vi.mocked(getPaymentOrder).mockResolvedValue({ ...current });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: "/enterprise/payments",
        name: "enterprise-payments",
        component: Page,
      },
      {
        path: "/enterprise/payments/:id",
        name: "enterprise-payment-order",
        component: Page,
      },
      { path: "/workspaces", component: { template: "workspaces" } },
    ],
  });
  await router.push(path);
  await router.isReady();
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(Page);
  app.use(router);
  app.mount(root);
  await flush();
  return router;
}
afterEach(() => {
  app?.unmount();
  root?.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("enterprise payment checkout", () => {
  it('shows creation failure without countdown or payment entry, and allows cancellation', async () => {
    const failed = {...order,status:'uncertain' as const,creationOutcome:'not_created' as const,creationMessage:'订单创建失败：支付宝应用尚未上线。可直接取消此订单。',qrCode:null};
    await mount('/enterprise/payments/order', {...report,orders:[failed],pendingOrder:failed}, failed);
    expect(root.querySelector('h2')?.textContent).toBe('创建失败');
    expect(root.textContent).toContain('订单创建失败：支付宝应用尚未上线');
    expect(root.textContent).not.toContain('付款剩余时间');
    expect(root.querySelector('img')).toBeNull();
    expect(Array.from(root.querySelectorAll('button')).some(b => b.textContent?.trim() === '取消订单')).toBe(true);
  });
  it('distinguishes local cancellation from channel closure and unblocks another purchase', async () => {
    const cancelled = {...order,status:'cancelled' as const,channelClosePending:true,qrCode:null,cancelRequestedAt:new Date().toISOString()};
    const router = await mount('/enterprise/payments/order', {...report,orders:[cancelled],pendingOrder:null}, cancelled);
    expect(root.querySelector('h2')?.textContent).toBe('已取消（本地）');
    expect(root.textContent).toContain('渠道关单尚未确认');
    expect(root.textContent).not.toContain('付款剩余时间');
    expect(root.querySelector('img')).toBeNull();
    await router.push('/enterprise/payments');
    await flush();
    expect(root.querySelector('.pending-order')).toBeNull();
    expect(root.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(false);
  });
  it("retains cancellation intent, hides payment entries and displays the actual channel blocker", async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      await mount('/enterprise/payments/order', { ...report, orders: [order], pendingOrder: order });
      vi.mocked(paymentOrderAction).mockResolvedValue({ ...order, cancelRequestedAt: new Date().toISOString(), cancellationMessage: '支付宝应用尚未上线，请联系平台管理员完成上线；系统会继续重试取消。' });
      Array.from(root.querySelectorAll('button')).find(b => b.textContent?.trim() === '取消订单')!.click();
      await flush();
      expect(paymentOrderAction).toHaveBeenCalledWith('org', 'order', 'cancel');
      expect(root.querySelector('h2')?.textContent).toBe('取消待确认');
      expect(root.textContent).toContain('支付宝应用尚未上线');
      expect(root.querySelector('img')).toBeNull();
      expect(root.querySelector('.pay-link')).toBeNull();
      expect(root.textContent).not.toContain('付款剩余时间');
      expect(root.textContent).not.toContain('取消订单');
      expect(root.querySelector('.history')?.textContent).toContain('取消待确认');
      vi.mocked(paymentOrderAction).mockResolvedValue({ ...order, cancelRequestedAt: new Date().toISOString(), status: 'cancelled' });
      Array.from(root.querySelectorAll('button')).find(b => b.textContent?.trim() === '查询支付结果')!.click();
      await flush();
      expect(root.querySelector('h2')?.textContent).toBe('已取消');
      expect(root.textContent).not.toContain('取消待确认');
    } finally { confirm.mockRestore(); }
  });
  it("does not release an expired order while cancellation remains unconfirmed", async () => {
    vi.useFakeTimers();
    const pending = { ...order, cancelRequestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() };
    await mount('/enterprise/payments', { ...report, orders: [pending], pendingOrder: pending });
    expect(root.querySelector('.pending-order')?.textContent).toContain('取消待确认');
    expect(root.querySelector('.pending-order a')?.textContent).toBe('查看取消进度');
    expect(root.textContent).not.toContain('继续支付已有订单');
    await vi.advanceTimersByTimeAsync(2000);
    expect(root.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(true);
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await flush();
    expect(createPaymentOrder).not.toHaveBeenCalled();
  });
  it('blocks a new order while an expired Alipay redirect still needs channel confirmation', async () => {
    const pending = {...order,mode:'redirect' as const,channelClosePending:true,expiresAt:new Date(Date.now()-1000).toISOString()};
    await mount('/enterprise/payments', {...report,orders:[pending],pendingOrder:pending});
    expect(root.querySelector('.pending-order')?.textContent).toContain('关单待确认');
    expect(root.querySelector('.pending-order a')?.textContent).toBe('查看关单进度');
    expect(root.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(true);
  });
  it("preserves the payment link for an existing WAP order",async()=>{
    const mobileOrder={...order,mode:'wap' as const,payURL:'https://openapi.alipay.com/gateway.do?fixture',qrCode:null};
    await mount('/enterprise/payments/order', report, mobileOrder);
    expect(root.querySelector<HTMLAnchorElement>('a[href^="https://openapi.alipay.com"]')).not.toBeNull();
  });
  it("labels sandbox channels and retains both WeChat payment modes",async()=>{
    await mount('/enterprise/payments',{...report,providers:[{id:'ali',name:'测试支付宝',kind:'alipay',environment:'sandbox'},{id:'wx',name:'微信',kind:'wxpay'}]});
    expect(root.textContent).toContain('不会发放正式套餐权益');
    const wx=root.querySelector<HTMLInputElement>('input[value="wxpay"]')!;wx.checked=true;wx.dispatchEvent(new Event('change'));await nextTick();await nextTick();
    expect(root.querySelector('input[value="wap"]')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('input[value="qrcode"]')!.checked).toBe(true);
    expect(root.querySelector('input[value="redirect"]')).not.toBeNull();
  });
  it("releases an elapsed pending order without requiring a page reload", async () => {
    vi.useFakeTimers();
    await mount("/enterprise/payments", {
      ...report,
      pendingOrder: { ...order, expiresAt: new Date(Date.now() + 1000).toISOString() },
    });
    expect(root.querySelector<HTMLButtonElement>("[type=submit]")!.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await nextTick();
    expect(root.querySelector(".pending-order")).toBeNull();
    expect(root.querySelector<HTMLButtonElement>("[type=submit]")!.disabled).toBe(false);
  });
  it("refreshes another member's cancellation without clearing the selected product", async () => {
    vi.useFakeTimers();
    const products = [...report.products, { ...report.products[0]!, id: "second", name: "续费套餐" }];
    await mount("/enterprise/payments", { ...report, products, pendingOrder: order });
    root.querySelectorAll<HTMLButtonElement>(".product")[1]!.click();
    await nextTick();
    vi.mocked(getCheckout).mockResolvedValue({ ...report, products, orders: [{ ...order, status: "cancelled" }] });
    await vi.advanceTimersByTimeAsync(15000);
    await nextTick();
    expect(root.querySelector(".pending-order")).toBeNull();
    expect(root.querySelector<HTMLButtonElement>("[type=submit]")!.disabled).toBe(false);
    expect(root.querySelectorAll(".product")[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(refreshAuthSession).not.toHaveBeenCalled();
  });
  it("refreshes shared entitlements when another member completes payment", async () => {
    vi.useFakeTimers();
    await mount("/enterprise/payments", { ...report, pendingOrder: order });
    vi.mocked(getCheckout).mockResolvedValue({
      ...report,
      organization: { ...report.organization, entitlementVersion: 4 },
      orders: [{ ...order, status: "fulfilled" }],
    });
    await vi.advanceTimersByTimeAsync(15000);
    await nextTick();
    expect(root.querySelector(".pending-order")).toBeNull();
    expect(root.querySelector(".history")?.textContent).toContain("套餐已开通");
    expect(refreshAuthSession).toHaveBeenCalledTimes(1);
  });
  it("shows the enterprise pending order and prevents a second purchase", async () => {
    const router = await mount("/enterprise/payments", { ...report, orders: [order], pendingOrder: order });
    expect(root.querySelector(".pending-order")?.textContent).toContain("企业已有待支付订单");
    expect(root.querySelector<HTMLButtonElement>("[type=submit]")!.disabled).toBe(true);
    root.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flush();
    expect(createPaymentOrder).not.toHaveBeenCalled();
    root.querySelector<HTMLAnchorElement>(".pending-order a")!.click();
    await flush();
    expect(router.currentRoute.value.params.id).toBe(order.id);
    expect(root.querySelector("img")).not.toBeNull();
  });
  it("recovers a cross-member creation conflict by opening the shared order", async () => {
    const router = await mount();
    vi.mocked(createPaymentOrder).mockRejectedValue(Object.assign(new Error("企业已有待支付订单"), { code: "PAYMENT_ORDER_ALREADY_PENDING" }));
    vi.mocked(getCheckout).mockResolvedValue({ ...report, orders: [order], pendingOrder: order });
    root.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flush();
    expect(router.currentRoute.value.params.id).toBe(order.id);
    expect(root.querySelector("[role=alert]")).toBeNull();
  });
  it.each(["cancelled", "expired", "refunded"] as const)("%s history does not block a new order", async status => {
    await mount("/enterprise/payments", { ...report, orders: [{ ...order, status }] });
    expect(root.querySelector(".pending-order")).toBeNull();
    expect(root.querySelector<HTMLButtonElement>("[type=submit]")!.disabled).toBe(false);
  });
  it("suspended workspaces cannot submit even through a form event", async () => {
    await mount("/enterprise/payments", { ...report, canPurchase: false });
    root.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flush();
    expect(createPaymentOrder).not.toHaveBeenCalled();
  });
  it("uses a subscription-specific page title", async () => {
    await mount();
    expect(root.querySelector("h1")?.textContent).toBe("企业订阅");
  });
  it('旧接口返回算力包时仍只显示和购买订阅',async()=>{
    const addon={...report.products[0]!,id:'credits',name:'长期算力包',billingKind:'addon' as const,durationDays:null};
    await mount('/enterprise/payments',{...report,products:[addon,...report.products],providers:[report.providers[1]!]});
    expect(root.querySelectorAll('.product')).toHaveLength(1);expect(root.querySelector('.product')?.textContent).toContain('团队版');expect(root.querySelector('.credit-balances')).toBeNull();expect(root.querySelector<HTMLInputElement>('input[value=wxpay]')!.checked).toBe(true);expect(root.textContent).not.toMatch(/算力包|AI 点数|分钟转写|算力充值/);
    vi.mocked(createPaymentOrder).mockResolvedValue(order);root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush();expect(createPaymentOrder).toHaveBeenCalledWith('org',expect.objectContaining({productId:'product',method:'wxpay',providerId:'wx'}),expect.any(String));
  });
  it('服务到期可直接续费订阅，不再展示余额提示',async()=>{
    await mount('/enterprise/payments',{...report,organization:{...report.organization,serviceAvailable:false}});expect(root.textContent).toContain('请续费或联系平台管理员');expect(root.textContent).not.toContain('余额保留');expect(root.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(false);
  });
  it('保留容量校验，历史只展示订阅且无充值筛选',async()=>{
    await mount('/enterprise/payments',{...report,organization:{...report.organization,seatUsage:21},orders:[{...order,id:'credit-order',billingKind:'addon',name:'充值历史',status:'fulfilled'},{...order,id:'sub-order',name:'订阅历史',status:'fulfilled'}]});expect(root.textContent).toContain('容量低于');expect(root.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(true);expect(root.querySelector('.history-filter')).toBeNull();expect(root.querySelector('.history tbody')?.textContent).toContain('订阅历史');expect(root.querySelector('.history tbody')?.textContent).not.toContain('充值历史');
  });
  it('历史待付款增购订单可查可取消但不再显示支付入口',async()=>{
    const old={...order,billingKind:'addon' as const,payURL:'https://pay.example.com/old'};await mount('/enterprise/payments/order',{...report,pendingOrder:old,orders:[old]},old);expect(root.querySelector('img')).toBeNull();expect(root.querySelector('.pay-link')).toBeNull();expect(root.textContent).toContain('已停售');for(const label of ['查询支付结果','取消订单'])expect([...root.querySelectorAll('button')].some(b=>b.textContent?.trim()===label)).toBe(true);
  });
  it('已完成历史增购订单不承诺额度到账',async()=>{
    await mount('/enterprise/payments/order',report,{...order,billingKind:'addon',status:'fulfilled'});expect(root.textContent).not.toContain('算力已到账');expect(root.textContent).not.toContain('算力已经到账');expect(root.querySelector('img')).toBeNull();
  });
  it('切换企业后忽略旧企业的下单响应',async()=>{
    const router=await mount();let finish!:(value:PaymentOrder)=>void;vi.mocked(createPaymentOrder).mockImplementation(()=>new Promise(resolve=>{finish=resolve}));root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush();
    vi.mocked(getCheckout).mockResolvedValue({...report,organization:{...report.organization,id:'other',name:'另一企业'}});await router.push('/enterprise/payments?workspace=other');await flush();finish({...order});await flush();expect(root.querySelector('header')?.textContent).toContain('另一企业');expect(root.querySelector('.order-card')).toBeNull();expect(router.currentRoute.value.query.workspace).toBe('other');
  });
  it("renders server-priced capacity and blocks purchase when no channel exists", async () => {
    await mount("/enterprise/payments", { ...report, providers: [] });
    expect(root.textContent).toContain("¥299.00");
    expect(root.textContent).toContain("20 个席位");
    expect(root.textContent).toContain("尚未启用");
    expect(
      root.querySelector<HTMLButtonElement>("[type=submit]")!.disabled,
    ).toBe(true);
  });
  it("only submits Alipay redirect, sends server catalog selection and opens the order", async () => {
    const router = await mount();
    expect(root.textContent).toContain("付款模式：跳转支付");
    expect(root.querySelector('input[value="qrcode"]')).toBeNull();
    expect(root.querySelector('input[value="wap"]')).toBeNull();
    const redirectOrder: PaymentOrder = {
      ...order,
      mode: "redirect",
      payURL: "https://pay.example.com/order",
      qrCode: null,
    };
    vi.mocked(createPaymentOrder).mockResolvedValue(redirectOrder);
    vi.mocked(getPaymentOrder).mockResolvedValue(redirectOrder);
    root.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flush();
    expect(createPaymentOrder).toHaveBeenCalledWith(
      "org",
      {
        productId: "product",
        providerId: "ali",
        method: "alipay",
        mode: "redirect",
        expectedVersion: 3,
      },
      expect.any(String),
    );
    expect(router.currentRoute.value.name).toBe("enterprise-payment-order");
    expect(root.querySelector('.pay-link')?.getAttribute('href')).toBe(redirectOrder.payURL);
    expect(root.querySelector('img[alt="订单付款二维码"]')).toBeNull();
  });
  it("shows formal package details and keeps selection usable before merchant activation", async () => {
    const products = [
      { id: "annual", name: "全功能年付套餐", amountFen: 250000, durationMonths: 12 },
      { id: "half-year", name: "全功能半年套餐", amountFen: 130000, durationMonths: 6 },
      { id: "monthly", name: "全功能月付套餐", amountFen: 25800, durationMonths: 1 },
    ].map((p) => ({ ...report.products[0]!, ...p, durationDays: null, allModules: true, seatLimit: 100, jobLimit: 2000 }));
    await mount("/enterprise/payments", { ...report, products, providers: [] });
    const cards = root.querySelectorAll<HTMLButtonElement>(".product");
    expect(cards).toHaveLength(3);
    expect(cards[0]!.textContent).toContain("¥2,500.00");
    expect(cards[0]!.textContent).toContain("使用期限：12 个月");
    expect(cards[1]!.textContent).toContain("使用期限：6 个月");
    expect(cards[2]!.textContent).toContain("使用期限：1 个月");
    for (const card of cards) {
      expect(card.textContent).toContain("全部模块功能");
      expect(card.textContent).toContain("100 个席位");
      expect(card.textContent).toContain("2000 个岗位");
    }
    cards[2]!.click();
    await nextTick();
    expect(cards[2]!.getAttribute("aria-pressed")).toBe("true");
    expect(cards[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(root.querySelector(".checkout-card")?.textContent).toContain("全功能月付套餐");
    expect(root.querySelector(".total")?.textContent).toBe("¥258.00");
    expect(root.querySelector<HTMLButtonElement>("[type=submit]")!.disabled).toBe(true);
    root.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flush();
    expect(createPaymentOrder).not.toHaveBeenCalled();
    expect(root.textContent).not.toContain("暂无在售套餐");
  });
  it("does not substitute simulation products when the formal catalog is empty", async () => {
    await mount("/enterprise/payments", { ...report, products: [] });
    expect(root.querySelectorAll(".product")).toHaveLength(0);
    expect(root.textContent).toContain("暂无在售订阅套餐");
    expect(root.querySelector<HTMLButtonElement>("[type=submit]")!.disabled).toBe(true);
  });
  it("browser status=success does not grant success and QR comes from the persisted order", async () => {
    await mount("/enterprise/payments/order?status=success");
    expect(root.textContent).toContain("等待付款");
    expect(root.textContent).not.toContain("已确认到账");
    expect(root.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,qr",
    );
  });
  it("confirmed payment displays success and removes payment links", async () => {
    await mount("/enterprise/payments/order", report, {
      ...order,
      status: "fulfilled",
    });
    expect(root.textContent).toContain("已确认到账");
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".pay-link")).toBeNull();
  });
  it("query settlement updates the history row together with the main order result", async () => {
    await mount("/enterprise/payments/order", { ...report, orders: [order] });
    vi.mocked(paymentOrderAction).mockResolvedValue({
      ...order,
      status: "fulfilled",
    });
    Array.from(root.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "查询支付结果")!
      .click();
    await flush();
    expect(root.querySelector(".history")?.textContent).toContain("套餐已开通");
    expect(root.querySelector(".history")?.textContent).not.toContain(
      "等待付款",
    );
  });
  it("blocks unsafe redirect schemes and displays review instead of claiming subscription completion", async () => {
    await mount("/enterprise/payments/order");
    vi.mocked(paymentOrderAction).mockResolvedValue({
      ...order,
      status: "review",
      payURL: "javascript:alert(1)",
      reviewReason: "权益已变更",
    });
    Array.from(root.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "查询支付结果")!
      .click();
    await flush();
    expect(root.textContent).toContain("权益已变更");
    expect(root.querySelector(".pay-link")).toBeNull();
    expect(root.textContent).not.toContain("套餐已经开通");
  });
});
