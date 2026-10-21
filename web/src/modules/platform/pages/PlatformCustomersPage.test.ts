// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import PlatformCustomersPage from './PlatformCustomersPage.vue'
import { authSession } from '../../auth/session'
import { listCustomers, updateCustomer, listPlatformAudit } from '../api'
vi.mock('../components/EnterpriseEntitlements.vue', () => ({ default: { props: ['name', 'organizationId', 'canWrite'], emits: ['ready'], template: `<div><h2>{{ name }} · 套餐及权益</h2><button @click="$emit('ready', organizationId)">模拟加载完成</button></div>` } }))
vi.mock('../api', () => ({ listCustomers: vi.fn(), updateCustomer: vi.fn(), listPlatformAudit: vi.fn() }))
vi.mock('../../auth/session', () => ({ authSession: {user: {platformRole:'admin'}}, refreshAuthSession: vi.fn() }))
const customer={id:'a',name:'测试企业客户',kind:'test' as const,status:'active' as const,serviceStatus:'enabled' as const,trialEndsAt:null,serviceVersion:3,serviceAvailable:true,memberCount:2,createdAt:'2026-10-12T00:00:00Z'}
let app:App,root:HTMLDivElement
const flush=async()=>{await Promise.resolve();await Promise.resolve();await nextTick();await new Promise(r=>setTimeout(r,0))}
const secondCustomer = { ...customer, id: 'b', name: '第二家企业' }
const scrollIntoView = vi.fn()
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
beforeEach(() => { Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView }) })
async function mount(role:'admin'|'viewer', items = [customer]){
  authSession.user!.platformRole=role
  vi.mocked(listCustomers).mockResolvedValue({items,page:1,pageSize:20,total:items.length})
  vi.mocked(listPlatformAudit).mockResolvedValue([])
  root=document.createElement('div');document.body.appendChild(root);app=createApp(PlatformCustomersPage);app.mount(root);await flush()
}
afterEach(()=>{
  app?.unmount();root?.remove();vi.clearAllMocks();vi.unstubAllGlobals()
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll)
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
})
function clickAction(label: string, row = 0) {
  const customerRow = root.querySelectorAll('tbody tr')[row]
  ;[...customerRow.querySelectorAll('button')].find(button => button.textContent === label)!.click()
}
describe('platform customer lifecycle UI',()=>{
  it('read-only operator sees metadata but no write controls',async()=>{await mount('viewer');expect(root.textContent).toContain('平台只读运营');expect(root.textContent).toContain('测试企业客户');expect(root.textContent).not.toContain('管理状态');expect(updateCustomer).not.toHaveBeenCalled()})
  it('requires reason and suspension confirmation before writing with current version',async()=>{
    await mount('admin');[...root.querySelectorAll('button')].find(b=>b.textContent==='管理状态')!.click();await nextTick()
    const form=root.querySelector('.editor form')!;form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();expect(updateCustomer).not.toHaveBeenCalled();expect(document.querySelector('.save-validation-alert')?.textContent).toContain('请填写 2～500 字的操作原因');expect(document.activeElement).toBe(root.querySelector('textarea'))
    const status=root.querySelector<HTMLSelectElement>('.editor select')!;status.value='suspended';status.dispatchEvent(new Event('change',{bubbles:true}))
    const reason=root.querySelector<HTMLTextAreaElement>('textarea')!;reason.value='测试暂停';reason.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()
    form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();expect(updateCustomer).not.toHaveBeenCalled();expect(document.querySelector('.save-validation-alert')?.textContent).toContain('请先确认暂停');expect(document.activeElement).toBe(root.querySelector('.confirmation input'))
    const confirmation=root.querySelector<HTMLInputElement>('.confirmation input')!;confirmation.checked=true;confirmation.dispatchEvent(new Event('change',{bubbles:true}));vi.mocked(updateCustomer).mockResolvedValue({...customer,serviceStatus:'suspended',serviceAvailable:false,serviceVersion:4})
    form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();expect(updateCustomer).toHaveBeenCalledWith(customer,'suspended',null,'测试暂停');expect(root.textContent).toContain('已更新并记录审计');expect(document.querySelector('.save-validation-alert')).toBeNull()
  })
  it('shows a dismissible red alert for blank or whitespace reasons and shows it again on retry',async()=>{
    await mount('admin');[...root.querySelectorAll('button')].find(b=>b.textContent==='管理状态')!.click();await nextTick()
    const form=root.querySelector('.editor form')!,reason=root.querySelector<HTMLTextAreaElement>('textarea')!
    reason.value='   ';reason.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()
    form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush()
    const alert=document.querySelector('.save-validation-alert')!
    expect(alert.getAttribute('role')).toBe('alert');expect(alert.textContent).toContain('暂时无法保存');expect(alert.textContent).toContain('操作原因');expect(updateCustomer).not.toHaveBeenCalled()
    alert.querySelector<HTMLButtonElement>('[aria-label="关闭保存提醒"]')!.click();await nextTick();expect(document.querySelector('.save-validation-alert')).toBeNull()
    form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();expect(document.querySelector('.save-validation-alert')).not.toBeNull();expect(updateCustomer).not.toHaveBeenCalled()
    ;[...root.querySelectorAll('button')].find(b=>b.textContent==='取消')!.click();await nextTick();expect(document.querySelector('.save-validation-alert')).toBeNull()
  })
  it('shows the same alert and focuses the deadline when trial expiry is missing or in the past',async()=>{
    await mount('admin');[...root.querySelectorAll('button')].find(b=>b.textContent==='管理状态')!.click();await nextTick()
    const status=root.querySelector<HTMLSelectElement>('.editor select')!,reason=root.querySelector<HTMLTextAreaElement>('textarea')!
    status.value='trial';status.dispatchEvent(new Event('change',{bubbles:true}));reason.value='延长试用';reason.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()
    const deadline=root.querySelector<HTMLInputElement>('.editor input[type="datetime-local"]')!
    for(const value of ['', '2020-01-01T00:00']){
      deadline.value=value;deadline.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()
      root.querySelector('.editor form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush()
      expect(document.querySelector('.save-validation-alert')?.textContent).toContain('请选择未来的试用到期时间');expect(document.activeElement).toBe(deadline);expect(updateCustomer).not.toHaveBeenCalled()
    }
  })
  it('renders conflict without claiming success or silently overwriting',async()=>{await mount('admin');[...root.querySelectorAll('button')].find(b=>b.textContent==='管理状态')!.click();await nextTick();const reason=root.querySelector<HTMLTextAreaElement>('textarea')!;reason.value='恢复启用';reason.dispatchEvent(new Event('input',{bubbles:true}));vi.mocked(updateCustomer).mockRejectedValue(new Error('客户状态已被修改，请刷新'));root.querySelector('.editor form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();expect(root.textContent).toContain('客户状态已被修改');expect(root.textContent).not.toContain('已更新并记录审计')})
})

describe('customer module navigation', () => {
  it('locates and focuses the service status panel after rendering', async () => {
    await mount('admin')
    expect(root.querySelector('.editor')).toBeNull()
    clickAction('管理状态')
    expect(scrollIntoView).not.toHaveBeenCalled()
    await flush()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    expect(scrollIntoView.mock.contexts[0]).toBe(root.querySelector('.editor'))
    expect(document.activeElement).toBe(root.querySelector('.editor'))
    expect(updateCustomer).not.toHaveBeenCalled()
  })
  it('locates entitlements after rendering without changing customer state', async () => {
    await mount('admin')
    clickAction('套餐权益'); await flush()
    const panel = root.querySelector('[aria-label="客户套餐权益"]')
    expect(panel?.textContent).toContain(customer.name)
    expect(scrollIntoView.mock.contexts[0]).toBe(panel)
    expect(document.activeElement).toBe(panel)
    expect(updateCustomer).not.toHaveBeenCalled()
  })
  it('realigns after async entitlements load while the panel still has focus', async () => {
    await mount('admin')
    clickAction('套餐权益'); await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="客户套餐权益"] button')!.click(); await flush()
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })
  it('does not steal focus back when entitlements finish after opening status management', async () => {
    await mount('admin')
    clickAction('套餐权益'); await flush()
    clickAction('管理状态'); await flush()
    root.querySelector<HTMLButtonElement>('[aria-label="客户套餐权益"] button')!.click(); await flush()
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(root.querySelector('.editor'))
  })
  it('repeated entitlement clicks keep the module open and locate it again', async () => {
    await mount('admin')
    clickAction('套餐权益'); await flush()
    clickAction('套餐权益'); await flush()
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect(root.querySelector('[aria-label="客户套餐权益"]')?.textContent).toContain(customer.name)
  })
  it.each(['管理状态', '套餐权益'])('locates the newly selected customer for %s', async (label) => {
    await mount('admin', [customer, secondCustomer])
    clickAction(label); await flush()
    clickAction(label, 1); await flush()
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    expect((scrollIntoView.mock.contexts[1] as HTMLElement).textContent).toContain(secondCustomer.name)
  })
  it('only locates the last requested panel when actions are clicked rapidly', async () => {
    await mount('admin')
    clickAction('管理状态'); clickAction('套餐权益'); await flush()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(root.querySelector('[aria-label="客户套餐权益"]'))
  })
  it('respects reduced motion while preserving viewer read-only access', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    await mount('viewer')
    clickAction('套餐权益'); await flush()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
    expect(root.querySelector('.editor')).toBeNull()
    expect(root.textContent).not.toContain('管理状态')
    expect(updateCustomer).not.toHaveBeenCalled()
  })
})
