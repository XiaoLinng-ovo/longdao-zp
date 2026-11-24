// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createApp,nextTick,type App} from 'vue';
import Panel from './CreditConversionPanel.vue';
import {previewCreditConversion,convertCredits,type CreditConversion} from '../api/payments';
vi.mock('../api/payments',()=>({previewCreditConversion:vi.fn(),convertCredits:vi.fn()}));
const fixture:CreditConversion={orderId:'order-1',digest:'snapshot-1',grants:[{id:'grant-1',resource:'interview_seconds',total:'5400',remaining:'3600',expires_at:'2099-01-01T00:00:00Z',blockedReason:null},{id:'grant-2',resource:'ai_points',total:'100',remaining:'90',expires_at:null,blockedReason:'已是长期额度'}]};
let app:App,root:HTMLDivElement;
const flush=async()=>{await Promise.resolve();await nextTick();await new Promise(r=>setTimeout(r,0))};
const set=(input:HTMLInputElement,value:string)=>{input.value=value;input.dispatchEvent(new Event('input'))};
async function mount(){vi.mocked(previewCreditConversion).mockResolvedValue(structuredClone(fixture));root=document.createElement('div');document.body.append(root);app=createApp(Panel);app.mount(root);set(root.querySelector('input')!,'order-1');await nextTick();root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush()}
afterEach(()=>{app?.unmount();root?.remove();vi.resetAllMocks()});
describe('历史付费额度转换',()=>{
 it('先显示批次剩余和阻塞原因，确认时携带预览摘要及依据',async()=>{
  vi.spyOn(window,'confirm').mockReturnValue(true);vi.mocked(convertCredits).mockResolvedValue({converted:1});await mount();expect(previewCreditConversion).toHaveBeenCalledWith('order-1');expect(root.textContent).toContain('60');expect(root.textContent).toContain('已是长期额度');const forms=root.querySelectorAll('form');set(forms[1]!.querySelector('input')!,'确认旧付费余额长期可用');await nextTick();forms[1]!.dispatchEvent(new Event('submit'));await flush();expect(convertCredits).toHaveBeenCalledWith({orderId:'order-1',expectedDigest:'snapshot-1',reason:'确认旧付费余额长期可用'});expect(root.textContent).toContain('已转换 1 个额度批次');expect(root.querySelectorAll('form')).toHaveLength(1);
 });
 it('预览后修改订单清空旧预览，避免转换另一订单',async()=>{
  await mount();set(root.querySelector('input')!,'order-2');await nextTick();expect(root.querySelector('table')).toBeNull();expect(convertCredits).not.toHaveBeenCalled();
 });
 it('没有可转换批次不提供确认操作',async()=>{
  vi.mocked(previewCreditConversion).mockResolvedValue({...fixture,grants:fixture.grants.map(g=>({...g,blockedReason:'存在预占或结果待核对的任务'}))});root=document.createElement('div');document.body.append(root);app=createApp(Panel);app.mount(root);set(root.querySelector('input')!,'order-1');await nextTick();root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush();expect(root.querySelectorAll('form')).toHaveLength(1);expect(convertCredits).not.toHaveBeenCalled();
 });
 it('余额变化导致失败后必须重新预览，不能沿用旧摘要重试',async()=>{
  vi.spyOn(window,'confirm').mockReturnValue(true);vi.mocked(convertCredits).mockRejectedValue(new Error('余额已变化，请重新预览'));await mount();const form=root.querySelectorAll('form')[1]!;set(form.querySelector('input')!,'核对后转换');await nextTick();form.dispatchEvent(new Event('submit'));await flush();expect(root.querySelector('[role=alert]')?.textContent).toContain('余额已变化');expect(root.querySelectorAll('form')).toHaveLength(1);
 });
});
