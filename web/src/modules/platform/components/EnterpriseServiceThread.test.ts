// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import Thread from './EnterpriseServiceThread.vue'
import { getServiceThread, replyServiceThread, getServiceAttachment, type ServiceThread } from '../api/payments'
vi.mock('../api/payments',()=>({getServiceThread:vi.fn(),replyServiceThread:vi.fn(),getServiceAttachment:vi.fn()}))
const sample = ():ServiceThread=>({request:{id:'ticket',organizationId:'org',message:'原始问题',status:'resolved',response:'已经回复',createdAt:'2026-11-10',resolvedAt:'2026-11-10'},messages:[{id:'message',authorKind:'administrator',message:'<script>安全文本</script>',createdAt:'2026-11-10',attachments:[{id:'file',filename:'说明.txt',mimeType:'text/plain',sizeBytes:10}]}],hasMore:false,nextBefore:null})
let app:App,root:HTMLDivElement
const flush=async()=>{await Promise.resolve();await nextTick();await new Promise(r=>setTimeout(r,0))}
async function mount(org:string|null='org'){
  const props=reactive({requestId:'ticket',organizationId:org ?? undefined})
  root=document.createElement('div');document.body.append(root);app=createApp({render:()=>h(Thread,{...props})});app.mount(root)
  root.querySelector<HTMLButtonElement>('button')!.click();await flush();return props
}
async function type(text:string){const el=root.querySelector('textarea')!;el.value=text;el.dispatchEvent(new Event('input'));await nextTick()}
beforeEach(()=>{vi.mocked(getServiceThread).mockResolvedValue(sample());vi.mocked(replyServiceThread).mockResolvedValue({...sample(),request:{...sample().request,status:'open'}})})
afterEach(()=>{app?.unmount();root?.remove();vi.resetAllMocks();vi.restoreAllMocks()})
describe('enterprise support conversation',()=>{
  it('shows history and attachments safely and submits member follow-ups to the enterprise endpoint',async()=>{
    await mount();expect(getServiceThread).toHaveBeenCalledWith('ticket','org',undefined)
    expect(root.textContent).toContain('继续发送消息会重新打开');expect(root.querySelector('script')).toBeNull()
    expect(root.textContent).toContain('下载 说明.txt');await type('仍然有疑问')
    root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush()
    expect(replyServiceThread).toHaveBeenCalledWith('ticket',{message:'仍然有疑问',attachments:[]},'org')
    expect(root.textContent).toContain('消息已发送');expect(root.querySelector('textarea')!.value).toBe('')
  })
  it('encodes a selected file in the same request as its message',async()=>{
    await mount();const input=root.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input,'files',{configurable:true,value:[new File(['附件内容'],'问题.txt',{type:'text/plain'})]});input.dispatchEvent(new Event('change'));await flush();await type('附上问题说明')
    root.querySelector('form')!.dispatchEvent(new Event('submit'));await new Promise(r=>setTimeout(r,20));await flush()
    expect(replyServiceThread).toHaveBeenCalledWith('ticket',{message:'附上问题说明',attachments:[{filename:'问题.txt',base64:btoa(unescape(encodeURIComponent('附件内容')))}]},'org')
  })
  it('allows administrators to reply without closing or explicitly complete the ticket',async()=>{
    await mount(null);await type('请先补充截图');root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush()
    expect(replyServiceThread).toHaveBeenLastCalledWith('ticket',{message:'请先补充截图',attachments:[],resolve:false},undefined)
    await type('已处理完成');[...root.querySelectorAll('button')].find(b=>b.textContent==='回复并完成工单')!.click();await flush()
    expect(replyServiceThread).toHaveBeenLastCalledWith('ticket',{message:'已处理完成',attachments:[],resolve:true},undefined)
  })
  it('retains a rejected follow-up draft and explains the conflicting open ticket',async()=>{
    vi.mocked(replyServiceThread).mockRejectedValue(new Error('企业已有另一张待处理工单，请在该工单继续沟通'))
    await mount();await type('旧单继续追问');root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush()
    expect(root.querySelector('textarea')!.value).toBe('旧单继续追问');expect(root.textContent).toContain('另一张待处理工单')
  })
  it('loads older history with the server cursor',async()=>{
    vi.mocked(getServiceThread).mockResolvedValueOnce({...sample(),hasMore:true,nextBefore:'cursor'}).mockResolvedValueOnce({...sample(),messages:[{...sample().messages[0]!,id:'older',message:'早期消息'}]})
    await mount();[...root.querySelectorAll('button')].find(b=>b.textContent==='加载更早消息')!.click();await flush()
    expect(getServiceThread).toHaveBeenLastCalledWith('ticket','org','cursor');expect(root.querySelectorAll('.message')).toHaveLength(2)
  })
  it('discards late responses after switching enterprises',async()=>{
    let finish!:(t:ServiceThread)=>void;vi.mocked(getServiceThread).mockImplementationOnce(()=>new Promise(r=>finish=r))
    const props=await mount();props.organizationId='another-org';await flush();finish(sample());await flush()
    expect(root.textContent).not.toContain('安全文本');expect(root.querySelector('textarea')).toBeNull()
  })
  it('downloads attachments through the authorized API instead of a public URL',async()=>{
    vi.mocked(getServiceAttachment).mockResolvedValue({filename:'说明.txt',mimeType:'text/plain',sizeBytes:2,base64:'b2s='})
    Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>'blob:test')});Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()})
    const click=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
    await mount();[...root.querySelectorAll('button')].find(b=>b.textContent?.includes('下载 说明.txt'))!.click();await flush()
    expect(getServiceAttachment).toHaveBeenCalledWith('ticket','file','org');expect(click).toHaveBeenCalledOnce()
  })
})
