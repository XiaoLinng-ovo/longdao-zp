// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {createApp,nextTick,type App} from 'vue'
import InvitationJoinPage from './InvitationJoinPage.vue'
const mocks=vi.hoisted(()=>({route:{query:{invite:'ABCDEF123456ABCDEF123456'}},session:{user:null as null|{name:string,email:string}},summary:vi.fn(),accept:vi.fn(),switch:vi.fn()}))
vi.mock('vue-router',()=>({useRoute:()=>mocks.route}))
vi.mock('../session',()=>({authSession:mocks.session,switchWorkspace:mocks.switch}))
vi.mock('../api/invitations',()=>({getInvitationSummary:mocks.summary,acceptInvitation:mocks.accept}))
let app:App,root:HTMLDivElement
async function flush(){for(let i=0;i<10;i++){await Promise.resolve();await nextTick()}}
async function mount(){root=document.createElement('div');document.body.appendChild(root);app=createApp(InvitationJoinPage);app.component('router-link',{props:['to'],template:'<a><slot /></a>'});app.mount(root);await flush()}
beforeEach(()=>{vi.resetAllMocks();mocks.session.user=null;mocks.summary.mockResolvedValue({workspaceName:'测试企业',expiresAt:'2099-01-01',shared:true});mocks.accept.mockResolvedValue({workspaceId:'w',workspaceName:'测试企业'})})
afterEach(()=>{app?.unmount();root?.remove()})
it('访客能看到企业及注册、登录入口，不直接接受邀请',async()=>{await mount();expect(root.textContent).toContain('测试企业');expect(root.textContent).toContain('注册并加入');expect(root.textContent).toContain('登录并加入');expect(mocks.accept).not.toHaveBeenCalled()})
it('已登录用户加入后切换失败可重试进入，不重复提交加入',async()=>{
 mocks.session.user={name:'成员',email:'member@example.com'};mocks.switch.mockRejectedValue(new Error('切换失败'))
 await mount();root.querySelector('button')!.click();await flush()
 expect(root.textContent).toContain('已加入企业');expect(root.querySelector('button')?.textContent).toBe('进入企业')
 root.querySelector('button')!.click();await flush()
 expect(mocks.accept).toHaveBeenCalledTimes(1);expect(mocks.switch).toHaveBeenCalledTimes(2)
})
it('失效邀请不显示注册和加入按钮',async()=>{mocks.summary.mockRejectedValue(new Error('邀请码已过期'));await mount();expect(root.querySelector('[role=alert]')?.textContent).toContain('过期');expect(root.textContent).not.toContain('注册并加入');expect(root.querySelector('button')).toBeNull()})
