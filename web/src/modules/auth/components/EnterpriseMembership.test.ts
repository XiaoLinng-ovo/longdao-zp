// @vitest-environment jsdom
import {createApp,nextTick,type App} from 'vue'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import EnterpriseMembership from './EnterpriseMembership.vue'
import {apiClient} from '../../../shared/api'
import {listWorkspaceMembers} from '../api/invitations'
import type {WorkspaceSummary} from '../api'
vi.mock('../../../shared/api',()=>({apiClient:{getJson:vi.fn(),postJson:vi.fn()}}))
vi.mock('../api/invitations',()=>({listWorkspaceMembers:vi.fn()}))
vi.mock('../session',()=>({authSession:{user:{id:'self'}}}))
let app:App,root:HTMLDivElement
async function flush(){for(let i=0;i<10;i++){await Promise.resolve();await nextTick()}}
function button(text:string){return [...root.querySelectorAll('button')].find(b=>b.textContent?.trim()===text)!}
async function mount(role:WorkspaceSummary['role']='member',membershipActive=true){
  root=document.createElement('div');document.body.append(root)
  app=createApp(EnterpriseMembership,{workspace:{id:'w',name:'企业',kind:'production',status:'active',role,membershipActive,createdAt:''}})
  app.mount(root);await flush()
}
beforeEach(()=>{
  vi.mocked(apiClient.getJson).mockResolvedValue({data:[]} as never)
  vi.mocked(apiClient.postJson).mockResolvedValue({data:{ok:true}} as never)
  vi.mocked(listWorkspaceMembers).mockResolvedValue([
    {id:'self',name:'自己',email:'self@example.invalid',membershipRole:'owner',isActive:true,accountActive:true,businessRole:'recruiter',departmentId:null,departmentName:null,joinedAt:''},
    {id:'other',name:'同事',email:'other@example.invalid',membershipRole:'member',isActive:true,accountActive:true,businessRole:'recruiter',departmentId:null,departmentName:null,joinedAt:''},
    {id:'admin',name:'子管理员',email:'admin@example.invalid',membershipRole:'admin',isActive:true,accountActive:true,businessRole:'recruiter',departmentId:null,departmentName:null,joinedAt:''},
  ])
})
afterEach(()=>{app?.unmount();root?.remove();vi.restoreAllMocks();vi.resetAllMocks()})
describe('企业退出与交接',()=>{
  it('普通成员申请退出，不提供直接解绑',async()=>{
    await mount()
    const reason=root.querySelector('textarea')!;reason.value='申请离职';reason.dispatchEvent(new Event('input'))
    root.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await flush()
    expect(apiClient.postJson).toHaveBeenCalledWith('/workspaces/w/exit-requests',{reason:'申请离职'})
    expect(root.textContent).toContain('退出申请已提交')
    expect(listWorkspaceMembers).not.toHaveBeenCalled()
  })
  it('停用身份仍可申请退出但不能管理其他成员',async()=>{
    await mount('admin',false)
    expect(root.textContent).toContain('申请退出企业')
    expect(root.querySelector('select')).toBeNull()
  })
  it('子管理员仅能选择普通成员办理退出',async()=>{
    await mount('admin')
    const options=[...root.querySelectorAll('select')[0].options].map(o=>o.value)
    expect(options).toContain('other');expect(options).not.toContain('admin');expect(options).not.toContain('self')
  })
  it('子管理员也可以申请本人退出',async()=>{
    vi.spyOn(window,'confirm').mockReturnValue(true)
    await mount('admin')
    const reason=root.querySelector('textarea')!;reason.value='本人申请退出';reason.dispatchEvent(new Event('input'))
    button('申请本人退出').click();await flush()
    expect(apiClient.postJson).toHaveBeenCalledWith('/workspaces/w/exit-requests',{reason:'本人申请退出'})
  })
  it('管理员选择接收人并确认后才解除绑定',async()=>{
    vi.mocked(apiClient.getJson).mockResolvedValue({data:[{id:'r',user_id:'other',name:'同事',reason:'申请离职'}]} as never)
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(false)
    await mount('owner');button('办理').click();await flush()
    const reason=root.querySelector('textarea')!;reason.value='已完成交接';reason.dispatchEvent(new Event('input'))
    root.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await flush()
    expect(apiClient.postJson).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    root.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await flush()
    expect(apiClient.postJson).toHaveBeenCalledWith('/workspaces/w/members/other/depart',{reason:'已完成交接',replacementId:'self',reject:false})
  })
})
