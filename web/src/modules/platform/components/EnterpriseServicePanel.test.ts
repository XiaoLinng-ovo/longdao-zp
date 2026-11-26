// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import Panel from './EnterpriseServicePanel.vue'
import { contactSystemAdministrator, exportEnterpriseContinuity, getEnterpriseContinuity, type EnterpriseContinuity } from '../api/payments'
vi.mock('../api/payments', () => ({ contactSystemAdministrator: vi.fn(), exportEnterpriseContinuity: vi.fn(), getEnterpriseContinuity: vi.fn() }))
const sample = (): EnterpriseContinuity => ({dataRestricted:false, data:{stats:{jobs:1,applications:2,interviews:3},limit:100,truncated:false,jobs:[{id:'job',jobNo:'JOB-1',title:'前端工程师',status:'draft',headcount:1,createdAt:'2026-11-01',updatedAt:'2026-11-01'}]},requests:[]})
let app: App, root: HTMLDivElement
const flush = async () => { await Promise.resolve(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)) }
async function mount(props = reactive({organizationId:'expired-enterprise',initiallyExpanded:true})) {
  root = document.createElement('div'); document.body.append(root)
  app = createApp({render: () => h(Panel, {...props})}); app.mount(root); await flush(); return props
}
beforeEach(() => { vi.mocked(getEnterpriseContinuity).mockResolvedValue(sample()) })
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks(); vi.restoreAllMocks() })
describe('expired enterprise service panel', () => {
  it('shows an explicit read-only projection and export limits, with no recruiting mutation controls', async () => {
    await mount()
    expect(getEnterpriseContinuity).toHaveBeenCalledWith('expired-enterprise')
    expect(root.textContent).toContain('已有数据（只读）')
    expect(root.textContent).toContain('前端工程师')
    expect(root.textContent).toContain('1000 条')
    expect(root.querySelectorAll('table tbody tr')).toHaveLength(1)
  })
  it('creates a support request and exposes the shared open request instead of inviting duplicate submissions', async () => {
    const request = {id:'request',organizationId:'expired-enterprise',message:'需要帮助续费',status:'open' as const,response:null,createdAt:'2026-11-10',resolvedAt:null}
    vi.mocked(contactSystemAdministrator).mockResolvedValue({request,existing:false})
    await mount()
    vi.mocked(getEnterpriseContinuity).mockResolvedValue({...sample(),requests:[request]})
    const text = root.querySelector('textarea')!; text.value='需要帮助续费'; text.dispatchEvent(new Event('input'))
    root.querySelector('form')!.dispatchEvent(new Event('submit')); await flush()
    expect(contactSystemAdministrator).toHaveBeenCalledWith('expired-enterprise','需要帮助续费')
    expect(root.textContent).toContain('工单已提交')
    expect(root.textContent).toContain('企业已有待处理工单')
    expect(root.querySelector<HTMLButtonElement>('form button')!.disabled).toBe(true)
  })
  it('submits initial attachments atomically and retains the draft when a competing member already opened a ticket', async () => {
    const request = {id:'request',organizationId:'expired-enterprise',message:'其他成员的问题',status:'open' as const,response:null,createdAt:'2026-11-10',resolvedAt:null}
    vi.mocked(contactSystemAdministrator).mockResolvedValue({request,existing:true})
    await mount()
    const textarea=root.querySelector('textarea')!;textarea.value='附上付款说明';textarea.dispatchEvent(new Event('input'))
    const file=new File(['payment evidence'],'付款说明.txt',{type:'text/plain'})
    const picker=root.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(picker,'files',{configurable:true,value:[file]});picker.dispatchEvent(new Event('change'));await flush()
    root.querySelector('form')!.dispatchEvent(new Event('submit'))
    await vi.waitFor(()=>expect(contactSystemAdministrator).toHaveBeenCalledWith('expired-enterprise','附上付款说明',[{filename:'付款说明.txt',base64:btoa('payment evidence')}]))
    await flush()
    expect(textarea.value).toBe('附上付款说明')
    expect(root.textContent).toContain('本次内容和附件未提交')
    expect(root.textContent).toContain('付款说明.txt')
  })
  it('rejects unsupported or oversized attachments before submitting', async () => {
    await mount()
    const picker=root.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(picker,'files',{configurable:true,value:[new File(['bad'],'script.html',{type:'text/html'})]})
    picker.dispatchEvent(new Event('change'));await flush()
    expect(root.textContent).toContain('仅支持 PNG、JPG、PDF 和 TXT')
    Object.defineProperty(picker,'files',{configurable:true,value:[new File([new Uint8Array(2*1024*1024+1)],'large.pdf')]})
    picker.dispatchEvent(new Event('change'));await flush()
    expect(root.textContent).toContain('单个不能超过 2 MB')
    expect(contactSystemAdministrator).not.toHaveBeenCalled()
  })
  it('preserves contact when service is suspended or its tenant data is unavailable', async () => {
    vi.mocked(getEnterpriseContinuity).mockResolvedValue({dataRestricted:true,data:null,requests:[]})
    await mount()
    expect(root.textContent).toContain('企业服务已暂停')
    expect(root.querySelector('table')).toBeNull()
    expect(root.querySelector('textarea')).not.toBeNull()
    expect([...root.querySelectorAll('button')].some(button => button.textContent?.includes('导出'))).toBe(false)
  })
  it('displays administrator replies as text, preserving the enterprise-visible outcome', async () => {
    vi.mocked(getEnterpriseContinuity).mockResolvedValue({...sample(),requests:[{id:'request',organizationId:'expired-enterprise',message:'续费问题',status:'resolved',response:'<script>unsafe</script> 请重新打开付款页',createdAt:'2026-11-10',resolvedAt:'2026-11-10'}]})
    await mount()
    expect(root.textContent).toContain('系统管理员回复：<script>unsafe</script> 请重新打开付款页')
    expect(root.querySelector('article script')).toBeNull()
    expect(root.querySelector('textarea')!.disabled).toBe(false)
  })
  it('ignores late reads from the previous enterprise', async () => {
    let finish!: (report: EnterpriseContinuity) => void
    vi.mocked(getEnterpriseContinuity).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const props = await mount()
    props.organizationId = 'another-enterprise'; await flush()
    finish({...sample(), data:{...sample().data!,jobs:[{...sample().data!.jobs[0]!,title:'旧企业机密'}]}})
    await flush()
    expect(root.textContent).not.toContain('旧企业机密')
    expect(getEnterpriseContinuity).toHaveBeenLastCalledWith('another-enterprise')
  })
  it('downloads only the server-generated restricted CSV and reports truncation', async () => {
    vi.mocked(exportEnterpriseContinuity).mockResolvedValue({filename:'jobs.csv',csv:'岗位编号\r\nJOB-1',rows:1000,truncated:true,limit:1000})
    const create = vi.fn(() => 'blob:test')
    Object.defineProperty(URL, 'createObjectURL', { configurable:true, value:create })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable:true, value:vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(() => {})
    await mount()
    ;[...root.querySelectorAll('button')].find(button => button.textContent?.includes('导出岗位摘要'))!.click()
    await flush()
    expect(exportEnterpriseContinuity).toHaveBeenCalledWith('expired-enterprise')
    expect(create).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce()
    expect(root.textContent).toContain('已达到 1000 条上限')
  })
})
