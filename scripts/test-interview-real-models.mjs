import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { readRuntimeConfig } from './runtime-config.mjs'
import { PlatformAiMaintenance, normalizeAiBaseUrl } from '../packages/enterprise-ai/index.js'
import { requireInterviewTestMemory } from './interview-test-resources.mjs'

const root=resolve(import.meta.dirname,'..'),directory=resolve(process.argv[2])
assert.ok(directory.startsWith(join(root,'tmp')+ '\\')||directory.startsWith(join(root,'tmp')+'/'))
const env=readRuntimeConfig(root).env
const load=file=>import(pathToFileURL(join(root,'apps/api/dist/src/interviews',file+'.js')))
const {loadDatabaseConfig}=await import(pathToFileURL(join(root,'apps/api/dist/src/db/config.js')))
const {target,...connection}=loadDatabaseConfig(env)
const {Pool}=createRequire(join(root,'apps/api/package.json'))('pg')
const db=new Pool({...connection,max:1,options:'-c default_transaction_read_only=on'})
let effective
try {
  Object.assign(process.env,{SYSTEM_ADMIN_USER_NO:env.SYSTEM_ADMIN_USER_NO,AI_ALLOWED_BASE_URL_ORIGINS:env.AI_ALLOWED_BASE_URL_ORIGINS,NODE_ENV:env.NODE_ENV})
  const org=(await db.query(`SELECT m.organization_id FROM public.organization_members m JOIN public.users u ON u.id=m.user_id
    JOIN public.platform_operators p ON p.user_id=u.id AND p.is_active AND p.role='admin'
    WHERE m.is_active AND u.is_active AND u.user_no=$1 AND organization_service_available(m.organization_id) ORDER BY m.organization_id LIMIT 1`,[env.SYSTEM_ADMIN_USER_NO])).rows[0]
  assert.ok(org,'An available system-administrator enterprise is required')
  effective=await new PlatformAiMaintenance(db,env.AI_CONFIG_ENCRYPTION_KEY).effectiveEnv(org.organization_id)
} finally {await db.end()}
const config={baseUrl:normalizeAiBaseUrl(effective.OPENAI_BASE_URL),apiKey:effective.OPENAI_API_KEY,model:effective.OPENAI_MODEL,timeoutMs:Number(effective.OPENAI_TIMEOUT_MS)}
const modelEnv={...env,...effective}
const report={configurationSource:'read-only persisted administrator enterprise model configuration',realProviderCalls:true,calls:[],checks:[]}
const measured=async(url,init)=>{
  const started=Date.now(),body=JSON.parse(String(init.body)),row={model:body.model,inputChars:String(init.body).length};report.calls.push(row)
  try{const response=await fetch(url,init);row.status=response.status;return response}
  catch(error){row.error=error.name;throw error}
  finally{row.durationMs=Date.now()-started;console.log('MODEL',JSON.stringify(row));await save()}
}
const save=()=>writeFile(join(directory,'real-models-report.json'),JSON.stringify(report,null,2))
async function check(name,action){console.log('CHECK',name);const row={name};report.checks.push(row);try{row.result=await action();row.passed=true}catch(error){row.passed=false;row.code=error.code;row.error=error.message;console.error('FAIL',name,error.message)}finally{await save()}}
const reviewed=JSON.parse(await readFile(join(directory,'real-role-review.json'),'utf8'))
const segments=reviewed.turns.map(row=>({...row,sessionId:'synthetic-real-asr',status:'transcribed'}))
const job={jobTitle:'智能客服后端开发',requirements:['能够开发知识检索、工单接口并处理超时和异常'],skills:['知识检索','接口开发','日志监控']}
await check('actual answer analysis and transcript refinement',async()=>{
  const {createInterviewAnswerAnalyzer}=await load('answer-analyzer')
  const candidateAnswer=segments.filter(row=>row.role==='candidate').map(row=>row.text).join('\n')
  const result=await createInterviewAnswerAnalyzer(config,measured).analyze({...job,jobRequirements:job.requirements,question:'',candidateAnswer,priorContext:[],refineTranscript:true})
  assert.ok(result.summary);return result
})
await check('actual full transcript contextual correction',async()=>{
  const {TranscriptContextCorrector}=await load('transcript-context-corrector')
  const result=await new TranscriptContextCorrector(measured).correct({context:{...job,candidateName:'语音验收候选人'},turns:segments.map(row=>({...row,roleReasons:[],evidenceIds:[row.id]}))},modelEnv)
  assert.equal(result.warnings.length,0);assert.equal(result.turns.length,segments.length);return result
})
await check('actual question sheet model and response validation',async()=>{
  const {createQuestionSheetGenerator}=await load('question-sheet-generator')
  const result=await createQuestionSheetGenerator(config,measured).generate({...job,stage:'initial',sheetType:'hiring_department',interviewTitle:'语音链路验收',pairs:[{question:'你在客服智能助手项目里负责什么？',answerText:segments.filter(row=>row.role==='candidate').map(row=>row.text).join('')}]})
  assert.ok(result.length);return result
})
await check('actual complete interview summary, classification and evidence validation',async()=>{
  const {createInterviewSummaryGenerator,createUnscoredSummary}=await load('interview-summary')
  const result=await createInterviewSummaryGenerator(config,measured).generate(createUnscoredSummary(segments,config.model),job)
  assert.ok(result.summary);assert.equal(result.transcript.length>0,true);return result
})
await check('actual faster-whisper inference rather than health-only probe',async()=>{
  report.whisperMemoryPreflight=await requireInterviewTestMemory()
  const {createFasterWhisperClient,loadFasterWhisperConfig}=await load('faster-whisper-client')
  const client=createFasterWhisperClient(loadFasterWhisperConfig(env))
  const result=await client.transcribe(await readFile(join(directory,'pcm-1.wav')),'audio/wav')
  assert.ok(result.length);return result
})
await save();console.log('REPORT',join(directory,'real-models-report.json'))
if(report.checks.some(row=>!row.passed))process.exitCode=1
