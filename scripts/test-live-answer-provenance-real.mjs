import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { readRuntimeConfig } from './runtime-config.mjs'
import { PlatformAiMaintenance } from '../packages/enterprise-ai/index.js'
import { loadDatabaseConfig } from '../apps/api/dist/src/db/config.js'
import { buildLiveAnalysisContext } from '../apps/api/dist/src/interviews/live-analysis-context.js'
import { createInterviewAnswerAnalyzer, loadInterviewAnswerAnalyzerConfig } from '../apps/api/dist/src/interviews/answer-analyzer.js'

const root=resolve(import.meta.dirname,'..'),directory=resolve(process.argv[2]??'')
const within=relative(join(root,'tmp'),directory)
assert.ok(within && !within.startsWith('..') && !isAbsolute(within),'Use a synthetic acceptance directory under tmp')
const env=readRuntimeConfig(root).env
const {target,...connection}=loadDatabaseConfig(env)
const {Pool}=createRequire(join(root,'apps/api/package.json'))('pg')
const pool=new Pool({...connection,max:1,options:'-c default_transaction_read_only=on'})
let effective,vite
const report={businessDatabaseWrites:false,syntheticReplay:true,configurationSource:'persisted system-administrator enterprise',calls:[],checks:[]}
try{
  Object.assign(process.env,{NODE_ENV:env.NODE_ENV,AI_ALLOWED_BASE_URL_ORIGINS:env.AI_ALLOWED_BASE_URL_ORIGINS})
  const org=(await pool.query(`SELECT m.organization_id FROM public.organization_members m JOIN public.users u ON u.id=m.user_id
    JOIN public.platform_operators p ON p.user_id=u.id AND p.is_active AND p.role='admin'
    WHERE m.is_active AND u.is_active AND u.user_no=$1 AND organization_service_available(m.organization_id) ORDER BY m.organization_id LIMIT 1`,[env.SYSTEM_ADMIN_USER_NO])).rows[0]
  assert.ok(org)
  effective=await new PlatformAiMaintenance(pool,env.AI_CONFIG_ENCRYPTION_KEY).effectiveEnv(org.organization_id)
  await pool.end()
  const raw=JSON.parse(await readFile(join(directory,'browser-segments.json'),'utf8'))
  const segments=raw.map(row=>({id:row.id,sessionId:'synthetic-provenance-replay',speakerId:row.speaker_id,role:row.role,confidence:Number(row.role_confidence),text:row.text,startMs:Number(row.start_ms),endMs:Number(row.end_ms),audioSource:row.audio_source,roleReview:row.role_review,speakerConfirmed:row.speaker_confirmed,status:'transcribed'}))
  const {createServer}=await import('../web/node_modules/vite/dist/node/index.js')
  vite=await createServer({root:join(root,'web'),server:{middlewareMode:true},appType:'custom'})
  const {buildUtterances}=await vite.ssrLoadModule('/src/modules/interviews/utils/utterance-state.ts')
  const turns=buildUtterances(segments,120000,15000).filter(row=>row.role==='candidate'&&!row.overlapping&&row.confidence>=.85)
  assert.equal(turns.length,2,'Replay the two substantive original browser answers, not fabricated replacements')
  const first=turns[0]
  turns.push({...first,sourceIds:[first.sourceIds[0]]})
  const fetcher=async(url,init)=>{
    const start=Date.now(),payload=JSON.parse(init.body),input=JSON.parse(payload.messages[1].content)
    const response=await fetch(url,init)
    const call={status:response.status,latencyMs:Date.now()-start,retry:payload.messages.length>2,invalidFields:[]}
    try{
      const envelope=await response.clone().json(),value=JSON.parse(envelope.choices[0].message.content)
      for(const [index,score]of (value.scores??[]).entries()){
        if(typeof score.questionQuote!=='string'||(score.questionQuote!==''&&!input.question.includes(score.questionQuote)))call.invalidFields.push('scores['+index+'].questionQuote')
        if(!score.evidence?.length||score.evidence.some(q=>typeof q!=='string'||!input.candidateAnswer.includes(q)))call.invalidFields.push('scores['+index+'].evidence')
      }
    }catch{call.invalidFields.push('response-format')}
    report.calls.push(call);return response
  }
  const analyzer=createInterviewAnswerAnalyzer(loadInterviewAnswerAnalyzerConfig(effective),fetcher)
  for(const turn of turns){
    const context=buildLiveAnalysisContext(segments,turn.id,turn.sourceIds)
    const input={...context,jobTitle:'智能客服后端开发',jobRequirements:['知识检索','工单接口','接口可靠性'],refineTranscript:true}
    const row={sourceSegments:turn.sourceIds.length,candidateCharacters:context.candidateAnswer.length,questionCharacters:context.question.length}
    try{const result=await analyzer.analyze(input);row.passed=true;row.scores=result.scores.length;assert.ok(result.transcriptRefinement?.text)}catch(error){row.passed=false;row.code=error.code;row.error=error.message}
    report.checks.push(row)
  }
}catch(error){report.error=error.code??error.message;process.exitCode=1}
finally{
  await vite?.close();await pool.end().catch(()=>{})
  report.finishedAt=new Date().toISOString()
  await writeFile(join(directory,'answer-provenance-replay.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report))
  if(report.checks.some(x=>!x.passed))process.exitCode=1
}
