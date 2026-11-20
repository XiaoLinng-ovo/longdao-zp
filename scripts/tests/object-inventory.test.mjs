import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inventoryLocalObjects } from '../inventory-local-objects.mjs'
import { createLocalObjectStorage } from '../../packages/object-storage/dist/index.js'

test('只读盘点分类引用、意图、位置及大小异常，未知历史文件不自动删除',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'object-inventory-')),root=join(directory,'objects'),outside=join(directory,'outside')
  try {
    await mkdir(root);await mkdir(outside)
    const storage=createLocalObjectStorage(root)
    for(const key of ['referenced','unknown','intent','mismatch','size'])await storage.put(key,Buffer.from('synthetic'),'text/plain')
    await writeFile(join(outside,'keep'),'outside')
    await symlink(outside,join(root,'linked'),process.platform==='win32'?'junction':'dir')
    const catalog={referenced:{referenced:true,locationId:storage.locationId},intent:{intentStatus:'unknown'},mismatch:{locationId:'different'},size:{sizeBytes:999}}
    const rows=[]
    for await(const row of inventoryLocalObjects({root,lookup:async key=>catalog[key],pauseEvery:1,pauseMs:0}))rows.push(row)
    assert.deepEqual(Object.fromEntries(rows.map(row=>[row.key,row.category])),{intent:'unbound-intent',linked:'unsafe-link',mismatch:'location-mismatch',referenced:'referenced',size:'size-mismatch',unknown:'unknown-historical'})
    assert.ok(rows.every(row=>row.deletionAuthorized===false))
    assert.equal((await storage.get('unknown')).toString(),'synthetic')
    assert.equal(await readFile(join(outside,'keep'),'utf8'),'outside')
    await assert.rejects(async()=>{for await(const row of inventoryLocalObjects({root,maxObjects:1}))void row},/超过上限/)
    const controller=new AbortController();controller.abort()
    await assert.rejects(async()=>{for await(const row of inventoryLocalObjects({root,signal:controller.signal}))void row},{name:'AbortError'})
  } finally {
    assert.equal(resolve(directory,'..'),resolve(tmpdir()))
    assert.match(directory.split(/[/\\]/).at(-1),/^object-inventory-/)
    await rm(directory,{recursive:true,force:true})
  }
})

test('命令行拒绝在扫描目录内写报告，独占创建不会覆盖已有报告',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'object-inventory-')),root=join(directory,'objects'),output=join(directory,'report.jsonl')
  const run=promisify(execFile),script=fileURLToPath(new URL('../inventory-local-objects.mjs',import.meta.url))
  try {
    await mkdir(root);await writeFile(join(root,'keep'),'synthetic')
    await assert.rejects(run(process.execPath,[script,'--root',root,'--output',join(root,'report.jsonl')]),error=>/扫描目录之外/.test(error.stderr))
    await run(process.execPath,[script,'--root',root,'--output',output])
    const result=await readFile(output,'utf8')
    assert.equal(JSON.parse(result).key,'keep')
    await assert.rejects(run(process.execPath,[script,'--root',root,'--output',output]),error=>/EEXIST/.test(error.stderr))
    assert.equal(await readFile(output,'utf8'),result)
  } finally {
    assert.equal(resolve(directory,'..'),resolve(tmpdir()))
    assert.match(directory.split(/[/\\]/).at(-1),/^object-inventory-/)
    await rm(directory,{recursive:true,force:true})
  }
})
