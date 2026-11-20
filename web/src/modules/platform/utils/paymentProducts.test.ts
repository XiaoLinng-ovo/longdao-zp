import {describe,it,expect} from 'vitest';
import {capacityIssue,subscriptionPreview} from './paymentProducts';
import type {Checkout,PaymentProduct} from '../api/payments';
const product:PaymentProduct={id:'p',planVersionId:'plan',name:'测试套餐',amountFen:100,currency:'CNY',durationDays:null,durationMonths:1,active:true,seatLimit:5,jobLimit:10,billingKind:'subscription'};
const org:Checkout['organization']={id:'org',name:'测试企业',entitlementVersion:1,expiresAt:null,seatUsage:2,jobUsage:4,planVersionId:'other',serviceAvailable:true};
describe('购买页权益说明和期限预测',()=>{
 it('历史增购商品即使服务有效也不能再次购买',()=>{expect(capacityIssue({...product,billingKind:'addon'},org)).toContain('已停售')});
 it('容量不足不能订阅，服务过期仍可续费',()=>{
  expect(capacityIssue(product,{...org,seatUsage:6})).toContain('容量低于');
  expect(capacityIssue(product,{...org,serviceAvailable:false})).toBe('');
  expect(capacityIssue({...product,billingKind:'addon'},{...org,serviceAvailable:false})).toContain('已停售');
 });
 it('自然月按中国时区计算，月末及闰年正确收敛',()=>{
  expect(subscriptionPreview(product,org,new Date('2028-01-30T16:30:00Z')).end.toISOString()).toBe('2028-02-28T16:30:00.000Z');
  expect(subscriptionPreview(product,org,new Date('2027-01-31T07:00:00Z')).end.toISOString()).toBe('2027-02-28T07:00:00.000Z');
 });
 it('同套餐顺延，已到期从现在开始，换套餐立即生效',()=>{
  const now=new Date('2026-11-12T00:00:00Z'),future={...org,planVersionId:'plan',expiresAt:'2026-12-31T00:00:00Z'};
  expect(subscriptionPreview(product,future,now).start.toISOString()).toBe(new Date(future.expiresAt).toISOString());
  expect(subscriptionPreview(product,{...future,expiresAt:'2026-01-01'},now).start).toEqual(now);
  expect(subscriptionPreview(product,{...future,planVersionId:'other'},now).start).toEqual(now);
 });
});
