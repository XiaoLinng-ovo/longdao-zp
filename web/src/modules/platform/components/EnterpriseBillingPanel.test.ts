// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {createApp,nextTick,type App} from 'vue';
import Panel from './EnterpriseBillingPanel.vue';
import {getEnterpriseBilling,type EnterpriseBilling} from '../api/payments';
import {authSession} from '../../auth/session';
vi.mock('../api/payments',()=>({getEnterpriseBilling:vi.fn()}));
vi.mock('../../auth/session',async()=>({authSession:(await import('vue')).reactive({user:{id:'member',workspaceId:'org-a'},sessionId:'session'})}));
let app:App,root:HTMLDivElement;
const flush=async()=>{await Promise.resolve();await nextTick();await new Promise(r=>setTimeout(r,0))};
const data:EnterpriseBilling={enabled:true,rules:{} as EnterpriseBilling['rules'],resources:[{resource:'ai_points',available:'108',next_expiry:'2026-12-01T00:00:00Z'}],tasks:[{id:'1',operation:'resume_analysis',resource:'ai_points',units:'7',state:'uncertain',policy_version:'9',created_at:'2026-11-01T00:00:00Z'}]};
async function mount(){root=document.createElement('div');document.body.append(root);app=createApp(Panel);app.mount(root);await flush()}
it('显示独立通道的实际占用与交互保留位',async()=>{vi.mocked(getEnterpriseBilling).mockResolvedValue({...data,execution:{enabled:true,text:{active:1,limit:2,reservedInteractive:1},audio:{active:0,limit:1},realtime:{active:1,limit:2}}});await mount();const rows=root.querySelectorAll('[aria-label="执行通道"] tbody tr');expect(rows).toHaveLength(3);expect(rows[0]!.textContent).toBe('对话与后台生成121');expect(rows[1]!.textContent).toBe('录音转写01—');expect(rows[2]!.textContent).toBe('实时转写会话12—')});
afterEach(()=>{app?.unmount();root?.remove();vi.resetAllMocks();authSession.user!.workspaceId='org-a'});
it('旧余额和扣点流水即使由旧接口返回也不再展示',async()=>{vi.mocked(getEnterpriseBilling).mockResolvedValue(data);await mount();expect(getEnterpriseBilling).toHaveBeenCalledWith('org-a');expect(root.textContent).toContain('企业执行状态');for(const text of ['108','AI 点数','企业共享额度','额度来源','最近额度流水','已扣除'])expect(root.textContent).not.toContain(text)});
it('切换企业时丢弃旧企业延迟响应',async()=>{let finish!:(d:EnterpriseBilling)=>void;vi.mocked(getEnterpriseBilling).mockImplementationOnce(()=>new Promise(r=>{finish=r})).mockResolvedValue({...data,resources:[]});await mount();authSession.user!.workspaceId='org-b';await flush();finish(data);await flush();expect(root.textContent).not.toContain('108');expect(getEnterpriseBilling).toHaveBeenLastCalledWith('org-b')});

it('服务暂停时显示续费提示，不再承诺余额',async()=>{vi.mocked(getEnterpriseBilling).mockResolvedValue({...data,serviceAvailable:false});await mount();expect(root.textContent).toContain('续费订阅或联系平台管理员');expect(root.textContent).not.toContain('余额')});
it('刷新失败清空旧执行状态并允许重试',async()=>{vi.mocked(getEnterpriseBilling).mockResolvedValue({...data,execution:{enabled:true,text:{active:1,limit:2,reservedInteractive:1},audio:{active:0,limit:1},realtime:{active:1,limit:2}}});await mount();vi.mocked(getEnterpriseBilling).mockRejectedValueOnce(Error('offline'));root.querySelector('button')!.click();await flush();expect(root.querySelector('[aria-label="执行通道"]')).toBeNull();expect(root.querySelector('[role=alert]')?.textContent).toContain('读取执行状态失败');root.querySelector('button')!.click();await flush();expect(root.querySelector('[aria-label="执行通道"]')).not.toBeNull()});
