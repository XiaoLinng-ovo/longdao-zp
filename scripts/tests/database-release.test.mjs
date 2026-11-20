import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { deployProductionApi } from '../deploy-api.mjs'
import { migratePostgres } from '../migrate-postgres.mjs'

function databaseFixture(pending = []) {
  const calls = []
  const database = {
    loadDatabaseConfig() { return {target: 'isolated-test'} },
    createDatabasePool() { return {end: async () => calls.push('close')} },
    async checkDatabaseReady() { calls.push('ready') },
    async inspectMigrations() { calls.push('inspect'); return {applied:['0079_ticket.sql'],pending,ledgerExists:true} },
    async runMigrations() { calls.push('migrate'); return {applied:pending,alreadyApplied:[]} },
  }
  return {database, calls, log() {}}
}

test('status is read-only; check rejects pending upgrades; both close the database pool', async () => {
  for (const flag of ['--status','--check']) {
    const fixture = databaseFixture(['0081_conversations.sql'])
    const action = migratePostgres({...fixture,args:[flag]})
    if (flag === '--check') await assert.rejects(action,/Database upgrade required/)
    else assert.deepEqual((await action).pending,['0081_conversations.sql'])
    assert.deepEqual(fixture.calls,['ready','inspect','close'])
  }
  const fixture=databaseFixture()
  await migratePostgres({...fixture,args:['--check']})
  assert.deepEqual(fixture.calls,['ready','inspect','close'])
})

test('explicit migration keeps the existing apply behavior; invalid arguments never connect', async () => {
  const fixture=databaseFixture(['0081_conversations.sql'])
  await migratePostgres(fixture)
  assert.deepEqual(fixture.calls,['ready','migrate','close'])
  for (const args of [['--unknown'],['--check','--status']]) {
    const invalid=databaseFixture()
    await assert.rejects(migratePostgres({...invalid,args}),/Usage:/)
    assert.deepEqual(invalid.calls,[])
  }
})

test('database failures close the pool and propagate to the release command', async () => {
  const fixture=databaseFixture()
  fixture.database.checkDatabaseReady=async()=>{throw Error('Database unavailable')}
  await assert.rejects(migratePostgres(fixture),/Database unavailable/)
  assert.deepEqual(fixture.calls,['close'])
})

function releaseFixture() {
  const calls=[], migration=new EventEmitter()
  migration.kill=()=>true
  let started=0
  const options={
    env:{NODE_ENV:'development',ALLOW_DEV_SEED:'true'},
    checkCredentials() {},
    checkBuild:async file=>{calls.push(['build',file])},
    spawnProcess:(command,args,options)=>{calls.push(['migration',command,args,options]);return migration},
    startApi:options=>{started++;calls.push(['start',options]);return 'api-child'},
  }
  return {calls,migration,options,get started(){return started}}
}

test('release waits for successful migrations before starting the prebuilt production API', async () => {
  const fixture=releaseFixture()
  const pending=deployProductionApi(fixture.options)
  await Promise.resolve()
  assert.equal(fixture.started,0)
  const migration=fixture.calls[1]
  assert.deepEqual(migration[2].map(p=>p.split(/[/\\]/).at(-1)),['migrate-postgres.mjs'])
  assert.equal(migration[3].env.NODE_ENV,'production')
  assert.equal(migration[3].shell,undefined)
  fixture.migration.emit('exit',0,null)
  assert.equal(await pending,'api-child')
  assert.equal(fixture.started,1)
  assert.equal(fixture.calls[2][1].env.NODE_ENV,'production')
})

for (const outcome of ['failure','signal','spawn-error']) {
  test('release never starts the API after migration '+outcome,async()=>{
    const fixture=releaseFixture(), pending=deployProductionApi(fixture.options)
    await Promise.resolve()
    if(outcome==='spawn-error')fixture.migration.emit('error',Error('Spawn unavailable'))
    else fixture.migration.emit('exit',outcome==='failure'?1:null,outcome==='signal'?'SIGTERM':null)
    await assert.rejects(pending)
    assert.equal(fixture.started,0)
  })
}

test('release refuses a missing build before starting any database command',async()=>{
  const fixture=releaseFixture()
  fixture.options.checkBuild=async()=>{throw Error('Missing build')}
  await assert.rejects(deployProductionApi(fixture.options),/Prebuilt API is unavailable/)
  assert.deepEqual(fixture.calls,[])
})

test('凭据检查失败时不得执行迁移或启动服务',async()=>{
  const fixture=releaseFixture()
  fixture.options.checkCredentials=()=>{throw Error('凭据检查阻断')}
  await assert.rejects(deployProductionApi(fixture.options),/凭据检查阻断/)
  assert.deepEqual(fixture.calls,[])
})
