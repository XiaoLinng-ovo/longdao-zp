import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'

const root=resolve(import.meta.dirname,'..'), output=join(root,'tmp','optimization-ui-'+Date.now())
const requireWeb=createRequire(join(root,'web/package.json'))
const requireRuntime=createRequire(join(process.env.CODEX_NODE_MODULES || join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'),'playwright/package.json'))
const {chromium}=requireRuntime('playwright')
const {createServer}=await import(pathToFileURL(requireWeb.resolve('vite')).href)
const {default:vue}=await import(pathToFileURL(requireWeb.resolve('@vitejs/plugin-vue')).href)
const stamp='2026-11-13T00:00:00Z'
const workspaces=[1,2].map(n=>({id:'company-'+n,name:'同名合成公司',kind:'test',status:'active',role:'member',serviceAvailable:true,serviceStatus:'enabled',createdAt:stamp}))
let administrator=true,active=workspaces[0].id,empty=false,failRead=false,failWrite=false
const requests=[],errors=[],checks=[]
const check=(label,value)=>{checks.push({label,passed:!!value});assert.ok(value,label)}
const user=()=>({id:'synthetic-user',name:'合成测试用户',email:'qa@example.invalid',role:'recruiter',departmentId:'',workspaceId:active,workspaceName:'同名合成公司',workspaceKind:'test',isSystemAdmin:administrator,...(administrator?{platformRole:'admin'}:{})})
const fields=Object.fromEntries(['SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASSWORD','SMTP_FROM'].map(key=>[key,{configured:true,masked:key==='SMTP_PASSWORD',value:({SMTP_HOST:'smtp.example.invalid',SMTP_PORT:'465',SMTP_SECURE:'true',SMTP_USER:'qa@example.invalid',SMTP_PASSWORD:'',SMTP_FROM:'qa@example.invalid'})[key]}]))
const fixtures={
  '/auth/csrf':{token:'synthetic-csrf'},'/departments':[],'/offers/eligible-applications':[],
  '/onboarding/reports':{totals:{all:0,pending:0,preparing:0,scheduled:0,completed:0,no_show:0,cancelled:0},arrivalRate:null,averagePreparationDays:null,medianPreparationDays:null,requiredTaskOnTimeRate:null,overdueTasks:0,blockedTasks:0,reasonDistribution:[],integrationStatus:{},highRiskItems:[]},
  '/system/features':{recruitmentReportsEnabled:true},'/trial-usage':{enforced:false,serviceStatus:'enabled'},
  '/ready':{status:'ready',checks:{}},'/health':{status:'ok',service:'synthetic-api',version:'qa',uptimeSeconds:1},
  '/admin/users':[], '/admin/roles':[], '/admin/departments':[], '/admin/settings':{}, '/admin/dingtalk-settings':{},
  '/admin/resume-virus-scan':{enabled:false}, '/admin/audit-logs':[], '/admin/ai-sharing':{enabled:false,activeOrganizationCount:2,sharedOrganizationCount:0},
  '/admin/ai-settings':{configured:false,baseUrlHost:'',model:'',timeoutMs:1000,apiKeyConfigured:false,missing:[],env:Object.fromEntries(['OPENAI_BASE_URL','OPENAI_API_KEY','OPENAI_MODEL','OPENAI_TIMEOUT_MS'].map(key=>[key,{value:'',configured:false,masked:key==='OPENAI_API_KEY'}]))},
  '/admin/smtp-settings':fields,
  '/jobs':[], '/candidates':[], '/candidate-tags':[], '/resume-import-batches':[], '/interviews':[], '/applications':[], '/interviewer-options':[], '/offers':[], '/offer-templates':[], '/onboarding':[], '/onboarding/workbench':[],
  '/dashboard/summary':{generatedAt:stamp,metrics:[],funnel:[],pendingApprovals:[],pendingInterviews:[],failedTasks:[],todos:[]},
}
await mkdir(output,{recursive:true})
const server=await createServer({root:join(root,'web'),configFile:false,plugins:[{name:'isolated-optimization-fixtures',configureServer(vite){
  vite.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/api/'))return next()
    const key=new URL(req.url,'http://localhost').pathname.replace(/^\/api\/v1/,'')
    let data,known=true,status=200
    if(req.method==='GET' && key==='/me')data={user:user(),sessionId:'synthetic-session',method:'session',workspaces}
    else if(req.method==='GET' && key==='/workspaces')data=workspaces
    else if(req.method==='POST' && /^\/workspaces\/company-[12]\/select$/.test(key)){active=key.split('/')[2];data={user:user()}}
    else if(req.method==='GET' && key==='/admin/email-deliveries')data=empty?[]:[{id:'email-1',organization_id:'company-1',offer_id:'offer-1',version_id:'version-1',message_id:'<synthetic-long-identifier-for-safe-reconciliation@example.invalid>',status:'unknown',created_at:stamp,updated_at:stamp}]
    else if(req.method==='GET' && key==='/admin/operational-recovery'){
      if(failRead){status=503;data={message:'隔离测试：结构暂未就绪'}}
      else data={cleanup:empty?[]:[{id:'cleanup-1',organization_id:'company-1',status:'failed',attempts:12,last_error:'原存储位置未知或当前配置已变化，已阻止删除'}],audio:empty?[]:[{id:'audio-1',organization_id:'company-1',status:'unknown',attempts:1,last_error:'识别期间中断，结果待核对'}],refund:empty?[]:[{id:'refund-1',organization_id:'company-1',status:'refund_pending',refund_check_attempts:2,refund_next_check_at:stamp}]}
    } else if(req.method==='POST' && ['/admin/email-deliveries/email-1/resolve','/admin/operational-recovery/cleanup/cleanup-1/resolve','/admin/operational-recovery/audio/audio-1/resolve'].includes(key)){
      let body='';for await(const chunk of req)body+=chunk
      const input=JSON.parse(body);assert.ok(input.note.length>=5)
      if(failWrite){status=409;data={message:'隔离测试：任务已被其他操作处理'}}else data={resolved:true}
    } else if(req.method==='GET' && Object.hasOwn(fixtures,key))data=fixtures[key]
    else {known=false;status=501;data={message:'隔离验收禁止未定义请求'}}
    requests.push({method:req.method,path:key,known,status,workspace:req.headers['x-workspace-id']})
    res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8')
    res.end(JSON.stringify(status===200?{ok:true,data}:{ok:false,error:{code:'QA_ISOLATION',...data}}))
  })
}},vue()],server:{host:'127.0.0.1',port:0,proxy:{},watch:{ignored:['**/reports/**']}}})
let browser,origin
try {
  await server.listen();origin='http://127.0.0.1:'+server.httpServer.address().port
  console.log('隔离浏览器验收地址：'+origin)
  browser=await chromium.launch({headless:true})
  const context=await browser.newContext({locale:'zh-CN'})
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort())
  const page=await context.newPage()
  page.on('pageerror',error=>errors.push(error.message))
  const panel=page.getByRole('region',{name:'异常任务核对'})
  for(const width of [320,390,768,1440]) {
    await page.setViewportSize({width,height:950});await page.goto(origin+'/administration?module=smtp')
    await panel.getByRole('button',{name:'未发送',exact:true}).waitFor()
    check(width+' 页面不空白且无错误遮罩',await page.locator('body').innerText().then(text=>text.length>100) && await page.locator('vite-error-overlay').count()===0)
    check(width+' 页面没有横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    await page.screenshot({path:join(output,'recovery-'+width+'.png'),fullPage:true})
    const trigger=panel.getByRole('button',{name:'未发送',exact:true})
    await trigger.click()
    const dialog=page.getByRole('dialog',{name:'确认未发送，解除发送预留'})
    await dialog.waitFor()
    check(width+' 核对说明获得初始焦点',await dialog.locator('textarea').evaluate(el=>el===document.activeElement))
    check(width+' 缺少依据时不可提交',await dialog.getByRole('button',{name:'记录核对结果'}).isDisabled())
    check(width+' 弹窗在视口内',await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1 && r.top>=0 && r.bottom<=innerHeight+1}))
    await page.screenshot({path:join(output,'dialog-'+width+'.png'),fullPage:true})
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
    check(width+' 取消后焦点回到原按钮',await trigger.evaluate(el=>el===document.activeElement))
    await trigger.click();await dialog.locator('textarea').fill('已核对合成服务日志，无投递记录')
    await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'记录核对结果'}).click()
    await panel.getByText('核对结果已记录',{exact:true}).waitFor()
    for(const label of ['文件清理','整场转写','退款查单']) {
      await panel.getByRole('tab',{name:label,exact:true}).click()
      check(width+' '+label+' 表格有记录',await panel.locator('tbody tr').count()===1)
      if(label==='整场转写')check(width+' 未知转写不提供重试',await panel.getByRole('button',{name:'重新排队'}).count()===0)
      if(label==='退款查单')check(width+' 退款只显示查单状态',await panel.locator('tbody button').count()===0)
    }
  }
  await page.setViewportSize({width:1440,height:950})
  await panel.getByRole('tab',{name:'文件清理',exact:true}).click();await panel.getByRole('button',{name:'重新排队'}).click()
  const dialog=page.getByRole('dialog',{name:'重新排队清理文件'})
  await dialog.locator('textarea').fill('原始位置已经人工核对');await dialog.getByRole('checkbox').check();failWrite=true
  await dialog.getByRole('button',{name:'记录核对结果'}).click();await dialog.getByRole('alert').waitFor()
  check('更新冲突保留核对依据',await dialog.locator('textarea').inputValue()==='原始位置已经人工核对')
  await dialog.getByRole('button',{name:'取消',exact:true}).click();failWrite=false
  empty=true;await panel.getByRole('button',{name:'刷新异常任务'}).click();await panel.getByText('暂无异常任务',{exact:true}).waitFor()
  check('没有记录时显示明确空状态',true)
  failRead=true;await panel.getByRole('button',{name:'刷新异常任务'}).click();await panel.getByRole('alert').waitFor()
  check('读取失败不伪装成功',await panel.getByRole('alert').innerText().then(text=>text.includes('结构暂未就绪')))
  failRead=false
  administrator=false
  const before=requests.length
  await page.goto(origin+'/administration?module=smtp');await page.waitForURL('**/forbidden?**')
  check('普通用户直达管理页被拒绝',new URL(page.url()).pathname==='/forbidden')
  check('普通用户未探测全局管理接口',requests.slice(before).every(row=>!row.path.startsWith('/admin/')))
  for(const path of ['/jobs','/candidates','/interviews','/offers','/onboarding']) {
    await page.goto(origin+path);await page.waitForLoadState('networkidle')
    check('普通用户可打开 '+path,new URL(page.url()).pathname===path && await page.locator('main').innerText().then(text=>text.length>10))
  }
  await page.getByRole('button',{name:'打开用户信息'}).click()
  await page.locator('.workspace-switcher-trigger').click();await page.locator('.workspace-switcher-item:not(:disabled)').click()
  await page.waitForURL(origin+'/');await page.waitForLoadState('networkidle')
  check('同名公司按唯一编号切换并重新加载',active==='company-2' && requests.filter(row=>row.path==='/me').length>2)
  check('不存在未定义的 API 请求',requests.every(row=>row.known))
  check('浏览器无未处理运行错误',errors.length===0)
  console.log(JSON.stringify({passed:true,checks:checks.length,output},null,2))
} catch(error) {
  errors.push(error.stack);process.exitCode=1;console.error(error)
} finally {
  await writeFile(join(output,'report.json'),JSON.stringify({executedAt:new Date().toISOString(),fixtureOnly:true,realApiRequests:0,checks,requests,errors},null,2))
  await browser?.close();await server.close()
}
