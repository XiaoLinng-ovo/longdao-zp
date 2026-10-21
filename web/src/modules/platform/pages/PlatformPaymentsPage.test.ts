// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import Page from "./PlatformPaymentsPage.vue";
import {
  getPaymentAdmin,
  publishPaymentProduct,
  addPaymentProvider,
  type PaymentAdmin,
} from "../api/payments";
import { authSession } from "../../auth/session";
vi.mock("../api/payments", async (original) => ({
  ...(await original<typeof import("../api/payments")>()),
  getPaymentAdmin: vi.fn(),
  publishPaymentProduct: vi.fn(),
  addPaymentProvider: vi.fn(),
  togglePaymentItem: vi.fn(),
  adminPaymentAction: vi.fn(),
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
  authSession: { user: { platformRole: "admin" } },
}));
const report: PaymentAdmin = {
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
async function mount() {
  vi.mocked(getPaymentAdmin).mockResolvedValue(report);
  root = document.createElement("div");
  document.body.appendChild(root);
  app = createApp(Page);
  app.mount(root);
  await flush();
}
afterEach(() => {
  app?.unmount();
  root?.remove();
  vi.clearAllMocks();
  authSession.user!.platformRole = "admin";
});
describe("platform payment management", () => {
  it("publishes immutable prices using integer fen and an existing capacity version", async () => {
    await mount();
    const form = root.querySelector<HTMLFormElement>(".product-form")!,
      select = form.querySelector("select")!;
    select.value = "plan";
    select.dispatchEvent(new Event("change"));
    const inputs = form.querySelectorAll("input");
    for (const [i, value] of [
      "团队版月付",
      "299.01",
      "30",
      "测试定价",
    ].entries()) {
      inputs[i]!.value = value;
      inputs[i]!.dispatchEvent(new Event("input"));
    }
    form.dispatchEvent(new Event("submit"));
    await flush();
    expect(publishPaymentProduct).toHaveBeenCalledWith({
      planVersionId: "plan",
      name: "团队版月付",
      amountFen: 29901,
      durationDays: 30,
      reason: "测试定价",
    });
    expect(root.textContent).toContain("不可修改");
  });
  it("viewer can inspect orders but cannot publish prices or merchant configurations", async () => {
    authSession.user!.platformRole = "viewer";
    await mount();
    expect(root.querySelector(".product-form")).toBeNull();
    expect(root.querySelector(".channel-form")).toBeNull();
    expect(root.textContent).toContain("收款渠道");
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
