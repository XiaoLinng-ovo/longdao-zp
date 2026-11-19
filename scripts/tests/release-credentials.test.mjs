import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { test } from 'node:test'
import { credentialSignatures, inspectReleaseCredentials } from '../check-release-credentials.mjs'

test('合成凭据能被阻断但结果不包含秘密',()=>{
  const secret='sk-' + 'a'.repeat(36)
  const password='synthetic-' + 'b'.repeat(20)
  const content=[secret,['postgresql','://test:',password,'@127.0.0.1/test'].join(''),'-----BEGIN '+ 'PRIVATE KEY-----'].join('\n')
  const hits=credentialSignatures(content)
  assert.deepEqual(hits.map(row=>row.rule).sort(),['credential-url','private-key','provider-secret'])
  assert.ok(!JSON.stringify(hits).includes(secret))
  assert.ok(!JSON.stringify(hits).includes(password))
  assert.deepEqual(credentialSignatures('postgresql://test:change-me-in-development@localhost/test'),[])
})

test('检查已暂存版本和工作区，删除工作区副本不能掩盖暂存凭据',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'release-credential-test-'))
  const git=args=>execFileSync('git',args,{cwd:directory,windowsHide:true,stdio:'pipe'})
  const secret='sk-'+'z'.repeat(36)
  try {
    git(['init','--quiet'])
    await writeFile(join(directory,'config.txt'),secret)
    git(['add','config.txt'])
    await writeFile(join(directory,'config.txt'),'safe')
    const report=inspectReleaseCredentials(directory)
    assert.ok(report.findings.some(row=>row.source==='index' && row.rule==='provider-secret'))
    assert.ok(!JSON.stringify(report).includes(secret))
    await writeFile(join(directory,'environment-before-release'),'synthetic')
    git(['add','environment-before-release'])
    assert.ok(inspectReleaseCredentials(directory).findings.some(row=>row.rule==='sensitive-path'))
  } finally {
    assert.equal(resolve(directory,'..'),resolve(tmpdir()))
    assert.match(directory.split(/[/\\]/).at(-1),/^release-credential-test-/)
    await rm(directory,{recursive:true,force:true})
  }
})

test('尚未暂存的新文件也参与发布检查，并明确报告扫描盲区',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'release-credential-test-'))
  const git=args=>execFileSync('git',args,{cwd:directory,windowsHide:true,stdio:'pipe'})
  const secret='sk-'+'u'.repeat(36)
  try {
    git(['init','--quiet'])
    await writeFile(join(directory,'new-config.txt'),secret)
    await writeFile(join(directory,'new-binary.bin'),Buffer.from([0,1,2]))
    const report=inspectReleaseCredentials(directory)
    assert.ok(report.findings.some(row=>row.file==='new-config.txt' && row.source==='working-tree' && row.rule==='provider-secret'))
    assert.ok(report.skipped.some(row=>row.file==='new-binary.bin' && row.reason==='binary'))
    assert.equal(report.scope.untracked,2)
    assert.equal(report.scope.history,'not-scanned')
    assert.equal(report.scope.archives,'not-expanded')
    assert.ok(!JSON.stringify(report).includes(secret))
  } finally {
    assert.equal(resolve(directory,'..'),resolve(tmpdir()))
    assert.match(basename(directory),/^release-credential-test-/)
    await rm(directory,{recursive:true,force:true})
  }
})
