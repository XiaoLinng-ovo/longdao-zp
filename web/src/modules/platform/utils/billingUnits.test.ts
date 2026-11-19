import { describe, expect, it } from 'vitest';
import { toBillingDisplay, toBillingStorage, formatBillingAmount, billingPolicyInMinutes, billingPolicyInSeconds } from './billingUnits';
import type { BillingPolicy } from '../api/payments';
describe('转写分钟与历史整数秒账本',()=>{
 it('整分钟准确换算，所有秒余量往返不丢失',()=>{
  expect(toBillingDisplay(5400,'interview_seconds')).toBe(90);expect(toBillingStorage(90,'interview_seconds')).toBe(5400);
  for(const seconds of [0,1,2,3,59,60,61,100,5400,999999999,1000000000000])expect(toBillingStorage(toBillingDisplay(seconds,'interview_seconds'),'interview_seconds')).toBe(seconds);
  expect(toBillingStorage(5,'ai_points')).toBe(5);expect(toBillingStorage(2,'ocr_pages')).toBe(2);
 });
 it('拒绝无法精确计量的分钟、负数、空值和非整数点数',()=>{
  for(const value of [-1,NaN,Infinity,0.001,'' as unknown as number])expect(()=>toBillingStorage(value,'interview_seconds')).toThrow();
  expect(()=>toBillingStorage(1.5,'ai_points')).toThrow();expect(toBillingStorage(0.5,'interview_seconds')).toBe(30);
 });
 it('小数分钟展示标注近似，原额度保持不变',()=>{
  expect(formatBillingAmount(60,'interview_seconds')).toBe('1');expect(formatBillingAmount(63,'interview_seconds')).toBe('1.05');expect(formatBillingAmount(61,'interview_seconds')).toBe('≈1.016667');
 });
 it('规则转换不修改来源，重复转换往返保持历史数值',()=>{
  const config={rules:{interview_audio:{enabled:true,resource:'interview_seconds',quantity:1,unitSize:7},jd:{enabled:true,resource:'interview_seconds',quantity:63,unitSize:1}},trial:{interviewSeconds:100}} as BillingPolicy;
  const form=billingPolicyInMinutes(config);expect(form.rules.interview_audio.quantity).toBe(1/60);expect(form.rules.jd.quantity).toBe(1.05);expect(config.trial.interviewSeconds).toBe(100);
  expect(billingPolicyInSeconds(form)).toEqual(config);expect(billingPolicyInSeconds(form)).toEqual(config);
 });
});
