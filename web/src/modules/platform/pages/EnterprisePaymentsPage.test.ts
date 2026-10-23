// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createRouter, createMemoryHistory } from "vue-router";
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
  await new Promise((r) => setTimeout(r, 0));
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
  vi.clearAllMocks();
});
describe("enterprise payment checkout", () => {
  it("uses a subscription-specific page title", async () => {
    await mount();
    expect(root.querySelector("h1")?.textContent).toBe("套餐订购与续费");
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
  it("supports redirect and QR modes, sends only server catalog selection and navigates to separate order", async () => {
    const router = await mount();
    vi.mocked(createPaymentOrder).mockResolvedValue({
      ...order,
      mode: "redirect",
      payURL: "https://pay.example.com/order",
      qrCode: null,
    });
    const radio = root.querySelector<HTMLInputElement>(
      "input[value=redirect]",
    )!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change"));
    await flush();
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
    expect(root.textContent).toContain("暂无在售套餐");
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
