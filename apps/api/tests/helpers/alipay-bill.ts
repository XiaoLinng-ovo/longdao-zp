import { deflateRawSync } from "node:zlib";
import { crc32 } from "../../src/payments/bill-format.js";
export function zipFixture(data:Buffer, name=Buffer.from("2088_业务明细.csv"), flags=0x800) {
  const packed=deflateRawSync(data), local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(flags,6);local.writeUInt16LE(8,8);local.writeUInt32LE(crc32(data),14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(flags,8);central.writeUInt16LE(8,10);central.writeUInt32LE(crc32(data),16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+packed.length,16);
  return Buffer.concat([local,name,packed,central,name,end]);
}
export const header="支付宝交易号,商户订单号,业务类型,订单金额（元）,退款批次号/请求号,商品名称";
export const billFixture=()=>zipFixture(Buffer.from("#支付宝业务明细查询\r\n"+header+'\r\nali,order,交易,299.01,,"招聘,套餐"\r\nali,order,退款,-299.01,refund,"多行\n说明"\r\n#合计\r\n'));
