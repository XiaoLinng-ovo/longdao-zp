import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

const root=resolve(import.meta.dirname,'../..')
test('credential copies, private keys and runtime logs cannot be added accidentally',()=>{
  for(const path of ['logs/connection-diagnostics.json','backups/config.json','deploy/private.pem','deploy/private.key','releases/test/environment-before-release','releases/test/environment-after-release','db/snapshot.dump']) {
    execFileSync('git',['check-ignore','--no-index','--quiet',path],{cwd:root,windowsHide:true})
  }
})
test('repository audit disables external diff and text converters and emits no matched values',async()=>{
  const source=await readFile(resolve(root,'scripts/audit-repository-hygiene.mjs'),'utf8')
  assert.ok(source.includes("'--no-ext-diff','--no-textconv'"))
  assert.ok(source.includes('findings.push({scope,file,line,rule,requiresManualReview:true})'))
  const dockerignore=await readFile(resolve(root,'.dockerignore'),'utf8')
  assert.ok(dockerignore.includes('**/environment-before-release'))
  assert.ok(dockerignore.includes('**/environment-after-release'))
})
