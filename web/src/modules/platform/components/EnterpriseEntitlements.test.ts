// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import EnterpriseEntitlements from './EnterpriseEntitlements.vue'
import { assignPlan,getEntitlements,listPlans,publishPlan } from '../api/entitlements'
vi.mock('../api/entitlements',()=>({assignPlan:vi.fn(),getEntitlements:vi.fn(),listPlans:vi.fn(),publishPlan:vi.fn()}))
const plan={id:'plan-a',name:'试用版',code:'trial',version:1,seatLimit:5,jobLimit:20},other={...plan,id:'plan-b',name:'团队版',code:'team',seatLimit:20,jobLimit:200}
const summary={plan,entitlementVersion:2,seats:{used:3,limit:5},jobs:{used:4,limit:20},serviceAvailable:true}
let app:App,root:HTMLDivElement
const flush=async()=>{await Promise.resolve();await Promise.resolve();await nextTick();await new Promise(r=>setTimeout(r,0))}
async function mount(platform=false,canWrite=false,onReady=vi.fn()){vi.mocked(getEntitlements).mockResolvedValue(summary);vi.mocked(listPlans).mockResolvedValue([plan,other]);root=document.createElement('div');document.body.appendChild(root);app=createApp(EnterpriseEntitlements,{organizationId:'org',name:'测试企业',platform,canWrite,onReady});app.mount(root);await flush()}
afterEach(()=>{app?.unmount();root?.remove();vi.resetAllMocks()})
describe('enterprise entitlements UI',()=>{
  it('notifies the parent once initial async content is ready',async()=>{const ready=vi.fn();await mount(true,true,ready);expect(ready).toHaveBeenCalledTimes(1);expect(ready).toHaveBeenCalledWith('org');expect(root.querySelector('.usage')).not.toBeNull()})
  it('enterprise read-only view shows actual capacity without purchasing or write controls',async()=>{await mount();expect(getEntitlements).toHaveBeenCalledWith('org',false);expect(root.textContent).toContain('试用版 · v1');expect(root.textContent).toContain('3 / 5');expect(root.textContent).toContain('4 / 20');expect(root.querySelector('form')).toBeNull();expect(listPlans).not.toHaveBeenCalled()})
  it('viewer sees plans and capacity but cannot assign or publish',async()=>{await mount(true,false);expect(listPlans).toHaveBeenCalled();expect(root.querySelector('form')).toBeNull();expect(assignPlan).not.toHaveBeenCalled()})
  it('admin must state reason and sends displayed version; conflict does not claim success',async()=>{
    await mount(true,true);const select=root.querySelector<HTMLSelectElement>('select')!;select.value='plan-b';select.dispatchEvent(new Event('change',{bubbles:true}));await nextTick()
    root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();expect(assignPlan).not.toHaveBeenCalled();expect(root.textContent).toContain('请填写')
    const reason=root.querySelector<HTMLTextAreaElement>('textarea')!;reason.value='测试升级';reason.dispatchEvent(new Event('input',{bubbles:true}));vi.mocked(assignPlan).mockRejectedValue(new Error('权益已被修改，请刷新'));root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();expect(assignPlan).toHaveBeenCalledWith('org','plan-b',2,'测试升级');expect(root.textContent).toContain('权益已被修改');expect(root.textContent).not.toContain('套餐权益已更新')
  })
  it('successful assignment updates displayed usage and optimistic version',async()=>{
    await mount(true,true);const select=root.querySelector<HTMLSelectElement>('select')!;select.value='plan-b';select.dispatchEvent(new Event('change',{bubbles:true}));const reason=root.querySelector<HTMLTextAreaElement>('textarea')!;reason.value='测试升级';reason.dispatchEvent(new Event('input',{bubbles:true}));vi.mocked(assignPlan).mockResolvedValue({...summary,plan:other,entitlementVersion:3,seats:{used:3,limit:20},jobs:{used:4,limit:200}});await nextTick();root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flush();expect(root.textContent).toContain('团队版 · v1');expect(root.textContent).toContain('权益版本 3');expect(root.textContent).toContain('套餐权益已更新')
  })
  it('failed load removes stale summary and surfaces error',async()=>{await mount();vi.mocked(getEntitlements).mockRejectedValue(new Error('没有企业权限'));root.querySelector('button')!.click();await flush();expect(root.textContent).toContain('没有企业权限');expect(root.querySelector('.usage')).toBeNull()})
})
