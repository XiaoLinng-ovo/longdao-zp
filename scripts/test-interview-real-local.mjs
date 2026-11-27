import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { readRuntimeConfig } from './runtime-config.mjs'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { launchIsolatedBrowser } from './isolated-browser-launch.mjs'
import { ephemeralLoopbackPort } from './isolated-browser-ingress.mjs'
import { requireInterviewTestMemory } from './interview-test-resources.mjs'

const execute = promisify(execFile)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const { Pool } = require('pg')
const { EnterpriseAiStore, PlatformAiStore, normalizeAiBaseUrl } = await import('../packages/enterprise-ai/index.js')
const load = name => import(pathToFileURL(join(projectRoot, 'apps/api/dist/src', name + '.js')))
const profile = readRuntimeConfig(projectRoot).env
const reuse = process.argv.find(value=>value.startsWith('--reuse='))?.slice(8)
const output = reuse ? resolve(reuse) : resolve(projectRoot, 'tmp', 'interview-real-' + new Date().toISOString().replace(/[:.]/g, '-'))
if(!reuse) await mkdir(output, { recursive: false })
const report = { output, startedAt: new Date().toISOString(), syntheticSpeech: true, realAsr: true, realLlm: true,
  businessDatabaseWrites: false, checks: [], modelCalls: [], monitor: [], failures: [], browserErrors: [], cleanup: {} }
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
async function check(name, action) {
  const row = { name, startedAt: new Date().toISOString() }; report.checks.push(row)
  console.log('CHECK', name)
  try { row.result = await action(); row.passed = true; return row.result }
  catch (error) { row.passed = false; row.error = error.message; report.failures.push({ name, error: error.message }); console.error('FAIL', name, error.message) }
  finally { row.durationMs = Date.now() - Date.parse(row.startedAt); await save() }
}
async function until(predicate, label, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (!await predicate()) { assert.ok(Date.now() < deadline, label); await delay(500) }
}
let actualEnv
await check('read-only enterprise model configuration resolution', async () => {
  const { loadDatabaseConfig } = await load('db/config')
  const { target, ...connection } = loadDatabaseConfig(profile)
  const db = new Pool({ ...connection, max: 1, options: '-c default_transaction_read_only=on' })
  let scoped
  try {
    const org = (await db.query(`SELECT DISTINCT o.id,o.name,s.schema_name FROM public.organizations o JOIN public.organization_schemas s ON s.organization_id=o.id
      JOIN public.organization_members m ON m.organization_id=o.id AND m.is_active
      JOIN public.platform_operators p ON p.user_id=m.user_id AND p.is_active AND p.role='admin'
      JOIN public.users u ON u.id=m.user_id AND u.is_active
      WHERE organization_service_available(o.id) AND s.status='ready' ORDER BY o.id`)).rows[0]
    assert.ok(org, 'An available system-administrator enterprise must exist')
    assert.match(org.schema_name, /^company_[a-f0-9]{32}$/)
    scoped = new Pool({ ...connection, max: 1, options: '-c default_transaction_read_only=on -c search_path=' + org.schema_name + ',public' })
    const resolved = await new EnterpriseAiStore(scoped, profile.AI_CONFIG_ENCRYPTION_KEY).runtimeEnv(org.id)
    actualEnv = Object.fromEntries(['OPENAI_BASE_URL','OPENAI_API_KEY','OPENAI_MODEL','OPENAI_TIMEOUT_MS'].map(key => [key, resolved[key]]))
    report.modelConfigurationSource = 'read-only administrator enterprise configuration; isolated acceptance data'
    return { enterprise: org.name, model: actualEnv.OPENAI_MODEL, origin: new URL(actualEnv.OPENAI_BASE_URL).origin, keyResolved: !!actualEnv.OPENAI_API_KEY }
  } finally { await scoped?.end(); await db.end() }
})
if (!actualEnv) {
  report.failures.push({ name: 'actual-enterprise-config', error: 'Enterprise settings unavailable; environment fallback is not a real enterprise test' })
  actualEnv = Object.fromEntries(['OPENAI_BASE_URL','OPENAI_API_KEY','OPENAI_MODEL','OPENAI_TIMEOUT_MS'].map(key=>[key,profile[key] ?? (key==='OPENAI_TIMEOUT_MS'?'120000':'')]))
  report.modelConfigurationSource = 'workspace env only; enterprise resolution failed and remains a failed check'
}
if (actualEnv.OPENAI_API_KEY && actualEnv.OPENAI_MODEL && actualEnv.OPENAI_BASE_URL) {
  const measuredFetch = async (url, init) => {
    const started = Date.now(), body = JSON.parse(String(init?.body ?? '{}'))
    const row = { model: body.model, startedAt: new Date().toISOString(), inputChars: String(init?.body ?? '').length }
    report.modelCalls.push(row)
    try {
      const response = await fetch(url, init)
      row.status = response.status; row.durationMs = Date.now() - started
      console.log('MODEL', row.status, row.durationMs + 'ms', row.model)
      return response
    } catch (error) { row.error = error.name; row.durationMs = Date.now() - started; throw error }
    finally { await save() }
  }
  actualEnv.OPENAI_BASE_URL = normalizeAiBaseUrl(actualEnv.OPENAI_BASE_URL)
  await check('real configured language model request', async () => {
    const response = await measuredFetch(actualEnv.OPENAI_BASE_URL + '/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + actualEnv.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: actualEnv.OPENAI_MODEL, messages: [{ role: 'user', content: '只回复：面试链路测试成功' }], max_completion_tokens: 128 }),
      signal: AbortSignal.timeout(60000),
    })
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.ok(data.choices?.[0]?.message?.content)
    return { content: data.choices[0].message.content, model: data.model }
  })
  const generated = reuse ? { lines:JSON.parse(await readFile(join(output,'timeline.json'),'utf8')),durationMs:JSON.parse(await readFile(join(output,'timeline.json'),'utf8')).at(-1).endMs+2500 } : await check('generate controlled two-voice Mandarin audio', async () => {
    const quote = value => "'" + value.replaceAll("'", "''") + "'"
    const command = '& ([scriptblock]::Create([IO.File]::ReadAllText(' + quote(join(projectRoot,'scripts/interview-real-fixture.ps1')) + ',[Text.Encoding]::UTF8))) -OutputDirectory ' + quote(output)
    const powershell = 'C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1123-915-0_26.1123.915.0_x64__3k8sg7r9htsxt/dependencies/native/powershell/pwsh.exe'
    await execute(powershell, ['-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')], { windowsHide: true, timeout: 60000 })
    const lines = JSON.parse((await readFile(join(output, 'script.json'), 'utf8')).replace(/^\uFEFF/, ''))
    let cursor = 2000
    for (const [index, line] of lines.entries()) {
      const file = join(output, 'pcm-' + index + '.wav')
      await execute('ffmpeg', ['-y','-i',line.file,'-ac','1','-ar','16000',file], { windowsHide: true })
      const audio = await readFile(file)
      const info = JSON.parse((await execute('ffprobe',['-v','quiet','-show_format','-of','json',file],{windowsHide:true})).stdout)
      line.pcmFile = file; line.durationMs = Math.round(Number(info.format.duration) * 1000); line.startMs = cursor; line.endMs = cursor + line.durationMs
      cursor = line.endMs + 2500
    }
    const args = lines.flatMap(line => ['-i', line.pcmFile])
    for (const source of ['microphone','meeting','all']) {
      const selected = lines.map((line,index) => ({...line,index})).filter(line => source === 'all' || (source === 'microphone' ? line.role === 'interviewer' : line.role === 'candidate'))
      const filters = selected.map(line => '[' + line.index + ':a]adelay=' + line.startMs + ':all=1[d' + line.index + ']')
      filters.push(selected.map(line => '[d' + line.index + ']').join('') + 'amix=inputs=' + selected.length + ':normalize=0,apad=whole_dur=' + cursor/1000 + '[out]')
      await execute('ffmpeg',['-y',...args,'-filter_complex',filters.join(';'),'-map','[out]','-ac','1','-ar','16000',join(output,source+'.wav')],{windowsHide:true})
    }
    await writeFile(join(output,'timeline.json'),JSON.stringify(lines,null,2))
    return { lines, durationMs: cursor }
  })
  if (generated) {
    const { createFunAsrClient, loadFunAsrConfig } = await load('interviews/funasr-client')
    const recognizer = createFunAsrClient(loadFunAsrConfig(profile))
    const offline = reuse ? JSON.parse(await readFile(join(output,'real-asr.json'),'utf8')) : await check('real FunASR full-dialogue recognition and text accuracy', async () => {
      report.offlineMemoryPreflight = await requireInterviewTestMemory()
      const turns = await recognizer.transcribe(await readFile(join(output,'all.wav')),'audio/wav')
      const expected = generated.lines.map(line=>line.text).join(''), actual = turns.map(row=>row.text).join('')
      const clean = text => [...text.replace(/[\p{P}\p{Z}\s]/gu,'').toLowerCase()]
      const a=clean(expected),b=clean(actual), costs=Array.from({length:b.length+1},(_,i)=>i)
      for(let i=1;i<=a.length;i++){let diagonal=costs[0];costs[0]=i;for(let j=1;j<=b.length;j++){const before=costs[j];costs[j]=Math.min(costs[j]+1,costs[j-1]+1,diagonal+(a[i-1]===b[j-1]?0:1));diagonal=before}}
      const evidence={ expected, actual, characterErrorRate: costs[b.length]/a.length, turns }
      await writeFile(join(output,'real-asr.json'),JSON.stringify(evidence,null,2))
      assert.ok(turns.length)
      return evidence
    })
    if(offline && !reuse) {
      await check('real contextual role review without manual labels', async () => {
        const { SemanticRoleReviewer } = await load('interviews/semantic-role-review')
        const reviewer = new SemanticRoleReviewer(measuredFetch)
        const result = await reviewer.review(offline.turns.map(row=>({...row,role:'unknown',confidence:.35})),actualEnv)
        await writeFile(join(output,'real-role-review.json'),JSON.stringify(result,null,2))
        assert.equal(result.warnings.length,0)
        return result
      })
    }
    if(process.argv.includes('--browser')) await runBrowser(generated)
  }
  report.finishedAt = new Date().toISOString(); await save(); console.log('REPORT',output)
  if(report.failures.length) process.exitCode = 1
}

async function runBrowser(generated) {
  const ready=await check('real recognition service readiness before browser capture',async()=>{
    report.browserMemoryPreflight = await requireInterviewTestMemory()
    const url=new URL(profile.FUNASR_BASE_URL);url.pathname='/ready';url.search=''
    const response=await fetch(url,{signal:AbortSignal.timeout(10000)})
    assert.equal(response.status,200,'Recognition service must be ready before starting capture')
    const health=await response.json()
    assert.equal(health.service,'funasr')
    assert.equal(health.ready,true,'Both offline and streaming models must be loaded')
    return health
  })
  if(!ready)return
  const instance = await startIsolatedPostgres('D:/software/pgsql/bin')
  report.isolatedDirectory=instance.directory
  const prior = process.env
  process.env = { ...instance.env, ...actualEnv, FUNASR_BASE_URL: profile.FUNASR_BASE_URL, FUNASR_TOKEN: profile.FUNASR_TOKEN ?? '',
    FASTER_WHISPER_BASE_URL: profile.FASTER_WHISPER_BASE_URL ?? '', FUNASR_TIMEOUT_MS: '120000',
    AUTH_OTP_HMAC_SECRET: randomBytes(40).toString('hex'), AUTH_MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AI_CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('base64'), INTERVIEW_AUDIO_POLL:'on',
    INTERVIEW_TRANSCRIPT_POSTPROCESS_POLL:'on',INTERVIEW_SUMMARY_POLL:'on',SMARTRECRUIT_MANAGED_ENV:'1',DB_POOL_MAX:'8',PGCONNECT_TIMEOUT_MS:'30000' }
  const admin = new Pool(instance.connection)
  let pool, tenant, api, vite, browser, monitor, faultProxy
  const org=randomUUID(),actor=randomUUID(),job=randomUUID(),candidate=randomUUID(),application=randomUUID(),interview=randomUUID()
  try {
    await admin.query('CREATE DATABASE "'+instance.database+'"')
    pool=new Pool({...instance.connection,database:instance.database})
    await (await load('db/migrations')).runMigrations(pool,join(projectRoot,'db/migrations'))
    await mkdir(process.env.INTERVIEW_STORAGE_ROOT,{recursive:true});await mkdir(process.env.RECRUITING_QUARANTINE_ROOT,{recursive:true})
    await pool.query("INSERT INTO public.organizations(id,name,kind,service_status,use_platform_ai,ai_model_source) VALUES($1,'real-interview-acceptance','test','enabled',true,'platform')",[org])
    await pool.query("INSERT INTO public.users(id,email,display_name) VALUES($1,'real-interview@example.invalid','本地验收员')",[actor])
    await pool.query("INSERT INTO public.organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",[org,actor])
    const schema=(await pool.query('SELECT public.initialize_organization_schema($1) AS name',[org])).rows[0].name
    tenant=new Pool({...instance.connection,database:instance.database,options:'-c search_path='+schema+',public'})
    await tenant.query("INSERT INTO jobs(id,job_no,title,headcount,organization_id) VALUES($1,'JOB-REAL','智能客服后端开发',1,$2)",[job,org])
    await tenant.query("INSERT INTO candidates(id,candidate_no,name,organization_id) VALUES($1,'CAN-REAL','语音验收候选人',$2)",[candidate,org])
    await tenant.query("INSERT INTO applications(id,application_no,candidate_id,job_id,status,organization_id) VALUES($1,'APP-REAL',$2,$3,'interviewing',$4)",[application,candidate,job,org])
    await tenant.query("INSERT INTO interviews(id,interview_no,application_id,round,type,title,status,organization_id,meeting_url,participants) VALUES($1,'INT-REAL',$2,1,'technical','真实语音链路验收','scheduled',$3,'https://meeting.example.invalid',$4::jsonb)",[interview,application,org,JSON.stringify([{userId:actor,name:'本地验收员',role:'interviewer',required:true,lead:true}])])
    await new PlatformAiStore(pool).save({...actualEnv,OPENAI_TIMEOUT_MS:String(Math.min(300000,Number(actualEnv.OPENAI_TIMEOUT_MS)||120000))},actor,'isolated-real-interview')
    const {PostgresSessionRepository}=await load('auth/session-repository')
    const session=await new PostgresSessionRepository(pool).createSession({id:actor,name:'本地验收员',email:'real-interview@example.invalid',role:'recruiter',workspaceId:org})
    report.asrRequests=[]
    faultProxy=createHttpServer(async(req,res)=>{
      const row={at:new Date().toISOString(),injected:false};report.asrRequests.push(row)
      try {
        const chunks=[];for await(const chunk of req)chunks.push(chunk)
        if(req.method==='POST'&&!report.asrRequests.some(item=>item.injected)) {
          row.injected=true;row.status=503;res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'deliberate acceptance-test outage'}));return
        }
        const response=await fetch(profile.FUNASR_BASE_URL,{method:req.method,headers:{'Content-Type':String(req.headers['content-type']??'audio/webm'),...(profile.FUNASR_TOKEN?{Authorization:'Bearer '+profile.FUNASR_TOKEN}:{})},...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})})
        row.status=response.status;res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json'});res.end(Buffer.from(await response.arrayBuffer()))
      } catch(error){row.error=error.message;res.writeHead(502);res.end('Forwarding failed')}
    })
    await new Promise(resolve=>faultProxy.listen(0,'127.0.0.1',resolve))
    process.env.FUNASR_BASE_URL='http://127.0.0.1:'+faultProxy.address().port+'/transcribe'
    process.env.FUNASR_STREAM_URL=profile.FUNASR_BASE_URL
    const {startServer}=await load('server'),{loadConfig}=await load('config')
    const port=await ephemeralLoopbackPort()
    const origin='http://127.0.0.1:'+port
    process.env.ALLOWED_ORIGINS=origin
    api=await startServer(loadConfig({...process.env,HOST:'127.0.0.1',PORT:'0'}))
    const webRequire=createRequire(join(projectRoot,'web/package.json'))
    const {createServer}=await import(pathToFileURL(webRequire.resolve('vite')))
    const {default:vue}=await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')))
    const target='http://127.0.0.1:'+api.address().port
    const fixturePlugin={name:'real-remote-audio-fixture',configureServer(server){
      server.middlewares.use('/__remote-test',(req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>Interview Remote Acceptance</title><audio controls src="/__remote-audio"></audio><button onclick="document.querySelector(\'audio\').play()">Start remote audio</button>')})
      server.middlewares.use('/__remote-audio',async(req,res)=>{res.setHeader('Content-Type','audio/wav');res.end(await readFile(join(output,'meeting.wav')))})
      server.middlewares.use('/__microphone-audio',async(req,res)=>{res.setHeader('Content-Type','audio/wav');res.end(await readFile(join(output,'microphone.wav')))})
    }}
    vite=await createServer({root:join(projectRoot,'web'),configFile:false,envFile:false,plugins:[fixturePlugin,vue()],server:{host:'127.0.0.1',port,strictPort:true,proxy:{'/api':{target},'/funasr-stream':{target,ws:true}}}})
    await vite.listen()
    report.browserOrigin=origin
    const runtime=createRequire('C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1123-915-0_26.1123.915.0_x64__3k8sg7r9htsxt/dependencies/node/node_modules/playwright/package.json')
    const {chromium}=runtime('playwright')
    browser=(await launchIsolatedBrowser(chromium,{channel:'chrome',executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:false,ignoreDefaultArgs:['--mute-audio'],args:['--auto-select-tab-capture-source-by-title=Interview Remote Acceptance','--allow-http-screen-capture','--autoplay-policy=no-user-gesture-required']})).browser
    report.captureBoundary={microphone:'Controlled WAV via WebAudio, not physical hardware',meeting:'Native getDisplayMedia of real audio-playing browser tab',recognition:'Real FunASR and configured language provider, no model mocks'}
    const context=await browser.newContext({permissions:['microphone'],viewport:{width:1440,height:1000}})
    await context.addCookies([{name:'smartrecruit_session',value:session.token,url:origin,httpOnly:true,sameSite:'Lax'}])
    const remote=await context.newPage();await remote.goto(origin+'/__remote-test')
    const page=await context.newPage()
    await page.addInitScript(()=>{
      const Native=window.WebSocket
      window.__acceptanceSockets=[]
      window.WebSocket=class extends Native {constructor(...args){super(...args);window.__acceptanceSockets.push(this)}}
      const display=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getDisplayMedia=async constraints=>{
        const stream=await display(constraints)
        window.__nativeDisplaySettings=stream.getTracks().map(track=>({kind:track.kind,label:track.label,settings:track.getSettings()}))
        return stream
      }
      navigator.mediaDevices.getUserMedia=async()=>{
        const context=new AudioContext()
        const decoded=await context.decodeAudioData(await (await fetch('/__microphone-audio')).arrayBuffer())
        const buffer=context.createBuffer(decoded.numberOfChannels,Math.max(decoded.length,decoded.sampleRate*120),decoded.sampleRate)
        for(let channel=0;channel<decoded.numberOfChannels;channel++)buffer.copyToChannel(decoded.getChannelData(channel),channel)
        const source=context.createBufferSource(),destination=context.createMediaStreamDestination()
        source.buffer=buffer;source.connect(destination);await context.resume();source.start()
        window.__acceptanceMicrophone={context,source}
        return destination.stream
      }
    })
    page.on('pageerror',error=>report.browserErrors.push(error.message))
    report.httpFailures=[]
    page.on('response',response=>{if(response.status()>=400&&response.url().includes('/api/'))void response.text().then(body=>{report.httpFailures.push({path:new URL(response.url()).pathname,status:response.status(),body:body.slice(0,1500)})}).catch(()=>{})})
    const streams=[];report.streams=streams
    page.on('websocket',socket=>{
      const evidence={source:new URL(socket.url()).searchParams.get('source'),urlPath:new URL(socket.url()).pathname,createdAt:new Date().toISOString(),frames:0,bytes:0,nonSilentFrames:0,messages:[]};streams.push(evidence)
      socket.on('framesent',({payload})=>{if(Buffer.isBuffer(payload)){evidence.frames++;evidence.bytes+=payload.length;let peak=0;for(let i=0;i+1<payload.length;i+=2)peak=Math.max(peak,Math.abs(payload.readInt16LE(i)));if(peak>200)evidence.nonSilentFrames++}})
      socket.on('framereceived',({payload})=>{if(typeof payload==='string'){try{evidence.messages.push(JSON.parse(payload))}catch{}}})
      socket.on('close',()=>evidence.closedAt=new Date().toISOString())
    })
    monitor=setInterval(()=>{void tenant.query("SELECT (SELECT count(*)::int FROM interview_live_segments) AS segments,(SELECT count(*)::int FROM interview_audio_transcription_jobs WHERE status='pending') AS pending,(SELECT count(*)::int FROM interview_audio_transcription_jobs WHERE status='failed') AS failed,(SELECT row_to_json(s) FROM (SELECT status,summary_status,summary_error FROM interview_live_sessions LIMIT 1) s) AS completion,(SELECT row_to_json(j) FROM (SELECT status,phase,error,attempts FROM interview_transcript_postprocess_jobs LIMIT 1) j) AS postprocess").then(result=>{report.monitor.push({at:new Date().toISOString(),...result.rows[0]});return save()}).catch(error=>console.warn('MONITOR',error.code))},2000)
    await check('real browser dual-source capture, streaming reconnect and audio persistence',async()=>{
      await page.goto(origin+'/interviews/'+interview+'/live')
      const dialog=page.getByRole('dialog',{name:'开始面试录音',exact:true});await dialog.waitFor()
      report.defaultAudioMode=await dialog.getByLabel('确认录音采集方式',{exact:true}).inputValue()
      await dialog.getByLabel('确认录音采集方式',{exact:true}).selectOption('meeting')
      await dialog.getByRole('checkbox',{name:'我已告知参与者并取得录音、转写及 AI 辅助分析同意',exact:true}).check()
      await dialog.getByRole('button',{name:'确认授权并开始录音',exact:true}).click()
      try{await page.getByRole('button',{name:'暂停',exact:true}).waitFor({timeout:30000})}
      catch(error){await page.screenshot({path:join(output,'browser-start-failure.png'),fullPage:true});report.startFailureBody=await page.locator('body').innerText();throw error}
      await remote.getByRole('button',{name:'Start remote audio',exact:true}).click()
      await remote.bringToFront()
      report.nativeDisplaySettings=await page.evaluate(()=>window.__nativeDisplaySettings)
      await until(()=>streams.some(row=>row.source==='meeting'&&row.bytes>32000),'meeting PCM must reach actual WebSocket')
      await delay(26000)
      const leases=await pool.query('SELECT connection_id,source FROM public.billing_stream_sources WHERE organization_id=$1',[org])
      const disconnectedAt=new Date().toISOString()
      const closed=await page.evaluate(()=>window.__acceptanceSockets.filter(socket=>socket.url.includes('/funasr-stream')&&socket.readyState===1).map(socket=>{socket.close(4001,'acceptance fault injection');return new URL(socket.url).searchParams.get('source')}))
      await context.setOffline(true)
      report.disconnect={at:disconnectedAt,sources:closed}
      assert.equal(closed.length,2,'Both real transcription sockets must be closed by fault injection')
      await delay(8000)
      report.offlineCache=await page.evaluate(()=>new Promise((resolve,reject)=>{
        const request=indexedDB.open('smartrecruit-pending-interview-audio',2)
        request.onerror=()=>reject(new Error('Cannot read offline audio cache'))
        request.onsuccess=()=>{const db=request.result,tx=db.transaction('chunks','readonly'),rows=tx.objectStore('chunks').getAll();rows.onsuccess=()=>{resolve(rows.result.map(row=>({source:row.audioSource?.id,offsetMs:row.offsetMs,endMs:row.endMs,bytes:row.audio.size})));db.close()}}
      }))
      await context.setOffline(false)
      await page.evaluate(()=>window.dispatchEvent(new Event('online')))
      assert.ok(report.offlineCache.length>=2,'Both recording sources must persist unuploaded chunks during the network outage')
      await until(()=>['microphone','meeting'].every(source=>streams.some(row=>row.source===source&&row.createdAt>disconnectedAt&&row.bytes>32000&&row.messages.some(message=>message.status==='ready'))),'both real streams must reconnect and forward PCM',90000)
      const remaining=generated.durationMs+5000-(Date.now()-Date.parse(streams.find(row=>row.source==='microphone').createdAt))
      await delay(Math.max(0,remaining))
      await page.getByRole('button',{name:'暂停',exact:true}).click()
      await until(async()=>{const rows=(await tenant.query('SELECT status,count(*)::int AS n FROM interview_audio_transcription_jobs GROUP BY status')).rows;assert.ok(!rows.some(row=>row.status==='failed'),'A real audio transcription job failed');return rows.length&&rows.every(row=>row.status==='completed')},'real audio background jobs must finish',240000)
      const segments=(await tenant.query('SELECT id,speaker_id,role,role_confidence,text,start_ms,end_ms,audio_source,role_review,speaker_confirmed FROM interview_live_segments ORDER BY start_ms,end_ms')).rows
      report.audioRecordings=(await tenant.query('SELECT * FROM interview_audio_recordings')).rows
      report.billingStates=(await pool.query('SELECT operation,state,count(*)::int AS count FROM public.billing_tasks WHERE organization_id=$1 GROUP BY operation,state',[org])).rows
      await writeFile(join(output,'browser-segments.json'),JSON.stringify(segments,null,2))
      await page.screenshot({path:join(output,'browser-live.png'),fullPage:true})
      assert.ok(streams.some(row=>row.source==='meeting'&&row.nonSilentFrames>10),'Remote track must contain actual audio rather than silence')
      assert.ok(streams.some(row=>row.source==='microphone'&&row.nonSilentFrames>10),'Microphone track must contain actual audio rather than silence')
      assert.ok(segments.filter(row=>row.audio_source==='meeting').map(row=>row.text).join('').includes('工单'),'Actual remote speech must be recognized')
      return {segments,streams:streams.length,leasesBeforeDisconnect:leases.rows,body:(await page.locator('body').innerText()).slice(-12000)}
    })
    if(report.audioRecordings?.length) {
      await check('original audio, continuous source timelines and recoverable full playback',async()=>{
        const sessionId=report.audioRecordings[0].session_id,result=[]
        const headers={'x-workspace-id':org}
        const rejected=await context.request.get(origin+'/api/v1/interviews/'+interview+'/recordings/'+report.audioRecordings[0].id)
        report.missingWorkspaceDownload={status:rejected.status(),body:await rejected.json()}
        assert.equal(rejected.status(),409)
        assert.equal(report.missingWorkspaceDownload.body.error.code,'WORKSPACE_CONTEXT_REQUIRED')
        for(const source of ['microphone','meeting']) {
          const rows=report.audioRecordings.filter(row=>row.audio_source===source).sort((a,b)=>Number(a.offset_ms)-Number(b.offset_ms))
          assert.ok(rows.length)
          const gaps=rows.slice(1).map((row,i)=>Number(row.offset_ms)-Number(rows[i].end_ms))
          assert.ok(gaps.every(gap=>gap<=100),'Recorder timeline must stay continuous across stream disconnection')
          for(const row of rows){const response=await context.request.get(origin+'/api/v1/interviews/'+interview+'/recordings/'+row.id,{headers});assert.equal(response.status(),200);const original=await response.body();assert.equal(original.length,Number(row.byte_length));await writeFile(join(output,source+'-'+row.offset_ms+'.webm'),original)}
          const response=await context.request.get(origin+'/api/v1/interviews/'+interview+'/recordings/full?sessionId='+sessionId+'&source='+source,{headers,timeout:120000})
          assert.equal(response.status(),200)
          const file=join(output,'recorded-'+source+'.m4a');await writeFile(file,await response.body())
          const info=JSON.parse((await execute('ffprobe',['-v','quiet','-show_format','-of','json',file],{windowsHide:true})).stdout)
          const durationMs=Number(info.format.duration)*1000
          assert.ok(Math.abs(durationMs-Number(rows.at(-1).end_ms))<1000,'Full recording must preserve capture duration, not speech-only duration')
          result.push({source,chunks:rows.length,durationMs,maxGapMs:Math.max(0,...gaps),bytes:rows.reduce((n,row)=>n+Number(row.byte_length),0)})
        }
        report.recordingEvidence=result;return result
      })
      await check('end interview and generate final report without manual speaker assignment',async()=>{
        await page.getByRole('button',{name:'结束面试',exact:true}).click()
        await page.waitForURL('**/interviews/'+interview+'?backgroundSave=1')
        await until(async()=>{const row=(await tenant.query('SELECT status,summary_status,summary_error FROM interview_live_sessions LIMIT 1')).rows[0];report.completionStatus=row;assert.notEqual(row?.summary_status,'failed',row?.summary_error);return row?.status==='completed'&&row.summary_status==='ready'},'Automatic completion, transcript processing and summary must finish',360000)
        const result=(await tenant.query('SELECT status,summary_status,summary_report,summary_error FROM interview_live_sessions LIMIT 1')).rows[0]
        assert.equal(result.summary_report?.version,'whole-dialogue-v2')
        assert.ok(result.summary_report?.model,'A real model report, not an empty fallback, must be generated')
        assert.ok(result.summary_report?.pairs?.length>=2,'Both actual question-answer pairs must survive processing')
        await writeFile(join(output,'browser-final-summary.json'),JSON.stringify(result,null,2))
        const corrected=(await tenant.query('SELECT v.turns,v.corrections,v.uncertainties,v.metadata FROM interview_transcript_versions v JOIN interview_live_sessions s ON s.corrected_transcript_version_id=v.id LIMIT 1')).rows[0]
        await writeFile(join(output,'browser-corrected-transcript.json'),JSON.stringify(corrected,null,2))
        report.finalSegments=(await tenant.query('SELECT role,text,start_ms,end_ms,audio_source,role_review,speaker_confirmed FROM interview_live_segments ORDER BY start_ms,end_ms')).rows
        await writeFile(join(output,'browser-final-segments.json'),JSON.stringify(report.finalSegments,null,2))
        await page.reload()
        const panel=page.getByRole('region',{name:'面试总结表',exact:true})
        await panel.getByRole('heading',{name:'AI 总体评价',exact:true}).waitFor()
        await until(async()=> (await panel.innerText()).includes(result.summary_report.summary),'The generated summary must render in the actual browser')
        report.renderedSummaryText=await panel.innerText()
        await page.screenshot({path:join(output,'browser-summary-desktop.png'),fullPage:true})
        await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'browser-summary-mobile.png'),fullPage:true})
        return result
      })
      await check('actual audio dialog playback and downloads preserve workspace authentication',async()=>{
        await page.setViewportSize({width:1440,height:1000})
        await page.goto(origin+'/interviews/'+interview+'/live')
        await page.getByRole('button',{name:'查看原音频',exact:true}).click()
        const dialog=page.getByRole('dialog',{name:'面试整场录音',exact:true})
        await dialog.waitFor()
        const result=[]
        for(const source of ['all','microphone','meeting']) {
          if(source!=='all')await dialog.getByLabel('回听音源',{exact:true}).selectOption(source)
          await until(async()=>dialog.locator('audio').evaluateAll(players=>players.some(player=>player.readyState>=1&&player.duration>50)),'Actual browser audio metadata must load',120000)
          const audio=dialog.locator('audio')
          const evidence=await audio.evaluate(async player=>{await player.play();return{duration:player.duration,source:player.src,paused:player.paused}})
          assert.equal(evidence.paused,false)
          await audio.evaluate(player=>player.pause())
          const downloading=page.waitForEvent('download')
          await dialog.getByRole('button',{name:source==='all'?'下载整场音频':'下载当前音源整场音频',exact:true}).click()
          const download=await downloading
          const file=join(output,'browser-download-'+source+'.m4a')
          await download.saveAs(file)
          assert.equal(await download.failure(),null)
          const bytes=(await readFile(file)).length
          assert.ok(bytes>1000)
          result.push({source,duration:evidence.duration,bytes,filename:download.suggestedFilename()})
        }
        await page.screenshot({path:join(output,'browser-audio-dialog.png'),fullPage:true})
        await dialog.getByRole('button',{name:'关闭原音频',exact:true}).click()
        return result
      })
    }
    await check('configuration diagnostics permissions, saved generation and responsive admin UI',async()=>{
      const userNo=(await pool.query('SELECT user_no FROM public.users WHERE id=$1',[actor])).rows[0].user_no
      const ordinary=await context.request.get(origin+'/api/v1/admin/ai-diagnostics',{headers:{'x-workspace-id':org}})
      assert.equal(ordinary.status(),403)
      // A platform-operator role alone must not bypass the immutable system-account binding.
      await pool.query("INSERT INTO public.platform_operators(user_id,role) VALUES($1,'admin')",[actor])
      const denied=await context.request.get(origin+'/api/v1/admin/ai-diagnostics',{headers:{'x-workspace-id':org}})
      assert.equal(denied.status(),403)
      process.env.SYSTEM_ADMIN_USER_NO=userNo
      await page.goto(origin+'/administration?module=ai')
      const diagnostic=page.getByRole('region',{name:'模型生效诊断'})
      await until(async()=>await diagnostic.count()>0 && (await diagnostic.innerText()).includes('配置解析与密钥读取'),'Diagnostics must render persisted effective settings')
      await diagnostic.getByRole('button',{name:'验证已保存模型生成',exact:true}).click()
      await until(async()=> (await diagnostic.innerText()).includes('通过 ·'),'Persisted enterprise model must generate successfully',150000)
      await page.screenshot({path:join(output,'browser-ai-diagnostics-desktop.png'),fullPage:true})
      await page.setViewportSize({width:390,height:844})
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Admin page must fit mobile width')
      await page.screenshot({path:join(output,'browser-ai-diagnostics-mobile.png'),fullPage:true})
      await page.setViewportSize({width:1440,height:1000})
      return {ordinaryMemberDenied:true,platformRoleAloneDenied:true,systemAccountAllowed:true,realGeneration:true,mobileOverflow:false}
    })
    await check('browser has no uncaught JavaScript errors or unexpected business HTTP failures',async()=>{assert.deepEqual(report.browserErrors,[]);assert.deepEqual(report.httpFailures,[],'Business request failures must not be hidden by a successful final summary');return true})
  } catch(error){report.failures.push({name:'isolated browser setup',error:error.message});console.error('BROWSER SETUP',error.message)}
  finally {
    clearInterval(monitor)
    for(const [name,close] of [['browser',()=>browser?.close()],['vite',()=>vite?.close()],['api',()=>api?.closeAsync()],['faultProxy',()=>faultProxy?new Promise(resolve=>faultProxy.close(resolve)):undefined],['tenant',()=>tenant?.end()],['pool',()=>pool?.end()],['admin',()=>admin.end()],['postgres',()=>instance.stop()]]){
      try{await close();report.cleanup[name]=true}catch(error){report.cleanup[name]=error.message}
    }
    process.env=prior;await save()
    await writeFile(join(output,'browser-report-'+report.startedAt.replace(/[:.]/g,'-')+'.json'),JSON.stringify(report,null,2))
  }
}
