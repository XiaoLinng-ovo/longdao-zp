// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {createApp,nextTick,type App} from 'vue'
import Panel from './OperationalRecoveryPanel.vue'
import * as api from '../api'
vi.mock('../api',()=>({listUnresolvedEmailDeliveries:vi.fn(),resolveEmailDelivery:vi.fn(),listOperationalRecovery:vi.fn(),resolveOperationalTask:vi.fn()}))
let app:App,root:HTMLDivElement
const flush=async()=>{await Promise.resolve();await nextTick();await new Promise(resolve=>setTimeout(resolve,0))}
const button=(label:string)=>Array.from(root.querySelectorAll('button')).find(item=>item.textContent?.trim()===label)!
async function mount(){root=document.createElement('div');document.body.append(root);app=createApp(Panel);app.mount(root);await flush()}
beforeEach(()=>{
  HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','')}
  HTMLDialogElement.prototype.close=function(){this.removeAttribute('open')}
  vi.mocked(api.listUnresolvedEmailDeliveries).mockResolvedValue([{id:'delivery',organization_id:'company',offer_id:'offer',version_id:'version',message_id:'<synthetic@invalid>',status:'unknown',created_at:'2026-11-13',updated_at:'2026-11-13'}])
  vi.mocked(api.listOperationalRecovery).mockResolvedValue({cleanup:[],audio:[{id:'audio',organization_id:'company',status:'unknown',recovery_version:'123'}],refund:[]})
})
afterEach(()=>{app?.unmount();root?.remove();vi.resetAllMocks()})
describe('异常任务人工核对',()=>{
  it('必须提供依据并二次确认，才会提交邮件核对',async()=>{
    await mount();button('未发送').click();await flush()
    const form=root.querySelector('form')!,submit=form.querySelector<HTMLButtonElement>('[type=submit]')!
    expect(submit.disabled).toBe(true)
    const note=form.querySelector('textarea')!;note.value='已核对服务商无投递记录';note.dispatchEvent(new Event('input'))
    const checkbox=form.querySelector<HTMLInputElement>('[type=checkbox]')!;checkbox.checked=true;checkbox.dispatchEvent(new Event('change'))
    await nextTick();expect(submit.disabled).toBe(false)
    form.dispatchEvent(new Event('submit'));await flush()
    expect(api.resolveEmailDelivery).toHaveBeenCalledWith('delivery','not_sent','已核对服务商无投递记录')
  })
  it('未知转写只允许核对终止，不提供直接重试',async()=>{
    await mount();button('整场转写').click();await nextTick()
    expect(root.textContent).toContain('核对并终止');expect(button('重新排队')).toBeUndefined()
    button('核对并终止').click();await flush()
    expect(root.querySelector('dialog')?.textContent).not.toContain('SMTP')
    root.querySelector('dialog')!.dispatchEvent(new Event('cancel',{cancelable:true}));await nextTick()
    expect(root.querySelector('dialog')).toBeNull();expect(api.resolveOperationalTask).not.toHaveBeenCalled()
  })
  it('读取失败明确显示错误而不伪装为空列表',async()=>{
    vi.mocked(api.listOperationalRecovery).mockRejectedValue(new Error('测试结构未就绪'))
    await mount();expect(root.querySelector('[role=alert]')?.textContent).toContain('测试结构未就绪')
  })
  it('人工终止携带列表版本，冲突不会关闭确认窗口',async()=>{
    vi.mocked(api.resolveOperationalTask).mockRejectedValue(new Error('任务状态已经变化，请刷新后重新核对'))
    await mount();button('整场转写').click();await nextTick();button('核对并终止').click();await flush()
    expect(root.querySelector('dialog')?.textContent).toContain('不表示服务商未执行或已退款')
    const form=root.querySelector('form')!,note=form.querySelector('textarea')!,checkbox=form.querySelector<HTMLInputElement>('[type=checkbox]')!
    note.value='已核实停止后续处理';note.dispatchEvent(new Event('input'))
    checkbox.checked=true;checkbox.dispatchEvent(new Event('change'));await nextTick()
    form.dispatchEvent(new Event('submit'));await flush()
    expect(api.resolveOperationalTask).toHaveBeenCalledWith('audio','audio','stop','已核实停止后续处理','123')
    expect(root.querySelector('dialog')).not.toBeNull()
    expect(root.textContent).toContain('任务状态已经变化')
  })
})
