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
it('普通成员查看共享余额、中文流水及规则版本',async()=>{vi.mocked(getEnterpriseBilling).mockResolvedValue(data);await mount();expect(getEnterpriseBilling).toHaveBeenCalledWith('org-a');expect(root.textContent).toContain('108');expect(root.textContent).toContain('待平台核对');expect(root.querySelector('details[open] tbody')!.textContent).toContain('9');expect(root.textContent).not.toContain('uncertain')});
it('切换企业时丢弃旧企业延迟响应',async()=>{let finish!:(d:EnterpriseBilling)=>void;vi.mocked(getEnterpriseBilling).mockImplementationOnce(()=>new Promise(r=>{finish=r})).mockResolvedValue({...data,resources:[]});await mount();authSession.user!.workspaceId='org-b';await flush();finish(data);await flush();expect(root.textContent).not.toContain('108');expect(getEnterpriseBilling).toHaveBeenLastCalledWith('org-b')});

it('转写余额、计费规则和流水统一按分钟展示，历史秒余额不整分扣除',async()=>{
 vi.mocked(getEnterpriseBilling).mockResolvedValue({...data,rules:{interview_audio:{enabled:true,resource:'interview_seconds',quantity:60,unitSize:60}} as EnterpriseBilling['rules'],resources:[{resource:'interview_seconds',available:'5400',next_expiry:'2026-12-01T00:00:00Z'}],tasks:[{...data.tasks[0]!,operation:'interview_audio',resource:'interview_seconds',units:'120'}]});await mount();
 expect(root.textContent).toContain('转写分钟90');expect(root.textContent).toContain('每 1 分钟扣除 1 转写分钟');expect(root.querySelector('details[open] tbody')!.textContent).toContain('预占 2 转写分钟');expect(root.textContent).not.toContain('面试秒数');
});
