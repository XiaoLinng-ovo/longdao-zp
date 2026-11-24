import { inflateRawSync } from "node:zlib";
import { HttpError } from "../http.js";
export interface BillEntry { outTradeNo:string; transactionId:string; type:"payment"|"refund"; amountFen:number; refundId:string }
const invalid = () => new HttpError(502,"PAYMENT_BILL_INVALID","支付宝账单格式无法确认，请管理员核对原始账单");
const MAX = 40 * 1024 * 1024;
export function crc32(data:Uint8Array):number {
  let crc = 0xffffffff;
  for (const b of data) { crc ^= b; for(let i=0;i<8;i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Read a bounded ZIP in memory. Never extract filenames to the filesystem. */
export function billFiles(zip:Buffer):Buffer[] {
  if(zip.length < 22 || zip.length > 20*1024*1024) throw invalid();
  let end = -1;
  for(let i=zip.length-22;i>=Math.max(0,zip.length-65557);i--) {
    if(zip.readUInt32LE(i)===0x06054b50 && i+22+zip.readUInt16LE(i+20)===zip.length) { end=i;break; }
  }
  if(end<0 || zip.readUInt16LE(end+4)!==0 || zip.readUInt16LE(end+6)!==0) throw invalid();
  const count=zip.readUInt16LE(end+10), start=zip.readUInt32LE(end+16), length=zip.readUInt32LE(end+12);
  if(!count || count>32 || zip.readUInt16LE(end+8)!==count || start+length!==end) throw invalid();
  let p=start,total=0;
  const result:Buffer[]=[];
  for(let i=0;i<count;i++) {
    if(p+46>end || zip.readUInt32LE(p)!==0x02014b50) throw invalid();
    const flags=zip.readUInt16LE(p+8), method=zip.readUInt16LE(p+10), crc=zip.readUInt32LE(p+16),
      packed=zip.readUInt32LE(p+20), size=zip.readUInt32LE(p+24), n=zip.readUInt16LE(p+28),
      extra=zip.readUInt16LE(p+30), comment=zip.readUInt16LE(p+32), local=zip.readUInt32LE(p+42);
    total+=size;
    if(flags&1 || ![0,8].includes(method) || size>MAX || total>MAX || p+46+n+extra+comment>end || local+30>start) throw invalid();
    const name = new TextDecoder(flags&0x800 ? "utf-8":"gb18030").decode(zip.subarray(p+46,p+46+n));
    if(zip.readUInt32LE(local)!==0x04034b50 || zip.readUInt16LE(local+8)!==method || zip.readUInt16LE(local+6)!==flags) throw invalid();
    if(zip.readUInt16LE(local+26)!==n || !zip.subarray(local+30,local+30+n).equals(zip.subarray(p+46,p+46+n))) throw invalid();
    const offset=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28);
    if(offset+packed>start) throw invalid();
    // Summary CSVs have different columns; parse only the official business detail file.
    if(name.endsWith(".csv") && name.includes("业务明细") && !name.includes("汇总")) {
      let data:Buffer;
      try { data=method===0 ? zip.subarray(offset,offset+packed) : inflateRawSync(zip.subarray(offset,offset+packed),{maxOutputLength:MAX}); }
      catch { throw invalid(); }
      if(data.length!==size || crc32(data)!==crc) throw invalid();
      result.push(data);
    }
    p+=46+n+extra+comment;
  }
  if(p!==end || !result.length) throw invalid();
  return result;
}
export function csvRows(text:string):string[][] {
  const rows:string[][]=[];
  let row:string[]=[],field="",quoted=false,closed=false;
  const cell=()=>{row.push(field.trim().replace(/^\uFEFF/,""));field="";closed=false;if(row.length>100)throw invalid();};
  for(let i=0;i<text.length;i++) {
    const c=text[i]!;
    if(quoted) { if(c==='"') {if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}} else field+=c; }
    else if(c==='"' && !field && !closed) quoted=true;
    else if(c===',') cell();
    else if(c==='\n' || c==='\r') {if(c==='\r'&&text[i+1]==='\n')i++;cell();rows.push(row);row=[];if(rows.length>100000)throw invalid();}
    else {if(closed && c!==' ' && c!=='\t')throw invalid();field+=c;}
    if(field.length>65536)throw invalid();
  }
  if(quoted)throw invalid();
  if(field || row.length){cell();rows.push(row);}
  return rows;
}
function decode(data:Buffer) {
  try {return new TextDecoder("utf-8",{fatal:true}).decode(data);} catch {return new TextDecoder("gb18030",{fatal:true}).decode(data);}
}
function clean(s:string|undefined){return (s??"").trim().replace(/^['’]/,"").trim();}
export function parseBill(zip:Buffer):BillEntry[] {
  const entries:BillEntry[]=[], seen=new Set<string>();
  for(const data of billFiles(zip)) {
    const rows=csvRows(decode(data));
    const head=rows.findIndex(r=>r.includes("支付宝交易号") && r.includes("商户订单号") && r.includes("业务类型"));
    if(head<0)throw invalid();
    const h=rows[head]!, column=(...names:string[])=>h.findIndex(v=>names.includes(v));
    const order=column("商户订单号"), trade=column("支付宝交易号"), type=column("业务类型"), amount=column("订单金额（元）","订单金额(元)"), refund=column("退款批次号/请求号","退款批次号／请求号");
    if([order,trade,type,amount,refund].some(i=>i<0))throw invalid();
    for(const r of rows.slice(head+1)) {
      if(r.every(v=>!v) || r[0]?.startsWith("#"))continue;
      const t=clean(r[type]), outTradeNo=clean(r[order]), transactionId=clean(r[trade]), value=clean(r[amount]);
      if(!["交易","退款"].includes(t) || !outTradeNo || !transactionId || outTradeNo.length>200 || transactionId.length>200 || !/^-?\d{1,12}(?:\.\d{1,2})?$/.test(value))throw invalid();
      const [whole,decimal=""]=value.replace(/^-/,'').split('.');
      const amountFen=Number(whole)*100+Number(decimal.padEnd(2,'0'));
      const refundId=t==="退款"?clean(r[refund]):"";
      if(!Number.isSafeInteger(amountFen)||amountFen<1||(t==="交易"&&value.startsWith('-'))||(t==="退款"&&!refundId))throw invalid();
      const key=outTradeNo+":"+t+":"+refundId;
      if(seen.has(key))throw invalid(); seen.add(key);
      entries.push({outTradeNo,transactionId,type:t==="交易"?"payment":"refund",amountFen,refundId});
    }
  }
  return entries;
}
