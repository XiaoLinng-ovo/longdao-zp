import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Pool } from 'pg'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { BillingStore, EnterpriseAiStore, EnterpriseAiError, meterInterviewAudio, isExecutionBusy } from '@smartrecruit-pro/enterprise-ai'
import { createDatabasePool } from '../db/connection.js'
import { runWithTenantContext, organizationSchemaName } from '../db/tenant-context.js'
import { attachAuth } from '../auth/middleware.js'
import { AuthService, createAuthSessionStore } from '../auth/auth-service.js'
import { requireReadyWorkspaceSchema } from '../auth/workspace-context.js'
import { isAllowedOrigin, parseAllowedOrigins } from '../auth/security.js'
import type { AppConfig } from '../config.js'
import type { RequestContext } from '../http.js'

const bytesOf = (data: RawData) => Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
const send = (socket: WebSocket, data: Buffer | string, binary: boolean) => new Promise<void>((resolve,reject) => {
  socket.send(data,{binary},error => error ? reject(error) : resolve())
})

interface StreamGatewayDependencies {
  pool?: Pool
  authenticate?: (context: RequestContext) => Promise<void>
  resolveEnv?: (organizationId: string) => Promise<NodeJS.ProcessEnv>
  upstreamUrl?: string
}

/** Browser ASR traffic requires a session and quota; audio capture and storage remain independent. */
export function attachBilledStreamGateway(server: Server, config: AppConfig, dependencies: StreamGatewayDependencies = {}): () => Promise<void> {
  const pool = dependencies.pool ?? createDatabasePool(), wss = new WebSocketServer({noServer:true,maxPayload:65536})
  const auth = dependencies.authenticate ? undefined : new AuthService(createAuthSessionStore(process.env, pool))
  const authenticate = dependencies.authenticate ?? ((context: RequestContext) => attachAuth(context, auth!))
  const connections = new Map<WebSocket, () => void>()
  const active = new Set<Promise<unknown>>()
  const pendingSockets = new Set<Duplex>()
  let closing: Promise<void> | undefined, closed = false
  const track = <T>(work: Promise<T>): Promise<T> => {
    active.add(work)
    void work.then(() => active.delete(work), () => active.delete(work))
    return work
  }
  server.on('upgrade',(req,socket,head) => {
    if(closed){socket.destroy();return}
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://localhost') }
    catch { socket.destroy(); return }
    if(url.pathname !== '/funasr-stream'){socket.destroy();return}
    pendingSockets.add(socket)
    let claimed: string | undefined
    void track((async () => {
      const origins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS)
      if(!isAllowedOrigin(req.headers.origin,origins.length ? origins : ['http://localhost:5174','http://127.0.0.1:5174'],process.env.NODE_ENV!=='production')) throw new Error('来源校验失败')
      const context={req,config,url,requestId:randomUUID()} as RequestContext
      await authenticate(context)
      if(closed || socket.destroyed)throw new Error('实时转写服务正在关闭')
      const auth=context.auth,org=auth?.user.workspaceId,session=url.searchParams.get('sessionId') ?? '',source=url.searchParams.get('source') ?? ''
      const offset=Number(url.searchParams.get('offsetMs') ?? '0')
      if(auth?.method!=='session' || !org || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(session) || !['microphone','meeting'].includes(source) || !Number.isSafeInteger(offset) || offset<0 || offset>1e9) throw new Error('请登录并选择有效面试')
      const scoped=<T>(action:()=>Promise<T>) => process.env.TENANT_SCHEMA_ROUTING==='on' ? runWithTenantContext({organizationId:org,schemaName:organizationSchemaName(org)},action) : action()
      const checkAccess=async()=>{
        if(process.env.TENANT_SCHEMA_ROUTING==='on') await requireReadyWorkspaceSchema(pool,org)
        const member=(await pool.query('SELECT 1 FROM public.organization_members m JOIN public.users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND u.is_active AND public.organization_service_available(m.organization_id)',[org,auth.user.id])).rows[0]
        const live=member && await scoped(()=>pool.query("SELECT s.id FROM interview_live_sessions s JOIN interviews i ON i.id=s.interview_id WHERE s.id=$1 AND i.organization_id=$2 AND s.status<>'completed'",[session,org]))
        if(!live?.rows[0])throw new EnterpriseAiError('STREAM_ACCESS_DENIED','企业权限已失效或面试已结束，录音仍会保留',403)
      }
      await checkAccess()
      const env=await (dependencies.resolveEnv ? dependencies.resolveEnv(org) : new EnterpriseAiStore(pool).runtimeEnv(org)),connectionId=randomUUID()
      const endpoint=new URL(dependencies.upstreamUrl || process.env.FUNASR_STREAM_URL || process.env.FUNASR_BASE_URL || 'http://127.0.0.1:10095')
      endpoint.protocol=['https:','wss:'].includes(endpoint.protocol)?'wss:':'ws:';endpoint.pathname='/stream';endpoint.search=''
      const db=await pool.connect()
      let initialMs=offset
      try{
        await db.query('BEGIN')
        await db.query('SELECT id FROM public.organizations WHERE id=$1 FOR NO KEY UPDATE',[org])
        const policy=await new BillingStore(pool).policy(db)
        const count=(await db.query('SELECT count(DISTINCT session_id)::int AS n FROM public.billing_stream_sources WHERE organization_id=$1 AND session_id<>$2 AND lease_until>now()',[org,session])).rows[0]
        if(count.n>=policy.config.limits.maxConcurrent)throw new Error('企业实时面试已达到并发上限')
        const lease=(await db.query("INSERT INTO public.billing_stream_sources(organization_id,session_id,source,connection_id,lease_until,end_ms) VALUES($1,$2,$3,$4,now()+interval '45 seconds',$5) ON CONFLICT(organization_id,session_id,source) DO UPDATE SET connection_id=excluded.connection_id,lease_until=excluded.lease_until,end_ms=greatest(billing_stream_sources.end_ms,excluded.end_ms) WHERE billing_stream_sources.lease_until<now() RETURNING end_ms",[org,session,source,connectionId,offset])).rows[0]
        if(!lease)throw new Error('该音轨已有实时连接，请稍后重试')
        initialMs=Number(lease.end_ms)
        await db.query('COMMIT');claimed=connectionId
      }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error}finally{db.release()}
      if(socket.destroyed)throw new Error('客户端已断开')
      if(closed)throw new Error('实时转写服务正在关闭')
      wss.handleUpgrade(req,socket,head,client=>{
        const upstream=new WebSocket(endpoint,{handshakeTimeout:10000,maxPayload:1048576,headers:process.env.FUNASR_TOKEN?{Authorization:'Bearer '+process.env.FUNASR_TOKEN}:{}})
        let chain=Promise.resolve(),queued=0,endMs=initialMs,sequence=0,totalBytes=0,closed=false,opened=false
        let heartbeatWork: Promise<unknown> = Promise.resolve(), heartbeatBusy = false
        let chunks:Buffer[]=[],buffered=0,flushTimer:ReturnType<typeof setTimeout>|undefined
        const ready=new Promise<void>((resolve,reject)=>{upstream.once('open',()=>{opened=true;resolve()});upstream.once('error',reject);upstream.once('close',()=>{if(!opened)reject(new Error('转写服务未就绪'))})})
        void ready.catch(()=>undefined)
        const stop=()=>{
          if(closed)return;closed=true;clearInterval(heartbeat);clearTimeout(flushTimer);chunks=[]
          connections.delete(client);client.terminate();upstream.terminate()
          void track(Promise.allSettled([chain,heartbeatWork]).then(()=>pool.query('UPDATE public.billing_stream_sources SET lease_until=now() WHERE connection_id=$1',[connectionId]))).catch(()=>console.warn('实时连接租约释放失败，将等待租约到期'))
        }
        const fail=(message:string,code='STREAM_TEMPORARY_UNAVAILABLE',retryable=true)=>{
          if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify({type:'billing_error',message,code,retryable}),()=>stop())
          else stop()
        }
        const heartbeat=setInterval(()=>{
          if(closed || heartbeatBusy)return
          heartbeatBusy=true
          heartbeatWork=track(checkAccess().then(()=>closed ? undefined : pool.query("UPDATE public.billing_stream_sources SET lease_until=now()+interval '45 seconds' WHERE connection_id=$1 RETURNING session_id",[connectionId])).then(r=>{if(r && !r.rows[0])stop()}).catch(error=>fail(error instanceof Error?error.message:'实时连接暂不可用',error?.code,error?.code!=='STREAM_ACCESS_DENIED')).finally(()=>{heartbeatBusy=false}))
        },15000);heartbeat.unref()
        connections.set(client,stop)
        claimed=undefined
        const enqueue=(data:Buffer,binary:boolean)=>{
          chain=chain.then(async()=>{
            if(closed)return
            await ready;await checkAccess()
            if(binary){
              totalBytes+=data.length
              const startMs=endMs,nextMs=initialMs+Math.ceil(totalBytes/32)
              const claim=await pool.query("UPDATE public.billing_stream_sources SET lease_until=now()+interval '45 seconds' WHERE connection_id=$1 RETURNING session_id",[connectionId])
              if(!claim.rows[0])throw new Error('实时音轨连接已变化')
              const key='stream:'+connectionId+':'+(++sequence)
              for(let attempt=0;;attempt++){
                try{await meterInterviewAudio(env,key,{sessionId:session,startMs,endMs:nextMs},async()=>{await send(upstream,data,true);return true},'realtime');break}
                catch(error){if((error as {code?:string}).code!=='BILLING_AUDIO_BUSY' || attempt>=20)throw error;await new Promise(r=>setTimeout(r,100));if(closed)return}
              }
              await pool.query('UPDATE public.billing_stream_sources SET end_ms=$2 WHERE connection_id=$1',[connectionId,nextMs])
              endMs=nextMs
            }else await send(upstream,data.toString('utf8'),false)
            queued-=data.length
          }).catch(error=>fail(error instanceof Error?error.message:'实时转写暂停，已保留录音',error?.code,
            isExecutionBusy(error) || !(error instanceof EnterpriseAiError)))
        }
        const flush=()=>{clearTimeout(flushTimer);flushTimer=undefined;if(!buffered)return;const data=Buffer.concat(chunks,buffered);chunks=[];buffered=0;enqueue(data,true)}
        upstream.on('message',(data,binary)=>{if(client.readyState===WebSocket.OPEN)client.send(data,{binary})})
        upstream.on('error',()=>fail('实时转写服务暂不可用，录音与分段保存继续。'))
        upstream.on('close',stop);client.on('error',stop);client.on('close',stop)
        client.on('message',(raw,binary)=>{
          if(closed)return
          const data=bytesOf(raw);queued+=data.length
          if(queued>320000){fail('实时转写处理繁忙，录音与分段保存继续。');return}
          if(binary){
            if(!data.length || data.length%2){fail('音频数据无效','STREAM_INVALID_AUDIO',false);return}
            chunks.push(data);buffered+=data.length
            if(buffered>=32000)flush()
            else if(!flushTimer){flushTimer=setTimeout(flush,1000);flushTimer.unref()}
          }else{
            try{if(data.length>2048)throw new Error();const msg=JSON.parse(data.toString('utf8')) as {type?:string};if(!['ping','commit','end'].includes(msg.type ?? ''))throw new Error()}
            catch{fail('控制消息无效','STREAM_INVALID_CONTROL',false);return}
            flush();enqueue(data,false)
          }
        })
      })
      if(claimed){await pool.query('UPDATE public.billing_stream_sources SET lease_until=now() WHERE connection_id=$1',[claimed]);claimed=undefined}
    })().catch(async()=>{
      if(claimed)await pool.query('UPDATE public.billing_stream_sources SET lease_until=now() WHERE connection_id=$1',[claimed]).catch(()=>undefined)
      if(!socket.destroyed){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy()}
    }).finally(()=>pendingSockets.delete(socket)))
  })
  const close = () => {
    if(closing)return closing
    closed=true
    for(const socket of pendingSockets)socket.destroy()
    for(const stop of connections.values())stop()
    closing=(async()=>{
      while(active.size)await Promise.allSettled(active)
      await new Promise<void>(resolve=>wss.close(()=>resolve()))
      if(!dependencies.pool)await pool.end()
    })()
    return closing
  }
  server.once('close',()=>{void close().catch(()=>console.warn('实时转写资源关闭失败'))})
  return close
}
