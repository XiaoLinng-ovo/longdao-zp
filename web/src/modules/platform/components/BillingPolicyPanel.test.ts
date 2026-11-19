// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createApp,nextTick,type App} from 'vue';
import Panel from './BillingPolicyPanel.vue';
import { listCustomers, type CustomerPage } from '../api';
vi.mock('../api',()=>({listCustomers:vi.fn()}));
const customerPage:CustomerPage={items:[{id:'11111111-1111-4111-8111-111111111111',name:'测试企业',kind:'test',status:'active',serviceStatus:'trial',trialEndsAt:null,serviceVersion:1,serviceAvailable:true,memberCount:2,createdAt:'2026-11-01T00:00:00Z'}],total:1,page:1,pageSize:20};
import {getBillingPolicy,publishBillingPolicy,grantBillingQuota,resolveBillingTask,type BillingOverview,type BillingOperation} from '../api/payments';
vi.mock('../api/payments',()=>({getBillingPolicy:vi.fn(),publishBillingPolicy:vi.fn(),grantBillingQuota:vi.fn(),resolveBillingTask:vi.fn()}));
const fixture=():BillingOverview=>({version:'3',history:[],tasks:[],config:{enabled:false,rules:Object.fromEntries(['resume_analysis','job_spec','jd','interview_questions','answer_analysis','interview_summary','transcript_processing','interview_audio','ocr'].map(key=>[key,{enabled:true,resource:'ai_points',quantity:10,unitSize:1}])) as BillingOverview['config']['rules'],limits:{maxConcurrent:2,dailyAiPoints:1000,maxInputChars:10000,maxOutputTokens:1000},trial:{durationDays:14,seatLimit:5,jobLimit:20,resumeUploads:3,interviews:3,aiGenerations:3,aiPoints:100,interviewSeconds:100,ocrPages:20}}});
let app:App,root:HTMLDivElement;
const flush=async()=>{await Promise.resolve();await nextTick();await new Promise(r=>setTimeout(r,0))};
const field=(label:string)=>[...root.querySelectorAll('label')].find(n=>n.textContent?.trim()===label)!.querySelector('input')!;
const set=(input:HTMLInputElement,value:string)=>{input.value=value;input.dispatchEvent(new Event('input'))};
async function mount(data=fixture()){vi.mocked(listCustomers).mockResolvedValue(structuredClone(customerPage));vi.mocked(getBillingPolicy).mockImplementation(async()=>structuredClone(data));root=document.createElement('div');document.body.append(root);app=createApp(Panel);app.mount(root);await flush()}
afterEach(()=>{app?.unmount();root?.remove();vi.resetAllMocks();vi.unstubAllGlobals()});
describe('后台计费规则配置',()=>{
 it('修改规则、试用容量与保护上限，以读取版本发布，不覆盖历史',async()=>{
  await mount();set(root.querySelector('[aria-label="简历分析扣除数量"]')!,'17');set(root.querySelector('[aria-label="简历分析单位大小"]')!,'2');set(field('试用天数'),'21');set(field('试用席位数'),'11');set(field('试用岗位数'),'61');set(field('最大并发'),'4');set(field('发布原因'),'调整试用和成本');await nextTick();root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush();
  const input=vi.mocked(publishBillingPolicy).mock.calls[0]![0];expect(input.expectedVersion).toBe('3');expect(input.config.rules.resume_analysis).toMatchObject({quantity:17,unitSize:2});expect(input.config.trial).toMatchObject({durationDays:21,seatLimit:11,jobLimit:61});expect(input.config.limits.maxConcurrent).toBe(4);expect(input.reason).toBe('调整试用和成本');
 });
 it('发放失败后使用同一请求标识重试，避免重复补额',async()=>{
  vi.stubGlobal('crypto',{randomUUID:()=> '44444444-4444-4444-8444-444444444444'});await mount();const customer=root.querySelector('.grant-form select') as HTMLSelectElement;customer.value=customerPage.items[0]!.id;customer.dispatchEvent(new Event('change'));set(field('发放数量（点）'),'75');set(field('到期时间'),'2099-01-01T10:00');set(field('发放原因'),'试用补充额度');await nextTick();vi.mocked(grantBillingQuota).mockRejectedValueOnce(Error('network'));const form=root.querySelector('.grant-form')!;form.dispatchEvent(new Event('submit'));await flush();form.dispatchEvent(new Event('submit'));await flush();expect(grantBillingQuota).toHaveBeenCalledTimes(2);expect(vi.mocked(grantBillingQuota).mock.calls[1]).toEqual(vi.mocked(grantBillingQuota).mock.calls[0]);expect(vi.mocked(grantBillingQuota).mock.calls[0]![0].units).toBe(75);
 });
 it('人工补发长期额度时无需到期日期，向后台明确提交空期限',async()=>{
  await mount();const select=root.querySelector<HTMLSelectElement>('.grant-form select')!;select.value=customerPage.items[0]!.id;select.dispatchEvent(new Event('change'));const checkbox=[...root.querySelectorAll('label')].find(n=>n.textContent?.trim()==='长期有效额度')!.querySelector<HTMLInputElement>('input')!;checkbox.checked=true;checkbox.dispatchEvent(new Event('change'));set(field('发放数量（点）'),'88');set(field('发放原因'),'长期补充额度');await nextTick();expect(field('到期时间').disabled).toBe(true);expect(field('到期时间').required).toBe(false);root.querySelector('.grant-form')!.dispatchEvent(new Event('submit'));await flush();expect(grantBillingQuota).toHaveBeenCalledWith(expect.objectContaining({units:88,expiresAt:null,organizationId:customerPage.items[0]!.id}));
 });
 it('无效到期时间不调用发放接口，人工核对包含依据',async()=>{
  const data=fixture();data.tasks=[{id:'task',operation:'jd' as BillingOperation,resource:'ai_points',units:'20',state:'uncertain',organizationName:'测试企业',createdAt:'2026-11-01T00:00:00Z'}];await mount(data);root.querySelector('.grant-form')!.dispatchEvent(new Event('submit'));await flush();expect(grantBillingQuota).not.toHaveBeenCalled();expect(root.textContent).toContain('请先查找并选择需要发放额度的企业');const customer=root.querySelector('.grant-form select') as HTMLSelectElement;customer.value=customerPage.items[0]!.id;customer.dispatchEvent(new Event('change'));await nextTick();root.querySelector('.grant-form')!.dispatchEvent(new Event('submit'));await flush();expect(grantBillingQuota).not.toHaveBeenCalled();expect(root.textContent).toContain('请选择有效的未来到期时间');[...root.querySelectorAll('button')].find(n=>n.textContent==='核对')!.click();await nextTick();set(field('核对依据'),'已确认请求未成功');await nextTick();root.querySelectorAll('form')[2]!.dispatchEvent(new Event('submit'));await flush();expect(resolveBillingTask).toHaveBeenCalledWith('task',{state:'released',reason:'已确认请求未成功'});
 });
 it('企业查询变更清空已选企业，丢弃过期响应并允许失败后重试',async()=>{
  await mount();const select=root.querySelector('.grant-form select') as HTMLSelectElement;select.value=customerPage.items[0]!.id;select.dispatchEvent(new Event('change'));await nextTick();
  let finish!:(result:CustomerPage)=>void;vi.mocked(listCustomers).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));set(field('企业名称或 ID'),'企业甲');await nextTick();root.querySelector<HTMLButtonElement>('.customer-search button')!.click();await nextTick();expect(select.value).toBe('');
  set(field('企业名称或 ID'),'企业乙');await nextTick();vi.mocked(listCustomers).mockResolvedValueOnce({...customerPage,items:[]});root.querySelector<HTMLButtonElement>('.customer-search button')!.click();await flush();expect(listCustomers).toHaveBeenLastCalledWith('企业乙');expect(root.textContent).toContain('未找到匹配的企业');finish(customerPage);await flush();expect(select.options).toHaveLength(1);
  vi.mocked(listCustomers).mockRejectedValueOnce(Error('offline'));root.querySelector<HTMLButtonElement>('.customer-search button')!.click();await flush();expect(root.textContent).toContain('查找企业失败');vi.mocked(listCustomers).mockResolvedValueOnce(customerPage);root.querySelector<HTMLButtonElement>('.customer-search button')!.click();await flush();expect(select.options).toHaveLength(2);expect(root.textContent).not.toContain('查找企业失败');
 });

});

it('分钟规则、试用与补额换算为原账本单位，重复保存不再次乘以六十',async()=>{
 const data=fixture();data.config.rules.interview_audio={enabled:true,resource:'interview_seconds',quantity:60,unitSize:60};await mount(data);
 const input=root.querySelector<HTMLInputElement>('[aria-label="面试音频转写扣除数量"]')!;
 expect(input.value).toBe('1');expect((root.querySelector('[aria-label="面试音频转写单位大小"]') as HTMLInputElement).value).toBe('1');
 set(input,'2');set(root.querySelector('[aria-label="面试音频转写单位大小"]')!,'3');set(field('试用转写分钟数'),'90');set(field('发布原因'),'按分钟计费');await nextTick();
 root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush();
 expect(vi.mocked(publishBillingPolicy).mock.calls[0]![0].config.rules.interview_audio).toMatchObject({quantity:120,unitSize:180});expect(vi.mocked(publishBillingPolicy).mock.calls[0]![0].config.trial.interviewSeconds).toBe(5400);
 const selects=root.querySelectorAll<HTMLSelectElement>('.grant-form select');selects[0]!.value=customerPage.items[0]!.id;selects[0]!.dispatchEvent(new Event('change'));selects[1]!.value='interview_seconds';selects[1]!.dispatchEvent(new Event('change'));await nextTick();
 set(field('发放数量（分钟）'),'30');set(field('到期时间'),'2099-01-01T10:00');set(field('发放原因'),'补发分钟');await nextTick();root.querySelector('.grant-form')!.dispatchEvent(new Event('submit'));await flush();
 expect(vi.mocked(grantBillingQuota).mock.calls[0]![0].units).toBe(1800);
});
it('历史不足一分钟的规则和试用额度原值发布，切换扣费资源后使用对应单位',async()=>{
 const data=fixture();data.config.rules.interview_audio={enabled:true,resource:'interview_seconds',quantity:1,unitSize:7};await mount(data);set(field('发布原因'),'保留历史设置');await nextTick();
 root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush();expect(vi.mocked(publishBillingPolicy).mock.calls[0]![0].config).toEqual(data.config);
 const select=root.querySelector<HTMLSelectElement>('[aria-label="简历分析额度类型"]')!;select.value='interview_seconds';select.dispatchEvent(new Event('change'));await nextTick();set(root.querySelector('[aria-label="简历分析扣除数量"]')!,'2');set(field('发布原因'),'修改资源单位');await nextTick();root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush();
 expect(vi.mocked(publishBillingPolicy).mock.calls[1]![0].config.rules.resume_analysis.quantity).toBe(120);
});
