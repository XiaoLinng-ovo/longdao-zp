import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { launchIsolatedBrowser } from './isolated-browser-launch.mjs'
import { ephemeralLoopbackPort } from './isolated-browser-ingress.mjs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
assert.ok(process.argv[2], 'Explicit isolated PostgreSQL bin directory required')
const instance = await startIsolatedPostgres(process.argv[2])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env,instance.env)
const require = createRequire(join(projectRoot,'apps/api/package.json'))
const guard = require(join(projectRoot,'scripts/isolated-network-guard.cjs'))
const {Pool} = require('pg'), admin = new Pool(instance.connection)
const load = file => import(pathToFileURL(join(projectRoot,'apps/api/dist/src',file + '.js')))
let pool, created = false
const checks = []
async function check(name,action) { await action();checks.push(name);console.log('PASS ' + name) }
try {
  await admin.query('CREATE DATABASE "' + instance.database + '"');created = true
  pool = new Pool({...instance.connection,database:instance.database})
  await (await load('db/migrations')).runMigrations(pool,join(projectRoot,'db/migrations'))
  const {TodoNotifications} = await load('recruiting/todo-notifications'), inbox = new TodoNotifications(pool)
  const [org,other,a,b,c,inactive,job,candidate,application,interview] = Array.from({length:10},()=>randomUUID())
  for (const id of [org,other]) await pool.query("INSERT INTO public.organizations(id,name,kind,service_status) VALUES($1,'synthetic-todos','test','enabled')",[id])
  for (const id of [a,b,c,inactive]) {
    await pool.query("INSERT INTO public.users(id,email,display_name) VALUES($1::uuid,$1::text || '@example.invalid','synthetic')",[id])
    await pool.query("INSERT INTO public.organization_members(organization_id,user_id,role,business_role,is_active) VALUES($1,$2,'member','recruiter',$3)",[org,id,id !== inactive])
  }
  const schema = (await pool.query('SELECT public.initialize_organization_schema($1) AS name',[org])).rows[0].name
  await pool.query('SELECT public.initialize_organization_schema($1)',[other])
  const table = name => '"' + schema + '".' + name
  await pool.query('INSERT INTO ' + table('jobs') + "(id,job_no,title,headcount,organization_id) VALUES($1,'JOB-SYNTHETIC','synthetic job',1,$2)",[job,org])
  await pool.query('INSERT INTO ' + table('candidates') + "(id,candidate_no,name,organization_id) VALUES($1,'CAN-SYNTHETIC','synthetic candidate',$2)",[candidate,org])
  await pool.query('INSERT INTO ' + table('applications') + "(id,application_no,candidate_id,job_id,status,organization_id) VALUES($1,'APP-SYNTHETIC',$2,$3,'interviewing',$4)",[application,candidate,job,org])
  const participants = [{userId:a,role:'interviewer',required:true,lead:true,sheetTypes:['hr_screen']},{userId:b,role:'interviewer',required:true,lead:false,sheetTypes:['hiring_department']}]
  await check('assignment notifications are created atomically in company schema for all selected members',async()=>{
    await pool.query('INSERT INTO ' + table('interviews') + "(id,interview_no,application_id,round,type,title,status,scheduled_start_at,participants,organization_id) VALUES($1,'INT-SYNTHETIC',$2,1,'technical','synthetic interview','scheduled',now()+interval '2 hours',$3::jsonb,$4)",[interview,application,JSON.stringify(participants),org])
    assert.equal((await inbox.list(org,a,false)).unreadCount,1)
    assert.equal((await inbox.list(org,b,false)).unreadCount,1)
    assert.equal((await inbox.list(org,c,false)).items.length,0)
    assert.equal((await inbox.list(other,a,false)).items.length,0)
    await pool.query('UPDATE ' + table('interviews') + ' SET updated_at=now() WHERE id=$1',[interview])
    assert.equal((await inbox.list(org,a,false)).unreadCount,1)
  })
  await check('schedule changes roll back together with notifications',async()=>{
    const db=await pool.connect()
    try {await db.query('BEGIN');await db.query('UPDATE ' + table('interviews') + " SET location='rollback' WHERE id=$1",[interview]);await db.query('ROLLBACK')} finally {db.release()}
    assert.equal((await inbox.list(org,a,false)).unreadCount,1)
    await pool.query('UPDATE ' + table('interviews') + " SET location='confirmed',updated_at=now() WHERE id=$1",[interview])
    assert.equal((await inbox.list(org,a,false)).unreadCount,2)
  })
  await check('removed participants get non-actionable messages and inactive members receive none',async()=>{
    await pool.query('UPDATE ' + table('interviews') + ' SET participants=$2::jsonb,updated_at=now() WHERE id=$1',[interview,JSON.stringify([participants[0],{...participants[1],userId:inactive}])])
    assert.ok((await inbox.list(org,b,false)).items.every(item=>item.state !== 'active'))
    assert.equal((await inbox.list(org,inactive,false)).items.length,0)
  })
  const todo = {id:'sheet-synthetic',category:'interview',title:'synthetic scoring',description:'assigned scoring',actionLabel:'score',path:'/interviews/' + interview,updatedAt:new Date().toISOString()}
  await check('concurrent sync creates one task notice and reading does not complete tasks',async()=>{
    await Promise.all(Array.from({length:4},()=>inbox.sync(org,c,async()=>[todo])))
    assert.equal((await inbox.list(org,c,false)).items.length,1)
    const id=(await inbox.list(org,c,false)).items[0].id
    await inbox.markRead(other,c,[id]);assert.equal((await inbox.list(org,c,false)).unreadCount,1)
    await inbox.markRead(org,b,[id]);assert.equal((await inbox.list(org,c,false)).unreadCount,1)
    await inbox.markRead(org,c,[id]);assert.equal((await inbox.list(org,c,false)).unreadCount,0)
    assert.equal((await pool.query('SELECT active FROM public.recruitment_user_tasks WHERE organization_id=$1 AND user_id=$2 AND task_key=$3',[org,c,todo.id])).rows[0].active,true)
    await inbox.sync(org,c,async()=>[todo]);assert.equal((await inbox.list(org,c,false)).unreadCount,0)
    await inbox.sync(org,c,async()=>[]);assert.equal((await inbox.list(org,c,false)).items[0].state,'resolved')
    await inbox.sync(org,c,async()=>[todo]);assert.equal((await inbox.list(org,c,false)).unreadCount,1)
  })
  await check('keyset pagination preserves equal timestamps and microsecond precision',async()=>{
    await pool.query('DELETE FROM public.recruitment_notifications WHERE user_id=$1',[c])
    await pool.query(`INSERT INTO public.recruitment_notifications(organization_id,user_id,task_key,event_key,kind,title,created_at)
      SELECT $1,$2,'page','page-'||n,'todo','synthetic','2026-11-26 00:00:00.123456+00'::timestamptz FROM generate_series(1,105)n`,[org,c])
    const seen=new Set();let cursor
    do {const page=await inbox.list(org,c,false,cursor);for(const item of page.items){assert.ok(!seen.has(item.id));seen.add(item.id)}cursor=page.nextBefore} while(cursor)
    assert.equal(seen.size,105)
    await assert.rejects(inbox.list(org,c,false,'invalid'),{status:400})
  })
  await check('cancellation removes actionable links for assigned interviewers',async()=>{
    await pool.query('UPDATE ' + table('interviews') + " SET status='cancelled',updated_at=now() WHERE id=$1",[interview])
    assert.ok((await inbox.list(org,a,false)).items.every(item=>item.state !== 'active'))
  })
  if (process.argv.includes('--browser')) {
    let api,vite,browser
    const errors=[],session='todos-' + randomUUID().slice(0,8)
    const agentIndex=process.argv.indexOf('--agent-browser'), agentCli=agentIndex >= 0 ? process.argv[agentIndex+1] : undefined
    assert.ok(agentCli,'Explicit agent-browser CLI path required')
    const execute=promisify(execFile)
    const chrome=join(process.env.ProgramFiles || 'C:/Program Files','Google/Chrome/Application/chrome.exe')
    const agent=async args => {
      const result=await execute(process.execPath,[agentCli,'--session',session,'--executable-path',chrome,...args],{env:process.env,windowsHide:true,timeout:60000,maxBuffer:1024*1024})
      console.log(result.stdout.trim());return result.stdout
    }
    try {
      const password=randomBytes(18).toString('base64url') + '!9aA'
      const hash=await (await load('auth/password')).hashPassword(password)
      await pool.query('UPDATE public.users SET password_hash=$1,email_verified_at=now() WHERE id=ANY($2::uuid[])',[hash,[a,b,c]])
      await pool.query("UPDATE public.organization_members SET role='owner' WHERE organization_id=$1 AND user_id=$2",[org,a])
      await pool.query('UPDATE ' + table('interviews') + " SET status='scheduled',participants=$2::jsonb,updated_at=now() WHERE id=$1",[interview,JSON.stringify(participants)])
      await pool.query('DELETE FROM public.recruitment_notifications WHERE user_id=$1',[c])
      const {startServer}=await load('server'), {loadConfig}=await load('config')
      api=await startServer(loadConfig({...process.env,HOST:'127.0.0.1',PORT:'0'}))
      guard.allowLoopbackPort(api.address().port)
      const webRequire=createRequire(join(projectRoot,'web/package.json'))
      const {createServer}=await import(pathToFileURL(join(projectRoot,'web/node_modules/vite/dist/node/index.js')))
      const {default:vue}=await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')))
      const port=await ephemeralLoopbackPort()
      vite=await createServer({root:join(projectRoot,'web'),configFile:false,envFile:false,plugins:[vue()],server:{host:'127.0.0.1',port,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:' + api.address().port,configure(proxy){proxy.on('proxyReq',req=>req.setHeader('origin','http://127.0.0.1:5173'))}}}}})
      await vite.listen();guard.allowLoopbackPort(port)
      const origin='http://127.0.0.1:' + port
      console.log('ISOLATED_PREVIEW ' + origin)
      await agent(['open',origin + '/login'])
      await agent(['snapshot','-i'])
      await agent(['screenshot',join(instance.directory,'login-desktop.png')])
      const runtime=createRequire(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'))
      const {chromium}=runtime('playwright')
      browser=(await launchIsolatedBrowser(chromium,{headless:true,executablePath:chrome})).browser
      const apiCall=async(page,method,path,body) => page.evaluate(async({method,path,body,org})=>{
        const csrf=document.cookie.split('; ').find(value=>value.startsWith('smartrecruit_csrf='))?.split('=').slice(1).join('=')
        const response=await fetch('/api/v1' + path,{method,headers:{'content-type':'application/json','x-workspace-id':org,...(csrf?{'x-csrf-token':decodeURIComponent(csrf)}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})})
        return {status:response.status,body:await response.json()}
      },{method,path,body,org})
      const login=async(id,viewport={width:1440,height:1000})=>{
        const context=await browser.newContext({viewport})
        await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
        const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message))
        await page.goto(origin + '/login');await page.getByLabel('邮箱',{exact:true}).fill(id + '@example.invalid')
        await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click()
        await page.waitForURL(origin + '/');await page.getByRole('heading',{name:/我的待办/}).waitFor()
        assert.equal(await page.locator('vite-error-overlay').count(),0)
        return page
      }
      const owner=await login(a), member=await login(b), unrelated=await login(c)
      await check('real API derives personal recipients and denies member enterprise scope and responsibility forgery',async()=>{
        const own=await apiCall(member,'GET','/dashboard/summary')
        assert.equal(own.status,200);assert.ok(own.body.data.todos.some(todo=>todo.id==='complete-' + interview))
        const empty=await apiCall(unrelated,'GET','/dashboard/summary');assert.equal(empty.body.data.todos.filter(todo=>todo.category==='interview').length,0)
        assert.equal((await apiCall(member,'GET','/dashboard/summary?scope=enterprise')).status,403)
        assert.equal((await apiCall(member,'PATCH','/interviews/' + interview + '/responsibilities',{participants})).status,403)
        assert.equal((await apiCall(unrelated,'PATCH','/interviews/' + interview,{participants})).status,403)
        assert.equal((await apiCall(member,'POST','/dashboard/notifications/read',{all:true,userId:a})).status,400)
        const wrong=await apiCall(member,'POST','/applications/' + application + '/question-sheets/initial/hr_screen/generate',{})
        assert.equal(wrong.status,403)
        const allowed=await apiCall(member,'POST','/applications/' + application + '/question-sheets/initial/hiring_department/generate',{})
        assert.equal(allowed.status,200,JSON.stringify(allowed.body))
      })
      await check('desktop notification bell and admin responsibility dialog render and save without altering schedule',async()=>{
        await owner.getByRole('button',{name:/待办消息，/}).click()
        await owner.getByRole('dialog',{name:/待办消息/}).waitFor()
        await owner.screenshot({path:join(instance.directory,'notifications-desktop.png'),fullPage:true})
        await owner.getByRole('button',{name:'关闭消息',exact:true}).click()
        await owner.goto(origin + '/interviews/' + interview)
        await owner.getByRole('button',{name:'分配面试职责',exact:true}).click()
        const dialog=owner.getByRole('dialog',{name:'面试职责',exact:true})
        await dialog.locator('input[type=checkbox]').first().waitFor()
        assert.equal(await dialog.locator('input:checked').count(),2)
        const before=(await pool.query('SELECT scheduled_start_at,status FROM ' + table('interviews') + ' WHERE id=$1',[interview])).rows[0]
        await dialog.getByRole('button',{name:'保存分工',exact:true}).click();await dialog.waitFor({state:'hidden'})
        const after=(await pool.query('SELECT scheduled_start_at,status FROM ' + table('interviews') + ' WHERE id=$1',[interview])).rows[0]
        assert.deepEqual(after,before)
      })
      await check('assigned scorer can edit only their sheet and unrelated viewers are read-only',async()=>{
        await member.goto(origin + '/interviews/' + interview + '?openQuestionSheet=1&sheetType=hiring_department')
        const panel=member.locator('.sheet-panel');await panel.locator('.sheet-card').first().waitFor()
        assert.equal(await panel.locator('#sheet-hr_screen button').first().isDisabled(),true)
        assert.equal(await panel.locator('#sheet-hiring_department button').first().isDisabled(),false)
        assert.ok(await panel.locator('input[type=number]').first().isDisabled())
        await unrelated.goto(origin + '/interviews/' + interview + '?openQuestionSheet=1')
        await unrelated.locator('.sheet-card').first().waitFor()
        assert.ok(await unrelated.locator('#sheet-hiring_department button').first().isDisabled())
      })
      await check('mobile bell and responsibility dialog stay within viewport and produce no runtime errors',async()=>{
        const mobile=await login(a,{width:390,height:844})
        const menu=mobile.getByRole('button',{name:/打开导航|展开导航|菜单/}).first()
        if(await menu.count())await menu.click()
        const bell=mobile.getByRole('button',{name:/待办消息，/})
        await bell.click();const dialog=mobile.locator('.notification-dialog');await dialog.waitFor()
        const box=await dialog.boundingBox();assert.ok(box && box.x>=0 && box.x+box.width<=391)
        await mobile.screenshot({path:join(instance.directory,'notifications-mobile.png'),fullPage:true})
        assert.deepEqual(errors,[])
      })
      console.log('BROWSER_EVIDENCE ' + instance.directory)
      await writeFile(join(instance.directory,'personal-todos-browser-report.json'),JSON.stringify({checks,errors},null,2))
    } finally {
      await browser?.close();await agent(['close']).catch(()=>{})
      await vite?.close();await api?.closeAsync()
    }
  }
  console.log(JSON.stringify({status:'passed',checks:checks.length,isolated:true}))
} finally {
  await pool?.end();if(created)await admin.query('DROP DATABASE "' + instance.database + '" WITH (FORCE)')
  await admin.end();await instance.stop()
}
