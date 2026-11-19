// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import Panel from './AlipayBillPanel.vue';
import { getPaymentBills, reconcilePaymentBill, type PaymentBillReport } from '../api/payments';

vi.mock('../api/payments', async original => ({
  ...(await original<typeof import('../api/payments')>()),
  getPaymentBills: vi.fn(),
  reconcilePaymentBill: vi.fn(),
}));
let app: App;
let root: HTMLDivElement;
const flush = async () => { await Promise.resolve(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); };
const fixture = (id: string, status: PaymentBillReport['status'], extra: Partial<PaymentBillReport> = {}): PaymentBillReport => ({
  id, status, providerId: 'alipay', providerName: '支付宝正式', environment: 'production', billDate: '2026-11-15',
  attempts: 2, entryCount: 20, differenceCount: 0, errorCode: null, fileSha256: null,
  completedAt: '2026-11-16T02:00:00Z', nextRetryAt: '2026-11-16T03:00:00Z', differences: [], ...extra,
});
async function mount() {
  root = document.createElement('div'); document.body.appendChild(root);
  app = createApp(Panel, { providers: [{ id: 'alipay', name: '支付宝正式', kind: 'alipay', environment: 'production' }, { id: 'sandbox', name: '支付宝沙箱', kind: 'alipay', environment: 'sandbox' }] });
  app.mount(root); await flush();
}
const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(text))!;
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks(); });

describe('Alipay reconciliation report presentation', () => {
  it('shows distinct states, prioritizes abnormal reports and filters without making requests', async () => {
    vi.mocked(getPaymentBills).mockResolvedValue([
      fixture('ok', 'succeeded', { billDate: '2026-11-16' }),
      fixture('failed', 'failed', { errorCode: 'PAYMENT_UPSTREAM_UNCERTAIN' }),
      fixture('waiting', 'not_ready'), fixture('different', 'differences', { differenceCount: 1 }), fixture('running', 'running'),
    ]);
    await mount();
    const rows = [...root.querySelectorAll<HTMLElement>('.bill-report')];
    expect(rows.map(r => r.dataset.status).slice(0, 3)).toEqual(['failed', 'not_ready', 'differences']);
    expect(rows[0]!.textContent).toContain('支付渠道返回结果不确定');
    expect(rows[0]!.textContent).toContain('PAYMENT_UPSTREAM_UNCERTAIN');
    expect(rows[0]!.textContent).toContain('待核对');
    expect(rows[0]!.textContent).toContain('待自动重试 · 11/16 11:00');
    const metrics = [...root.querySelectorAll('.bill-summary dd')].map(e => e.textContent?.trim());
    expect(metrics).toEqual(['5份', '3份', '1份', '1份']);
    button('异常 / 待重试').click(); await nextTick();
    expect(root.querySelectorAll('.bill-report')).toHaveLength(3);
    expect(button('异常 / 待重试').getAttribute('aria-pressed')).toBe('true');
    button('账单一致').click(); await nextTick();
    expect(root.querySelectorAll('.bill-report')).toHaveLength(1);
    expect(root.querySelector('.bill-report')?.getAttribute('data-status')).toBe('succeeded');
    expect(getPaymentBills).toHaveBeenCalledTimes(1);
    expect(reconcilePaymentBill).not.toHaveBeenCalled();
  });
  it('expands difference details with type, order and both amounts', async () => {
    vi.mocked(getPaymentBills).mockResolvedValue([fixture('different', 'differences', {
      differenceCount: 2, differences: [{ type: 'amount_mismatch', outTradeNo: 'ORDER-1', expectedFen: 29900, actualFen: 19900 }],
    })]);
    await mount();
    expect(root.querySelector('details')?.open).toBe(true);
    expect(root.querySelector('table')?.textContent).toContain('金额不符');
    expect(root.querySelector('table')?.textContent).toContain('ORDER-1');
    expect(root.querySelector('table')?.textContent).toContain('299.00');
    expect(root.querySelector('table')?.textContent).toContain('199.00');
    expect(root.querySelector('summary')?.textContent).toContain('显示前 1 条');
  });
  it('distinguishes a failed load from an empty report and clears errors after refreshing', async () => {
    vi.mocked(getPaymentBills).mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([]);
    await mount();
    expect(root.querySelector('[role=alert]')).not.toBeNull();
    expect(root.textContent).not.toContain('尚无对账报告');
    button('刷新报告').click(); await flush();
    expect(root.querySelector('[role=alert]')).toBeNull();
    expect(root.textContent).toContain('尚无对账报告');
  });
  it('shows filtered empty and loading states without claiming success', async () => {
    let finish!: (value: PaymentBillReport[]) => void;
    vi.mocked(getPaymentBills).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await mount();
    expect(root.textContent).toContain('正在读取对账报告');
    expect(root.querySelector('.bill-summary')).toBeNull();
    expect(button('正在读取').disabled).toBe(true);
    finish([fixture('ok', 'succeeded')]); await flush();
    button('异常 / 待重试').click(); await nextTick();
    expect(root.textContent).toContain('此状态下暂无对账报告');
    expect(root.textContent).not.toContain('尚无对账报告');
  });
  it('keeps old reports on refresh failure and never changes their reconciliation state', async () => {
    vi.mocked(getPaymentBills).mockResolvedValueOnce([fixture('ok', 'succeeded')]).mockRejectedValueOnce(Error('unavailable'));
    await mount(); button('刷新报告').click(); await flush();
    expect(root.querySelector('[role=alert]')).not.toBeNull();
    expect(root.querySelector('.bill-report')?.getAttribute('data-status')).toBe('succeeded');
    expect(reconcilePaymentBill).not.toHaveBeenCalled();
  });
});
