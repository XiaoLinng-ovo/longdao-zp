import { opendir, lstat, readFile, open } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { checkedLocalObjectPath, createLocalObjectStorage } from '../packages/object-storage/dist/index.js'

/** Metadata only. No object contents, database connection, deletion or automatic orphan inference. */
export async function* inventoryLocalObjects({root,lookup=async()=>undefined,maxObjects=100000,pauseEvery=100,pauseMs=10,signal}) {
  if (!Number.isSafeInteger(maxObjects) || maxObjects<1 || maxObjects>1000000) throw Error('盘点数量上限无效')
  if (!Number.isSafeInteger(pauseEvery) || pauseEvery<1 || !Number.isFinite(pauseMs) || pauseMs<0) throw Error('盘点限速参数无效')
  await checkedLocalObjectPath(root,'.inventory-probe')
  const locationId=createLocalObjectStorage(root).locationId
  let count=0
  async function* walk(prefix='',depth=0) {
    if(depth>32)throw Error('盘点目录层级超过上限，已停止')
    await checkedLocalObjectPath(root,prefix?prefix+'/.inventory-probe':'.inventory-probe')
    const directory=await opendir(join(root,prefix),{bufferSize:64})
    for await (const entry of directory) {
      signal?.throwIfAborted()
      const key=prefix?prefix+'/'+entry.name:entry.name
      if(++count>maxObjects)throw Error('盘点数量超过上限，已停止；未删除文件')
      if(count%pauseEvery===0)await delay(pauseMs,undefined,{signal})
      const metadata=await lstat(join(root,key))
      if(metadata.isSymbolicLink()) {yield {key,category:'unsafe-link',deletionAuthorized:false};continue}
      if(metadata.isDirectory()){yield* walk(key,depth+1);continue}
      if(!metadata.isFile()){yield {key,category:'unsupported-type',deletionAuthorized:false};continue}
      await checkedLocalObjectPath(root,key)
      const known=await lookup(key)
      const category=known?.locationId && known.locationId!==locationId?'location-mismatch'
        : known?.sizeBytes!==undefined && known.sizeBytes!==metadata.size?'size-mismatch'
        : known?.referenced?'referenced':known?.intentStatus?'unbound-intent':'unknown-historical'
      yield {key,sizeBytes:metadata.size,modifiedAt:metadata.mtime.toISOString(),locationId,category,
        ...(known?.intentStatus?{intentStatus:known.intentStatus}:{}),deletionAuthorized:false}
    }
  }
  yield* walk()
}

async function main(args) {
  const options={}
  for(let index=0;index<args.length;index+=2){
    if(!['--root','--catalog','--output','--limit'].includes(args[index]) || !args[index+1] || Object.hasOwn(options,args[index]))throw Error('参数无效；必须显式指定 --root 和 --output，可选 --catalog 和 --limit')
    options[args[index]]=args[index+1]
  }
  if(!options['--root'] || !options['--output'])throw Error('必须显式指定 --root 和 --output；不会读取现有业务配置')
  const outputWithinRoot=relative(resolve(options['--root']),resolve(options['--output']))
  if(!isAbsolute(outputWithinRoot) && outputWithinRoot!=='..' && !outputWithinRoot.startsWith('..'+(process.platform==='win32'?'\\':'/')))throw Error('盘点报告必须写在扫描目录之外')
  let catalog=new Map()
  if(options['--catalog']){
    if((await lstat(options['--catalog'])).size>8*1024*1024)throw Error('目录索引超过8MB上限')
    const rows=JSON.parse(await readFile(options['--catalog'],'utf8'))
    if(!Array.isArray(rows) || rows.some(row=>typeof row.key!=='string'))throw Error('目录索引格式无效')
    catalog=new Map(rows.map(row=>[row.key,row]))
  }
  // Exclusive creation prevents overwriting an existing report or any user file.
  const output=await open(resolve(options['--output']),'wx',0o600),counts={}
  try {
    for await(const row of inventoryLocalObjects({root:resolve(options['--root']),lookup:async key=>catalog.get(key),maxObjects:Number(options['--limit']||100000)})){
      counts[row.category]=(counts[row.category]||0)+1
      await output.write(JSON.stringify(row)+'\n')
    }
  } finally {await output.close()}
  console.log(JSON.stringify({counts,deleted:0,reportPath:resolve(options['--output'])}))
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1})
