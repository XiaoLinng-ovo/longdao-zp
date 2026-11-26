// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createApp,nextTick,type App} from 'vue';
import Panel from './BillingPolicyPanel.vue';
import {getBillingPolicy,publishBillingPolicy,grantBillingQuota,resolveBillingTask,type BillingOverview} from '../api/payments';
vi.mock('../api/payments',()=>({getBillingPolicy:vi.fn(),publishBillingPolicy:vi.fn(),grantBillingQuota:vi.fn(),resolveBillingTask:vi.fn()}));
const fixture=():BillingOverview=>({version:'3',history:[],tasks:[],config:{enabled:false,rules:Object.fromEntries(['resume_analysis','job_spec','jd','interview_questions','answer_analysis','interview_summary','transcript_processing','interview_audio','ocr'].map(key=>[key,{enabled:true,resource:'ai_points',quantity:10,unitSize:1}])) as BillingOverview['config']['rules'],limits:{maxConcurrent:2,dailyAiPoints:1000,maxInputChars:10000,maxOutputTokens:1000},trial:{durationDays:14,seatLimit:5,jobLimit:20,resumeUploads:3,interviews:3,aiGenerations:3,aiPoints:100,interviewSeconds:100,ocrPages:20}}});
let app:App,root:HTMLDivElement;
const flush=async()=>{await Promise.resolve();await nextTick();await new Promise(r=>setTimeout(r,0))};
const field=(label:string)=>[...root.querySelectorAll('label')].find(n=>n.textContent?.trim()===label)!.querySelector('input')!;
const set=(input:HTMLInputElement,value:string)=>{input.value=value;input.dispatchEvent(new Event('input'))};
async function mount(data=fixture()){vi.mocked(getBillingPolicy).mockImplementation(async()=>structuredClone(data));root=document.createElement('div');document.body.append(root);app=createApp(Panel);app.mount(root);await flush()}
afterEach(()=>{app?.unmount();root?.remove();vi.resetAllMocks()});
describe('后台执行与服务规则',()=>{
 it('只编辑期限、容量及执行限制，发布时强制不扣费并保留历史快照',async()=>{
  const data=fixture();data.config.enabled=true;await mount(data);
  set(field('试用天数'),'21');set(field('试用席位数'),'11');set(field('试用岗位数'),'61');set(field('最大并发'),'4');set(field('发布原因'),'调整执行上限');await nextTick();root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush();
  expect(publishBillingPolicy).toHaveBeenCalledWith({expectedVersion:'3',reason:'调整执行上限',config:{...data.config,enabled:false,limits:{...data.config.limits,maxConcurrent:4},trial:{...data.config.trial,durationDays:21,seatLimit:11,jobLimit:61}}});
 });
 it('不提供算力启用、补额、扣费规则和三次试用控件',async()=>{
  await mount();expect(root.querySelector('.grant-form')).toBeNull();expect(root.querySelectorAll('input[type=checkbox]')).toHaveLength(0);
  for(const label of ['AI 点数','转写分钟','OCR 页数','AI 生成次数','简历上传次数','面试次数','扣除数量'])expect(root.textContent).not.toContain(label);
  expect(grantBillingQuota).not.toHaveBeenCalled();
 });
 it('历史任务仍可核对并提交原因，不触发额度发放',async()=>{
  await mount({...fixture(),tasks:[{id:'task',organizationName:'测试企业',operation:'jd',resource:'ai_points',units:'10',state:'uncertain',createdAt:'2026-11-01T00:00:00Z'}]});
  const archive=root.querySelector<HTMLDetailsElement>('[aria-label="历史计费任务核对"]')!;expect(archive.open).toBe(false);archive.open=true;
  [...archive.querySelectorAll('button')].find(b=>b.textContent==='核对')!.click();await nextTick();set(field('核对依据'),'确认旧请求未完成');await nextTick();archive.querySelector('form')!.dispatchEvent(new Event('submit'));await flush();
  expect(resolveBillingTask).toHaveBeenCalledWith('task',{state:'released',reason:'确认旧请求未完成'});expect(grantBillingQuota).not.toHaveBeenCalled();expect(root.textContent).toContain('历史任务已核对');
 });
 it('发布失败保留原因供重试',async()=>{
  await mount();vi.mocked(publishBillingPolicy).mockRejectedValueOnce(Error('版本已变化'));set(field('发布原因'),'调整执行上限');await nextTick();root.querySelector('form')!.dispatchEvent(new Event('submit'));await flush();expect(root.querySelector('[role=alert]')?.textContent).toContain('版本已变化');expect(field('发布原因').value).toBe('调整执行上限');
 });
 it('保存过程中禁用重复提交',async()=>{
  await mount();let finish!:(value:never)=>void;vi.mocked(publishBillingPolicy).mockImplementationOnce(()=>new Promise(r=>{finish=r}));set(field('发布原因'),'调整执行上限');await nextTick();root.querySelector('form')!.dispatchEvent(new Event('submit'));await nextTick();root.querySelector('form')!.dispatchEvent(new Event('submit'));await nextTick();expect(publishBillingPolicy).toHaveBeenCalledTimes(1);expect(root.querySelector('fieldset')!.disabled).toBe(true);finish(undefined as never);await flush();
 });
});
